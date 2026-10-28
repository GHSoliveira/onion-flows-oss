import adapter from '../../db/DatabaseAdapter.js';
import { generateId } from '../utils/helpers.js';

const COLLECTION = 'chatMessages';
const DEFAULT_MESSAGE_LIMIT = 500;
const MAX_MESSAGE_LIMIT = 2000;

const normalizeDateValue = (value) => {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

const normalizeLimit = (value, fallback = DEFAULT_MESSAGE_LIMIT) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_MESSAGE_LIMIT);
};

const isUserFacingMessage = (message) => String(message?.sender || '').toLowerCase() !== 'system';

const compactMessage = (message) => {
  if (!message || typeof message !== 'object') return null;
  return {
    id: message.id || message.messageId || null,
    messageId: message.messageId || message.id || null,
    sender: message.sender || null,
    text: message.text || '',
    media: message.media || null,
    buttons: message.buttons || null,
    meta: message.meta || null,
    timestamp: message.timestamp || message.createdAt || null,
    providerMessageId: message.providerMessageId || message.meta?.providerMessageId || null,
    deliveryStatus: message.deliveryStatus || message.meta?.deliveryStatus || null,
    deliveryStatusAt: message.deliveryStatusAt || message.meta?.deliveryStatusAt || null
  };
};

export const normalizeChatMessage = (chat, message = {}) => {
  const messageId = String(message.messageId || message.id || generateId('msg'));
  const timestamp = normalizeDateValue(message.timestamp || message.createdAt);
  const providerMessageId = message.providerMessageId || message.meta?.providerMessageId || null;
  const deliveryStatus = message.deliveryStatus || message.meta?.deliveryStatus || null;
  const deliveryStatusAt = message.deliveryStatusAt || message.meta?.deliveryStatusAt || null;

  return {
    id: `${chat.id}_${messageId}`,
    tenantId: chat.tenantId || null,
    chatId: chat.id,
    messageId,
    sender: message.sender || null,
    text: message.text || '',
    media: message.media || null,
    buttons: message.buttons || null,
    meta: message.meta || null,
    replyTo: message.replyTo || null,
    timestamp,
    providerMessageId,
    deliveryStatus,
    deliveryStatusAt,
    createdAt: message.createdAt || timestamp,
    updatedAt: new Date().toISOString()
  };
};

export const toLegacyChatMessage = (storedMessage) => {
  if (!storedMessage) return null;
  return {
    id: storedMessage.messageId || storedMessage.id,
    sender: storedMessage.sender || null,
    text: storedMessage.text || '',
    media: storedMessage.media || null,
    buttons: storedMessage.buttons || null,
    meta: storedMessage.meta || null,
    replyTo: storedMessage.replyTo || null,
    timestamp: storedMessage.timestamp || storedMessage.createdAt || null,
    providerMessageId: storedMessage.providerMessageId || null,
    deliveryStatus: storedMessage.deliveryStatus || null,
    deliveryStatusAt: storedMessage.deliveryStatusAt || null
  };
};

// Busca uma mensagem específica do chat pela id legacy (messageId). Usado para
// resolver a mensagem que está sendo respondida (reply/quote), já que o
// activeChats.messages embutido pode estar desatualizado — a fonte real é esta
// coleção.
export const getChatMessageById = async ({ chatId, tenantId = null, messageId }) => {
  if (!chatId || !messageId) return null;
  const query = { chatId, messageId: String(messageId) };
  if (tenantId) query.tenantId = tenantId;
  const row = await adapter.findOne(COLLECTION, query, { projection: { _id: 0 } });
  return row ? toLegacyChatMessage(row) : null;
};

// Busca uma mensagem do chat pelo providerMessageId (id no WhatsApp/Telegram).
// Usado para resolver reply inbound: o cliente cita uma mensagem usando o id
// do provedor, e precisamos achar a mensagem correspondente no nosso histórico.
export const getChatMessageByProviderId = async ({ chatId, tenantId = null, providerMessageId }) => {
  if (!chatId || !providerMessageId) return null;
  const pid = String(providerMessageId);
  const query = {
    chatId,
    $or: [
      { providerMessageId: pid },
      { 'meta.providerMessageId': pid }
    ]
  };
  if (tenantId) query.tenantId = tenantId;
  const row = await adapter.findOne(COLLECTION, query, { projection: { _id: 0 } });
  return row ? toLegacyChatMessage(row) : null;
};

export const appendChatMessage = async (chatOrId, message = {}, options = {}) => {
  const chat = typeof chatOrId === 'string'
    ? await adapter.findOne('activeChats', { id: chatOrId }, { projection: { _id: 0 } })
    : chatOrId;

  if (!chat?.id) {
    throw new Error('Chat nao encontrado para adicionar mensagem');
  }

  const normalized = normalizeChatMessage(chat, message);
  const existing = await adapter.findOne(COLLECTION, {
    tenantId: normalized.tenantId,
    chatId: normalized.chatId,
    messageId: normalized.messageId
  }, { projection: { _id: 0, id: 1 } });

  if (!existing) {
    await adapter.insertOne(COLLECTION, normalized);
  }

  const now = new Date().toISOString();
  const legacyCount = Array.isArray(chat.messages) ? chat.messages.length : 0;
  const currentCount = Number(chat.messageCount || 0) || legacyCount;
  const summarySet = {
    updatedAt: now,
    lastMessageAt: normalized.timestamp,
    messageCount: currentCount + (existing ? 0 : 1)
  };

  if (isUserFacingMessage(normalized)) {
    summarySet.lastMessage = compactMessage(toLegacyChatMessage(normalized));
  }

  const shouldIncrementUnread = !existing
    && String(normalized.sender || '').toLowerCase() === 'user'
    && options.incrementUnread !== false;

  await adapter.updateOne(
    'activeChats',
    { id: chat.id },
    {
      $set: summarySet,
      ...(shouldIncrementUnread ? { $inc: { unreadByAgentCount: 1 } } : {})
    }
  );

  return {
    chat: {
      ...chat,
      ...summarySet,
      unreadByAgentCount: Number(chat.unreadByAgentCount || 0) + (shouldIncrementUnread ? 1 : 0)
    },
    message: toLegacyChatMessage(normalized),
    inserted: !existing
  };
};

