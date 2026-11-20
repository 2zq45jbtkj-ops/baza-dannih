// Объединение двух карточек ученика в одну (20.11, просьба Николая:
// «Nikolai Sept» + «админ»). Не функция Vercel (префикс _), вызывается из
// students.js веткой ?merge=preview|run — лимит 12 функций не трогаем.
//
// keep — карточка, которая остаётся (её код доступа/Telegram продолжают
// работать), drop — вливается в неё и удаляется.
// Правило слияния полей: у keep значение есть — оставляем; у keep пусто,
// а у drop есть — берём из drop («где нет информации — оставить как есть»).
// Таблицы с student_id ищутся по information_schema, а не списком в коде —
// чтобы новая таблица не потерялась при слиянии.
const { query } = require('./_db');
const { Pool } = require('pg');

function isEmpty(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Date) return false;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

async function studentTables(c) {
  const r = await c.query(`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'student_id'
     ORDER BY table_name`);
  const out = [];
  for (const row of r.rows) {
    const t = row.table_name;
    // уникален ли student_id сам по себе (одна строка на ученика)
    const u = await c.query(`
      SELECT i.indisunique, array_agg(a.attname ORDER BY a.attname) AS cols
        FROM pg_index i
        JOIN pg_class cl ON cl.oid = i.indrelid
        JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = ANY(i.indkey)
       WHERE cl.relname = $1 AND i.indisunique
       GROUP BY i.indexrelid, i.indisunique`, [t]);
    let single = false, composite = null;
    for (const ix of u.rows) {
      const cols = ix.cols;
      if (cols.length === 1 && cols[0] === 'student_id') single = true;
      else if (cols.indexOf('student_id') !== -1) composite = cols;
    }
    out.push({ table: t, single, composite });
  }
  return out;
}

function lastSeen(s) { return s && s.last_seen_at ? new Date(s.last_seen_at).getTime() : 0; }

async function preview(keepId, dropId) {
  await query('SELECT 1', []); // ensureSchema
  const st = await query('SELECT * FROM students WHERE id = ANY($1)', [[keepId, dropId]]);
  const byId = {}; st.rows.forEach(r => { byId[r.id] = r; });
  if (!byId[keepId] || !byId[dropId]) return { error: 'student not found' };
  const tables = await studentTables({ query: (s, p) => query(s, p) });
  const counts = [];
  for (const t of tables) {
    const r = await query(`SELECT student_id, count(*)::int AS n FROM "${t.table}" WHERE student_id = ANY($1) GROUP BY student_id`, [[keepId, dropId]]);
    const m = {}; r.rows.forEach(x => { m[x.student_id] = x.n; });
    counts.push({ table: t.table, keep: m[keepId] || 0, drop: m[dropId] || 0 });
  }
  const short = s => ({
    id: s.id, name: s.name, status: s.status, created_at: s.created_at,
    last_seen_at: s.last_seen_at, telegram_linked: !!s.telegram_chat_id,
    extra_unlocked_lessons: s.extra_unlocked_lessons || '',
    package_size: s.package_size
  });
  return { keep: short(byId[keepId]), drop: short(byId[dropId]), counts };
}

// поля строки drop, которые надо перенести в keep (там пусто, тут есть)
function fillCols(keepRow, dropRow, skip) {
  const set = {};
  for (const k of Object.keys(dropRow)) {
    if (skip.indexOf(k) !== -1) continue;
    if (isEmpty(keepRow[k]) && !isEmpty(dropRow[k])) set[k] = dropRow[k];
  }
  return set;
}

async function updateCols(c, table, keyCol, keyVal, set) {
  const keys = Object.keys(set);
  if (!keys.length) return 0;
  const parts = keys.map((k, i) => `"${k}" = $${i + 2}`);
  const vals = keys.map(k => {
    const v = set[k];
    return (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) ? JSON.stringify(v) : v;
  });
  await c.query(`UPDATE "${table}" SET ${parts.join(', ')} WHERE "${keyCol}" = $1`, [keyVal].concat(vals));
  return keys.length;
}

function unionLessons(a, b) {
  const s = new Set();
  [a, b].forEach(x => String(x || '').split(/[\s,;]+/).forEach(n => { if (/^\d+$/.test(n)) s.add(+n); }));
  return Array.from(s).sort((x, y) => x - y).join(', ');
}

