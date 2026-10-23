// Проверка доступа для /api/*. Это НЕ функция Vercel: файлы в api/, чьё имя
// начинается с «_», в маршруты не превращаются и слот из лимита в 12 не
// занимают (как _db.js и _telegram.js) — иначе этот файл уронил бы весь деплой.
//
// До появления этого модуля серверной сессии у сайта не было вообще: браузер
// держал в localStorage только дату входа (bd_auth_ts), а сами ручки не
// проверяли ничего. Пароль от сайта закрывал страницу, но не API, так что
// GET /api/students отдавал всех учеников вместе с их кодами доступа, а
// GET /api/player-tracks?studentId=… — список песен любому, кто знал id
// (а id предсказуемы: s1, s3, s<timestamp>). Та же мысль уже записана в
// комментарии api/admin-auth.js про «проверить „он уже залогинен“ нечем».
//
// Два уровня:
//
// ПРЕПОДАВАТЕЛЬ — полный доступ. Токен выдаётся в обмен на пароль от сайта
//   (api/site-login.js) или на пару админ-ключей (api/admin-auth.js — ими
//   входит «Режим админа» в Telegram Mini App), клиент держит его в
//   localStorage и присылает в заголовке X-Site-Auth.
//
// УЧЕНИК — только свои песни в плеере. Выдаётся в обмен на код
//   (students.telegram_token) в player-tracks?action=auth, присылается в
//   X-Player-Session. Живёт 12 часов: постоянный код после входа перестаёт
//   ездить в каждом запросе, и утёкшая ссылка/лог перестают работать сами.
//
// Токены подписаны HMAC и в базе не хранятся — проверка не стоит запроса к
// Postgres (важно: на холодном старте ensureSchema и так подходит к лимиту
// 10с, см. queryRaw в _db.js), а смена SITE_PASSWORD разом отзывает все
// выданные сессии.
const { createHmac, timingSafeEqual } = require('crypto');

// 12 часов: ученик занимается дома за один присест, а клиент умеет молча
// перелогиниться по сохранённому коду, так что истечение он не замечает.
const STUDENT_TTL_SEC = 12 * 3600;

// Ключ подписи — пароль от сайта. Отдельной env-переменной намеренно нет:
// ещё одну строчку в настройках Vercel легко забыть проставить, а без неё
// модуль обязан отказывать всем (fail-closed), то есть забывчивость положила
// бы и сайт, и плеер. SITE_PASSWORD же задан там всегда — без него не
// работает сам вход на сайт.
function secret() {
  const s = process.env.SITE_PASSWORD;
  if (!s) {
    const err = new Error('SITE_PASSWORD не задан: нечем подписывать сессии, доступ закрыт');
    err.code = 'AUTH_NOT_CONFIGURED';
    throw err;
  }
  return s;
}

function sign(payload) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

// Сравнение за постоянное время — чтобы подпись нельзя было подобрать по
// времени ответа. Тот же мотив, что у safeEq в site-login.js/admin-auth.js.
function safeEq(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (!A.length || A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

function header(req, name) {
  return String((req.headers && req.headers[name]) || '');
}

/* ── Преподаватель ── */

// Токен постоянный, без срока — его задаёт клиент (index.html чистит
// localStorage через 30 дней, как и раньше делал с bd_auth_ts). Отзывается
// сменой пароля сайта.
function teacherToken() {
  return 't1.' + sign('teacher');
}

function isTeacher(req) {
  return safeEq(header(req, 'x-site-auth'), teacherToken());
}

// true — пускаем; false — ответ клиенту уже отправлен, вызывающему остаётся
// только выйти из обработчика.
function requireTeacher(req, res) {
  let ok = false;
  try {
    ok = isTeacher(req);
  } catch (err) {
    if (err.code !== 'AUTH_NOT_CONFIGURED') throw err;
    res.status(503).json({ error: err.message });
    return false;
  }
  if (!ok) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

/* ── Ученик ── */

function studentSession(studentId) {
  const exp = Math.floor(Date.now() / 1000) + STUDENT_TTL_SEC;
  const body = 's1.' + Buffer.from(String(studentId), 'utf8').toString('base64url') + '.' + exp;
  return body + '.' + sign(body);
}

// → { studentId } либо null, если сессии нет, подпись не сходится или вышел
// срок. studentId берётся ИЗ ПОДПИСАННОГО токена, а не из параметров запроса:
// подменив ?studentId=, чужие песни не получить.
function readStudentSession(req) {
  const parts = header(req, 'x-player-session').split('.');
  if (parts.length !== 4 || parts[0] !== 's1') return null;
  const body = parts.slice(0, 3).join('.');
  if (!safeEq(parts[3], sign(body))) return null;
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null;
  let studentId = '';
  try {
    studentId = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
  return studentId ? { studentId } : null;
}

// Заголовки с токенами нужно перечислить в Access-Control-Allow-Headers,
// иначе браузер зарежет кросс-доменный запрос (плеер урока живёт на своём
// домене) ещё на preflight — и это будет выглядеть как «сервер недоступен».
const CORS_HEADERS = 'Content-Type, X-Site-Auth, X-Player-Session';

module.exports = {
  teacherToken,
  isTeacher,
  requireTeacher,
  studentSession,
  readStudentSession,
  STUDENT_TTL_SEC,
  CORS_HEADERS,
};
