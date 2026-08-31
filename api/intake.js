const { query } = require('./_db');

function rowToJson(row) {
  if (!row) return null;
  return {
    studentId: row.student_id,
    age: row.age,
    goal: row.goal,
    genreRefs: row.genre_refs,
    priorExperience: row.prior_experience,
    complaints: row.complaints || [],
    symptomDuration: row.symptom_duration,
    entDiagnosis: row.ent_diagnosis,
    vocalLoadJob: row.vocal_load_job,
    smoking: row.smoking,
    hydration: row.hydration,
    sleep: row.sleep,
    rangeLow: row.range_low,
    rangeHigh: row.range_high,
    tessituraComfort: row.tessitura_comfort,
    registerBreakNote: row.register_break_note,
    cvtModesStart: row.cvt_modes_start || [],
    metallicBalance: row.metallic_balance,
    laryngealPosition: row.laryngeal_position,
    tensionAreas: row.tension_areas || [],
    breathingType: row.breathing_type,
    referenceAudioUrl: row.reference_audio_url,
    updatedAt: row.updated_at
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const studentId = (req.query && req.query.studentId) || new URL(req.url, 'http://x').searchParams.get('studentId');
      if (!studentId) { res.status(400).json({ error: 'studentId required' }); return; }
      const r = await query('SELECT * FROM student_intake WHERE student_id = $1', [studentId]);
      res.status(200).json({ intake: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      if (!b.studentId) { res.status(400).json({ error: 'studentId required' }); return; }

      const params = [
        b.studentId,
        b.age === undefined || b.age === null || b.age === '' ? null : Number(b.age),
        b.goal || null,
        b.genreRefs || null,
        b.priorExperience || null,
        Array.isArray(b.complaints) ? b.complaints : [],
        b.symptomDuration || null,
        b.entDiagnosis || null,
        b.vocalLoadJob || null,
        b.smoking || null,
        b.hydration || null,
        b.sleep || null,
        b.rangeLow || null,
        b.rangeHigh || null,
        b.tessituraComfort || null,
        b.registerBreakNote || null,
        Array.isArray(b.cvtModesStart) ? b.cvtModesStart : [],
        b.metallicBalance || null,
        b.laryngealPosition || null,
        Array.isArray(b.tensionAreas) ? b.tensionAreas : [],
        b.breathingType || null,
        b.referenceAudioUrl || null
      ];

      const r = await query(
        `INSERT INTO student_intake (
           student_id, age, goal, genre_refs, prior_experience, complaints,
           symptom_duration, ent_diagnosis, vocal_load_job, smoking, hydration, sleep,
           range_low, range_high, tessitura_comfort, register_break_note, cvt_modes_start,
           metallic_balance, laryngeal_position, tension_areas, breathing_type, reference_audio_url,
           updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
         ON CONFLICT (student_id) DO UPDATE SET
           age = EXCLUDED.age, goal = EXCLUDED.goal, genre_refs = EXCLUDED.genre_refs,
           prior_experience = EXCLUDED.prior_experience, complaints = EXCLUDED.complaints,
           symptom_duration = EXCLUDED.symptom_duration, ent_diagnosis = EXCLUDED.ent_diagnosis,
           vocal_load_job = EXCLUDED.vocal_load_job, smoking = EXCLUDED.smoking,
           hydration = EXCLUDED.hydration, sleep = EXCLUDED.sleep,
           range_low = EXCLUDED.range_low, range_high = EXCLUDED.range_high,
           tessitura_comfort = EXCLUDED.tessitura_comfort, register_break_note = EXCLUDED.register_break_note,
           cvt_modes_start = EXCLUDED.cvt_modes_start, metallic_balance = EXCLUDED.metallic_balance,
           laryngeal_position = EXCLUDED.laryngeal_position, tension_areas = EXCLUDED.tension_areas,
           breathing_type = EXCLUDED.breathing_type, reference_audio_url = EXCLUDED.reference_audio_url,
           updated_at = now()
         RETURNING *`,
        params
      );
      res.status(200).json({ intake: rowToJson(r.rows[0]) });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