async function run(keepId, dropId, newName) {
  if (!keepId || !dropId || keepId === dropId) return { error: 'bad ids' };
  await query('SELECT 1', []); // ensureSchema
  const cs = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL_NON_POOLING;
  const pool = new Pool({ connectionString: cs, ssl: cs.includes('sslmode=') ? undefined : { rejectUnauthorized: false }, max: 1 });
  const c = await pool.connect();
  const log = [];
  try {
    await c.query('BEGIN');
    const st = await c.query('SELECT * FROM students WHERE id = ANY($1) FOR UPDATE', [[keepId, dropId]]);
    const K = st.rows.find(r => r.id === keepId), D = st.rows.find(r => r.id === dropId);
    if (!K || !D) throw new Error('student not found');

    // 1) все таблицы с student_id
    const tables = await studentTables(c);
    for (const t of tables) {
      if (t.single) {
        const kr = (await c.query(`SELECT * FROM "${t.table}" WHERE student_id = $1`, [keepId])).rows[0];
        const dr = (await c.query(`SELECT * FROM "${t.table}" WHERE student_id = $1`, [dropId])).rows[0];
        if (!dr) continue;
        if (!kr) {
          await c.query(`UPDATE "${t.table}" SET student_id = $1 WHERE student_id = $2`, [keepId, dropId]);
          log.push(t.table + ': перенесена запись');
        } else {
          const n = await updateCols(c, t.table, 'student_id', keepId, fillCols(kr, dr, ['student_id', 'id', 'created_at', 'updated_at']));
          await c.query(`DELETE FROM "${t.table}" WHERE student_id = $1`, [dropId]);
          log.push(t.table + ': дополнено полей ' + n);
        }
      } else if (t.composite) {
        // одна строка на (ученик, что-то): у keep такой нет — переносим;
        // есть — дополняем пустые поля и галочки (true побеждает), дубль удаляем
        const other = t.composite.filter(x => x !== 'student_id');
        const drs = (await c.query(`SELECT * FROM "${t.table}" WHERE student_id = $1`, [dropId])).rows;
        let moved = 0, merged = 0;
        for (const dr of drs) {
          const where = other.map((k, i) => `"${k}" = $${i + 2}`).join(' AND ');
          const vals = other.map(k => dr[k]);
          const kr = (await c.query(`SELECT * FROM "${t.table}" WHERE student_id = $1 AND ${where}`, [keepId].concat(vals))).rows[0];
          if (!kr) {
            await c.query(`UPDATE "${t.table}" SET student_id = $1 WHERE student_id = $${other.length + 2} AND ${where}`, [keepId].concat(vals, [dropId]));
            moved++;
          } else {
            const set = fillCols(kr, dr, ['student_id'].concat(other, ['updated_at']));
            Object.keys(dr).forEach(k => { if (dr[k] === true && kr[k] === false) set[k] = true; });
            const keys = Object.keys(set);
            if (keys.length) {
              const parts = keys.map((k, i) => `"${k}" = $${i + 2 + other.length}`);
              await c.query(`UPDATE "${t.table}" SET ${parts.join(', ')} WHERE student_id = $1 AND ${where}`, [keepId].concat(vals, keys.map(k => set[k])));
            }
            await c.query(`DELETE FROM "${t.table}" WHERE student_id = $1 AND ${where}`, [dropId].concat(vals));
            merged++;
          }
        }
        if (drs.length) log.push(t.table + ': перенесено ' + moved + ', объединено ' + merged);
      } else {
        const r = await c.query(`UPDATE "${t.table}" SET student_id = $1 WHERE student_id = $2`, [keepId, dropId]);
        if (r.rowCount) log.push(t.table + ': перенесено ' + r.rowCount);
      }
    }

    // 2) сама карточка: пустые поля keep дополняем из drop
    const set = fillCols(K, D, ['id', 'created_at', 'telegram_token', 'name', 'last_seen_at', 'hw_reminder_sent_at']);
    if (K.extra_unlocked_lessons || D.extra_unlocked_lessons) set.extra_unlocked_lessons = unionLessons(K.extra_unlocked_lessons, D.extra_unlocked_lessons);
    if (K.status !== 'active' && D.status === 'active') set.status = 'active';
    if (newName && String(newName).trim()) set.name = String(newName).trim();
    if (D.created_at && K.created_at && new Date(D.created_at) < new Date(K.created_at)) set.created_at = D.created_at;
    // Telegram drop переносим, только если у keep его нет (иначе бот потеряет keep)
    await c.query('DELETE FROM students WHERE id = $1', [dropId]);
    const n = await updateCols(c, 'students', 'id', keepId, set);
    log.push('карточка: обновлено полей ' + n + ', вторая карточка удалена');

    await c.query('COMMIT');
    return { ok: true, log };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (x) {}
    return { error: String(e && e.message || e), log };
  } finally {
    c.release();
    await pool.end();
  }
}

module.exports = { preview, run, _isEmpty: isEmpty, _unionLessons: unionLessons };
