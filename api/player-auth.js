// POST /api/player-auth { code } → { ok: true, studentId, name } или 401
// Проверяет код доступа ученика (тот же код, что открывает Telegram-бота с ДЗ —
// столбец students.telegram_token). Один код на все приложения ученика:
// стоит преподавателю нажать «↻ Новый код» в кабинете — старый код сразу
// перестаёт пускать и сюда тоже, доступ вернётся только с новым кодом.
const { query } = require('./_db');

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

  const code = ((body && body.code) || '').trim();

  try {
    if (!code) {
      res.status(400).json({ error: 'code required' });
      return;
    }

    const r = await query('SELECT id, name FROM students WHERE telegram_token = $1', [code]);
    if (!r.rows.length) {
      // Такая же искусственная задержка, как в site-login.js/admin-auth.js —
      // не даёт угадать код по времени ответа.
      await new Promise(resolve => setTimeout(resolve, 400));
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const student = r.rows[0];
    res.status(200).json({ ok: true, studentId: student.id, name: student.name });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
