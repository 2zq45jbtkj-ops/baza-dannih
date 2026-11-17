// Проверка двух ключей администратора для Telegram Mini App.
// POST /api/admin-auth  { key1, key2 }
// → 200 { ok: true, token }  или  401 { error: 'unauthorized' }
// Ключи хранятся в env vars ADMIN_KEY_1, ADMIN_KEY_2 — в коде фронтенда их нет.
//
// token — тот же токен преподавателя, что выдаёт site-login.js по паролю от
// сайта (api/_auth.js): обе пары «ключи» и «пароль» подтверждают одно и то
// же — что это Николай. Mini App в «Режиме админа» присылает его в
// X-Site-Auth, когда читает /api/students.
const auth = require('./_auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', auth.CORS_HEADERS);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }

  const { key1, key2 } = body || {};

  const K1 = process.env.ADMIN_KEY_1;
  const K2 = process.env.ADMIN_KEY_2;

  if ((!K1 || !K2) && !(body && body.linkToken)) {
    res.status(503).json({ error: 'admin keys not configured' });
    return;
  }

  // Timing-safe comparison — не даёт угадать ключ по времени ответа
  function safeEq(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  // Показ ключей в карточке админа на сайте.
  // Отдаём их только тому, кто прямо сейчас ввёл пароль от сайта: серверной
  // сессии у сайта нет (site-login.js просто отвечает ok, а браузер хранит в
  // localStorage только дату входа), поэтому проверить «он уже залогинен»
  // нечем. Без этой проверки GET-ручка раздавала бы ключи кому угодно.
  if (body && body.action === 'reveal') {
    const SITE_PASSWORD = process.env.SITE_PASSWORD;
    if (!SITE_PASSWORD) {
      res.status(503).json({ error: 'site password not configured' });
      return;
    }
    const crypto = require('crypto');
    const sign = ts => crypto.createHmac('sha256', SITE_PASSWORD).update('reveal:' + ts).digest('hex');
    // Токен из site-login: "ts.hmac", валиден 30 дней — пароль не нужен
    let tokenOk = false;
    if (typeof body.token === 'string' && body.token.includes('.')) {
      const [ts, sig] = body.token.split('.');
      const age = Date.now() - parseInt(ts, 10);
      tokenOk = age >= 0 && age < 30 * 24 * 3600 * 1000 && safeEq(sig, sign(ts));
    }
    if (!tokenOk && !safeEq(body.password, SITE_PASSWORD)) {
      await new Promise(r => setTimeout(r, 400));
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const nts = String(Date.now());
    res.status(200).json({ ok: true, key1: K1, key2: K2, revealToken: tokenOk ? body.token : nts + '.' + sign(nts) });
    return;
  }

  // Вход Николая без ключей: личная ссылка (?k=<telegram_token>) его СОБСТВЕННОЙ
  // карточки «Nikolai Sept» / «Николай Септ». Он сам попросил не спрашивать у
  // него ключи в приложении. Ссылку бот выдаёт только ему; карточку с таким
  // именем заводит только он сам. Код любого другого ученика здесь отказ.
  if (body && typeof body.linkToken === 'string') {
    const tok = body.linkToken.trim().toLowerCase();
    let ok = false;
    if (/^[0-9a-f-]{36}$/.test(tok)) {
      const { query } = require('./_db');
      const r = await query('SELECT name FROM students WHERE telegram_token = $1', [tok]);
      const n = String((r.rows[0] && r.rows[0].name) || '').toLowerCase();
      ok = (n.includes('sept') && n.includes('nikola')) || (n.includes('септ') && n.includes('никола'));
    }
    if (ok) { res.status(200).json({ ok: true, token: auth.teacherToken() }); return; }
    await new Promise(r => setTimeout(r, 300));
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  if (safeEq(key1, K1) && safeEq(key2, K2)) {
    res.status(200).json({ ok: true, token: auth.teacherToken() });
  } else {
    // Одинаковая задержка чтобы нельзя было угадать какой ключ неверный
    await new Promise(r => setTimeout(r, 300));
    res.status(401).json({ error: 'unauthorized' });
  }
};
