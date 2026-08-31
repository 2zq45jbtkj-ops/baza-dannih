const { query } = require('./_db');

// Справочники: общий (не привязанный к ученику) список "закреплено в основных
// / добавлено вручную" для полей типа "Цель обучения" и "Жанр" в Кабинете.
// Встроенный ("core") список вариантов всегда живёт в коде фронтенда — здесь
// хранится только то, что накопил преподаватель поверх него.

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const r = await query('SELECT * FROM field_dicts', []);
      const dicts = {};
      r.rows.forEach(row => {
        dicts[row.field_key] = { pinned: row.pinned || [], added: row.added || [] };
      });
      res.status(200).json({ dicts });
      return;
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      if (!b.fieldKey) { res.status(400).json({ error: 'fieldKey required' }); return; }

      const r = await query(
        `INSERT INTO field_dicts (field_key, pinned, added, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (field_key) DO UPDATE SET
           pinned = EXCLUDED.pinned, added = EXCLUDED.added, updated_at = now()
         RETURNING *`,
        [
          b.fieldKey,
          Array.isArray(b.pinned) ? b.pinned : [],
          Array.isArray(b.added) ? b.added : []
        ]
      );
      const row = r.rows[0];
      res.status(200).json({ dict: { fieldKey: row.field_key, pinned: row.pinned || [], added: row.added || [] } });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
