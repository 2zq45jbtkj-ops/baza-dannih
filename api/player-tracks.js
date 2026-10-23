// /api/player-tracks — вкладка «Репертуар»: список песен ученика с тёмным
// плеером (раздельные дорожки «Голос»/«Музыка», метки, текст песни, заметки).
// GET    ?studentId=xxx   → список песен ученика (по дате добавления, старые сверху)
// GET    ?inline=<songId>&kind=voice|music → одна legacy-дорожка целиком
//   (base64 из базы) — только для переноса старых песен в Blob, см. SONG_COLS
// POST   { studentId }    → создать пустую песню «Новая песня» и сразу вернуть её
// POST   ?action=auth { code } → вход ученика в плеер, см. ниже
// PATCH  ?id=xxx  { любые поля песни } → частично обновить
// DELETE ?id=xxx           → удалить
//
// Вход ученика живёт здесь же, а не отдельным файлом api/player-auth.js:
// на плане Hobby у проекта лимит в 12 функций, и отдельный файл ради
// сорока строк стоил бы целый слот (из-за такого перебора деплой уже
// однажды падал целиком). Оба эндпоинта — про плеер и обращаются к одной
// и той же паре таблиц, так что разнесение было искусственным.
const { query } = require('./_db');
const { randomUUID, randomBytes } = require('crypto');

// Короткий код входа в плеер. students.telegram_token — это UUID на 36
// символов: боту и Mini App он годится, потому что приезжает готовой
// ссылкой, но ученик, открывший плеер на телефоне, набрать его руками не
// может. Поэтому у ученика есть ещё короткий код, он лежит в lesson_rooms.
// Алфавит без 0/O/1/I/L — эти символы не различить, когда код диктуют
// голосом на уроке.
const ROOM_ALPHABET = 'ACDEFGHJKMNPQRSTUVWXYZ23456789';
function makeRoomCode() {
  let out = '';
  while (out.length < 6) {
    // Отбрасываем байты >= 240: 240 = 8×30, так что остаток по модулю 30
    // распределён ровно. Иначе первые символы алфавита выпадали бы чаще.
    for (const byte of randomBytes(12)) {
      if (byte >= 240) continue;
      out += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
      if (out.length === 6) break;
    }
  }
  return out;
}

// Явный список колонок вместо SELECT */RETURNING *. У дорожек, залитых до
// переезда на Vercel Blob, в vocal_url/instrumental_url лежит сам файл в
// base64 — песня на 3 минуты это ~9 МБ, и весь объём уезжал в каждом ответе
// при каждом открытии вкладки. Приложение для онлайн-уроков читает этот же
// эндпоинт с планшета, иногда по мобильному интернету, так что терпеть это
// стало нельзя. Вырезаем такие ссылки прямо в SQL (из Postgres они даже не
// выходят) и вместо них ставим флаг inline: по нему клиент показывает
// «нужно перезалить файл», а перенос догружает файл по одному — через
// ветку ?inline=<songId>&kind=voice|music ниже.
// Короткие https-ссылки на Blob проходят насквозь.
//
// ВАЖНО: любая новая колонка player_tracks должна быть добавлена и сюда,
// иначе она просто не доедет до клиента (та же грабля, что описана в
// CLAUDE.md про SELECT/INSERT/UPDATE).
const SONG_COLS = `
  id, student_id, title, artist, song_key, status, start_date, moises_link,
  notes, lyrics, peaks, peaks_voice, peaks_music, markers, volumes,
  voice_name, music_name, voice_duration_sec, music_duration_sec,
  pitch_semitones, tempo_pct, lyric_times, created_at,
  CASE WHEN vocal_url        LIKE 'data:%' THEN NULL ELSE vocal_url        END AS vocal_url,
  CASE WHEN instrumental_url LIKE 'data:%' THEN NULL ELSE instrumental_url END AS instrumental_url,
  COALESCE(vocal_url        LIKE 'data:%', false) AS voice_inline,
  COALESCE(instrumental_url LIKE 'data:%', false) AS music_inline
`;

function stemToJson(row, kind) {
  const url = kind === 'voice' ? row.vocal_url : row.instrumental_url;
  const inline = kind === 'voice' ? row.voice_inline === true : row.music_inline === true;
  if (!url && !inline) return null;
  const name = kind === 'voice' ? row.voice_name : row.music_name;
  const dur = kind === 'voice' ? row.voice_duration_sec : row.music_duration_sec;
  return {
    name: name || '',
    url: url || '',
    durationSec: dur != null ? Number(dur) : 0,
    // inline — файл есть, но лежит base64 в базе и сюда не отдан.
    // Играть нельзя, нужно перезалить или прогнать перенос.
    inline,
  };
}

