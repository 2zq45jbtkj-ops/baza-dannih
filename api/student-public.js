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

      // Ученик отметил задание выполненным (или снял отметку) в Mini App.
      // Статус лежит внутри lesson_log.hw_items — JSONB-массива, поэтому
      // нужную запись находим по паре title+due: id у заданий нет, а именно
      // этой парой они и склеиваются в GET ниже (seen = `${title}|${due}`),
      // так что одно и то же задание из разных уроков меняется целиком.
      const hwDone = body && body.hwDone;
      if (hwDone && hwDone.title) {
        const hsr = await query('SELECT id FROM students WHERE telegram_token = $1', [token]);
        if (!hsr.rows.length) { res.status(404).json({ error: 'student not found' }); return; }
        const hStudentId = hsr.rows[0].id;
        const done = hwDone.done !== false;
        const newStatus = done ? 'выполнено учеником' : 'в приложении: не начато';
        const lrows = await query(
          `SELECT id, hw_items FROM lesson_log
            WHERE student_id = $1 AND hw_items IS NOT NULL AND jsonb_array_length(hw_items) > 0`,
          [hStudentId]
        );
        for (const row of lrows.rows) {
          const items = Array.isArray(row.hw_items) ? row.hw_items : [];
          let changed = false;
          const next = items.map((it) => {
            if (String(it.title || '') !== String(hwDone.title)) return it;
            if (String(it.due || '') !== String(hwDone.due || '')) return it;
            changed = true;
            return Object.assign({}, it, {
              status: newStatus,
              doneAt: done ? new Date().toISOString().slice(0, 10) : null,
            });
          });
          if (changed) {
            await query('UPDATE lesson_log SET hw_items = $1, updated_at = now() WHERE id = $2',
              [JSON.stringify(next), row.id]);
          }
        }
        // Отметка ДЗ — тоже признак жизни: без этого ученик, который зашёл,
        // всё сделал и закрыл приложение, мог бы вечером получить напоминание.
        await query('UPDATE students SET last_seen_at = now() WHERE telegram_token = $1', [token]);
        res.status(200).json({ ok: true, status: newStatus });
        return;
      }

      // Пинг «ученик открыл приложение» — питает напоминания о ДЗ в боте
      // (см. api/lessons.js?part=hw-reminder). Шлётся при каждом запуске
      // Mini App, в том числе вне Telegram, где chatId неизвестен.
      if (body && body.seen) {
        await query('UPDATE students SET last_seen_at = now() WHERE telegram_token = $1', [token]);
        res.status(200).json({ ok: true });
        return;
      }

      // «Было и стало» в Mini App: первая запись голоса ученика, сделанная в
      // самом приложении. Ложится к референс-записям Кабинета (reference_takes)
      // с source: 'app' — Николай слушает её там же, где свои записи на входе.
      // Первая запись одна: повторная отправка не перезаписывает её.
      // Ученик правит свою первую запись: название и пометки (как в диктофоне
      // базы), либо удаляет её, чтобы записать заново.
      const fe = body && (body.firstTakeEdit || body.firstTakeDelete);
      if (fe) {
        const esr = await query('SELECT id FROM students WHERE telegram_token = $1', [token]);
        if (!esr.rows.length) { res.status(404).json({ error: 'student not found' }); return; }
        const sid = esr.rows[0].id;
        const cur = await query('SELECT reference_takes FROM student_intake WHERE student_id = $1', [sid]);
        const list = cur.rows.length && Array.isArray(cur.rows[0].reference_takes) ? cur.rows[0].reference_takes : [];
        const i = list.findIndex((t) => t && t.source === 'app' && String(t.id) === String(fe.id));
        if (i < 0) { res.status(404).json({ error: 'no recording' }); return; }
        let next;
        if (body.firstTakeDelete) {
          next = list.slice(0, i).concat(list.slice(i + 1));
        } else {
          const t = Object.assign({}, list[i]);
          if (typeof fe.name === 'string' && fe.name.trim()) t.name = fe.name.trim().slice(0, 200);
          if (Array.isArray(fe.markers)) {
            t.markers = fe.markers.slice(0, 200).map((m) => ({
              id: String((m && m.id) || '').slice(0, 40),
              t: Math.max(0, Math.round((Number(m && m.t) || 0) * 10) / 10),
              label: String((m && m.label) || '').slice(0, 200),
              createdAt: String((m && m.createdAt) || new Date().toISOString()).slice(0, 40),
            }));
          }
          next = list.slice(0, i).concat([t]).concat(list.slice(i + 1));
        }
        await query('UPDATE student_intake SET reference_takes = $2::jsonb WHERE student_id = $1', [sid, JSON.stringify(next)]);
        res.status(200).json({ ok: true });
        return;
      }

      const ft = body && body.firstTake;
      if (ft) {
        const dataUrl = String(ft.dataUrl || '');
        if (!/^data:(audio\/|application\/octet-stream)[\w.+-]*(;[\w=.+-]+)*;base64,/.test(dataUrl) || dataUrl.length > 4200000) {
          res.status(400).json({ error: 'bad recording' });
          return;
        }
        const fsr = await query('SELECT id, name FROM students WHERE telegram_token = $1', [token]);
        if (!fsr.rows.length) { res.status(404).json({ error: 'student not found' }); return; }
        const fStudent = fsr.rows[0];
        const have = await query('SELECT reference_takes FROM student_intake WHERE student_id = $1', [fStudent.id]);
        const takes = have.rows.length && Array.isArray(have.rows[0].reference_takes) ? have.rows[0].reference_takes : [];
        if (takes.some((t) => t && t.source === 'app')) { res.status(409).json({ error: 'already recorded' }); return; }
        const secs = Math.max(0, Math.min(600, Math.round(Number(ft.durationSec) || 0)));
        const pad = (n) => String(n).padStart(2, '0');
        const d = new Date();
        const dateLabel = pad(d.getUTCDate()) + '.' + pad(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
        const ext = /^data:[^;]*mp4/.test(dataUrl) ? 'm4a' : /^data:[^;]*ogg/.test(dataUrl) ? 'ogg' : 'webm';
        const peaks = Array.isArray(ft.peaks) ? ft.peaks.slice(0, 400).map((v) => Math.max(0, Math.min(1, Number(v) || 0))) : [];
        const take = {
          id: Date.now(),
          name: 'Первая запись из приложения · ' + dateLabel,
          fileName: dateLabel + '_pervaya-zapis.' + ext,
          meta: pad(Math.floor(secs / 60)) + ':' + pad(secs % 60) + ' · ' + Math.round(dataUrl.length * 0.75 / 1024) + ' KB',
          dataUrl,
          createdAt: d.toISOString(),
          durationSec: secs,
          markers: [],
          peaks,
          visibleToStudent: true,
          source: 'app',
        };
        await query(
          `INSERT INTO student_intake (student_id, reference_takes) VALUES ($1, $2::jsonb)
           ON CONFLICT (student_id) DO UPDATE
             SET reference_takes = COALESCE(student_intake.reference_takes, '[]'::jsonb) || $2::jsonb`,
          [fStudent.id, JSON.stringify([take])]
        );
        res.status(200).json({ ok: true, id: take.id, name: take.name, meta: take.meta, createdAt: take.createdAt, durationSec: secs });
        return;
      }

      const chatId = body && body.chatId;
      if (!chatId) { res.status(400).json({ error: 'chatId required' }); return; }
      await query(
        'UPDATE students SET telegram_chat_id = $1, last_seen_at = now() WHERE telegram_token = $2',
        [String(chatId), token]
      );
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

    // «Было и стало»: «Было» — первая запись голоса из приложения,
    // «Стало» — последняя запись с урока, которую Николай отметил «Виден ученику».
    // part=bylo — только даты, длительности и волны; part=bylo-audio&which=was|now
    // — сам звук байтами (две записи base64 в одном ответе упёрлись бы в лимит
    // Vercel на размер ответа).
    const part = (req.query && req.query.part) || new URL(req.url, 'http://x').searchParams.get('part');
    if (part === 'bylo' || part === 'bylo-audio') {
      const ir = await query('SELECT reference_takes FROM student_intake WHERE student_id = $1', [student.id]);
      const refs = ir.rows.length && Array.isArray(ir.rows[0].reference_takes) ? ir.rows[0].reference_takes : [];
      const was = refs.filter((t) => t && t.source === 'app' && t.dataUrl)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
      const lr = await query(
        `SELECT lesson_date, takes FROM lesson_log
          WHERE student_id = $1 AND takes @> '[{"visibleToStudent": true}]'::jsonb
          ORDER BY lesson_date DESC LIMIT 1`,
        [student.id]
      );
      let now = null, nowDate = null;
      if (lr.rows.length) {
        const vis = (lr.rows[0].takes || []).filter((t) => t && t.visibleToStudent === true && t.dataUrl);
        now = vis[vis.length - 1] || null;
        nowDate = lr.rows[0].lesson_date;
      }
      if (part === 'bylo') {
        const meta = (t, date) => t ? { id: t.id, name: t.name, date: date || t.createdAt, createdAt: t.createdAt, durationSec: t.durationSec || 0, peaks: t.peaks || [], markers: t.markers || [], meta: t.meta || '' } : null;
        res.status(200).json({ was: meta(was), now: meta(now, nowDate) });
        return;
      }
      const which = (req.query && req.query.which) || new URL(req.url, 'http://x').searchParams.get('which');
      const t = which === 'was' ? was : which === 'now' ? now : null;
      const m = t && /^data:([^;,]+)[^,]*;base64,(.*)$/s.exec(t.dataUrl);
      if (!m) { res.status(404).json({ error: 'no recording' }); return; }
      const buf = Buffer.from(m[2], 'base64');
      res.setHeader('Content-Type', m[1]);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).end(buf);
      return;
    }

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
          // done — явный флаг вместо разбора строки статуса на клиенте:
          // статусы заводятся вручную в Дневнике и формулируются по-разному
          // («выполнено учеником», «в приложении: не начато», …).
          hwAll.push({
            ...item,
            done: /выполнен/i.test(String(item.status || '')),
            lessonDate: row.lesson_date,
          });
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

    // Кабинет в Mini App: абонемент, ближайшие уроки, «золотой» урок-срез и
    // трекер ДЗ. Ошибка здесь не должна ронять весь кабинет — тогда эти
    // блоки просто придут пустыми.
    let cabinet = { subscription: null, upcoming: [], nextSrez: null, hwTracker: [] };
    try {
      cabinet = await buildCabinet(student, lr.rows);
    } catch (e) {
      cabinet.error = String((e && e.message) || e);
      console.error('cabinet build failed:', cabinet.error);
    }

    res.status(200).json({
      subscription: cabinet.subscription,
      upcomingLessons: cabinet.upcoming,
      nextSrez: cabinet.nextSrez,
      hwTracker: cabinet.hwTracker,
      subscriptionHistory: cabinet.history || [],
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

// ---------------------------------------------------------------------------
// Кабинет: данные из бота записи (общая база). Таблицы subscriptions и
// calendar_events ведёт бот; сайт их только читает.
//
// Время уроков в calendar_events — день + минуты от полуночи по времени
// Николая (Екатеринбург, UTC+5). Наружу отдаём ISO в UTC, а время ученику
// показывает уже приложение — в его собственном часовом поясе.
const TEACHER_UTC_OFFSET_MIN = 5 * 60;
const DAY_MS = 86400000;

// Пакеты из бота (shared.PACKAGES): deadline_days = основной срок + запас.
// 37 = 30 дней + 1 неделя, 74 = 60 + 2 недели, 120 = 90 + 1 месяц.
const TERM_SPLIT = {
  37: { base: 30, extraLabel: '+1 неделя' },
  74: { base: 60, extraLabel: '+2 недели' },
  120: { base: 90, extraLabel: '+1 месяц' },
};

function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dayMs(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); }
function teacherToday() { return ymd(Date.now() + TEACHER_UTC_OFFSET_MIN * 60000); }
function teacherNowMin() { const t = new Date(Date.now() + TEACHER_UTC_OFFSET_MIN * 60000); return t.getUTCHours() * 60 + t.getUTCMinutes(); }
function lessonIso(day, startMin) { return new Date(dayMs(day) + (Number(startMin) - TEACHER_UTC_OFFSET_MIN) * 60000).toISOString(); }

async function buildCabinet(student, hwRows) {
  const sid = String(student.id);
  const today = teacherToday();
  const out = { subscription: null, upcoming: [], nextSrez: null, hwTracker: [] };

  // ---- абонемент ----
  // to_jsonb(s)->>'term_started': колонку добавляет бот (17.11); пока её нет,
  // запрос не падает, а просто считает срок ещё не начатым.
  const sr = await query(
    `SELECT lessons_total, lessons_left, deadline_days, deadline::text AS deadline,
            (created_at AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS created_day,
            to_jsonb(s)->>'term_started' AS term_started
       FROM subscriptions s
      WHERE student_id::text = $1 AND status = 'active'
      ORDER BY created_at DESC LIMIT 1`,
    [sid]
  );
  const sub = sr.rows[0] || null;
  if (sub) {
    const total = Number(sub.lessons_total) || 0;
    const left = Math.max(0, Math.min(total, Number(sub.lessons_left) || 0));
    const days = Number(sub.deadline_days) || 0;
    const s = { lessonsTotal: total, lessonsLeft: left, started: false,
                termDays: null, termEnd: null, extraLabel: null, extraEnd: null };
    if (days > 0 && sub.deadline) {
      const split = TERM_SPLIT[days] || { base: days, extraLabel: null };
      s.termDays = split.base;
      s.extraLabel = split.extraLabel;
      const extra = days - split.base;
      if (sub.term_started === 'true') {
        // Бот уже поставил настоящий срок: первый урок + дни пакета (+ отпуск).
        s.started = true;
        s.extraEnd = split.extraLabel ? sub.deadline : null;
        s.termEnd = ymd(dayMs(sub.deadline) - extra * DAY_MS);
      } else {
        // До первого урока в deadline лежит «начать до» (оплата + 7, отпуск
        // его сдвигает). Срок идёт с первого урока, но не позже этой даты.
        const startBy = dayMs(sub.deadline);
        const fr = await query(
          `SELECT min(day)::text AS d FROM calendar_events
            WHERE student_id::text = $1
              AND lesson_outcome IN ('completed', 'no_show', 'student_cancel')
              AND COALESCE(lesson_type, '') <> 'trial'
              AND day >= $2::date`,
          [sid, sub.created_day]
        );
        const first = fr.rows[0] && fr.rows[0].d ? dayMs(fr.rows[0].d) : null;
        let start = null;
        if (first !== null) start = Math.min(first, startBy);
        else if (dayMs(today) > startBy) start = startBy;
        if (start !== null) {
          s.started = true;
          s.termEnd = ymd(start + split.base * DAY_MS);
          if (split.extraLabel) s.extraEnd = ymd(start + days * DAY_MS);
        }
      }
    }
    out.subscription = s;
  }

  // ---- история абонементов: свежий сверху ----
  // Уроки к абонементу привязаны только датами: всё от его покупки до
  // покупки следующего.
  const hr = await query(
    `SELECT id, lessons_total, lessons_left, lesson_format, deadline_days,
            deadline::text AS deadline, status,
            (created_at AT TIME ZONE 'Asia/Yekaterinburg')::date::text AS created_day,
            to_jsonb(s)->>'term_started' AS term_started
       FROM subscriptions s
      WHERE student_id::text = $1
      ORDER BY created_at DESC, id DESC`,
    [sid]
  );
  // Все уроки ученика (без пробного) — для списка уроков в каждом абонементе.
  const evr = await query(
    `SELECT id::text AS id, day::text AS day, start_min, created_at,
            COALESCE(canceled, false) AS c, COALESCE(lesson_outcome, '') AS o,
            COALESCE(repeat_weekly, false) AS rw
       FROM calendar_events
      WHERE student_id::text = $1 AND COALESCE(lesson_type, '') <> 'trial'
      ORDER BY day, start_min`,
    [sid]
  );
  const evs = evr.rows;
  const nowMinH = teacherNowMin();
  // Перенос: старый урок отменён, новый бот создаёт с id «bot_…» позже.
  const usedTo = new Set();
  const moveTarget = (x) => {
    const xt = new Date(x.created_at).getTime();
    const xd = dayMs(x.day);
    let best = null;
    for (const r of evs) {
      if (r === x || usedTo.has(r.id) || !r.id.startsWith('bot_')) continue;
      if (r.c && r.o !== '') continue;
      const rt = new Date(r.created_at).getTime();
      if (!(rt > xt) || dayMs(r.day) < xd - 3 * DAY_MS) continue;
      if (!best || rt < new Date(best.created_at).getTime()) best = r;
    }
    if (best) usedTo.add(best.id);
    return best;
  };
  const lessonOf = (e) => {
    const o = e.o;
    if (o === 'completed') return { day: e.day, s: 'ok' };
    if (o === 'no_show') return { day: e.day, s: 'ns' };
    if (o === 'student_cancel' || o === 'late_cancel') return { day: e.day, s: 'cx', paid: true };
    if (o === 'teacher_cancel' || o === 'removed') return { day: e.day, s: 'cx', paid: false, teacher: true };
    if (o === 'rescheduled') {
      const t = moveTarget(e);
      return { day: e.day, s: 'mv', to: t ? t.day : null };
    }
    if (e.c) {
      const t = moveTarget(e);
      return t ? { day: e.day, s: 'mv', to: t.day } : { day: e.day, s: 'cx', paid: false };
    }
    if (e.rw) return null; // повтор каждую неделю: будущие даты ниже, из расписания
    if (e.day < today || (e.day === today && Number(e.start_min) <= nowMinH)) return { day: e.day, s: 'wait' };
    return null; // будущий урок — в списке «впереди»
  };
  const lessonsAll = evs.map((e) => [e, lessonOf(e)]);

  out.history = [];
  for (let i = 0; i < hr.rows.length; i++) {
    const h = hr.rows[i];
    const until = i > 0 ? hr.rows[i - 1].created_day : null;
    const lr2 = await query(
      `SELECT min(day)::text AS a, max(day)::text AS b, count(*)::int AS n
         FROM calendar_events
        WHERE student_id::text = $1
          AND lesson_outcome IN ('completed', 'no_show', 'student_cancel')
          AND COALESCE(lesson_type, '') <> 'trial'
          AND day >= $2::date AND ($3::date IS NULL OR day < $3::date)`,
      [sid, h.created_day, until]
    );
    const L = lr2.rows[0] || {};
    const totalH = Number(h.lessons_total) || 0;
    out.history.push({
      current: i === 0 && h.status === 'active',
      bought: h.created_day,
      lessonsTotal: totalH,
      lessonsUsed: Math.max(0, totalH - (Number(h.lessons_left) || 0)),
      format: Number(h.lesson_format) || 45,
      firstLesson: L.a || null,
      lastLesson: L.b || null,
      termEnd: h.term_started === 'true' ? h.deadline : null,
      lessons: lessonsAll
        .filter(([e, l]) => l && e.day >= h.created_day && (until === null || e.day < until))
        .map(([, l]) => l),
    });
  }

  // ---- ближайшие уроки (с еженедельными повторами, как в боте) ----
  const ur = await query(
    `SELECT g.d::text AS day, ce.start_min
       FROM (SELECT gs::date AS d FROM generate_series($2::date, $2::date + 120, interval '1 day') gs) g
       JOIN calendar_events ce
         ON ce.student_id::text = $1
        AND COALESCE(ce.canceled, false) = false
        AND COALESCE(ce.lesson_outcome, '') = ''
        AND COALESCE(ce.lesson_type, '') <> 'trial'
        AND (ce.day = g.d OR (COALESCE(ce.repeat_weekly, false) AND ce.day <= g.d
             AND EXTRACT(ISODOW FROM ce.day) = EXTRACT(ISODOW FROM g.d)
             AND (NULLIF(ce.repeat_until::text, '') IS NULL
                  OR NULLIF(ce.repeat_until::text, '')::date >= g.d)))
      ORDER BY g.d, ce.start_min
      LIMIT 80`,
    [sid, today]
  );
  const nowMin = teacherNowMin();
  const seenSlot = new Set();
  const all = [];
  for (const r of ur.rows) {
    if (r.day === today && Number(r.start_min) <= nowMin) continue;
    const key = r.day + '|' + r.start_min;
    if (seenSlot.has(key)) continue;
    seenSlot.add(key);
    all.push({ day: r.day, startMin: Number(r.start_min) });
  }

  // «Золотой» урок — последний урок месяца, на нём Николай делает срез и
  // заполняет колесо баланса. Считаем его только если он попадает в последние
  // 10 дней месяца: у «плавающих» учеников записан бывает один урок вперёд, и
  // урок 5-го числа не должен становиться «последним в месяце».
  const lastInMonth = {};
  for (const l of all) lastInMonth[l.day.slice(0, 7)] = l;
  for (const l of Object.values(lastInMonth)) {
    const [y, m, d] = l.day.split('-').map(Number);
    const monthDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d > monthDays - 10) l.golden = true;
  }

  const cap = sub ? Math.max(0, Number(sub.lessons_left) || 0) : all.length;
  out.upcoming = all.slice(0, Math.min(cap, 24)).map((l) => ({
    at: lessonIso(l.day, l.startMin), day: l.day, golden: !!l.golden,
  }));
  // Текущему абонементу — ещё уроки впереди (с датой, если уже в расписании).
  const curH = out.history[0];
  if (curH && curH.current) {
    for (const u of out.upcoming) curH.lessons.push({ day: u.day, s: 'up' });
  }
  const g = all.find((l) => l.golden);
  out.nextSrez = g ? g.day : null;

  // ---- трекер ДЗ: одно задание = ДЗ после одного урока (запись дневника) ----
  const rows = (hwRows || []).slice(0, 8).reverse();
  out.hwTracker = rows.map((row, i) => {
    const items = Array.isArray(row.hw_items) ? row.hw_items : [];
    const done = items.length > 0 && items.every((it) => /выполнен/i.test(String(it.status || '')));
    const isLast = i === rows.length - 1;
    const open = items.some((it) => !/выполнен/i.test(String(it.status || '')) &&
      (it.due ? String(it.due).slice(0, 10) >= today : isLast));
    const date = row.lesson_date instanceof Date ? ymd(row.lesson_date.getTime() + 12 * 3600000) : String(row.lesson_date || '').slice(0, 10);
    return { lessonDate: date, state: done ? 'ok' : (open ? 'now' : 'no') };
  });

  return out;
}
