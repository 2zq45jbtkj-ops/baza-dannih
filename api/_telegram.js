// Небольшой помощник для отправки сообщений через Telegram Bot API.
// Использует TELEGRAM_BOT_TOKEN — тот же бот (@your_vocal_teacher_bot), что
// у Mini App your_vocal. Не бросает исключения наружу — ошибка отправки не
// должна ломать сохранение урока/домашнего задания.
async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { ok: false, skipped: true };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    return await r.json();
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = { sendTelegramMessage };
