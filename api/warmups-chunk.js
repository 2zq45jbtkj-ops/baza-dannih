// /api/warmups-chunk — приём большого аудио распевки маленькими кусками
// в обход лимита размера тела запроса serverless-функций (~4.5 МБ,
// HTTP 413 при обычном PATCH /api/warmups с base64 целиком). Файл
// режется на клиенте на куски по ~2 МБ, каждый кусок летит отдельным
// лёгким запросом и складывается построчно во временную таблицу. На
// последнем шаге (finalize) сервер сам, одним SQL-запросом, склеивает
// все куски и дописывает готовую data: URL в audios нужной распевки —
// собранная строка никогда не идёт обратно через тело запроса.
// POST { action:'chunk',    uploadId, chunkIndex, totalChunks, data }
// POST { action:'finalize', uploadId, totalChunks, warmupId, mimeType, name, durationSec }
// POST { action:'abort',    uploadId }
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }
  const b = body || {};

  try {
    // Лёгкая уборка брошенных загрузок (вкладку закрыли посередине и т.п.)
    query(`DELETE FROM warmup_upload_chunks WHERE created_at < now() - interval '1 day'`, []).catch(() => {});

    if (b.action === 'chunk') {
      if (!b.uploadId || b.chunkIndex == null || typeof b.data !== 'string') {
        res.status(400).json({ error: 'uploadId, chunkIndex, data required' });
        return;
      }
      await query(
        `INSERT INTO warmup_upload_chunks (upload_id, chunk_index, chunk_data)
         VALUES ($1,$2,$3)
         ON CONFLICT (upload_id, chunk_index) DO UPDATE SET chunk_data = EXCLUDED.chunk_data`,
        [b.uploadId, b.chunkIndex, b.data]
      );
      res.status(200).json({ ok: true });
      return;
    }

    if (b.action === 'finalize') {
      if (!b.uploadId || !b.warmupId || !b.totalChunks) {
        res.status(400).json({ error: 'uploadId, warmupId, totalChunks required' });
        return;
      }
      const r = await query(
        'SELECT chunk_index, chunk_data FROM warmup_upload_chunks WHERE upload_id = $1 ORDER BY chunk_index ASC',
        [b.uploadId]
      );
      if (r.rows.length !== Number(b.totalChunks)) {
        res.status(409).json({ error: 'получено кусков ' + r.rows.length + ' из ' + b.totalChunks + ' — попробуйте загрузить заново' });
        return;
      }
      const base64 = r.rows.map(row => row.chunk_data).join('');
      const mime = b.mimeType || 'audio/mpeg';
      const dataUrl = 'data:' + mime + ';base64,' + base64;

      const exR = await query('SELECT audios FROM warmups WHERE id = $1', [b.warmupId]);
      if (!exR.rows.length) { res.status(404).json({ error: 'warmup not found' }); return; }
      const audios = exR.rows[0].audios || [];
      const newAudio = {
        id: 'wa' + randomUUID(),
        name: b.name || 'Запись',
        dataUrl,
        durationSec: b.durationSec || 0,
        bpm: 90,
        key: 'C',
        starred: false,
        peaks: []
      };
      const upd = await query(
        'UPDATE warmups SET audios = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [JSON.stringify(audios.concat([newAudio])), b.warmupId]
      );
      await query('DELETE FROM warmup_upload_chunks WHERE upload_id = $1', [b.uploadId]);
      res.status(200).json({ warmup: rowToJson(upd.rows[0]) });
      return;
    }

    if (b.action === 'abort') {
      if (b.uploadId) await query('DELETE FROM warmup_upload_chunks WHERE upload_id = $1', [b.uploadId]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
