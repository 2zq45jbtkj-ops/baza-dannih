// Публичный endpoint для Telegram Mini App.
// GET /api/student-public?token=UUID — возвращает данные ученика по токену.
// Не требует авторизации, но токен — UUID (122 бита энтропии), подобрать нереально.
const { query } = require('./_db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const token = (req.query && req.query.token) || new URL(req.url, 'http://x').searchParams.get('token');
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    res.status(400).json({ error: 'invalid token' });
    return;
  }

  // Mini App шлёт сюда свой Telegram chat_id при открытии (Telegram.WebApp.
  // initDataUnsafe.user.id) — так бот потом может написать ученику первым,
  // без того чтобы ученик сначала написал боту сам. См. api/lessons.js —
  // используется при отправке домашнего задания.
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const chatId = body && body.chatId;
      if (!chatId) { res.status(400).json({ error: 'chatId required' }); return; }
      await query('UPDATE students SET telegram_chat_id = $1 WHERE telegram_token = $2', [String(chatId), token]);
      res.status(200).json({ ok: true });
    } catch (err) {
      const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
      res.status(status).json({ error: err.message || String(err) });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {

    // Ученик по токену
    const sr = await query('SELECT * FROM students WHERE telegram_token = $1', [token]);
    if (!sr.rows.length) {
      res.status(404).json({ error: 'student not found' });
      return;
    }
    const student = sr.rows[0];

    // Intake (Кабинет)
    const ir = await query('SELECT * FROM student_intake WHERE student_id = $1', [student.id]);
    const intake = ir.rows[0] || null;

    // Домашнее задание — из всех записей дневника, у которых hw_items не пуст
    // Отдаём только hw_items со статусом не "выполнено" + те, где дедлайн ещё не истёк
    // Сортируем: ближайший дедлайн сначала
    const lr = await query(
      `SELECT lesson_date, hw_items FROM lesson_log
       WHERE student_id = $1
         AND hw_items IS NOT NULL
         AND jsonb_array_length(hw_items) > 0
       ORDER BY lesson_date DESC
       LIMIT 20`,
      [student.id]
    );

    // Собираем все ДЗ-задания, убираем дубли по title+due
    const hwAll = [];
    const seen = new Set();
    for (const row of lr.rows) {
      const items = Array.isArray(row.hw_items) ? row.hw_items : [];
      for (const item of items) {
        const key = `${item.title}|${item.due}`;
        if (!seen.has(key)) {
          seen.add(key);
          hwAll.push({ ...item, lessonDate: row.lesson_date });
        }
      }
    }
    // Сортируем по дедлайну (ближайший сначала)
    hwAll.sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : 1);

    // Записи с уроков — самая первая и самая последняя по дате
    const recFirst = await query(
      `SELECT lesson_date, takes FROM lesson_log
       WHERE student_id = $1 AND takes IS NOT NULL AND jsonb_array_length(takes) > 0
       ORDER BY lesson_date ASC LIMIT 1`,
      [student.id]
    );
    const recLast = await query(
      `SELECT lesson_date, takes FROM lesson_log
       WHERE student_id = $1 AND takes IS NOT NULL AND jsonb_array_length(takes) > 0
       ORDER BY lesson_date DESC LIMIT 1`,
      [student.id]
    );

    res.status(200).json({
      student: {
        name: student.name,
        status: student.status,
        schedule: student.schedule || null,
      },
      intake: intake ? {
        voiceType: intake.voice_type,
        genre: intake.genre,
        genres: intake.genres || [],
        goals: intake.goals || [],
        experienceLevel: intake.experience_level,
        rangeLow: intake.range_low,
        rangeHigh: intake.range_high,
        tessLow: intake.tess_low,
        tessHigh: intake.tess_high,
        registerBreakLow: intake.register_break_low,
        registerBreakHigh: intake.register_break_high,
        larStatus: intake.lar_status,
        diagnosis: intake.diagnosis,
        breathingType: intake.breathing_type,
        laryngealPosition: intake.laryngeal_position,
        tensionAreas: intake.tension_areas || [],
        metallicPercent: intake.metallic_percent,
        repertoire: intake.repertoire,
        articulatory: intake.articulatory || [],
      } : null,
      homework: hwAll,
      recordings: {
        first: recFirst.rows[0] ? {
          date: recFirst.rows[0].lesson_date,
          takes: recFirst.rows[0].takes,
        } : null,
        last: recLast.rows[0] ? {
          date: recLast.rows[0].lesson_date,
          takes: recLast.rows[0].takes,
        } : null,
      },
    });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
