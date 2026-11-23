// reviews-public.js — star rating on the website's Reviews page.
// Loaded from reviews.js. 4-5 stars -> Google; 1-3 stars -> office is emailed.
module.exports = function ({ app, pool, notifyLow, GOOGLE_REVIEW_URL, crypto }) {
  const hits = new Map();
  app.post('/api/review-public', async (req, res) => {
    try {
      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      const now = Date.now();
      const recent = (hits.get(ip) || []).filter(t => now - t < 3600000);
      if (recent.length >= 10) return res.status(429).json({ error: 'Too many requests. Please call us at (718) 382-8000.' });
      recent.push(now);
      hits.set(ip, recent);

      const rating = Number(req.body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1 to 5.' });

      const token = crypto.randomBytes(12).toString('hex');
      const ins = await pool.query(
        `INSERT INTO review_requests (token, name, phone, rating, rated_at, sent_at) VALUES ($1, 'Website visitor', '(website)', $2, NOW(), NOW()) RETURNING *`,
        [token, rating]
      );
      if (rating >= 4) return res.json({ ok: true, high: true, redirect: GOOGLE_REVIEW_URL || null });
      await notifyLow(ins.rows[0], rating, '');
      res.json({ ok: true, high: false, token });
    } catch (err) {
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });
};