function rowToJson(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    title: row.title,
    artist: row.artist || '',
    key: row.song_key || '',
    status: row.status || 'work',
    startDate: row.start_date instanceof Date ? row.start_date.toISOString().slice(0, 10) : (row.start_date || ''),
    moisesLink: row.moises_link || '',
    notes: row.notes || '',
    lyrics: row.lyrics || '',
    voice: stemToJson(row, 'voice'),
    music: stemToJson(row, 'music'),
    peaks: row.peaks || [],
    peaksVoice: row.peaks_voice || [],
    peaksMusic: row.peaks_music || [],
    markers: row.markers || [],
    volumes: row.volumes || { voice: 80, music: 80 },
    pitchSemitones: row.pitch_semitones != null ? Number(row.pitch_semitones) : 0,
    tempoPct: row.tempo_pct != null ? Number(row.tempo_pct) : 100,
    lyricTimes: row.lyric_times || [],
    createdAt: row.created_at,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET') {
      // Одна дорожка по требованию, целиком. Нужна только для legacy-песен,
      // залитых до переезда на Blob: в общий список их base64 не попадает
      // (см. SONG_COLS), а переносу нужно достать файл, чтобы переложить его
      // в хранилище. Тот же приём, что ?audio= в api/warmups.js.
      const inlineId = (req.query && req.query.inline) || url.searchParams.get('inline');
      if (inlineId) {
        const kind = ((req.query && req.query.kind) || url.searchParams.get('kind')) === 'music' ? 'music' : 'voice';
        const col = kind === 'music' ? 'instrumental_url' : 'vocal_url';
        const ri = await query(`SELECT ${col} AS data_url FROM player_tracks WHERE id = $1`, [inlineId]);
        const dataUrl = ri.rows.length ? ri.rows[0].data_url : null;
        if (!dataUrl || !String(dataUrl).startsWith('data:')) {
          res.status(404).json({ error: 'inline audio not found' });
          return;
        }
        res.status(200).json({ dataUrl });
        return;
      }

      const studentId = (req.query && req.query.studentId) || url.searchParams.get('studentId');
      if (!studentId) { res.status(400).json({ error: 'studentId required' }); return; }
      const r = await query(
        `SELECT ${SONG_COLS} FROM player_tracks WHERE student_id = $1 ORDER BY created_at ASC`,
        [studentId]
      );
      res.status(200).json({ songs: r.rows.map(rowToJson) });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
      }
      const b = body || {};

      const action = (req.query && req.query.action) || url.searchParams.get('action');
      // Короткий код ученика: выдать существующий или перевыдать новый.
      // Дёргает преподаватель из карточки, ученик сюда не обращается.
      if (action === 'room') {
        const studentId = String(b.studentId || '').trim();
        if (!studentId) { res.status(400).json({ error: 'studentId required' }); return; }
        const st = await query('SELECT id FROM students WHERE id = $1', [studentId]);
        if (!st.rows.length) { res.status(404).json({ error: 'student not found' }); return; }

        if (b.regenerate) {
          // Старый код перестаёт пускать сразу же — так же, как «↻» у
          // telegram_token. Иначе отозвать выданный код было бы нечем.
          await query('DELETE FROM lesson_rooms WHERE student_id = $1', [studentId]);
        } else {
          const cur = await query(
            'SELECT code FROM lesson_rooms WHERE student_id = $1 ORDER BY created_at DESC LIMIT 1',
            [studentId]
          );
          if (cur.rows.length) { res.status(200).json({ code: cur.rows[0].code }); return; }
        }

        // code — PRIMARY KEY, так что от совпадения спасает сама база, а не
        // предварительная проверка: между SELECT и INSERT код мог бы занять
        // параллельный запрос.
        for (let attempt = 0; attempt < 6; attempt++) {
          const ins = await query(
            `INSERT INTO lesson_rooms (code, student_id) VALUES ($1, $2)
             ON CONFLICT (code) DO NOTHING RETURNING code`,
            [makeRoomCode(), studentId]
          );
          if (ins.rows.length) { res.status(200).json({ code: ins.rows[0].code }); return; }
        }
        res.status(500).json({ error: 'не удалось подобрать свободный код' });
        return;
      }

      if (action === 'auth') {
        // Пускаем по двум видам кода. Длинный UUID (students.telegram_token)
        // — тот же, что открывает Telegram-бота с ДЗ; приезжает ссылкой.
        // Короткий шестисимвольный (lesson_rooms.code) — тот, что ученик
        // набирает руками на телефоне. Любой из них отзывается кнопкой «↻»
        // в карточке, и старый сразу перестаёт пускать.
        const code = String(b.code || '').trim();
        if (!code) { res.status(400).json({ error: 'code required' }); return; }

        let r = await query('SELECT id, name FROM students WHERE telegram_token = $1', [code]);
        if (!r.rows.length) {
          r = await query(
            `SELECT s.id, s.name FROM lesson_rooms lr
               JOIN students s ON s.id = lr.student_id
              WHERE lr.code = $1 AND (lr.expires_at IS NULL OR lr.expires_at > now())`,
            [code.toUpperCase()]
          );
        }
        if (!r.rows.length) {
          // Та же искусственная задержка, что в site-login.js и admin-auth.js:
          // без неё по времени ответа видно, существует код или нет.
          await new Promise(resolve => setTimeout(resolve, 400));
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        res.status(200).json({ ok: true, studentId: r.rows[0].id, name: r.rows[0].name });
        return;
      }

      if (!b.studentId) { res.status(400).json({ error: 'studentId required' }); return; }
      const id = 'song' + randomUUID();
      const r = await query(
        `INSERT INTO player_tracks (id, student_id, title, status, start_date, volumes)
         VALUES ($1,$2,$3,$4, CURRENT_DATE, '{"voice":80,"music":80}')
         RETURNING ${SONG_COLS}`,
        [id, b.studentId, 'Новая песня', 'work']
      );
      res.status(200).json({ song: rowToJson(r.rows[0]) });
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
      const has = k => Object.prototype.hasOwnProperty.call(b, k);

      const cols = [];
      const vals = [];
      let i = 1;

      if (has('title')) { cols.push(`title = $${i++}`); vals.push(String(b.title || '').trim() || 'Без названия'); }
      if (has('artist')) { cols.push(`artist = $${i++}`); vals.push(b.artist || null); }
      if (has('key')) { cols.push(`song_key = $${i++}`); vals.push(b.key || null); }
      if (has('status')) { cols.push(`status = $${i++}`); vals.push(b.status || 'work'); }
      if (has('startDate')) { cols.push(`start_date = $${i++}`); vals.push(b.startDate || null); }
      if (has('moisesLink')) { cols.push(`moises_link = $${i++}`); vals.push(b.moisesLink || null); }
      if (has('notes')) { cols.push(`notes = $${i++}`); vals.push(b.notes || null); }
      if (has('lyrics')) { cols.push(`lyrics = $${i++}`); vals.push(b.lyrics || null); }
      if (has('markers')) { cols.push(`markers = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.markers) ? b.markers : [])); }
      if (has('peaks')) { cols.push(`peaks = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.peaks) ? b.peaks : [])); }
      if (has('peaksVoice')) { cols.push(`peaks_voice = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.peaksVoice) ? b.peaksVoice : [])); }
      if (has('peaksMusic')) { cols.push(`peaks_music = $${i++}`); vals.push(JSON.stringify(Array.isArray(b.peaksMusic) ? b.peaksMusic : [])); }
      if (has('volumes')) { cols.push(`volumes = $${i++}`); vals.push(JSON.stringify(b.volumes || { voice: 80, music: 80 })); }
      // Тональность, темп и разметка текста — это то, что пишет ещё и
      // приложение для онлайн-уроков. Границы специально узкие (−12..12,
      // 50..150): значения приходят с другого проекта, и класть в базу то,
      // на чём потом захлебнётся плеер, не хочется.
      if (has('pitchSemitones')) {
        const n = Math.round(Number(b.pitchSemitones) || 0);
        cols.push(`pitch_semitones = $${i++}`); vals.push(Math.max(-12, Math.min(12, n)));
      }
      if (has('tempoPct')) {
        const n = Math.round(Number(b.tempoPct) || 100);
        cols.push(`tempo_pct = $${i++}`); vals.push(Math.max(50, Math.min(150, n)));
      }
      if (has('lyricTimes')) {
        const src = Array.isArray(b.lyricTimes) ? b.lyricTimes : [];
        const clean = src
          .filter(m => m && Number.isFinite(Number(m.t)))
          .map(m => ({ i: Math.max(0, Math.round(Number(m.i) || 0)), t: Math.max(0, Number(m.t)), text: String(m.text || '').slice(0, 300) }))
          .sort((a, b2) => a.t - b2.t);
        cols.push(`lyric_times = $${i++}`); vals.push(JSON.stringify(clean));
      }
      if (has('voice')) {
        const v = b.voice;
        cols.push(`vocal_url = $${i++}`); vals.push(v ? v.url : null);
        cols.push(`voice_name = $${i++}`); vals.push(v ? (v.name || '') : null);
        cols.push(`voice_duration_sec = $${i++}`); vals.push(v ? (v.durationSec || 0) : null);
      }
      if (has('music')) {
        const m = b.music;
        cols.push(`instrumental_url = $${i++}`); vals.push(m ? m.url : null);
        cols.push(`music_name = $${i++}`); vals.push(m ? (m.name || '') : null);
        cols.push(`music_duration_sec = $${i++}`); vals.push(m ? (m.durationSec || 0) : null);
      }

      if (!cols.length) {
        const cur = await query(`SELECT ${SONG_COLS} FROM player_tracks WHERE id = $1`, [id]);
        if (!cur.rows[0]) { res.status(404).json({ error: 'not found' }); return; }
        res.status(200).json({ song: rowToJson(cur.rows[0]) });
        return;
      }

      cols.push(`updated_at = now()`);
      vals.push(id);
      const r = await query(`UPDATE player_tracks SET ${cols.join(', ')} WHERE id = $${i} RETURNING ${SONG_COLS}`, vals);
      if (!r.rows.length) { res.status(404).json({ error: 'not found' }); return; }
      res.status(200).json({ song: rowToJson(r.rows[0]) });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.query && req.query.id) || url.searchParams.get('id');
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      await query('DELETE FROM player_tracks WHERE id = $1', [id]);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.code === 'DB_NOT_CONFIGURED' ? 503 : 500;
    res.status(status).json({ error: err.message || String(err) });
  }
};
