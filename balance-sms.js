// Texts a patient their "pay your balance" link via Twilio.
// Returns true if the text was sent (so the caller skips the email),
// false if it could not be sent (no valid phone, Twilio not configured, or
// Twilio refused) so the caller falls back to the email.
//
// Uses the same env vars as the review texts:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (or TWILIO_MESSAGING_SERVICE_SID)
// Optional: BALANCE_TEXTS=off turns balance texting off without a code change.

function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

module.exports = async function sendBalanceText(invoice, publicSiteUrl, formatMoney) {
  try {
    if (String(process.env.BALANCE_TEXTS || '').toLowerCase() === 'off') return false;
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    const svc = process.env.TWILIO_MESSAGING_SERVICE_SID;
    if (!(sid && token && (from || svc))) return false;

    const to = toE164(invoice.phone);
    if (!to) return false;

    const first = String(invoice.name || '').trim().split(/\s+/)[0] || 'there';
    const link = `${publicSiteUrl}/billing.html?invoice=${encodeURIComponent(invoice.id)}`;
    const body =
      `Hi ${first}, a balance of ${formatMoney(invoice.amount)} is ready at Fresh Smiles Dental. ` +
      `Pay here: ${link}  Invoice code: ${invoice.id}. Reply STOP to opt out.`;

    const params = new URLSearchParams({ To: to, Body: body });
    if (svc) params.set('MessagingServiceSid', svc);
    else params.set('From', from);

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`Balance text failed (${res.status}): ${text.slice(0, 200)} — falling back to email.`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Balance text error, falling back to email:', err.message);
    return false;
  }
};
