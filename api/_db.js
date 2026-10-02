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

  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS articulatory JSONB DEFAULT '[]';`);

  ensured = true;

    // Дневник занятий — редизайн формы «Новая запись» (структурированные шаги,
    // список новых проблем, структурированные домашние задания). Старые
    // колонки structures/cvt_modes/anchors/new_problem/homework не трогаются —
    // ими продолжает пользоваться инлайн-редактирование старых записей в
    // «Записи занятий» (не входит в этот редизайн).
    await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS lesson_steps JSONB DEFAULT '[]';`);
    await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS new_problems TEXT[] DEFAULT '{}';`);
    await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS hw_items JSONB DEFAULT '[]';`);
    await p.query(`ALTER TABLE lesson_log ADD COLUMN IF NOT EXISTS hw_sent BOOLEAN DEFAULT false;`);

  // Telegram-интеграция: уникальный непредсказуемый токен для каждого ученика.
  // Ученик вводит его в Telegram Mini App один раз — бот его запоминает.
  await p.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS telegram_token TEXT;`);
  await p.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_students_telegram_token ON students(telegram_token) WHERE telegram_token IS NOT NULL;`);
  // Генерируем токены для существующих учеников без токена (gen_random_uuid — встроен в Postgres 13+)
  await p.query(`UPDATE students SET telegram_token = gen_random_uuid()::text WHERE telegram_token IS NULL;`);

  // Дистанционный плеер: минусовки ученика, раздельно вокал/инструментал
  // (загружаются вручную — уже разделены заранее, например в Moises).
  // Файлы лежат в Vercel Blob, здесь хранится только метаданные + ссылки.
  await p.query(`
    CREATE TABLE IF NOT EXISTS player_tracks (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      vocal_url TEXT,
      instrumental_url TEXT,
      duration_sec NUMERIC,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_player_tracks_student ON player_tracks(student_id, created_at DESC);`);
  // Приватные метки преподавателя на треке — {id, t, label, createdAt}[].
  // Ученику никогда не отдаются (see api/student-public.js — там их просто нет в ответе).
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS markers JSONB DEFAULT '[]';`);

  // Голосовые аттракторы — оценка критичности отклонения от нейтрали (1–10)
  // по каждой структуре, если выбрано значение, отличное от neutral.
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS structure_severity JSONB DEFAULT '{}';`);

  // Telegram chat_id ученика — записывается Mini App при открытии (см.
  // POST /api/student-public), нужен чтобы бот мог написать ученику сам,
  // без того чтобы он первым написал боту. Используется при отправке
  // домашнего задания (см. api/lessons.js).
  await p.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;`);

  // PDF ученика (карточка-передача): абонемент — вручную вводится размер
  // и дата начала текущего абонемента, "осталось" считается на лету как
  // package_size минус число занятий с package_start_date.
  await p.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS package_size INTEGER;`);
  await p.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS package_start_date DATE;`);

  // PDF ученика: «Песни в работе» — список песен с тональностью/статусом,
  // отдельно от старого текстового repertoire (intake, "что хочет разбирать")
  // и от локального моканного стейта вкладки "Репертуар" (future[]).
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS repertoire_songs JSONB DEFAULT '[]';`);
  // PDF ученика: «Проблемы» — какие из new_problems дневника отмечены решёнными
  // (и в каком месяце), чтобы отличать "Открытые" от "Решённые".
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS resolved_problems JSONB DEFAULT '[]';`);
  // PDF ученика: две короткие заметки преподавателя, которых нет больше нигде
  // в Кабинете — заполняются/правятся прямо в предпросмотре PDF.
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS current_focus TEXT;`);
  await p.query(`ALTER TABLE student_intake ADD COLUMN IF NOT EXISTS lesson_considerations TEXT;`);

  // Вкладка «Репертуар» (полная версия — список песен ученика с тёмным
  // плеером: раздельные дорожки «Голос»/«Музыка», своя громкость на каждую,
  // метки, текст песни, заметки). Использует ранее заведённую под дистанционный
  // плеер таблицу player_tracks (vocal_url/instrumental_url/title/markers уже
  // были) — просто добавляем к ней остальные поля песни. vocal_url/instrumental_url
  // пока хранят data: URL (base64), как и остальные записи в проекте (см.
  // referenceTakes/takes) — переход на Vercel Blob осознанно отложен, см. ПРОМТ.
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS artist TEXT;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS song_key TEXT;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'work';`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS start_date DATE;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS moises_link TEXT;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS notes TEXT;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS lyrics TEXT;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS peaks JSONB DEFAULT '[]';`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS volumes JSONB DEFAULT '{"voice":80,"music":80}';`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS voice_name TEXT;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS music_name TEXT;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS voice_duration_sec NUMERIC;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS music_duration_sec NUMERIC;`);
  await p.query(`ALTER TABLE player_tracks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();`);
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

// Тот же пул, но без ensureSchema() — для горячих путей, которым заведомо
// достаточно старых, давно существующих колонок (например api/recording.js,
// публичная страница по QR: на холодном старте функции ensureSchema гоняет
// ~60 последовательных ALTER TABLE к Neon, и вместе с его собственным
// пробуждением на free-tier это реально подходит к лимиту в 10с на Vercel
// Hobby — отсюда "сервер не отвечает" при редком/первом за долгое время
// открытии QR).
async function queryRaw(sql, params) {
  const p = getPool();
  if (!p) {
    const err = new Error('DB_NOT_CONFIGURED: в проекте не подключена база Postgres (нет POSTGRES_URL/DATABASE_URL). Подключите Storage → Postgres в настройках проекта Vercel.');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }
  return p.query(sql, params);
}

module.exports = { query, queryRaw };
