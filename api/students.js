const { query } = require('./_db');
const { randomUUID } = require('crypto');

function rowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    schedule: row.schedule,
    scheduleFormat: row.schedule_format,
    trialNote: row.trial_note,
    packageSize: row.package_size,
    packageStartDate: row.package_start_date,
    telegramToken: row.telegram_token || null,
    createdAt: row.created_at
  };
}

// Telegram Mini App («Режим админа» → выбор ученика) живёт на другом домене,
// поэтому без этих заголовков браузер резал запрос ещё до ответа, фронт падал
// в catch и показывал пустой список — выглядело как «учеников нет».
// Origin указан точечно, а не '*': эндпоинт отдаёт всех учеников целиком.
const ALLOWED_ORIGINS = ['https://your-vocal.vercel.app'];
// Локальные превью-серверы поднимаются на случайном свободном порту.
const LOCAL_ORIGIN = /^http:\/\/localhost:\d+$/;

module.exports = async (req, res) => {
  const origin = req.headers && req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.indexOf(origin) !== -1 || LOCAL_ORIGIN.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method === 'GET') {
      const r = await query('SELECT * FROM students ORDER BY created_at ASC, id ASC', []);
      res.status(200).json({ students: r.rows.map(rowToJson) });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      if (!b.name || !String(b.name).trim()) {
        res.status(400).json({ error: 'name required' });
        return;
      }
      const id = b.id || ('s' + Date.now() + Math.floor(Math.random() * 1000));
      const status = b.status || 'trial';
      const token = randomUUID();
      const r = await query(
        'INSERT INTO students (id, name, status, telegram_token) VALUES ($1,$2,$3,$4) RETURNING *',
        [id, String(b.name).trim(), status, token]
      );
      res.status(200).json({ student: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const url = new URL(req.url, 'http://x');
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      const sets = [];
      const values = [];
      let i = 1;
      if (b.name !== undefined && String(b.name).trim()) { sets.push(`name = $${i++}`); values.push(String(b.name).trim()); }
      if (b.status !== undefined) { sets.push(`status = $${i++}`); values.push(b.status); }
      if (b.schedule !== undefined) { sets.push(`schedule = $${i++}`); values.push(b.schedule); }
      if (b.scheduleFormat !== undefined) { sets.push(`schedule_format = $${i++}`); values.push(b.scheduleFormat || null); }
      if (b.trialNote !== undefined) { sets.push(`trial_note = $${i++}`); values.push(b.trialNote || null); }
      if (b.packageSize !== undefined) { sets.push(`package_size = $${i++}`); values.push(b.packageSize === null || b.packageSize === '' ? null : Number(b.packageSize)); }
      if (b.packageStartDate !== undefined) { sets.push(`package_start_date = $${i++}`); values.push(b.packageStartDate || null); }
      // regenerateToken: true → выдаём новый UUID (старый перестаёт работать в боте)
      if (b.regenerateToken) { sets.push(`telegram_token = $${i++}`); values.push(randomUUID()); }
      if (!sets.length) { res.status(400).json({ error: 'nothing to update' }); return; }
      values.push(id);
      const r = await query(`UPDATE students SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
      if (!r.rows.length) { res.status(404).json({ error: 'not found' }); return; }
      res.status(200).json({ student: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x');
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      await query('DELETE FROM students WHERE id = $1', [id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
