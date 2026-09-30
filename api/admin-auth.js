// Проверка двух ключей администратора для Telegram Mini App.
// POST /api/admin-auth  { key1, key2 }
// → 200 { ok: true }  или  401 { error: 'unauthorized' }
// Ключи хранятся в env vars ADMIN_KEY_1, ADMIN_KEY_2 — в коде фронтенда их нет.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  if (!K1 || !K2) {
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

  if (safeEq(key1, K1) && safeEq(key2, K2)) {
    res.status(200).json({ ok: true });
  } else {
    // Одинаковая задержка чтобы нельзя было угадать какой ключ неверный
    await new Promise(r => setTimeout(r, 300));
    res.status(401).json({ error: 'unauthorized' });
  }
};