export const getChatMessages = async (chatId, options = {}) => {
  if (!chatId) return [];
  const limit = normalizeLimit(options.limit);
  const query = { chatId };
  if (options.tenantId) query.tenantId = options.tenantId;
  if (options.before || options.after) {
    query.timestamp = {};
    if (options.before) query.timestamp.$lt = normalizeDateValue(options.before);
    if (options.after) query.timestamp.$gt = normalizeDateValue(options.after);
  }

  const sortDirection = options.sort === 'desc' ? -1 : 1;
  const rows = await adapter.findMany(COLLECTION, {
    query,
    projection: { _id: 0 },
    sort: { timestamp: sortDirection, createdAt: sortDirection },
    limit
  });

  const messages = (Array.isArray(rows) ? rows : []).map(toLegacyChatMessage).filter(Boolean);
  return options.sort === 'desc' ? messages.reverse() : messages;
};

export const getLastChatMessage = async (chatId, options = {}) => {
  if (!chatId) return null;
  const rows = await adapter.findMany(COLLECTION, {
    query: {
      chatId,
      ...(options.tenantId ? { tenantId: options.tenantId } : {})
    },
    projection: { _id: 0 },
    sort: { timestamp: -1, createdAt: -1 },
    limit: 1
  });
  return rows?.[0] ? toLegacyChatMessage(rows[0]) : null;
};

export const hydrateChatWithMessages = async (chat, options = {}) => {
  if (!chat?.id) return chat;
  const storedMessages = await getChatMessages(chat.id, {
    tenantId: chat.tenantId,
    limit: options.limit,
    before: options.before,
    after: options.after
  });

  const legacyMessages = Array.isArray(chat.messages) ? chat.messages : [];
  const byId = new Map();
  [...legacyMessages, ...storedMessages].forEach((message) => {
    const key = String(message?.id || message?.messageId || `${message?.sender || ''}_${message?.timestamp || ''}_${message?.text || ''}`);
    if (key) byId.set(key, message);
  });
  const merged = [...byId.values()]
    .sort((a, b) => new Date(a?.timestamp || a?.createdAt || 0) - new Date(b?.timestamp || b?.createdAt || 0));
  return {
    ...chat,
    messages: merged.slice(-normalizeLimit(options.limit, merged.length || DEFAULT_MESSAGE_LIMIT))
  };
};

export const hydrateChatsWithMessages = async (chats = [], options = {}) => (
  Promise.all((Array.isArray(chats) ? chats : []).map((chat) => hydrateChatWithMessages(chat, options)))
);

export const updateChatMessageDeliveryStatusByProvider = async ({
  providerMessageId,
  status,
  deliveryStatusAt,
  errors = null
}) => {
  if (!providerMessageId || !status) return null;
  const message = await adapter.findOne(COLLECTION, {
    $or: [
      { providerMessageId: String(providerMessageId) },
      { 'meta.providerMessageId': String(providerMessageId) }
    ]
  }, { projection: { _id: 0 } });

  if (!message?.id) return null;

  const nextMeta = {
    ...(message.meta || {}),
    providerMessageId,
    deliveryStatus: status,
    deliveryStatusAt,
    deliveryErrors: status === 'failed' ? (errors || null) : null
  };
  const nextMessage = {
    ...message,
    providerMessageId,
    deliveryStatus: status,
    deliveryStatusAt,
    meta: nextMeta,
    updatedAt: new Date().toISOString()
  };

  await adapter.updateOne(COLLECTION, { id: message.id }, { $set: nextMessage });

  const chat = await adapter.findOne('activeChats', { id: message.chatId }, {
    projection: { _id: 0, id: 1, tenantId: 1, lastMessage: 1 }
  });
  if (chat?.lastMessage && String(chat.lastMessage.providerMessageId || chat.lastMessage.meta?.providerMessageId || '') === String(providerMessageId)) {
    await adapter.updateOne('activeChats', { id: chat.id }, {
      $set: {
        lastMessage: compactMessage(toLegacyChatMessage(nextMessage)),
        updatedAt: new Date().toISOString()
      }
    });
  }

  return {
    chatId: message.chatId,
    message: toLegacyChatMessage(nextMessage)
  };
};

export const deleteChatMessagesByChatIds = async ({ tenantId, chatIds = [] }) => {
  const ids = (Array.isArray(chatIds) ? chatIds : []).filter(Boolean);
  if (!ids.length) return 0;
  const result = await adapter.deleteMany(COLLECTION, {
    ...(tenantId ? { tenantId } : {}),
    chatId: { $in: ids }
  });
  return result?.deletedCount || 0;
};
