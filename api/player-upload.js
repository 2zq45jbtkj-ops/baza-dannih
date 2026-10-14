// POST /api/player-upload — выдаёт клиенту разовый токен на прямую
// загрузку файла в Vercel Blob (в обход лимита размера тела запроса
// у serverless-функций). Схема: браузер учителя загружает mp3/wav
// напрямую в Blob, а не через эту функцию — она только выдаёт токен
// и потом получает уведомление о завершении.
// Требует переменную окружения BLOB_READ_WRITE_TOKEN (появляется
// автоматически после создания Blob-хранилища в Storage → Vercel Blob).
const { handleUpload } = require('@vercel/blob/client');

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
    res.status(503).json({ error: 'Blob storage not configured — создайте Blob store в Storage на Vercel' });
    return;
  }

  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
  }

  // Адаптер: @vercel/blob ждёт Fetch-подобный Request (нужен только .headers.get)
  const requestLike = { headers: { get: (name) => req.headers[String(name).toLowerCase()] } };

  try {
    const jsonResponse = await handleUpload({
      body,
      request: requestLike,
      onBeforeGenerateToken: async (pathname) => {
        return {
          allowedContentTypes: ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave'],
          addRandomSuffix: true,
          maximumSizeInBytes: 60 * 1024 * 1024, // 60 МБ с запасом под wav
        };
      },
      onUploadCompleted: async () => {
        // Метаданные (студент/название/какая это дорожка) сохраняет
        // клиент отдельным запросом в /api/player-tracks после того,
        // как получит итоговый url — так же как handleUpload сам
        // возвращает url сразу в ответе на загрузку.
      },
    });
    res.status(200).json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
};
