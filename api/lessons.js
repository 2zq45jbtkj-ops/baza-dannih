const { query } = require('./_db');

function rowToJson(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    lessonDate: row.lesson_date instanceof Date
      ? row.lesson_date.toISOString().slice(0, 10)
      : row.lesson_date,
    topic: row.topic,
    workLow: row.work_low,
    workHigh: row.work_high,
    goal: row.goal,
    structures: row.structures || [],
    intensity: row.intensity,
    grade: row.grade,
    cvtModes: row.cvt_modes || [],
    anchors: row.anchors || [],
    newProblem: row.new_problem,
    hw: row.homework,
    takes: row.takes || [],
    // Legacy fields from the old (unused, improvised) Дневник занятий UI —
    // kept for backward compatibility, not written to by the current form.
    effortLevel: row.effort_level,
    rangeWorked: row.range_worked,
    whatWorked: row.what_worked,
    whatDidnt: row.what_didnt,
    newTension: row.new_tension,
    mediaUrl: row.media_url,
    progressFlag: row.progress_flag,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
           student_id, lesson_date, topic, work_low, work_high, goal,
           structures, intensity, grade, cvt_modes, anchors, new_problem,
           homework, takes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          b.studentId,
          b.lessonDate,
          b.topic || null,
          b.workLow || null,
          b.workHigh || null,
          b.goal || null,
          Array.isArray(b.structures) ? b.structures : [],
          b.intensity === undefined || b.intensity === null || b.intensity === '' ? null : Number(b.intensity),
          b.grade === undefined || b.grade === null || b.grade === '' ? null : Number(b.grade),
          Array.isArray(b.cvtModes) ? b.cvtModes : [],
          Array.isArray(b.anchors) ? b.anchors : [],
          b.newProblem || null,
          b.hw || null,
          JSON.stringify(Array.isArray(b.takes) ? b.takes : [])
        ]
      );
      res.status(200).json({ lesson: rowToJson(r.rows[0]) });
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

      const cols = [];
      const vals = [];
      let i = 1;

      if (Object.prototype.hasOwnProperty.call(b, 'lessonDate')) { cols.push(`lesson_date = $${i++}`); vals.push(b.lessonDate); }
      if (Object.prototype.hasOwnProperty.call(b, 'topic')) { cols.push(`topic = $${i++}`); vals.push(b.topic || null); }
      if (Object.prototype.hasOwnProperty.call(b, 'workLow')) { cols.push(`work_low = $${i++}`); vals.push(b.workLow || null); }
      if (Object.prototype.hasOwnProperty.call(b, 'workHigh')) { cols.push(`work_high = $${i++}`); vals.push(b.workHigh || null); }
      if (Object.prototype.hasOwnProperty.call(b, 'goal')) { cols.push(`goal = $${i++}`); vals.push(b.goal || null); }
      if (Object.prototype.hasOwnProperty.call(b, 'structures')) { cols.push(`structures = $${i++}`); vals.push(Array.isArray(b.structures) ? b.structures : []); }
      if (Object.prototype.hasOwnProperty.call(b, 'intensity')) { cols.push(`intensity = $${i++}`); vals.push(b.intensity === null || b.intensity === '' ? null : Number(b.intensity)); }
      if (Object.prototype.hasOwnProperty.call(b, 'grade')) { cols.push(`grade = $${i++}`); vals.push(b.grade === null || b.grade === '' ? null : Number(b.grade)); }
      if (Object.prototype.hasOwnProperty.call(b, 'cvtModes')) { cols.push(`cvt_modes = $${i++}`); vals.push(Array.isArray(b.cvtModes) ? b.cvtModes : []); }
      if (Object.prototype.hasOwnProperty.call(b, 'anchors')) { cols.push(`anchors = $${i++}`); vals.push(Array.isArray(b.anchors) ? b.anchors : []); }
      if (Object.prototype.hasOwnProperty.call(b, 'newProblem')) { cols.push(`new_problem = $${i++}`); vals.push(b.newProblem || null); }
      if (Object.prototype.hasOwnProperty.call(b, 'hw')) { cols.push(`homework = $${i++}`); vals.push(b.hw || null); }
      if (Object.prototype.hasOwnProperty.call(b, 'takes')) { cols.push(`takes = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.takes) ? b.takes : [])); }

      if (!cols.length) {
        const cur = await query('SELECT * FROM lesson_log WHERE id = $1', [id]);
        if (!cur.rows[0]) { res.status(404).json({ error: 'not found' }); return; }
        res.status(200).json({ lesson: rowToJson(cur.rows[0]) });
        return;
      }

      cols.push(`updated_at = now()`);
      vals.push(id);
      const r = await query(
        `UPDATE lesson_log SET ${cols.join(', ')} WHERE id = $${i} RETURNING *`,
        vals
      );
      if (!r.rows[0]) { res.status(404).json({ error: 'not found' }); return; }
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
