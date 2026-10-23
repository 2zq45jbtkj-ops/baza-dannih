const { query } = require('./_db');
const { sendTelegramMessage } = require('./_telegram');
const auth = require('./_auth');

function fmtDue(due) {
  if (!due) return '';
  const parts = String(due).slice(0, 10).split('-');
  return parts.length === 3 ? ' — до ' + parts[2] + '.' + parts[1] + '.' + parts[0] : '';
}

// Отправляет ученику уведомление о домашнем задании в Telegram, если у него
// сохранён chat_id (см. POST /api/student-public). Ошибка отправки не должна
// ронять сохранение урока — поэтому исключения здесь гасятся молча.
async function notifyHomeworkSent(studentId, hwItems) {
  try {
    const items = Array.isArray(hwItems) ? hwItems : [];
    if (!items.length) return;
    const sr = await query('SELECT telegram_chat_id FROM students WHERE id = $1', [studentId]);
    const chatId = sr.rows[0] && sr.rows[0].telegram_chat_id;
    if (!chatId) return;
    const lines = items.map(it => `• [Уровень ${it.level}] ${it.title}${fmtDue(it.due)}`).join('\n');
    await sendTelegramMessage(chatId, `📚 Новое домашнее задание:\n\n${lines}\n\nОткрой мини-приложение, чтобы посмотреть подробности.`);
  } catch (e) {
    // намеренно молча — доставка в Telegram не должна блокировать сохранение
  }
}

/* ---------- ежедневное напоминание о домашнем задании ----------

   GET /api/lessons?part=hw-reminder — дёргается Vercel Cron раз в сутки
   (расписание в vercel.json). Отдельным файлом в api/ эту ручку сделать
   нельзя: проект на Hobby-плане и уже занимает все 12 serverless-функций,
   тринадцатая роняет деплой целиком. Поэтому — ветка внутри lessons.js, тем
   же приёмом, что api/intake.js?part=srezy. Домашние задания и так лежат в
   lesson_log, который обслуживает именно этот файл.

   Пишем ученику, только если выполнены ОБА условия: задание не отмечено
   выполненным И ученик сутки не открывал Mini App. Тому, кто заходит и
   занимается, бот не пишет вовсе. */

const REMINDER_LOOKBACK_DAYS = 7;

function hwIsDone(item) {
  return /выполнен/i.test(String((item && item.status) || ''));
}

