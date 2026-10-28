import adapter from '../../db/DatabaseAdapter.js';
import { addUserMessage, addBotMessage, applyUserInput, getChatById, runFlow, startChatFlow, tryHandleGlobalCommand } from './flowRunner.js';
import { isTenantBillingPaused, markChatBillingPaused } from './billingGuard.js';
import { answerCallbackQuery, sendTelegramMedia, sendTelegramMessage } from './telegramApi.js';
import { ensureTenantLimit } from './tenantLimits.js';
import { withChannelUserLock, withChatLock } from './chatLocks.js';
import { sanitizeChatState } from './chatStateGuard.js';
import { getCachedRuntimeFlow, toRuntimeFlow, getCachedRuntimeSchedules, getCachedRuntimeTemplates } from './flowRuntimeCache.js';
import { generateId } from '../utils/helpers.js';
import { CHAT_EVENT_TYPES, emitChatEvent } from './chatEvents.js';
import { upsertContactFromChannel } from './contactIdentity.js';
import { getChatMessageByProviderId } from './chatMessages.js';

const resolveInboundReplyTo = async (chat, replyToProviderId) => {
  if (!replyToProviderId) return null;
  try {
    const original = await getChatMessageByProviderId({
      chatId: chat.id,
      tenantId: chat.tenantId || null,
      providerMessageId: replyToProviderId
    });
    if (!original) return null;
    const rawText = String(original.text || (original.media ? `[${original.media.type || 'mídia'}]` : '') || '').trim();
    const preview = rawText.length > 120 ? `${rawText.slice(0, 117)}…` : rawText;
    return {
      messageId: original.id,
      sender: original.sender || null,
      preview: preview || null,
      hasMedia: Boolean(original.media)
    };
  } catch (_) {
    return null;
  }
};

const normalizeEnvValue = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};

const getTelegramFlowId = () => normalizeEnvValue(process.env.TELEGRAM_FLOW_ID);
const getTelegramTenantId = () => normalizeEnvValue(process.env.TELEGRAM_TENANT_ID);

const ensureFlow = async (tenantId, flowId) => getCachedRuntimeFlow({
  tenantId,
  flowId,
  loader: async () => {
    const flows = await adapter.getCollection('flows', tenantId);
    if (!flows || flows.length === 0) return null;
    let flow = null;
    if (flowId) {
      flow = flows.find((f) => f.id === flowId) || null;
    }
    if (!flow) {
      flow = flows.find((f) => f.published && f.published.nodes && f.published.nodes.length > 0) || flows[0];
    }
    return toRuntimeFlow(flow);
  }
});

const ensureTemplates = async (tenantId) => getCachedRuntimeTemplates({
  tenantId,
  loader: async () => {
    const scoped = await adapter.getCollection('templates', tenantId);
    if (scoped && scoped.length) return scoped;
    const scopedAlt = await adapter.getCollection('messageTemplates', tenantId);
    if (scopedAlt && scopedAlt.length) return scopedAlt;
    const all = await adapter.getCollection('templates');
    if (all && all.length) return all;
    return adapter.getCollection('messageTemplates');
  }
});

const ensureSchedules = async (tenantId) => getCachedRuntimeSchedules({
  tenantId,
  loader: async () => {
    const scoped = await adapter.getCollection('schedules', tenantId);
    if (scoped && scoped.length) return scoped;
    return adapter.getCollection('schedules');
  }
});

