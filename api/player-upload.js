// POST /api/player-upload — выдаёт браузеру разовый токен на прямую
// загрузку аудио в Vercel Blob. Файл летит из браузера в хранилище
// напрямую, минуя эту функцию: тело запроса у serverless ограничено
// ~4.5 МБ, и именно из-за этого раньше пришлось резать распевки на
// куски (api/warmups-chunk.js). При прямой загрузке лимита нет.
//
// Раньше обслуживал только дорожки плеера. Теперь — всё аудио проекта:
// распевки, референс-записи, записи с уроков и дорожки. Так аудио
// перестаёт лежать base64-строками внутри Postgres, где оно съедало
// почти всю бесплатную квоту Neon (~0.5 ГБ, то есть около 130 файлов
// на всю базу). В базе остаётся только ссылка.
//
// Имя файла в хранилище: <scope>/<что прислал клиент>. Клиент передаёт
// scope в clientPayload; он же определяет, какие типы файлов пускать.
// Требует BLOB_READ_WRITE_TOKEN (появляется сам после создания Blob
// store в Storage на Vercel).
const { handleUpload } = require('@vercel/blob/client');
const auth = require('./_auth');

const SCOPES = ['warmups', 'takes', 'reference', 'tracks', 'lessons'];

// Записи с микрофона браузер отдаёт в webm (Chrome) или mp4 (Safari),
// а готовые дорожки и распевки приходят файлами как mp3/wav.
const AUDIO_TYPES = [
  'audio/mpeg', 'audio/mp3',
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/webm', 'audio/ogg',
  'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'video/webm', 'video/mp4'
];

const MAX_SIZE = 80 * 1024 * 1024;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', auth.CORS_HEADERS);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ error: 'Хранилище не подключено — создайте Blob store в разделе Storage на Vercel' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }

  // Токен на запись в хранилище — только преподавателю: без проверки любой
  // желающий заливал бы файлы в Blob за счёт владельца аккаунта.
  //
  // Токен едет в clientPayload, а не в заголовке X-Site-Auth: загрузку
  // начинает VercelBlob.upload() из браузера, а у него в опциях заголовков
  // нет вообще (см. UploadOptions в @vercel/blob/client) — добавить свой
  // просто некуда. clientPayload же задуман ровно как «передать своё на свою
  // же ручку» и приезжает сюда в body.payload. Синтетический req ниже нужен,
  // чтобы не дублировать разбор 401/503 и сравнение за постоянное время.
  //
  // Проверяется ТОЛЬКО запрос за токеном. Второй тип тела —
  // blob.upload-completed — присылают серверы Vercel Blob, а не браузер, и
  // никакого нашего токена у них взяться неоткуда; закрой обработчик целиком,
  // и этот коллбэк начал бы получать 401. Он не беззащитен: handleUpload
  // сверяет HMAC-подпись из x-vercel-signature с BLOB_READ_WRITE_TOKEN —
  // и сверяет её по-настоящему только с заглушкой заголовков ниже.
  if (body && body.type === 'blob.generate-client-token') {
    // Заголовок проверяем первым и clientPayload к нему только запасной:
    // дев-прокси .claude/server.js подставляет X-Site-Auth во всё, что
    // проксирует, а localStorage на localhost пуст — иначе загрузка файлов
    // работала бы на проде и падала с 401 локально.
    const sent = String(req.headers['x-site-auth'] || '')
      || (body.payload && body.payload.clientPayload) || '';
    if (!auth.requireTeacher({ headers: { 'x-site-auth': sent } }, res)) return;
  }

  // @vercel/blob ждёт Fetch-подобный Request, но читает заголовки двумя
  // разными способами и выбирает по наличию поля credentials:
  //   "credentials" in request ? request.headers.get(name) : request.headers[name]
  // У нашей заглушки credentials нет, поэтому на ветке blob.upload-completed
  // библиотека лезет за подписью как за обычным свойством. Пока здесь был
  // только .get(), x-vercel-signature приходил undefined → пустая строка →
  // «Missing callback signature» → 400 на каждый коллбэк от серверов Blob,
  // то есть защита подписью, на которую ссылается комментарий выше, не
  // работала вовсе. Отдаём оба способа сразу: сами заголовки — своими
  // свойствами, .get() — через прототип (так настоящий заголовок не
  // затрёт метод).
  const requestLike = {
    headers: Object.assign(
      Object.create({ get: (name) => req.headers[String(name).toLowerCase()] }),
      req.headers
    ),
  };

  try {
    const jsonResponse = await handleUpload({
      body,
      request: requestLike,
      onBeforeGenerateToken: async (pathname) => {
        // Папку задаёт клиент первым аргументом upload(). Вернуть pathname
        // отсюда нельзя — handleUpload его игнорирует (проверено сквозным
        // тестом: файл лёг в корень вместо warmups/). Поэтому здесь путь
        // не назначаем, а проверяем — иначе клиент писал бы куда угодно.
        const scope = String(pathname || '').split('/')[0];
        if (!SCOPES.includes(scope)) {
          throw new Error('Недопустимая папка для загрузки: ' + (scope || 'не указана'));
        }
        return {
          allowedContentTypes: AUDIO_TYPES,
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_SIZE,
          // Иначе handleUpload подставит сюда clientPayload, а там лежит
          // токен преподавателя: он уехал бы внутрь клиентского токена и
          // дальше на серверы Blob в коллбэке. Проверили — и забыли.
          tokenPayload: null,
        };
      },
      onUploadCompleted: async () => {
        // Метаданные (какой ученик, какая распевка, длительность) пишет
        // сам клиент отдельным запросом, когда получит итоговый url —
        // handleUpload возвращает его сразу в ответе на загрузку.
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
};
