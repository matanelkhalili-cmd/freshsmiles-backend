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

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.warn('Warning: STRIPE_SECRET_KEY is not set. Payment endpoints will fail until it is.');
}
const stripe = require('stripe')(STRIPE_SECRET_KEY);

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
      amount NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'unpaid',
      created_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      stripe_payment_intent_id TEXT
    );
  `);
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

// Create a new booking
app.post('/api/bookings', async (req, res) => {
  const { date, time, name, phone, email, reason } = req.body;
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
      `INSERT INTO bookings (date, time, name, phone, email, reason, booked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [date, time, name, phone, email || '', reason || '', bookedAt]
    );
    res.status(201).json(bookingRowToJson(result.rows[0]));
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
  const { name, phone, amount } = req.body;
  if (!name || !amount || amount <= 0) {
    return res.status(400).json({ error: 'name and a positive amount are required.' });
  }
  try {
    const id = genInvoiceId();
    const createdAt = new Date();
    const result = await pool.query(
      `INSERT INTO invoices (id, name, phone, amount, status, created_at)
       VALUES ($1, $2, $3, $4, 'unpaid', $5) RETURNING *`,
      [id, name, phone || '', Number(amount), createdAt]
    );
    res.status(201).json(invoiceRowToJson(result.rows[0]));
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
    res.json(invoiceRowToJson(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Could not confirm payment: ' + err.message });
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
  });function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function genInvoiceId() {
  return 'INV-' + Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ---- Booking endpoints ----

// Get all bookings for one date (used to grey out taken time slots)
app.get('/api/bookings/:date', (req, res) => {
  const db = readDB();
  res.json(db.bookings[req.params.date] || []);
});

// Create a new booking
app.post('/api/bookings', (req, res) => {
  const { date, time, name, phone, email, reason } = req.body;
  if (!date || !time || !name || !phone) {
    return res.status(400).json({ error: 'date, time, name, and phone are required.' });
  }
  const db = readDB();
  if (!db.bookings[date]) db.bookings[date] = [];
  const alreadyTaken = db.bookings[date].some(b => b.time === time);
  if (alreadyTaken) {
    return res.status(409).json({ error: 'That time slot was just taken. Please pick another.' });
  }
  const booking = { time, name, phone, email, reason, bookedAt: new Date().toISOString() };
  db.bookings[date].push(booking);
  writeDB(db);
  res.status(201).json(booking);
});

// Staff view: all upcoming bookings across all dates
app.get('/api/bookings', (req, res) => {
  const db = readDB();
  const all = [];
  for (const [date, dayBookings] of Object.entries(db.bookings)) {
    dayBookings.forEach(b => all.push({ ...b, date }));
  }
  all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(all);
});

// Check in a patient for a given date. If their name matches an existing
// booking that day, mark it arrived. If not (e.g. a walk-in with no
// appointment), create a lightweight entry so they still show up on the
// staff's arrived list.
app.post('/api/bookings/:date/checkin', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'A name is required to check in.' });
  }
  const db = readDB();
  const date = req.params.date;
  if (!db.bookings[date]) db.bookings[date] = [];

  const normalized = name.trim().toLowerCase();
  let booking = db.bookings[date].find(b => b.name.trim().toLowerCase() === normalized);

  if (booking) {
    if (!booking.arrivedAt) booking.arrivedAt = new Date().toISOString();
  } else {
    booking = {
      time: 'Walk-in',
      name: name.trim(),
      phone: '',
      email: '',
      reason: '',
      bookedAt: new Date().toISOString(),
      arrivedAt: new Date().toISOString(),
      walkIn: true
    };
    db.bookings[date].push(booking);
  }
  writeDB(db);
  res.json(booking);
});

// ---- Invoice / billing endpoints ----

// Staff: create a balance
app.post('/api/invoices', (req, res) => {
  const { name, phone, amount } = req.body;
  if (!name || !amount || amount <= 0) {
    return res.status(400).json({ error: 'name and a positive amount are required.' });
  }
  const db = readDB();
  const invoice = {
    id: genInvoiceId(),
    name,
    phone: phone || '',
    amount: Number(amount),
    status: 'unpaid',
    createdAt: new Date().toISOString()
  };
  db.invoices.push(invoice);
  writeDB(db);
  res.status(201).json(invoice);
});

// Staff: list all invoices
app.get('/api/invoices', (req, res) => {
  const db = readDB();
  res.json(db.invoices);
});

// Patient: look up one invoice by ID
app.get('/api/invoices/:id', (req, res) => {
  const db = readDB();
  const invoice = db.invoices.find(i => i.id === req.params.id.toUpperCase());
  if (!invoice) return res.status(404).json({ error: 'No balance found for that ID.' });
  res.json(invoice);
});

// Patient: start a real payment for an invoice.
// This creates a genuine Stripe PaymentIntent — the object Stripe uses to track
// a real charge attempt — and returns a "client secret" the browser needs to
// finish the payment with Stripe directly. The secret key never leaves this server.
app.post('/api/invoices/:id/create-payment-intent', async (req, res) => {
  const db = readDB();
  const invoice = db.invoices.find(i => i.id === req.params.id.toUpperCase());
  if (!invoice) return res.status(404).json({ error: 'No balance found for that ID.' });
  if (invoice.status === 'paid') return res.status(409).json({ error: 'This balance is already paid.' });

  try {
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
  const db = readDB();
  const idx = db.invoices.findIndex(i => i.id === req.params.id.toUpperCase());
  if (idx === -1) return res.status(404).json({ error: 'No balance found for that ID.' });

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment has not succeeded yet.' });
    }
    db.invoices[idx].status = 'paid';
    db.invoices[idx].paidAt = new Date().toISOString();
    db.invoices[idx].stripePaymentIntentId = paymentIntentId;
    writeDB(db);
    res.json(db.invoices[idx]);
  } catch (err) {
    res.status(500).json({ error: 'Could not confirm payment: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Fresh Smiles backend running on port ${PORT}`));