// Сколько дней осталось до дедлайна: >0 — ещё есть время, 0 — сегодня,
// <0 — просрочено. Считаем в календарных днях по UTC: due хранится как
// дата без времени, и разница часовых поясов сдвинула бы её на сутки.
function daysUntil(due, todayMs) {
  if (!due) return null;
  const t = Date.parse(String(due).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  return Math.round((t - todayMs) / 86400000);
}

function reminderText(name, items, todayMs) {
  const lines = items.map((it) => {
    const left = daysUntil(it.due, todayMs);
    // Хвост в скобках, а не через тире: fmtDue уже начинается с « — до …»,
    // и два тире подряд в одной строке читаются как опечатка.
    let tail = '';
    if (left === null) tail = '';
    else if (left < 0) tail = ` (просрочено на ${-left} дн.)`;
    else if (left === 0) tail = ' (сегодня последний день)';
    else if (left === 1) tail = ' (остался 1 день)';
    else tail = ` (осталось ${left} дн.)`;
    return `• [Уровень ${it.level || '?'}] ${it.title}${fmtDue(it.due)}${tail}`;
  });
  const hello = name ? `${String(name).trim().split(' ')[0]}, ` : '';
  return `🎤 ${hello}не вижу тебя в приложении, а домашнее задание ждёт:\n\n` +
    `${lines.join('\n')}\n\n` +
    'Открой мини-приложение и отметь выполненное — тогда я перестану напоминать.';
}

async function runHomeworkReminders(req, res) {
  // Vercel Cron сам подставляет заголовок Authorization: Bearer $CRON_SECRET,
  // если переменная CRON_SECRET задана в проекте. Без неё ручка закрыта
  // наглухо: иначе разослать сообщения всем ученикам смог бы любой, кто
  // угадает адрес — ручка-то живёт внутри публичного /api/lessons.
  const secret = process.env.CRON_SECRET;
  if (!secret) { res.status(503).json({ error: 'CRON_SECRET not configured' }); return; }
  if ((req.headers.authorization || '') !== `Bearer ${secret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const todayMs = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');

  // Отбор кандидатов целиком в SQL: «есть chat_id», «учится», «сутки не
  // заходил», «сегодня уже не писали». Порог последнего условия 20 часов,
  // а не 24: Vercel запускает крон в пределах часа, и при ровно 24 время
  // отправки уползало бы вперёд, пока в какие-то сутки не пропустилось бы.
  const cands = await query(
    `SELECT id, name, telegram_chat_id
       FROM students
      WHERE telegram_chat_id IS NOT NULL AND telegram_chat_id <> ''
        AND status IN ('active', 'trial')
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '24 hours')
        AND (hw_reminder_sent_at IS NULL OR hw_reminder_sent_at < now() - interval '20 hours')`
  );

  let sent = 0;
  let noPendingHw = 0;
  let failed = 0;
  for (const st of cands.rows) {
    const lr = await query(
      `SELECT hw_items FROM lesson_log
        WHERE student_id = $1 AND hw_items IS NOT NULL AND jsonb_array_length(hw_items) > 0
        ORDER BY lesson_date DESC LIMIT 20`,
      [st.id]
    );

    // Дубли по title+due убираем так же, как в GET /api/student-public:
    // одно и то же задание может быть выписано на нескольких уроках подряд.
    const seen = new Set();
    const pending = [];
    for (const row of lr.rows) {
      for (const it of (Array.isArray(row.hw_items) ? row.hw_items : [])) {
        const key = `${it.title}|${it.due}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (hwIsDone(it)) continue;
        const left = daysUntil(it.due, todayMs);
        // Про задания без дедлайна и просроченные больше чем на неделю не
        // напоминаем: иначе бот пишет ученику бесконечно и его перестают
        // читать вовсе. Такое задание Николай либо закроет, либо выдаст заново.
        if (left === null || left < -REMINDER_LOOKBACK_DAYS) continue;
        pending.push(it);
      }
    }
    if (!pending.length) { noPendingHw += 1; continue; }

    pending.sort((a, b) => (String(a.due || '9999') < String(b.due || '9999') ? -1 : 1));
    const r = await sendTelegramMessage(st.telegram_chat_id, reminderText(st.name, pending, todayMs));
    // Штамп ставим только на реально доставленное сообщение: если ученик
    // заблокировал бота или chat_id протух, строка останется кандидатом и
    // попытка повторится завтра, а не «отметится отправленной» навсегда.
    if (r && r.ok) {
      await query('UPDATE students SET hw_reminder_sent_at = now() WHERE id = $1', [st.id]);
      sent += 1;
    } else {
      failed += 1;
    }
  }

  res.status(200).json({ ok: true, candidates: cands.rows.length, sent, noPendingHw, failed });
}

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
          lessonSteps: row.lesson_steps || [],
          newProblems: row.new_problems || [],
          hwItems: row.hw_items || [],
          hwSent: row.hw_sent || false,
          warmupIds: row.warmup_ids || [],
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
    const part = (req.query && req.query.part) || url.searchParams.get('part');

    // Крон-ручка, а не CRUD: проверяется до всего остального и не трогает
    // ни studentId, ни тело запроса. См. runHomeworkReminders выше.
    if (part === 'hw-reminder') {
      await runHomeworkReminders(req, res);
      return;
    }

    // Всё остальное — Дневник занятий, только преподавателю. Проверка стоит
    // ПОСЛЕ ветки hw-reminder намеренно: у крона своя защита по CRON_SECRET,
    // а Vercel Cron шлёт Authorization: Bearer, не X-Site-Auth — поставь
    // requireTeacher выше, и ежедневные напоминания молча перестали бы ходить.
    if (!auth.requireTeacher(req, res)) return;

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
           homework, takes, lesson_steps, new_problems, hw_items, hw_sent, warmup_ids
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
          JSON.stringify(Array.isArray(b.takes) ? b.takes : []),
                    JSON.stringify(Array.isArray(b.lessonSteps) ? b.lessonSteps : []),
                    Array.isArray(b.newProblems) ? b.newProblems : [],
                    JSON.stringify(Array.isArray(b.hwItems) ? b.hwItems : []),
                    !!b.hwSent,
                    Array.isArray(b.warmupIds) ? b.warmupIds : []
        ]
      );
      if (b.hwSent) {
        await notifyHomeworkSent(r.rows[0].student_id, r.rows[0].hw_items);
      }
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
            if (Object.prototype.hasOwnProperty.call(b, 'lessonSteps')) { cols.push(`lesson_steps = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.lessonSteps) ? b.lessonSteps : [])); }
            if (Object.prototype.hasOwnProperty.call(b, 'newProblems')) { cols.push(`new_problems = $${i++}`); vals.push(Array.isArray(b.newProblems) ? b.newProblems : []); }
            if (Object.prototype.hasOwnProperty.call(b, 'hwItems')) { cols.push(`hw_items = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.hwItems) ? b.hwItems : [])); }
            if (Object.prototype.hasOwnProperty.call(b, 'hwSent')) { cols.push(`hw_sent = $${i++}`); vals.push(!!b.hwSent); }
            if (Object.prototype.hasOwnProperty.call(b, 'warmupIds')) { cols.push(`warmup_ids = $${i++}`); vals.push(Array.isArray(b.warmupIds) ? b.warmupIds : []); }

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
      if (Object.prototype.hasOwnProperty.call(b, 'hwSent') && b.hwSent) {
        await notifyHomeworkSent(r.rows[0].student_id, r.rows[0].hw_items);
      }
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
