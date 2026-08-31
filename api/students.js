const { query } = require('./_db');

function rowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    schedule: row.schedule,
    createdAt: row.created_at
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const r = await query('SELECT * FROM students ORDER BY created_at ASC, id ASC', []);
      res.status(200).json({ students: r.rows.map(rowToJson) });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      if (!b.name || !String(b.name).trim()) {
        res.status(400).json({ error: 'name required' });
        return;
      }
      const id = b.id || ('s' + Date.now() + Math.floor(Math.random() * 1000));
      const status = b.status || 'trial';
      const r = await query(
        'INSERT INTO students (id, name, status) VALUES ($1,$2,$3) RETURNING *',
        [id, String(b.name).trim(), status]
      );
      res.status(200).json({ student: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'PATCH' || req.method === 'PUT') {
      const url = new URL(req.url, 'http://x');
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};
      const sets = [];
      const values = [];
      let i = 1;
      if (b.name !== undefined && String(b.name).trim()) { sets.push(`name = $${i++}`); values.push(String(b.name).trim()); }
      if (b.status !== undefined) { sets.push(`status = $${i++}`); values.push(b.status); }
      if (b.schedule !== undefined) { sets.push(`schedule = $${i++}`); values.push(b.schedule); }
      if (!sets.length) { res.status(400).json({ error: 'nothing to update' }); return; }
      values.push(id);
      const r = await query(`UPDATE students SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
      if (!r.rows.length) { res.status(404).json({ error: 'not found' }); return; }
      res.status(200).json({ student: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url, 'http://x');
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      await query('DELETE FROM students WHERE id = $1', [id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
