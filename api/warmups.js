// /api/warmups — вкладка «Распевки»: общая библиотека разогревочных
// упражнений для ВСЕХ учеников (не привязана к studentId), по уровням A–D.
// GET    → весь список (все уровни), отсортирован по level, sort_order
// POST   { level }                → создать пустую «Новую распевку» в конце уровня
// PATCH  ?id=xxx  { title?, topics?, audios?, sortOrder? } → частично обновить
//   (audios — полная замена массива: используется только для операций,
//   которые САМИ не содержат больших data: URL, например переупорядочивание)
// PATCH  ?id=xxx  { audioPatch: {id, set} } → точечно обновить одно аудио
//   внутри audios (имя/пики/темп/тональность/избранное) SQL-джойном,
//   не пересылая через тело запроса остальные (или это же) аудио —
//   иначе лёгкое действие вроде пересчёта волны после загрузки упиралось
//   бы в тот же лимит размера тела запроса, что и сама загрузка файла.
// PATCH  ?id=xxx  { removeAudioId: id } → удалить одно аудио тем же приёмом
// DELETE ?id=xxx                  → удалить распевку
const { query } = require('./_db');
const { randomUUID } = require('crypto');

function rowToJson(row) {
  return {
    id: row.id,
    level: row.level,
    title: row.title,
    topics: row.topics || [],
    sortOrder: row.sort_order,
    audios: row.audios || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET') {
      const r = await query('SELECT * FROM warmups ORDER BY level ASC, sort_order ASC, created_at ASC', []);
      res.status(200).json({ warmups: r.rows.map(rowToJson) });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      if (!b.level) { res.status(400).json({ error: 'level required' }); return; }
      const id = 'wu' + randomUUID();
      const maxR = await query('SELECT COALESCE(MAX(sort_order), -1) AS m FROM warmups WHERE level = $1', [b.level]);
      const nextOrder = Number(maxR.rows[0].m) + 1;
      const r = await query(
        `INSERT INTO warmups (id, level, title, topics, sort_order, audios)
         VALUES ($1,$2,$3,$4,$5,'[]') RETURNING *`,
        [id, b.level, 'Новая распевка', Array.isArray(b.topics) ? b.topics : [], nextOrder]
      );
      res.status(200).json({ warmup: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'PATCH') {
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      const has = k => Object.prototype.hasOwnProperty.call(b, k);

      if (has('audioPatch') && b.audioPatch && b.audioPatch.id && b.audioPatch.set && typeof b.audioPatch.set === 'object') {
        const r2 = await query(
          `UPDATE warmups SET audios = (
             SELECT COALESCE(jsonb_agg(
               CASE WHEN elem->>'id' = $1 THEN elem || $2::jsonb ELSE elem END
             ), '[]'::jsonb)
             FROM jsonb_array_elements(COALESCE(audios, '[]'::jsonb)) elem
           ), updated_at = now()
           WHERE id = $3
           RETURNING *`,
          [b.audioPatch.id, JSON.stringify(b.audioPatch.set), id]
        );
        if (!r2.rows.length) { res.status(404).json({ error: 'not found' }); return; }
        res.status(200).json({ warmup: rowToJson(r2.rows[0]) });
        return;
      }

      if (has('removeAudioId')) {
        const r2 = await query(
          `UPDATE warmups SET audios = (
             SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
             FROM jsonb_array_elements(COALESCE(audios, '[]'::jsonb)) elem
             WHERE elem->>'id' != $1
           ), updated_at = now()
           WHERE id = $2
           RETURNING *`,
          [b.removeAudioId, id]
        );
        if (!r2.rows.length) { res.status(404).json({ error: 'not found' }); return; }
        res.status(200).json({ warmup: rowToJson(r2.rows[0]) });
        return;
      }

      const cols = [];
      const vals = [];
      let i = 1;

      if (has('title')) { cols.push(`title = $${i++}`); vals.push(String(b.title || '').trim() || 'Новая распевка'); }
      if (has('topics')) { cols.push(`topics = $${i++}`); vals.push(Array.isArray(b.topics) ? b.topics : []); }
      if (has('audios')) { cols.push(`audios = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.audios) ? b.audios : [])); }
      if (has('sortOrder')) { cols.push(`sort_order = $${i++}`); vals.push(Number(b.sortOrder) || 0); }

      if (!cols.length) {
        const cur = await query('SELECT * FROM warmups WHERE id = $1', [id]);
        if (!cur.rows[0]) { res.status(404).json({ error: 'not found' }); return; }
        res.status(200).json({ warmup: rowToJson(cur.rows[0]) });
        return;
      }

      cols.push(`updated_at = now()`);
      vals.push(id);
      const r = await query(`UPDATE warmups SET ${cols.join(', ')} WHERE id = $${i} RETURNING *`, vals);
      if (!r.rows.length) { res.status(404).json({ error: 'not found' }); return; }
      res.status(200).json({ warmup: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      await query('DELETE FROM warmups WHERE id = $1', [id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
