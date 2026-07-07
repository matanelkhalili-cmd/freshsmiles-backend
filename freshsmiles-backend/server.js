// Fresh Smiles Dental — backend server
//
// This is the "private" part of the system. Unlike booking.html and billing.html,
// which run in a patient's browser where anyone could view the code, this file
// only ever runs on a private server. That's why it's the only place allowed to
// hold the Stripe SECRET key and the database connection string.
//
// Storage: a real Postgres database (Neon), not a local file. A local file
// on Render's free tier can be wiped whenever the service restarts — a real
// external database persists independently of that.

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const { Resend } = require('resend');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.warn('Warning: STRIPE_SECRET_KEY is not set. Payment endpoints will fail until it is.');
}
const stripe = require('stripe')(STRIPE_SECRET_KEY);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
  console.warn('Warning: RESEND_API_KEY is not set. Emails will be skipped until it is.');
}
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const EMAIL_FROM = 'Fresh Smiles Dental <appointments@freshsmilesnow.com>';

// Sending an email is never allowed to break the actual booking/payment
// request it's attached to — if Resend isn't configured yet, or the send
// fails for any reason, we log it and move on rather than throwing.
async function sendEmail(to, subject, html) {
  if (!resend || !to) return;
  try {
    await resend.emails.send({ from: EMAIL_FROM, to: [to], subject, html });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn('Warning: DATABASE_URL is not set. Database endpoints will fail until it is.');
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      reason TEXT,
      booked_at TIMESTAMPTZ,
      arrived_at TIMESTAMPTZ,
      walk_in BOOLEAN DEFAULT FALSE
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      amount NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      stripe_payment_intent_id TEXT
    );
  `);
  // Safe to run even if the table already exists without these columns —
  // IF NOT EXISTS means it's a no-op on a database that already has them.
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS insurance_provider TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS insurance_member_id TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS insurance_provider TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS insurance_member_id TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS insurance_status TEXT NOT NULL DEFAULT 'not_billed';`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS insurance_group_number TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS insurance_notes TEXT;`);
  console.log('Database ready.');
}

function genInvoiceId() {
  return 'INV-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

// Convert a database row (snake_case) into the shape the frontend expects (camelCase)
function bookingRowToJson(row) {
  return {
    time: row.time,
    name: row.name,
    phone: row.phone || '',
    email: row.email || '',
    reason: row.reason || '',
    insuranceProvider: row.insurance_provider || '',
    insuranceMemberId: row.insurance_member_id || '',
    bookedAt: row.booked_at ? row.booked_at.toISOString() : null,
    arrivedAt: row.arrived_at ? row.arrived_at.toISOString() : undefined,
    walkIn: row.walk_in || undefined
  };
}

function invoiceRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || '',
    email: row.email || '',
    insuranceProvider: row.insurance_provider || '',
    insuranceMemberId: row.insurance_member_id || '',
    insuranceGroupNumber: row.insurance_group_number || '',
    insuranceNotes: row.insurance_notes || '',
    insuranceStatus: row.insurance_status || 'not_billed',
    amount: Number(row.amount),
    status: row.status,
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    paidAt: row.paid_at ? row.paid_at.toISOString() : undefined,
    stripePaymentIntentId: row.stripe_payment_intent_id || undefined
  };
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Booking endpoints ----

// Get all bookings for one date (used to grey out taken time slots)
app.get('/api/bookings/:date', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bookings WHERE date = $1 ORDER BY time', [req.params.date]);
    res.json(result.rows.map(bookingRowToJson));
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// Create a new booking
app.post('/api/bookings', async (req, res) => {
  const { date, time, name, phone, email, reason, insuranceProvider, insuranceMemberId } = req.body;
  if (!date || !time || !name || !phone) {
    return res.status(400).json({ error: 'date, time, name, and phone are required.' });
  }
  try {
    const existing = await pool.query('SELECT id FROM bookings WHERE date = $1 AND time = $2', [date, time]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'That time slot was just taken. Please pick another.' });
    }
    const bookedAt = new Date();
    const result = await pool.query(
      `INSERT INTO bookings (date, time, name, phone, email, reason, insurance_provider, insurance_member_id, booked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [date, time, name, phone, email || '', reason || '', insuranceProvider || '', insuranceMemberId || '', bookedAt]
    );
    const booking = bookingRowToJson(result.rows[0]);
    res.status(201).json(booking);

    if (email) {
      await sendEmail(
        email,
        `Your appointment is confirmed — ${formatDateLabel(date)}`,
        `<p>Hi ${name.split(' ')[0]},</p>
         <p>Your appointment at <strong>Fresh Smiles Dental</strong> is confirmed:</p>
         <p><strong>${formatDateLabel(date)}</strong> at <strong>${time}</strong></p>
         <p>If you need to change or cancel, please call the office.</p>
         <p>See you soon!</p>`
      );
    }
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Staff view: all upcoming bookings across all dates
app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bookings ORDER BY date, time');
    const all = result.rows.map(row => ({ ...bookingRowToJson(row), date: row.date }));
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Check in a patient for a given date. If their name matches an existing
// booking that day, mark it arrived. If not (e.g. a walk-in with no
// appointment), create a lightweight entry so they still show up on the
// staff's arrived list.
app.post('/api/bookings/:date/checkin', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'A name is required to check in.' });
  }
  const date = req.params.date;
  const trimmedName = name.trim();
  try {
    const existing = await pool.query(
      'SELECT * FROM bookings WHERE date = $1 AND LOWER(TRIM(name)) = LOWER($2)',
      [date, trimmedName]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (!row.arrived_at) {
        const updated = await pool.query(
          'UPDATE bookings SET arrived_at = $1 WHERE id = $2 RETURNING *',
          [new Date(), row.id]
        );
        return res.json(bookingRowToJson(updated.rows[0]));
      }
      return res.json(bookingRowToJson(row));
    }
    const now = new Date();
    const inserted = await pool.query(
      `INSERT INTO bookings (date, time, name, phone, email, reason, booked_at, arrived_at, walk_in)
       VALUES ($1, 'Walk-in', $2, '', '', '', $3, $3, TRUE) RETURNING *`,
      [date, trimmedName, now]
    );
    res.json(bookingRowToJson(inserted.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// ---- Invoice / billing endpoints ----

// Staff: create a balance
app.post('/api/invoices', async (req, res) => {
  const { name, phone, email, amount, insuranceProvider, insuranceMemberId, insuranceGroupNumber, insuranceNotes } = req.body;
  if (!name || !amount || amount <= 0) {
    return res.status(400).json({ error: 'name and a positive amount are required.' });
  }
  try {
    const id = genInvoiceId();
    const createdAt = new Date();
    const initialInsuranceStatus = insuranceProvider ? 'pending' : 'not_billed';
    const result = await pool.query(
      `INSERT INTO invoices (id, name, phone, email, amount, status, created_at, insurance_provider, insurance_member_id, insurance_group_number, insurance_notes, insurance_status)
       VALUES ($1, $2, $3, $4, $5, 'unpaid', $6, $7, $8, $9, $10, $11) RETURNING *`,
      [id, name, phone || '', email || '', Number(amount), createdAt, insuranceProvider || '', insuranceMemberId || '', insuranceGroupNumber || '', insuranceNotes || '', initialInsuranceStatus]
    );
    res.status(201).json(invoiceRowToJson(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Staff: edit insurance details on an existing balance (e.g. patient calls
// back later with their member ID they didn't have at first)
app.post('/api/invoices/:id/insurance', async (req, res) => {
  const { insuranceProvider, insuranceMemberId, insuranceGroupNumber, insuranceNotes } = req.body;
  try {
    const existing = await pool.query('SELECT insurance_status FROM invoices WHERE id = $1', [req.params.id.toUpperCase()]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'No balance found for that ID.' });
    // If there wasn't a provider before and now there is, move it into "pending" automatically.
    const newStatus = (!existing.rows[0].insurance_status || existing.rows[0].insurance_status === 'not_billed') && insuranceProvider
      ? 'pending'
      : existing.rows[0].insurance_status;
    const result = await pool.query(
      `UPDATE invoices SET insurance_provider = $1, insurance_member_id = $2, insurance_group_number = $3, insurance_notes = $4, insurance_status = $5 WHERE id = $6 RETURNING *`,
      [insuranceProvider || '', insuranceMemberId || '', insuranceGroupNumber || '', insuranceNotes || '', newStatus, req.params.id.toUpperCase()]
    );
    res.json(invoiceRowToJson(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

const VALID_INSURANCE_STATUSES = ['not_billed', 'pending', 'paid', 'denied'];

// Staff: update just the insurance status on an existing balance
// (e.g. after hearing back from the insurer)
app.post('/api/invoices/:id/insurance-status', async (req, res) => {
  const { status } = req.body;
  if (!VALID_INSURANCE_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid insurance status.' });
  }
  try {
    const result = await pool.query(
      'UPDATE invoices SET insurance_status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id.toUpperCase()]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No balance found for that ID.' });
    res.json(invoiceRowToJson(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Staff: list all invoices
app.get('/api/invoices', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices ORDER BY created_at');
    res.json(result.rows.map(invoiceRowToJson));
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Patient: look up one invoice by ID
app.get('/api/invoices/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id.toUpperCase()]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No balance found for that ID.' });
    res.json(invoiceRowToJson(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});

// Patient: start a real payment for an invoice.
// This creates a genuine Stripe PaymentIntent — the object Stripe uses to track
// a real charge attempt — and returns a "client secret" the browser needs to
// finish the payment with Stripe directly. The secret key never leaves this server.
app.post('/api/invoices/:id/create-payment-intent', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id.toUpperCase()]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'No balance found for that ID.' });
    const invoice = invoiceRowToJson(result.rows[0]);
    if (invoice.status === 'paid') return res.status(409).json({ error: 'This balance is already paid.' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(invoice.amount * 100), // Stripe uses cents, not dollars
      currency: 'usd',
      metadata: { invoiceId: invoice.id, patientName: invoice.name }
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: 'Could not start payment: ' + err.message });
  }
});

// Patient: after Stripe confirms the charge in the browser, verify it really
// succeeded (by asking Stripe directly, not by trusting the browser) before
// marking the balance paid. This is what stops someone from faking a "success"
// message without actually paying.
app.post('/api/invoices/:id/confirm', async (req, res) => {
  const { paymentIntentId } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id.toUpperCase()]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'No balance found for that ID.' });

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded yet.' });
    }
    const result = await pool.query(
      `UPDATE invoices SET status = 'paid', paid_at = $1, stripe_payment_intent_id = $2 WHERE id = $3 RETURNING *`,
      [new Date(), paymentIntentId, req.params.id.toUpperCase()]
    );
    const invoice = invoiceRowToJson(result.rows[0]);
    res.json(invoice);

    if (invoice.email) {
      const amountFormatted = invoice.amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
      await sendEmail(
        invoice.email,
        `Payment received — ${amountFormatted}`,
        `<p>Hi ${invoice.name.split(' ')[0]},</p>
         <p>This confirms your payment to <strong>Fresh Smiles Dental</strong>:</p>
         <p><strong>${amountFormatted}</strong> — invoice ${invoice.id}</p>
         <p>Thank you!</p>`
      );
    }
  } catch (err) {
    res.status(500).json({ error: 'Could not confirm payment: ' + err.message });
  }
});

// ---- Rose (Vapi voice assistant) tool endpoints ----
//
// This is how Rose actually does things during a phone call. Vapi sends a
// POST here whenever the assistant decides to call one of its configured
// tools, and expects a response matching each tool call by its ID. Today
// these functions read/write our own database; once Dentrix Ascend API
// access is approved, the *inside* of these functions gets swapped to call
// Dentrix instead — Rose's side of the contract never has to change.

const VOICE_TIME_SLOTS = ['9:00 AM', '10:00 AM', '11:00 AM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM'];

async function handleCheckAvailability(args) {
  const date = args.date;
  if (!date) return 'I need a specific date to check availability.';
  const result = await pool.query('SELECT time FROM bookings WHERE date = $1', [date]);
  const taken = result.rows.map(r => r.time);
  const available = VOICE_TIME_SLOTS.filter(t => !taken.includes(t));
  if (available.length === 0) return `There are no open slots on ${date}. Would you like me to check another day?`;
  return `On ${date}, these times are open: ${available.join(', ')}.`;
}

async function handleBookAppointment(args) {
  const { date, time, name, phone, email } = args;
  if (!date || !time || !name || !phone) {
    return 'I need a date, time, patient name, and phone number to book this appointment.';
  }
  const existing = await pool.query('SELECT id FROM bookings WHERE date = $1 AND time = $2', [date, time]);
  if (existing.rows.length > 0) {
    return `Sorry, ${time} on ${date} was just taken. Could you pick a different time?`;
  }
  await pool.query(
    `INSERT INTO bookings (date, time, name, phone, email, reason, booked_at) VALUES ($1, $2, $3, $4, $5, '', $6)`,
    [date, time, name, phone, email || '', new Date()]
  );
  if (email) {
    await sendEmail(
      email,
      `Your appointment is confirmed — ${formatDateLabel(date)}`,
      `<p>Hi ${name.split(' ')[0]},</p><p>Your appointment at <strong>Fresh Smiles Dental</strong> is confirmed for <strong>${formatDateLabel(date)}</strong> at <strong>${time}</strong>.</p>`
    );
  }
  return `You're all set — booked for ${formatDateLabel(date)} at ${time}.`;
}

async function handleGetPatientInfo(args) {
  const phone = args.phone;
  if (!phone) return 'I need a phone number to look that up.';
  const bookingRes = await pool.query('SELECT * FROM bookings WHERE phone = $1 ORDER BY booked_at DESC LIMIT 1', [phone]);
  const invoiceRes = await pool.query('SELECT * FROM invoices WHERE phone = $1 ORDER BY created_at DESC LIMIT 1', [phone]);
  if (bookingRes.rows.length === 0 && invoiceRes.rows.length === 0) {
    return "I don't have a record for that phone number yet — this may be a new patient.";
  }
  const booking = bookingRes.rows[0];
  const inv = invoiceRes.rows[0];
  const name = (inv && inv.name) || (booking && booking.name);
  // Prefer the invoice's insurance info (more complete — has group number too),
  // but fall back to whatever's saved on the booking if there's no invoice yet.
  const provider = (inv && inv.insurance_provider) || (booking && booking.insurance_provider);
  const memberId = (inv && inv.insurance_member_id) || (booking && booking.insurance_member_id);
  const insuranceText = provider
    ? `Insurance on file: ${provider}, member ID ${memberId || 'not given'}.`
    : 'No insurance on file.';
  return `Found ${name}. ${insuranceText}`;
}

// Actually saves insurance info a caller gives Rose over the phone, rather
// than just having her say "I'll pass that along" with nothing behind it.
// Attaches it to their most recent booking, since that's what links a
// phone number to a real record today.
async function handleSaveInsuranceInfo(args) {
  const { phone, insuranceProvider, insuranceMemberId } = args;
  if (!phone) return "I need a phone number to save that against.";
  if (!insuranceProvider) return "I need at least the insurance provider name to save this.";
  const result = await pool.query(
    `UPDATE bookings SET insurance_provider = $1, insurance_member_id = $2
     WHERE phone = $3 AND id = (SELECT id FROM bookings WHERE phone = $3 ORDER BY booked_at DESC LIMIT 1)
     RETURNING *`,
    [insuranceProvider, insuranceMemberId || '', phone]
  );
  if (result.rows.length === 0) {
    return "I couldn't find a booking for that phone number to attach the insurance info to. Let them know staff will need to add it manually.";
  }
  return `Saved — ${insuranceProvider}${insuranceMemberId ? ', member ID ' + insuranceMemberId : ''} is now on file for this patient's appointment.`;
}

app.post('/api/vapi/tools', async (req, res) => {
  try {
    const toolCalls = (req.body.message && req.body.message.toolCalls) || [];
    const results = [];
    for (const call of toolCalls) {
      const fnName = call.function && call.function.name;
      let args = call.function && call.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch (e) { args = {}; }
      }
      args = args || {};

      let result;
      try {
        if (fnName === 'check_availability') result = await handleCheckAvailability(args);
        else if (fnName === 'book_appointment') result = await handleBookAppointment(args);
        else if (fnName === 'get_patient_info') result = await handleGetPatientInfo(args);
        else result = `I don't recognize the function "${fnName}".`;
      } catch (innerErr) {
        result = `Something went wrong on our end: ${innerErr.message}`;
      }
      results.push({ toolCallId: call.id, result });
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Tool call failed: ' + err.message });
  }
});

// Simple REST-style versions of the same three abilities, for Vapi's
// "API Request" tool type, which just makes a plain HTTP call and reads
// back a plain JSON response — no special envelope needed.
app.get('/api/vapi/check-availability', async (req, res) => {
  try {
    const message = await handleCheckAvailability({ date: req.query.date });
    res.json({ message });
  } catch (err) {
    res.json({ message: `Something went wrong: ${err.message}` });
  }
});

app.post('/api/vapi/book-appointment', async (req, res) => {
  try {
    const message = await handleBookAppointment(req.body);
    res.json({ message });
  } catch (err) {
    res.json({ message: `Something went wrong: ${err.message}` });
  }
});

app.get('/api/vapi/patient-info', async (req, res) => {
  try {
    const message = await handleGetPatientInfo({ phone: req.query.phone });
    res.json({ message });
  } catch (err) {
    res.json({ message: `Something went wrong: ${err.message}` });
  }
});

app.post('/api/vapi/save-insurance-info', async (req, res) => {
  try {
    const message = await handleSaveInsuranceInfo(req.body);
    res.json({ message });
  } catch (err) {
    res.json({ message: `Something went wrong: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Fresh Smiles backend running on port ${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
