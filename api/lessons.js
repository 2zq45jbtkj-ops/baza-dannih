const { query } = require('./_db');

function rowToJson(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    lessonDate: row.lesson_date instanceof Date
      ? row.lesson_date.toISOString().slice(0, 10)
      : row.lesson_date,
    cvtModes: row.cvt_modes || [],
    effortLevel: row.effort_level,
    rangeWorked: row.range_worked,
    whatWorked: row.what_worked,
    whatDidnt: row.what_didnt,
    newTension: row.new_tension,
    homework: row.homework,
    mediaUrl: row.media_url,
    progressFlag: row.progress_flag,
    createdAt: row.created_at
  };
}

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET') {
      const studentId = (req.query && req.query.studentId) || url.searchParams.get('studentId');
      if (!studentId) { res.status(400).json({ error: 'studentId required' }); return; }
      const r = await query(
        'SELECT * FROM lesson_log WHERE student_id = $1 ORDER BY lesson_date DESC, id DESC',
        [studentId]
      );
      res.status(200).json({ lessons: r.rows.map(rowToJson) });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      if (!b.studentId || !b.lessonDate) {
        res.status(400).json({ error: 'studentId and lessonDate required' });
        return;
      }
      const r = await query(
        `INSERT INTO lesson_log (
           student_id, lesson_date, cvt_modes, effort_level, range_worked,
           what_worked, what_didnt, new_tension, homework, media_url, progress_flag
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          b.studentId,
          b.lessonDate,
          Array.isArray(b.cvtModes) ? b.cvtModes : [],
          b.effortLevel === undefined || b.effortLevel === null || b.effortLevel === '' ? null : Number(b.effortLevel),
          b.rangeWorked || null,
          b.whatWorked || null,
          b.whatDidnt || null,
          b.newTension || null,
          b.homework || null,
          b.mediaUrl || null,
          b.progressFlag || null
        ]
      );
      res.status(200).json({ lesson: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      await query('DELETE FROM lesson_log WHERE id = $1', [id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
