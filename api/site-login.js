// POST /api/site-login { password } → { ok: true } или 401
// Проверяет пароль от сайта (env var SITE_PASSWORD). Не затрагивает /api/student-public и другие публичные эндпоинты.
module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }

  const { password } = body || {};
  const SITE_PASSWORD = process.env.SITE_PASSWORD;

  if (!SITE_PASSWORD) { res.status(503).json({ error: 'password not configured' }); return; }

  function safeEq(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  if (safeEq(password, SITE_PASSWORD)) {
    // Подписанный токен для показа двойного кода без повторного ввода пароля
    // (проверяется в admin-auth.js, живёт 30 дней как и сессия сайта).
    const crypto = require('crypto');
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', SITE_PASSWORD).update('reveal:' + ts).digest('hex');
    res.status(200).json({ ok: true, revealToken: ts + '.' + sig });
  } else {
    await new Promise(r => setTimeout(r, 400));
    res.status(401).json({ error: 'unauthorized' });
  }
};
