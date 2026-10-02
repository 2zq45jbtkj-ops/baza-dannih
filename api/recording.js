// Публичная страница воспроизведения одной записи по непредсказуемому токену.
// GET /api/recording?token=UUID — отдаёт HTML со встроенным плеером.
// Используется QR-кодами в PDF ученика («Записи голоса»): сама запись лежит
// как base64 внутри student_intake.reference_takes или lesson_log.takes —
// отдельного файлового хранилища для неё нет, поэтому эндпоинт просто
// находит take с нужным publicToken и отдаёт его dataUrl в <audio>.
const { query } = require('./_db');

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const token = (req.query && req.query.token) || new URL(req.url, 'http://x').searchParams.get('token');
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    res.status(400).send('Неверная ссылка на запись.');
    return;
  }

  try {
    const needle = JSON.stringify([{ publicToken: token }]);
    let take = null;
    let studentName = '';

    const ir = await query(
      `SELECT si.reference_takes, s.name FROM student_intake si
       JOIN students s ON s.id = si.student_id
       WHERE si.reference_takes @> $1::jsonb LIMIT 1`,
      [needle]
    );
    if (ir.rows.length) {
      take = (ir.rows[0].reference_takes || []).find(t => t.publicToken === token) || null;
      studentName = ir.rows[0].name;
    }

    if (!take) {
      const lr = await query(
        `SELECT l.takes, s.name FROM lesson_log l
         JOIN students s ON s.id = l.student_id
         WHERE l.takes @> $1::jsonb LIMIT 1`,
        [needle]
      );
      if (lr.rows.length) {
        take = (lr.rows[0].takes || []).find(t => t.publicToken === token) || null;
        studentName = lr.rows[0].name;
      }
    }

    if (!take || !take.dataUrl) {
      res.status(404).send('Запись не найдена — возможно, ссылка устарела.');
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(`<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(take.name || 'Запись')}</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#FBF8F3;color:#23201D;margin:0;padding:40px 20px;display:flex;flex-direction:column;align-items:center;gap:18px;}
  .card{background:#fff;border:1px solid #ECE5DB;border-radius:14px;padding:28px 24px;max-width:420px;width:100%;box-shadow:0 8px 28px rgba(0,0,0,0.06);}
  .name{font-weight:800;font-size:13px;color:#A09488;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;}
  h1{font-size:20px;margin:0 0 18px;}
  audio{width:100%;}
</style>
</head><body>
  <div class="card">
    <div class="name">${escapeHtml(studentName)}</div>
    <h1>${escapeHtml(take.name || 'Запись')}</h1>
    <audio controls autoplay src="${take.dataUrl}"></audio>
  </div>
</body></html>`);
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).send('Ошибка: ' + (err.message || String(err)));
  }
};
