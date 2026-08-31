const { Pool } = require('pg');

let pool = null;
let ensured = false;

function getConnectionString() {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING ||
    null
  );
}

function getPool() {
  if (pool) return pool;
  const cs = getConnectionString();
  if (!cs) return null;
  pool = new Pool({
    connectionString: cs,
    ssl: cs.includes('sslmode=') ? undefined : { rejectUnauthorized: false }
  });
  return pool;
}

async function ensureSchema(p) {
  if (ensured) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'trial',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await p.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS schedule TEXT;`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS student_intake (
      student_id TEXT PRIMARY KEY,
      age INTEGER,
      goal TEXT,
      genre_refs TEXT,
      prior_experience TEXT,
      complaints TEXT[] DEFAULT '{}',
      symptom_duration TEXT,
      ent_diagnosis TEXT,
      vocal_load_job TEXT,
      smoking TEXT,
      hydration TEXT,
      sleep TEXT,
      range_low TEXT,
      range_high TEXT,
      tessitura_comfort TEXT,
      register_break_note TEXT,
      cvt_modes_start TEXT[] DEFAULT '{}',
      metallic_balance TEXT,
      laryngeal_position TEXT,
      tension_areas TEXT[] DEFAULT '{}',
      breathing_type TEXT,
      reference_audio_url TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS lesson_log (
      id SERIAL PRIMARY KEY,
      student_id TEXT NOT NULL,
      lesson_date DATE NOT NULL,
      cvt_modes TEXT[] DEFAULT '{}',
      effort_level INTEGER,
      range_worked TEXT,
      what_worked TEXT,
      what_didnt TEXT,
      new_tension TEXT,
      homework TEXT,
      media_url TEXT,
      progress_flag TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_lesson_log_student ON lesson_log(student_id, lesson_date DESC);`);
  ensured = true;
}

async function query(sql, params) {
  const p = getPool();
  if (!p) {
    const err = new Error('DB_NOT_CONFIGURED: в проекте не подключена база Postgres (нет POSTGRES_URL/DATABASE_URL). Подключите Storage → Postgres в настройках проекта Vercel.');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
  await ensureSchema(p);
  return p.query(sql, params);
}

module.exports = { query };
