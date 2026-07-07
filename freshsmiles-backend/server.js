// Fresh Smiles Dental — backend server
//
// This is the "private" part of the system. Unlike booking.html and billing.html,
// which run in a patient's browser where anyone could view the code, this file
// only ever runs on a private server. That's why it's the only place allowed to
// hold the Stripe SECRET key.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// The secret key is read from an environment variable, never written in this file.
// Environment variables are a way to hand a private value to a running program
// without putting that value in code — so it's never visible on GitHub, never
// visible to anyone reading this file, only known to the hosting service at runtime.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.warn('Warning: STRIPE_SECRET_KEY is not set. Payment endpoints will fail until it is.');
}
const stripe = require('stripe')(STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { bookings: {}, invoices: [] };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(db) {
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
