const resolveToken = (token) => token || process.env.TELEGRAM_BOT_TOKEN;

const getApiBase = (token) => {
  const resolved = resolveToken(token);
  return resolved ? `https://api.telegram.org/bot${resolved}` : null;
};

export const telegramFetch = async (method, body, token) => {
  const apiBase = getApiBase(token);
  if (!apiBase) {
    throw new Error('TELEGRAM_BOT_TOKEN nao definido');
  }
  const res = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Erro Telegram: ${res.status}`);
  }
  return data.result;
};

export const sendTelegramMessage = async (chatId, text, buttons = null, token = null, options = {}) => {
  const payload = {
    chat_id: chatId,
    text: text || ''
  };

  if (buttons && Array.isArray(buttons) && buttons.length > 0) {
    payload.reply_markup = {
      inline_keyboard: buttons.map((b) => ([
        { text: b.label || 'Opcao', callback_data: String(b.id) }
      ]))
    };
  }

  // Quote nativo. allow_sending_without_reply evita erro caso a mensagem
  // original tenha sido apagada — manda normal em vez de falhar.
  if (options?.replyToMessageId) {
    payload.reply_parameters = {
      message_id: Number(options.replyToMessageId),
      allow_sending_without_reply: true
    };
  }

  return telegramFetch('sendMessage', payload, token);
};

const telegramMediaMap = {
  image: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  document: { method: 'sendDocument', field: 'document' },
  audio: { method: 'sendAudio', field: 'audio' }
};

export const sendTelegramMedia = async ({
  chatId,
  mediaType,
  mediaUrl,
  caption = '',
  token = null,
  replyToMessageId = null
}) => {
  const normalizedType = String(mediaType || '').toLowerCase();
  const mediaConfig = telegramMediaMap[normalizedType] || telegramMediaMap.document;
  const payload = {
    chat_id: chatId,
    [mediaConfig.field]: mediaUrl
  };

  if (caption) {
    payload.caption = caption;
  }

  if (replyToMessageId) {
    payload.reply_parameters = {
      message_id: Number(replyToMessageId),
      allow_sending_without_reply: true
    };
  }

  return telegramFetch(mediaConfig.method, payload, token);
};

export const answerCallbackQuery = async (callbackQueryId, token = null) => {
  return telegramFetch('answerCallbackQuery', { callback_query_id: callbackQueryId }, token);
};

export const getUpdates = async (token, offset) => {
  const payload = { timeout: 25 };
  if (offset) payload.offset = offset;
  return telegramFetch('getUpdates', payload, token);
};
