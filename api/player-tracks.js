// /api/player-tracks — вкладка «Репертуар»: список песен ученика с тёмным
// плеером (раздельные дорожки «Голос»/«Музыка», метки, текст песни, заметки).
// GET    ?studentId=xxx   → список песен ученика (по дате добавления, старые сверху)
// POST   { studentId }    → создать пустую песню «Новая песня» и сразу вернуть её
// PATCH  ?id=xxx  { любые поля песни } → частично обновить
// DELETE ?id=xxx           → удалить
const { query } = require('./_db');
const { randomUUID } = require('crypto');

function rowToJson(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    title: row.title,
    artist: row.artist || '',
    key: row.song_key || '',
    status: row.status || 'work',
    startDate: row.start_date instanceof Date ? row.start_date.toISOString().slice(0, 10) : (row.start_date || ''),
    moisesLink: row.moises_link || '',
    notes: row.notes || '',
    lyrics: row.lyrics || '',
    voice: row.vocal_url ? { name: row.voice_name || '', url: row.vocal_url, durationSec: row.voice_duration_sec != null ? Number(row.voice_duration_sec) : 0 } : null,
    music: row.instrumental_url ? { name: row.music_name || '', url: row.instrumental_url, durationSec: row.music_duration_sec != null ? Number(row.music_duration_sec) : 0 } : null,
    peaks: row.peaks || [],
    markers: row.markers || [],
    volumes: row.volumes || { voice: 80, music: 80 },
    createdAt: row.created_at,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET') {
      const studentId = (req.query && req.query.studentId) || url.searchParams.get('studentId');
      if (!studentId) { res.status(400).json({ error: 'studentId required' }); return; }
      const r = await query(
        'SELECT * FROM player_tracks WHERE student_id = $1 ORDER BY created_at ASC',
        [studentId]
      );
      res.status(200).json({ songs: r.rows.map(rowToJson) });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      if (!b.studentId) { res.status(400).json({ error: 'studentId required' }); return; }
      const id = 'song' + randomUUID();
      const r = await query(
        `INSERT INTO player_tracks (id, student_id, title, status, start_date, volumes)
         VALUES ($1,$2,$3,$4, CURRENT_DATE, '{"voice":80,"music":80}')
         RETURNING *`,
        [id, b.studentId, 'Новая песня', 'work']
      );
      res.status(200).json({ song: rowToJson(r.rows[0]) });
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

      const cols = [];
      const vals = [];
      let i = 1;

      if (has('title')) { cols.push(`title = $${i++}`); vals.push(String(b.title || '').trim() || 'Без названия'); }
      if (has('artist')) { cols.push(`artist = $${i++}`); vals.push(b.artist || null); }
      if (has('key')) { cols.push(`song_key = $${i++}`); vals.push(b.key || null); }
      if (has('status')) { cols.push(`status = $${i++}`); vals.push(b.status || 'work'); }
      if (has('startDate')) { cols.push(`start_date = $${i++}`); vals.push(b.startDate || null); }
      if (has('moisesLink')) { cols.push(`moises_link = $${i++}`); vals.push(b.moisesLink || null); }
      if (has('notes')) { cols.push(`notes = $${i++}`); vals.push(b.notes || null); }
      if (has('lyrics')) { cols.push(`lyrics = $${i++}`); vals.push(b.lyrics || null); }
      if (has('markers')) { cols.push(`markers = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.markers) ? b.markers : [])); }
      if (has('peaks')) { cols.push(`peaks = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.peaks) ? b.peaks : [])); }
      if (has('volumes')) { cols.push(`volumes = $${i++}`); vals.push(JSON.stringify(b.volumes || { voice: 80, music: 80 })); }
      if (has('voice')) {
        const v = b.voice;
        cols.push(`vocal_url = $${i++}`); vals.push(v ? v.url : null);
        cols.push(`voice_name = $${i++}`); vals.push(v ? (v.name || '') : null);
        cols.push(`voice_duration_sec = $${i++}`); vals.push(v ? (v.durationSec || 0) : null);
      }
      if (has('music')) {
        const m = b.music;
        cols.push(`instrumental_url = $${i++}`); vals.push(m ? m.url : null);
        cols.push(`music_name = $${i++}`); vals.push(m ? (m.name || '') : null);
        cols.push(`music_duration_sec = $${i++}`); vals.push(m ? (m.durationSec || 0) : null);
      }

      if (!cols.length) {
        const cur = await query('SELECT * FROM player_tracks WHERE id = $1', [id]);
        if (!cur.rows[0]) { res.status(404).json({ error: 'not found' }); return; }
        res.status(200).json({ song: rowToJson(cur.rows[0]) });
        return;
      }

      cols.push(`updated_at = now()`);
      vals.push(id);
      const r = await query(`UPDATE player_tracks SET ${cols.join(', ')} WHERE id = $${i} RETURNING *`, vals);
      if (!r.rows.length) { res.status(404).json({ error: 'not found' }); return; }
      res.status(200).json({ song: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      await query('DELETE FROM player_tracks WHERE id = $1', [id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
