const { query } = require('./_db');

module.exports = async (req, res) => {
  try {
    const r = await query('SELECT now() as now', []);
    res.status(200).json({ ok: true, dbTime: r.rows[0].now });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ ok: false, error: err.message || String(err) });
  }
};
