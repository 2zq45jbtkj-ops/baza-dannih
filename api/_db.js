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

  // Кабинет — блок «Анкета» (аккордеон из 7 секций), доп. поля поверх уже существующих
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS voice_type TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS genre TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS experience_level TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS stuck_note TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS tess_low TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS tess_high TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS register_break_low TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS register_break_high TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS baseline_range_low TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS baseline_range_high TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS baseline_tess_low TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS baseline_tess_high TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS baseline_register_break TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS lar_status TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS diagnosis TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS alcohol TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS pms_factor TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS structures JSONB DEFAULT '{}';`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS qualities JSONB DEFAULT '{}';`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS modes JSONB DEFAULT '{}';`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS anchors JSONB DEFAULT '{}';`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS metallic_percent INTEGER DEFAULT 32;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS reference_takes JSONB DEFAULT '[]';`);

  // Цель обучения и жанр — переведены на множественный выбор (было TEXT, стало TEXT[]).
  // Старые singular-колонки goal/genre остаются нетронутыми для обратной совместимости
  // со старым (неиспользуемым) кодом вкладки «Дневник занятий».
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS goals TEXT[] DEFAULT '{}';`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS genres TEXT[] DEFAULT '{}';`);

  // Справочники — общий (не привязанный к ученику) список вариантов для
  // полей вроде "Цель обучения"/"Жанр": какие варианты закреплены в основных
  // и какие добавлены преподавателем вручную. Встроенные ("core") варианты
  // не хранятся здесь — они всегда приходят из кода фронтенда.
  await p.query(`
    CREATE TABLE IF NOT EXISTS field_dicts (
      field_key TEXT PRIMARY KEY,
      pinned TEXT[] DEFAULT '{}',
      added TEXT[] DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // "На чём застряла" (stuck_note) заменена в Кабинете на "Репертуар" —
  // отдельная новая колонка, старая stuck_note не трогается/не удаляется
  // (данные там остаются на случай, если пригодятся отдельно).
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS repertoire TEXT;`);

  // Дневник занятий — реальная форма из «Кабинет ученика EVT.dc.html»
  // («Новая запись» + «Записи занятий»). Старые колонки effort_level/
  // range_worked/what_worked/what_didnt/new_tension/media_url/progress_flag
  // остаются нетронутыми (были частью прежней самодельной версии вкладки,
  // которая не соответствовала макету) — просто больше не используются
  // новым кодом. cvt_modes и homework — те же колонки, что и раньше,
  // переиспользуются под «Моды CVT» и «Домашнее задание» из нового макета.
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS topic TEXT;`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS work_low TEXT;`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS work_high TEXT;`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS goal TEXT;`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS structures TEXT[] DEFAULT '{}';`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS intensity INTEGER;`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS grade INTEGER;`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS anchors TEXT[] DEFAULT '{}';`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS new_problem TEXT;`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS takes JSONB DEFAULT '[]';`);
  await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();`);

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