const createChat = async (userId, telegramChatId, tenantId) => {
  await ensureTenantLimit(tenantId, 'chats');
  const chat = {
    id: generateId('chat'),
    customerCpf: `tg_${userId}`,
    status: 'bot',
    messages: [],
    lastMessage: null,
    lastMessageAt: null,
    messageCount: 0,
    unreadByAgentCount: 0,
    vars: {},
    tenantId,
    channel: 'telegram',
    channelUserId: String(userId),
    channelChatId: telegramChatId ? String(telegramChatId) : null,
    currentNodeId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const sanitized = sanitizeChatState(chat);
  await adapter.saveDocument('activeChats', sanitized.chat);
  await emitChatEvent({
    tenantId,
    chatId: sanitized.chat.id,
    type: CHAT_EVENT_TYPES.CHAT_OPENED,
    actor: { kind: 'customer', id: String(userId) },
    context: { channel: 'telegram', channelUserId: String(userId), channelChatId: telegramChatId ? String(telegramChatId) : null }
  });
  return sanitized.chat;
};

const getOrCreateSession = async (userId, telegramChatId, tenantId, flowId) => {
  let session = await adapter.getDocument('telegramSessions', { userId: String(userId) });

  if (!session) {
    const chat = await createChat(userId, telegramChatId, tenantId);
    session = {
      id: `tg_${userId}`,
      userId: String(userId),
      telegramChatId: String(telegramChatId),
      chatId: chat.id,
      flowId,
      tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await adapter.saveDocument('telegramSessions', session);
    return { session, chat };
  }

  session.telegramChatId = String(telegramChatId);
  session.updatedAt = new Date().toISOString();
  await adapter.saveDocument('telegramSessions', session);

  let chat = await getChatById(session.chatId);
  if (!chat || chat.status === 'closed') {
    chat = await createChat(userId, telegramChatId, tenantId);
    session.chatId = chat.id;
    session.updatedAt = new Date().toISOString();
    await adapter.saveDocument('telegramSessions', session);
  } else if (telegramChatId && chat.channelChatId !== String(telegramChatId)) {
    chat.channelChatId = String(telegramChatId);
    chat.updatedAt = new Date().toISOString();
    const sanitized = sanitizeChatState(chat);
    chat = sanitized.chat;
    await adapter.saveDocument('activeChats', chat);
  }

  return { session, chat };
};

const resetSession = async (userId, telegramChatId, tenantId, flowId) => {
  let session = await adapter.getDocument('telegramSessions', { userId: String(userId) });
  const chat = await createChat(userId, telegramChatId, tenantId);
  if (!session) {
    session = {
      id: `tg_${userId}`,
      userId: String(userId),
      telegramChatId: String(telegramChatId),
      chatId: chat.id,
      flowId,
      tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  } else {
    session.telegramChatId = String(telegramChatId);
    session.chatId = chat.id;
    session.updatedAt = new Date().toISOString();
  }
  await adapter.saveDocument('telegramSessions', session);
  return { session, chat };
};

export const handleTelegramUpdate = async (update, config = null) => {
  if (!update) return;
  const isCallback = Boolean(update.callback_query);
  const message = isCallback ? update.callback_query.message : update.message;
  const from = isCallback ? update.callback_query.from : update.message?.from;
  const text = update.message?.text || null;
  const buttonId = update.callback_query?.data || null;
  const callbackId = update.callback_query?.id || null;

  if (!message || !from) return;

  const telegramChatId = message.chat?.id;
  const telegramUserId = from.id;
  if (!telegramChatId || !telegramUserId) return;

  if (update.message?.date) {
    const sentAt = new Date(update.message.date * 1000).toISOString();
    console.log(`[TG] Message date ${sentAt} server ${new Date().toISOString()}`);
  }

  const tenantId = config?.tenantId || getTelegramTenantId();
  const flowId = config?.flowId || getTelegramFlowId();
  const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN;

  // Captura display name do Telegram: prefere full name (first_name + last_name),
  // cai para username (@handle) quando o usuário não tem nome configurado.
  const telegramDisplayName = (() => {
    const first = String(from.first_name || '').trim();
    const last = String(from.last_name || '').trim();
    const full = `${first} ${last}`.trim();
    return full || (from.username ? `@${from.username}` : null);
  })();

  if (tenantId) {
    upsertContactFromChannel({
      tenantId,
      channel: 'telegram',
      rawIdentifier: String(telegramUserId),
      handle: from.username ? `@${from.username}` : null,
      channelDisplayName: telegramDisplayName,
      channelMeta: {
        telegramChatId: String(telegramChatId),
        languageCode: from.language_code || null
      }
    }).catch(() => {});
  }

  const sendMessage = async (msgText, buttons) => {
    await sendTelegramMessage(telegramChatId, msgText, buttons, botToken);
  };
  const sendMedia = async ({ mediaType, mediaUrl, caption }) => {
    await sendTelegramMedia({
      chatId: telegramChatId,
      mediaType,
      mediaUrl,
      caption,
      token: botToken
    });
  };
  sendMessage.__sendMedia = sendMedia;

  if (callbackId) {
    try {
      await answerCallbackQuery(callbackId, botToken);
    } catch (error) {
      const msg = String(error?.message || '');
      if (!msg.includes('query is too old') && !msg.includes('query ID is invalid')) {
        console.warn('Erro ao responder callback do Telegram:', msg);
      }
    }
  }

  const isReset = text && (text.trim().toLowerCase() === '/start' || text.trim().toLowerCase() === '/reset');

  await withChannelUserLock({
    channel: 'telegram',
    tenantId,
    userId: telegramUserId
  }, async () => {
    const { chat } = isReset
      ? await resetSession(telegramUserId, telegramChatId, tenantId, flowId)
      : await getOrCreateSession(telegramUserId, telegramChatId, tenantId, flowId);

    await withChatLock(chat.id, async () => {
      const flowData = await ensureFlow(tenantId, flowId);
      if (!flowData || !flowData.nodes) {
        await sendMessage('Nenhum fluxo publicado encontrado para este bot.');
        return;
      }

      const templates = await ensureTemplates(tenantId);
      const schedules = await ensureSchedules(tenantId);

      if (text && !isCallback) {
        const replyToProviderId = update.message?.reply_to_message?.message_id != null
          ? String(update.message.reply_to_message.message_id)
          : null;
        const inboundReplyTo = await resolveInboundReplyTo(chat, replyToProviderId);
        await addUserMessage(chat.id, text, {
          providerMessageId: update.message?.message_id != null ? String(update.message.message_id) : null,
          replyTo: inboundReplyTo
        });
      }

      // Pausada por cobranca: a mensagem ja esta gravada; o bot nao responde.
      if (await isTenantBillingPaused(tenantId)) {
        await markChatBillingPaused(chat.id);
        return;
      }

      let currentChat = await getChatById(chat.id);
      if (!isReset && (currentChat?.status === 'open' || currentChat?.status === 'waiting' || currentChat?.activeOutreach === true)) {
        return;
      }

      const handledCommand = !isReset && (
        await tryHandleGlobalCommand({
          chat: currentChat,
          flowData,
          text: isCallback ? null : text,
          templates,
          schedules,
          sendMessage,
          sendMedia
        })
      );
      if (handledCommand) {
        return;
      }

      if (!currentChat.currentNodeId) {
        if (currentChat.flowStarted && !isReset) {
          console.warn(`[TG] Reiniciando fluxo por estado inconsistente no chat ${currentChat.id}`);
        }
        await startChatFlow({
          chatId: currentChat.id,
          flowData,
          templates,
          schedules,
          sendMessage,
          sendMedia
        });
        currentChat = await getChatById(currentChat.id);
        if (isReset) return;
        if (!currentChat.currentNodeId) return;
      }

      if (isCallback) {
        await applyUserInput({
          chat: currentChat,
          flowData,
          text: null,
          buttonId,
          templates,
          schedules,
          sendMessage,
          sendMedia
        });
        return;
      }

      if (text && !isReset) {
        await applyUserInput({
          chat: currentChat,
          flowData,
          text,
          buttonId: null,
          templates,
          schedules,
          sendMessage,
          sendMedia
        });
      }
    });
  });
};
