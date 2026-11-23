// reviews.js — post-visit review texts for Fresh Smiles Dental.
//
// Flow:
//   1. ~4 hours after a checked-in patient's appointment time, a text goes out
//      asking how their visit went, with a private link.
//   2. The link opens /review.html, where they tap 1-5 stars.
//   3. 4-5 stars  -> sent on to the Google review page.
//      1-3 stars  -> "we'll let them know"; the office is emailed right away.
//
// Env vars (set on Render):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   — Twilio credentials
//   TWILIO_FROM                              — your Twilio number, e.g. +17185551234
//                                              (or TWILIO_MESSAGING_SERVICE_SID instead)
//   GOOGLE_REVIEW_URL                        — your Google "write a review" link
//   REVIEW_DELAY_MINUTES (optional)          — default 240 (4 hours)
//
// Until the Twilio vars are set, nothing is sent and nothing breaks.

const crypto = require('crypto');

module.exports = function ({ app, pool, requireStaffAuth, sendEmail, OFFICE_EMAILS, PUBLIC_SITE_URL, timeSlotToMinutes }) {
  const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM = process.env.TWILIO_FROM;
  const TWILIO_MSG_SERVICE = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL;
  const DELAY_MIN = Number(process.env.REVIEW_DELAY_MINUTES || 240);
  const MAX_AGE_MIN = 48 * 60; // never text about a visit older than 2 days
  const smsReady = !!(TWILIO_SID && TWILIO_TOKEN && (TWILIO_FROM || TWILIO_MSG_SERVICE));

  async function ensureTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS review_requests (
        id SERIAL PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        booking_id INTEGER,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        send_error TEXT,
        rating INTEGER,
        comment TEXT,
        rated_at TIMESTAMPTZ
      );
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS review_requests_booking_uq ON review_requests (booking_id) WHERE booking_id IS NOT NULL;`);
  }

  function toE164(raw) {
    const d = String(raw || '').replace(/\D/g, '');
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return null;
  }

  function firstName(name) {
    return String(name || '').trim().split(/\s+/)[0] || 'there';
  }

  async function sendSms(to, body) {
    const params = new URLSearchParams({ To: to, Body: body });
    if (TWILIO_MSG_SERVICE) params.set('MessagingServiceSid', TWILIO_MSG_SERVICE);
    else params.set('From', TWILIO_FROM);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twilio ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  // Creates the request row and sends the text. Returns {ok, error?}.
  async function createAndSend({ bookingId, name, phone }) {
    const e164 = toE164(phone);
    if (!e164) return { ok: false, error: 'Invalid phone number' };
    if (!smsReady) return { ok: false, error: 'Texting is not configured yet (Twilio env vars missing)' };

    const token = crypto.randomBytes(12).toString('hex');
    let row;
    try {
      const ins = await pool.query(
        `INSERT INTO review_requests (token, booking_id, name, phone) VALUES ($1, $2, $3, $4) RETURNING id`,
        [token, bookingId || null, name, e164]
      );
      row = ins.rows[0];
    } catch (err) {
      if (err.code === '23505') return { ok: false, error: 'Already requested for this booking' };
      throw err;
    }

    const link = `${PUBLIC_SITE_URL}/review.html?t=${token}`;
    const body = `Hi ${firstName(name)}, thanks for visiting Fresh Smiles Dental! How did your appointment go? Tap to rate us: ${link}  Reply STOP to opt out.`;
    try {
      await sendSms(e164, body);
      await pool.query(`UPDATE review_requests SET sent_at = NOW() WHERE id = $1`, [row.id]);
      return { ok: true };
    } catch (err) {
      await pool.query(`UPDATE review_requests SET send_error = $1 WHERE id = $2`, [err.message, row.id]);
      console.error('Review SMS failed:', err.message);
      return { ok: false, error: err.message };
    }
  }

  // Office-local "minutes since a fixed point" so date + time compare cleanly.
  function nyNowAbs() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const m = {};
    parts.forEach(p => { m[p.type] = p.value; });
    return Date.UTC(+m.year, +m.month - 1, +m.day) / 60000 + (+m.hour % 24) * 60 + +m.minute;
  }
  function apptAbs(dateStr, timeStr) {
    const [y, mo, d] = dateStr.split('-').map(Number);
    return Date.UTC(y, mo - 1, d) / 60000 + timeSlotToMinutes(timeStr);
  }

  async function runScheduler() {
    if (!smsReady) return;
    try {
      // Only patients who actually showed up (checked in) get a text — never no-shows.
      const { rows } = await pool.query(`
        SELECT b.id, b.date, b.time, b.name, b.phone FROM bookings b
        WHERE COALESCE(b.archived, FALSE) = FALSE AND COALESCE(b.cancelled, FALSE) = FALSE
          AND COALESCE(b.phone, '') <> ''
          AND b.visit_status IN ('waiting', 'in_room', 'done')
          AND b.date >= to_char((NOW() AT TIME ZONE 'America/New_York') - INTERVAL '3 days', 'YYYY-MM-DD')
          AND NOT EXISTS (SELECT 1 FROM review_requests r WHERE r.booking_id = b.id)
      `);
      const now = nyNowAbs();
      for (const b of rows) {
        const age = now - apptAbs(b.date, b.time);
        if (age >= DELAY_MIN && age <= MAX_AGE_MIN) {
          await createAndSend({ bookingId: b.id, name: b.name, phone: b.phone });
        }
      }
    } catch (err) {
      console.error('Review scheduler error:', err.message);
    }
  }

  // ---- Public endpoints (used by review.html) ----
  app.get('/api/review/:token', async (req, res) => {
    try {
      const r = await pool.query(`SELECT name, rating FROM review_requests WHERE token = $1`, [req.params.token]);
      if (!r.rows.length) return res.status(404).json({ error: 'Link not found.' });
      res.json({ firstName: firstName(r.rows[0].name), rating: r.rows[0].rating, googleUrl: GOOGLE_REVIEW_URL || null });
    } catch (err) {
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });

  app.post('/api/review/:token', async (req, res) => {
    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || '').slice(0, 1000);
    try {
      const r = await pool.query(`SELECT * FROM review_requests WHERE token = $1`, [req.params.token]);
      if (!r.rows.length) return res.status(404).json({ error: 'Link not found.' });
      const row = r.rows[0];

      // Comment added after a low rating was already recorded.
      if (!req.body.rating && comment && row.rating) {
        await pool.query(`UPDATE review_requests SET comment = $1 WHERE id = $2`, [comment, row.id]);
        if (row.rating <= 3) await notifyLow(row, row.rating, comment);
        return res.json({ ok: true });
      }

      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be 1 to 5.' });
      }
      if (row.rating) { // already rated — don't let a link be reused to change/duplicate
        return res.json({ ok: true, high: row.rating >= 4, redirect: row.rating >= 4 ? GOOGLE_REVIEW_URL || null : null });
      }
      await pool.query(`UPDATE review_requests SET rating = $1, comment = $2, rated_at = NOW() WHERE id = $3`, [rating, comment || null, row.id]);
      if (rating >= 4) return res.json({ ok: true, high: true, redirect: GOOGLE_REVIEW_URL || null });
      await notifyLow(row, rating, comment);
      res.json({ ok: true, high: false });
    } catch (err) {
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });

  async function notifyLow(row, rating, comment) {
    const esc = s => String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    await sendEmail(
      OFFICE_EMAILS,
      `${rating}-star feedback from ${row.name}`,
      `<p>A patient left a <strong>${rating}-star</strong> rating after their visit.</p>
       <p><strong>Patient:</strong> ${esc(row.name)}<br><strong>Phone:</strong> ${esc(row.phone)}<br>
       <strong>Comment:</strong> ${esc(comment) || '(none yet)'}</p>
       <p>Consider reaching out to make it right.</p>`
    );
  }

  require('./reviews-public')({ app, pool, notifyLow, GOOGLE_REVIEW_URL, crypto });   // ---- Staff endpoints ----
  app.post('/api/reviews/send', requireStaffAuth, async (req, res) => {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').trim();
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });
    try {
      const result = await createAndSend({ bookingId: null, name, phone });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/reviews', requireStaffAuth, async (req, res) => {
    try {
      const r = await pool.query(`SELECT name, phone, created_at, sent_at, send_error, rating, comment, rated_at FROM review_requests ORDER BY created_at DESC LIMIT 100`);
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/staff/reviews', requireStaffAuth, (req, res) => {
    res.type('html').send(STAFF_PAGE);
  });

  return {
    start() {
      ensureTable()
        .then(() => {
          if (!smsReady) console.warn('Review texts are off: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to enable.');
          if (!GOOGLE_REVIEW_URL) console.warn('GOOGLE_REVIEW_URL is not set: 4-5 star patients will see a thank-you instead of the Google page.');
          runScheduler();
          setInterval(runScheduler, 5 * 60 * 1000);
        })
        .catch(err => console.error('Review table setup failed:', err.message));
    }
  };
};

const STAFF_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review requests — Fresh Smiles</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#14261F}
h1{font-size:22px}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1.5px solid #DCE4DF}
button{background:#D9A441;border-color:#D9A441;font-weight:600;cursor:pointer}
form{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:14px}
td,th{text-align:left;padding:8px;border-bottom:1px solid #DCE4DF}#msg{min-height:22px;font-size:14px}</style></head><body>
<h1>Send a review text</h1>
<p>Use this for patients who booked through Ascend. Patients checked in on the dashboard get one automatically 4 hours after their appointment.</p>
<form id="f"><input id="n" placeholder="Patient name" required><input id="p" placeholder="Mobile number" required><button>Send now</button></form>
<div id="msg"></div>
<h1>Recent</h1><table><thead><tr><th>Patient</th><th>Sent</th><th>Rating</th><th>Comment</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){const r=await fetch('/api/reviews');const d=await r.json();
document.getElementById('rows').innerHTML=d.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+(x.sent_at?new Date(x.sent_at).toLocaleString():esc(x.send_error||'pending'))+'</td><td>'+(x.rating?'★'.repeat(x.rating):'—')+'</td><td>'+esc(x.comment)+'</td></tr>').join('');}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const m=document.getElementById('msg');m.textContent='Sending…';
const r=await fetch('/api/reviews/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n.value,phone:p.value})});
const j=await r.json();m.textContent=j.ok?'Sent!':'Not sent: '+j.error;if(j.ok){n.value='';p.value='';}load();};
load();
</script></body></html>`;
