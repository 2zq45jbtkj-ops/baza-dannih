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

    // Кабинет — аккордеон анкеты (7 секций)
    voiceType: row.voice_type,
    genre: row.genre,
    experienceLevel: row.experience_level,
    stuckNote: row.stuck_note,
    tessLow: row.tess_low,
    tessHigh: row.tess_high,
    registerBreakLow: row.register_break_low,
    registerBreakHigh: row.register_break_high,
    baselineRangeLow: row.baseline_range_low,
    baselineRangeHigh: row.baseline_range_high,
    baselineTessLow: row.baseline_tess_low,
    baselineTessHigh: row.baseline_tess_high,
    baselineRegisterBreak: row.baseline_register_break,
    larStatus: row.lar_status,
    diagnosis: row.diagnosis,
    alcohol: row.alcohol,
    pmsFactor: row.pms_factor,
    structures: row.structures || {},
    qualities: row.qualities || {},
    modes: row.modes || {},
    anchors: row.anchors || {},
    metallicPercent: row.metallic_percent === null || row.metallic_percent === undefined ? 32 : row.metallic_percent,
    referenceTakes: row.reference_takes || [],

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

      // Порядок 1:1 совпадает с колонками INSERT ниже — $1..$45
      const params = [
        /* 1  */ b.studentId,
        /* 2  */ b.age === undefined || b.age === null || b.age === '' ? null : Number(b.age),
        /* 3  */ b.goal || null,
        /* 4  */ b.genreRefs || null,
        /* 5  */ b.priorExperience || null,
        /* 6  */ Array.isArray(b.complaints) ? b.complaints : [],
        /* 7  */ b.symptomDuration || null,
        /* 8  */ b.entDiagnosis || null,
        /* 9  */ b.vocalLoadJob || null,
        /* 10 */ b.smoking || null,
        /* 11 */ b.hydration || null,
        /* 12 */ b.sleep || null,
        /* 13 */ b.rangeLow || null,
        /* 14 */ b.rangeHigh || null,
        /* 15 */ b.tessituraComfort || null,
        /* 16 */ b.registerBreakNote || null,
        /* 17 */ Array.isArray(b.cvtModesStart) ? b.cvtModesStart : [],
        /* 18 */ b.metallicBalance || null,
        /* 19 */ b.laryngealPosition || null,
        /* 20 */ Array.isArray(b.tensionAreas) ? b.tensionAreas : [],
        /* 21 */ b.breathingType || null,
        /* 22 */ b.referenceAudioUrl || null,
        /* 23 */ b.voiceType || null,
        /* 24 */ b.genre || null,
        /* 25 */ b.experienceLevel || null,
        /* 26 */ b.stuckNote || null,
        /* 27 */ b.tessLow || null,
        /* 28 */ b.tessHigh || null,
        /* 29 */ b.registerBreakLow || null,
        /* 30 */ b.registerBreakHigh || null,
        /* 31 */ b.rangeLow || null,          // baseline_range_low candidate
        /* 32 */ b.rangeHigh || null,         // baseline_range_high candidate
        /* 33 */ b.tessLow || null,           // baseline_tess_low candidate
        /* 34 */ b.tessHigh || null,          // baseline_tess_high candidate
        /* 35 */ b.registerBreakLow || null,  // baseline_register_break candidate
        /* 36 */ b.larStatus || null,
        /* 37 */ b.diagnosis || null,
        /* 38 */ b.alcohol || null,
        /* 39 */ b.pmsFactor || null,
        /* 40 */ JSON.stringify(b.structures && typeof b.structures === 'object' ? b.structures : {}),
        /* 41 */ JSON.stringify(b.qualities && typeof b.qualities === 'object' ? b.qualities : {}),
        /* 42 */ JSON.stringify(b.modes && typeof b.modes === 'object' ? b.modes : {}),
        /* 43 */ JSON.stringify(b.anchors && typeof b.anchors === 'object' ? b.anchors : {}),
        /* 44 */ b.metallicPercent === undefined || b.metallicPercent === null || b.metallicPercent === '' ? 32 : Number(b.metallicPercent),
        /* 45 */ JSON.stringify(Array.isArray(b.referenceTakes) ? b.referenceTakes : [])
      ];

      const r = await query(
        `INSERT INTO student_intake (
           student_id, age, goal, genre_refs, prior_experience, complaints,
           symptom_duration, ent_diagnosis, vocal_load_job, smoking, hydration, sleep,
           range_low, range_high, tessitura_comfort, register_break_note, cvt_modes_start,
           metallic_balance, laryngeal_position, tension_areas, breathing_type, reference_audio_url,
           voice_type, genre, experience_level, stuck_note, tess_low, tess_high,
           register_break_low, register_break_high,
           baseline_range_low, baseline_range_high, baseline_tess_low, baseline_tess_high, baseline_register_break,
           lar_status, diagnosis, alcohol, pms_factor,
           structures, qualities, modes, anchors, metallic_percent, reference_takes,
           updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
           $23,$24,$25,$26,$27,$28,$29,$30,
           $31,$32,$33,$34,$35,
           $36,$37,$38,$39,
           $40,$41,$42,$43,$44,$45,
           now()
         )
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
           voice_type = EXCLUDED.voice_type, genre = EXCLUDED.genre, experience_level = EXCLUDED.experience_level,
           stuck_note = EXCLUDED.stuck_note, tess_low = EXCLUDED.tess_low, tess_high = EXCLUDED.tess_high,
           register_break_low = EXCLUDED.register_break_low, register_break_high = EXCLUDED.register_break_high,
           baseline_range_low = COALESCE(student_intake.baseline_range_low, EXCLUDED.baseline_range_low),
           baseline_range_high = COALESCE(student_intake.baseline_range_high, EXCLUDED.baseline_range_high),
           baseline_tess_low = COALESCE(student_intake.baseline_tess_low, EXCLUDED.baseline_tess_low),
           baseline_tess_high = COALESCE(student_intake.baseline_tess_high, EXCLUDED.baseline_tess_high),
           baseline_register_break = COALESCE(student_intake.baseline_register_break, EXCLUDED.baseline_register_break),
           lar_status = EXCLUDED.lar_status, diagnosis = EXCLUDED.diagnosis,
           alcohol = EXCLUDED.alcohol, pms_factor = EXCLUDED.pms_factor,
           structures = EXCLUDED.structures, qualities = EXCLUDED.qualities,
           modes = EXCLUDED.modes, anchors = EXCLUDED.anchors,
           metallic_percent = EXCLUDED.metallic_percent, reference_takes = EXCLUDED.reference_takes,
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
