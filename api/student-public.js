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
      // Отметка шага урока из Mini App — раньше это был api/notion-progress.js.
      // Галочка только ставится и никогда не снимается, как было в Notion.
      const STEP_COLUMNS = {
        lecture: 'lecture_done',
        quiz: 'quiz_done',
        warmups: 'warmups_done',
        song: 'song_done',
      };
      const step = body && body.step;
      if (step) {
        const column = STEP_COLUMNS[step];
        const lessonNum = parseInt(body.lessonNum, 10);
        if (!column || !Number.isInteger(lessonNum) || lessonNum < 1) {
          res.status(400).json({ error: 'need lessonNum and step (lecture|quiz|warmups|song)' });
          return;
        }
        const psr = await query('SELECT id, status FROM students WHERE telegram_token = $1', [token]);
        if (!psr.rows.length) { res.status(404).json({ error: 'student not found' }); return; }
        const pStudent = psr.rows[0];

        // Имя колонки подставляется только из STEP_COLUMNS выше — из тела
        // запроса в текст SQL не попадает ничего, значения идут параметрами.
        await query(
          `INSERT INTO lesson_progress (student_id, lesson_number, ${column}, updated_at)
           VALUES ($1, $2, true, now())
           ON CONFLICT (student_id, lesson_number)
           DO UPDATE SET ${column} = true, updated_at = now()`,
          [pStudent.id, lessonNum]
        );

        // Автопереход «Пробный» → «Активный», перенесён из notion-progress.js:
        // урок 1 пройден целиком (4/4) и есть хоть какой-то прогресс по уроку
        // с номером больше 1. Статусы «Пауза» и «Завершил», выставленные
        // вручную, никогда не перезаписываем — только trial.
        if (pStudent.status === 'trial') {
          const allp = await query(
            `SELECT lesson_number, lecture_done, quiz_done, warmups_done, song_done
               FROM lesson_progress WHERE student_id = $1`,
            [pStudent.id]
          );
          const lesson1Done = allp.rows.some((r) => r.lesson_number === 1 &&
            r.lecture_done && r.quiz_done && r.warmups_done && r.song_done);
          const otherProgress = allp.rows.some((r) => r.lesson_number > 1 &&
            (r.lecture_done || r.quiz_done || r.warmups_done || r.song_done));
          if (lesson1Done && otherProgress) {
            await query(`UPDATE students SET status = 'active' WHERE id = $1`, [pStudent.id]);
          }
        }

        res.status(200).json({ ok: true });
        return;
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

    // Вторичная цель — «над чем работаем сейчас». Берём цель последнего
    // проведённого занятия: Николай ставит её в Дневнике на каждый урок,
    // так что это всегда актуальная задача, а не то, что ученик написал
    // при записи (это первичная цель, она лежит в анкете).
    const lg = await query(
      `SELECT lesson_date, goal, topic FROM lesson_log
       WHERE student_id = $1 AND goal IS NOT NULL AND goal <> ''
       ORDER BY lesson_date DESC LIMIT 1`,
      [student.id]
    );
    const lastGoal = lg.rows[0]
      ? { goal: lg.rows[0].goal, topic: lg.rows[0].topic || null, date: lg.rows[0].lesson_date }
      : null;

    // «Колесо баланса и срезы» — то же, что Николай видит на сайте.
    // Даты лежат как дд.мм.гггг, лексикографически они не сортируются,
    // поэтому для сортировки разворачиваем их в гггг-мм-дд.
    const zr = await query('SELECT * FROM student_srezy WHERE student_id = $1', [student.id]);
    const srezDateKey = (d) => {
      const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(d || ''));
      return m ? m[3] + '-' + m[2] + '-' + m[1] : '0000-00-00';
    };
    const srezy = zr.rows
      .map((r) => ({ id: r.id, date: r.srez_date, topics: Array.isArray(r.topics) ? r.topics : [] }))
      .sort((a, b) => srezDateKey(a.date).localeCompare(srezDateKey(b.date)));

    // Прогресс по шагам урока для Mini App. Раньше это жило в Notion (база
    // «Прогресс»), формат ответа оставлен тот же, что отдавал notion-student.js:
    // { "1": { lecture, quiz, warmups, song }, "2": {...} } — чтобы app.js
    // не пришлось переучивать на новую форму данных.
    const pr = await query(
      `SELECT lesson_number, lecture_done, quiz_done, warmups_done, song_done
         FROM lesson_progress WHERE student_id = $1`,
      [student.id]
    );
    const progressByLesson = {};
    for (const row of pr.rows) {
      progressByLesson[row.lesson_number] = {
        lecture: !!row.lecture_done,
        quiz: !!row.quiz_done,
        warmups: !!row.warmups_done,
        song: !!row.song_done,
      };
    }

    // «Доп. открытые уроки» — строка вида "10, 15"; отдаём массивом чисел,
    // как раньше делал parseLessonNumbers в notion-student.js.
    const unlockedLessons = String(student.extra_unlocked_lessons || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);

    res.status(200).json({
      student: {
        name: student.name,
        status: student.status,
        schedule: student.schedule || null,
      },
      srezy,
      progressByLesson,
      unlockedLessons,
      lastGoal,
      wheelTopics: (intake && Array.isArray(intake.wheel_topics)) ? intake.wheel_topics : [],
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
