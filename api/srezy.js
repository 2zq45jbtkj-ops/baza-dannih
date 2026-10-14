// «Колесо баланса и срезы» — хранение на сервере.
//
// До появления этого файла и текущее колесо, и вся история срезов лежали
// только в localStorage браузера (ключ kabinet_lz_v5). Это означало две вещи:
// ученик не мог увидеть свои срезы в Mini App (на сервере их попросту нет),
// а чистка браузера уничтожала всю историю. Здесь они переезжают в Postgres.
//
// GET    /api/srezy?studentId=ID     → { topics: [...], srezy: [{id,date,topics}] }
// POST   /api/srezy                  → { studentId, date, topics, id? }  создать срез
// POST   /api/srezy?migrate=1        → { studentId, topics, srezy[] }    разовый перенос
// PUT    /api/srezy?studentId=ID     → { topics }                        сохранить колесо
// DELETE /api/srezy?id=ID            → удалить срез
const { query } = require('./_db');
const { randomUUID } = require('crypto');

function readBody(req) {
  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }
  return body || {};
}

function rowToJson(row) {
  return {
    id: row.id,
    date: row.srez_date,
    topics: Array.isArray(row.topics) ? row.topics : [],
  };
}

// Срезы сортируем по дате в формате дд.мм.гггг — лексикографически это не
// работает, поэтому разворачиваем в гггг-мм-дд. Непарсимые даты уходят вниз.
function dateKey(d) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(d || ''));
  return m ? m[3] + '-' + m[2] + '-' + m[1] : '0000-00-00';
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const studentId = (req.query && req.query.studentId) || url.searchParams.get('studentId');
  const srezId = (req.query && req.query.id) || url.searchParams.get('id');
  const isMigrate = ((req.query && req.query.migrate) || url.searchParams.get('migrate')) === '1';

  try {
    if (req.method === 'GET') {
      if (!studentId) { res.status(400).json({ error: 'studentId required' }); return; }
      const sr = await query(
        'SELECT * FROM student_srezy WHERE student_id = $1',
        [studentId]
      );
      const ir = await query(
        'SELECT wheel_topics FROM student_intake WHERE student_id = $1',
        [studentId]
      );
      const srezy = sr.rows.map(rowToJson).sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
      const topics = (ir.rows[0] && Array.isArray(ir.rows[0].wheel_topics)) ? ir.rows[0].wheel_topics : [];
      res.status(200).json({ topics, srezy });
      return;
    }

    if (req.method === 'POST' && isMigrate) {
      // Разовый перенос из браузера. Намеренно НЕ трогаем то, что уже лежит
      // на сервере: переносим, только если история пуста, иначе повторный
      // запуск продублировал бы срезы.
      const b = readBody(req);
      const id = b.studentId || studentId;
      if (!id) { res.status(400).json({ error: 'studentId required' }); return; }
      const existing = await query('SELECT COUNT(*)::int AS n FROM student_srezy WHERE student_id = $1', [id]);
      if (existing.rows[0].n > 0) {
        res.status(200).json({ ok: true, skipped: true, reason: 'на сервере уже есть срезы', count: existing.rows[0].n });
        return;
      }
      const list = Array.isArray(b.srezy) ? b.srezy : [];
      for (const s of list) {
        await query(
          'INSERT INTO student_srezy (id, student_id, srez_date, topics) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
          [String(s.id || randomUUID()), id, String(s.date || ''), JSON.stringify(Array.isArray(s.topics) ? s.topics : [])]
        );
      }
      if (Array.isArray(b.topics)) {
        await query(
          `INSERT INTO student_intake (student_id, wheel_topics) VALUES ($1,$2)
           ON CONFLICT (student_id) DO UPDATE SET wheel_topics = EXCLUDED.wheel_topics`,
          [id, JSON.stringify(b.topics)]
        );
      }
      res.status(200).json({ ok: true, migrated: list.length });
      return;
    }

    if (req.method === 'POST') {
      const b = readBody(req);
      const id = b.studentId || studentId;
      if (!id) { res.status(400).json({ error: 'studentId required' }); return; }
      const row = {
        id: String(b.id || randomUUID()),
        date: String(b.date || ''),
        topics: Array.isArray(b.topics) ? b.topics : [],
      };
      await query(
        'INSERT INTO student_srezy (id, student_id, srez_date, topics) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
        [row.id, id, row.date, JSON.stringify(row.topics)]
      );
      res.status(200).json({ srez: row });
      return;
    }

    if (req.method === 'PUT' || req.method === 'PATCH') {
      if (!studentId) { res.status(400).json({ error: 'studentId required' }); return; }
      const b = readBody(req);
      const topics = Array.isArray(b.topics) ? b.topics : [];
      await query(
        `INSERT INTO student_intake (student_id, wheel_topics) VALUES ($1,$2)
         ON CONFLICT (student_id) DO UPDATE SET wheel_topics = EXCLUDED.wheel_topics`,
        [studentId, JSON.stringify(topics)]
      );
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      if (!srezId) { res.status(400).json({ error: 'id required' }); return; }
      await query('DELETE FROM student_srezy WHERE id = $1', [srezId]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
