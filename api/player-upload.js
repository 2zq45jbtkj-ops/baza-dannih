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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  // @vercel/blob ждёт Fetch-подобный Request — ему нужен только .headers.get
  const requestLike = { headers: { get: (name) => req.headers[String(name).toLowerCase()] } };

  try {
    const jsonResponse = await handleUpload({
      body,
      request: requestLike,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload = clientPayload;
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
        }
        const scope = (payload && SCOPES.includes(payload.scope)) ? payload.scope : 'takes';

        // Клиент не должен уметь записать куда угодно: имя файла ему
        // задаём сами, оставляя от присланного только базовую часть.
        const safeName = String(pathname || 'audio').split('/').pop().slice(-80);

        return {
          allowedContentTypes: AUDIO_TYPES,
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_SIZE,
          pathname: `${scope}/${safeName}`,
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
