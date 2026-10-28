import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { sendTelegramMedia, sendTelegramMessage } from '../services/telegramApi.js';
import { sendWhatsAppMedia, sendWhatsAppText } from '../services/whatsappApi.js';
import { getTelegramConfig, getWhatsAppConfig, resolveWhatsAppFlowId, resolveWhatsAppSender } from '../services/channelConfig.js';
import { applyFlowRuntimeReset, runFlow } from '../services/flowRunner.js';
import { getCachedRuntimeFlow, toRuntimeFlow, getCachedRuntimeTemplates, getCachedRuntimeSchedules } from '../services/flowRuntimeCache.js';
import { getIo } from '../services/logs.js';
import { createLog } from '../services/logs.js';
import { attachContactNames } from '../services/contactIdentity.js';
import { ensureTenantLimit } from '../services/tenantLimits.js';
import { normalizeWhatsappWaId } from '../services/activeOutreach.js';
import { migrateTenantSecretVars, sanitizeChatCollectionForAgent, sanitizeChatForAgent } from '../services/chatSecurity.js';
import { withChatLock } from '../services/chatLocks.js';
import { sanitizeChatState } from '../services/chatStateGuard.js';
import { buildChatSummaryCollection } from '../services/chatSummaries.js';
import { generateId } from '../utils/helpers.js';
import { CHAT_EVENT_TYPES, emitChatEvent, queryChatEvents } from '../services/chatEvents.js';
import { getTenantSettings } from '../services/tenantSettings.js';
import {
  appendChatMessage,
  getChatMessageById,
  getLastChatMessage,
  hydrateChatWithMessages,
  hydrateChatsWithMessages
} from '../services/chatMessages.js';
import {
  isGenesysChat,
  relayAgentMessageToGenesys,
  relayAgentCloseToGenesys
} from '../services/extensionAtendimento.js';
import { syncAttendanceLifecycle } from '../services/attendanceRouting.js';
import { isTurizmoProtectedAttendance } from '../services/protectedAttendance.js';

const router = express.Router();
const MAX_HISTORY_LIMIT = 200;

// MANAGER tem visão estratégica do tenant: pode LER chats, history, timeline e
// métricas, mas não atende — pickup/transfer/close/messages/media/vars são
// exclusivos de quem opera de fato (AGENT/ADMIN) ou de SUPER_ADMIN.
const CHAT_OPERATIONAL_ROLES = ['ADMIN', 'AGENT', 'SUPER_ADMIN'];

// --- Input hardening helpers ---
// Mongo operators ($ne, $gt, $regex…) and dot-notation keys must never reach a
// query as bare body values. These helpers coerce identifiers to plain strings
// and reject document payloads that carry such keys.

const asIdentifier = (value, { maxLength = 200 } = {}) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.slice(0, maxLength);
};

const isPlainObject = (value) => (
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const hasMongoOperatorKey = (input, depth = 0) => {
  if (depth > 8) return true; // refuse pathological nesting
  if (Array.isArray(input)) return input.some((item) => hasMongoOperatorKey(item, depth + 1));
  if (!isPlainObject(input)) return false;
  for (const key of Object.keys(input)) {
    if (typeof key !== 'string') return true;
    if (key.startsWith('$') || key.includes('.')) return true;
    if (hasMongoOperatorKey(input[key], depth + 1)) return true;
  }
  return false;
};


const CHAT_SUMMARY_PROJECTION = {
  _id: 0,
  id: 1,
  tenantId: 1,
  status: 1,
  queue: 1,
  queueId: 1,
  agentId: 1,
  agentName: 1,
  customerCpf: 1,
  customerPhone: 1,
  customerName: 1,
  channel: 1,
  channelUserId: 1,
  channelChatId: 1,
  whatsappPhoneNumberId: 1,
  createdAt: 1,
  updatedAt: 1,
  closedAt: 1,
  waitingSince: 1,
  vars: 1,
  variables: 1,
  lastMessage: 1,
  lastMessageAt: 1,
  messageCount: 1,
  unreadByAgentCount: 1
};

const normalizeDate = (value, endOfDay = false) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  } else {
    date.setHours(0, 0, 0, 0);
  }
  return date;
};

const parseTimeMs = (value) => {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

const average = (values = []) => {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
};

const minutesBetween = (start, end) => {
  const startMs = parseTimeMs(start);
  const endMs = parseTimeMs(end);
  if (!startMs || !endMs || endMs < startMs) return null;
  return (endMs - startMs) / 60000;
};

const getChatQueueWaitMinutes = (chat) => {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const waitStart = parseTimeMs(chat?.waitingSince || chat?.transferredAt);
  if (!waitStart) return null;

  const assumedMessage = [...messages]
    .filter((message) => {
      const sender = String(message?.sender || '').toLowerCase();
      const text = String(message?.text || '').toLowerCase();
      const time = parseTimeMs(message?.timestamp);
      return sender === 'system'
        && time > 0
        && time >= waitStart
        && text.includes('assumiu');
    })
    .sort((a, b) => parseTimeMs(a.timestamp) - parseTimeMs(b.timestamp))[0];

  return assumedMessage ? minutesBetween(new Date(waitStart).toISOString(), assumedMessage.timestamp) : null;
};

const getChatRatingValue = (chat) => {
  const vars = chat?.vars || chat?.variables || {};
  const rating = Number(vars.nota ?? vars.rating ?? vars.avaliacao);
  return Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : null;
};

const getAgentChatDisplayName = (chat) => (
  chat?.customerName
  || chat?.vars?.nome_cliente
  || chat?.variables?.nome_cliente
  || chat?.channelUserId
  || chat?.customerCpf
  || chat?.id
  || 'Cliente'
);

const getScopedChatQuery = (req, extra = {}) => {
  const query = { isFlowTest: { $ne: true }, ...extra };
  if (req.user?.role === 'SUPER_ADMIN') {
    if (req.tenantId) query.tenantId = req.tenantId;
    return query;
  }
  query.tenantId = req.tenantId;
  return query;
};

const getTenantVariableDefinitions = async (tenantId) => {
  if (!tenantId) return [];
  const definitions = await adapter.getCollection('variables', tenantId);
  return Array.isArray(definitions) ? definitions : [];
};

const sanitizeChatPayloadForViewer = async (tenantId, payload) => {
  await migrateTenantSecretVars(tenantId);
  const variableDefinitions = await getTenantVariableDefinitions(tenantId);
  if (Array.isArray(payload)) {
    return sanitizeChatCollectionForAgent(payload, variableDefinitions);
  }
  return sanitizeChatForAgent(payload, variableDefinitions);
};

const loadChatById = async (req, res, id) => {
  const chat = await adapter.getDocument('activeChats', { id });
  if (!chat) {
    res.status(404).json({ error: 'Chat não encontrado' });
    return null;
  }
  if (req.user.role !== 'SUPER_ADMIN' && chat.tenantId !== req.tenantId) {
    res.status(403).json({ error: 'Acesso negado' });
    return null;
  }
  const sanitized = sanitizeChatState(chat);
  if (sanitized.changed) {
    await adapter.saveDocument('activeChats', sanitized.chat);
  }
  return sanitized.chat;
};

const getChatWhatsAppPhoneNumberId = (chat, config) => (
  chat?.whatsappPhoneNumberId
  || resolveWhatsAppSender(config)?.phoneNumberId
  || config?.phoneNumberId
  || null
);

// Resolve a mensagem que está sendo respondida e devolve o objeto `replyTo`
// (para render na UI) e o `providerMessageId` (para o quote nativo no canal).
// Busca primeiro na coleção chatMessages (fonte real) e cai para o array
// embutido como fallback. Retorna null se não achar.
const buildReplyContext = async (chat, replyToMessageId) => {
  const id = asIdentifier(replyToMessageId);
  if (!id) return null;
  let original = await getChatMessageById({ chatId: chat?.id, tenantId: chat?.tenantId || null, messageId: id });
  if (!original) {
    const messages = Array.isArray(chat?.messages) ? chat.messages : [];
    original = messages.find((m) => m?.id === id) || null;
  }
  if (!original) return null;
  const rawText = String(original.text || (original.media ? `[${original.media.type || 'mídia'}]` : '') || '').trim();
  const preview = rawText.length > 120 ? `${rawText.slice(0, 117)}…` : rawText;
  return {
    replyTo: {
      messageId: original.id,
      sender: original.sender || null,
      preview: preview || null,
      hasMedia: Boolean(original.media)
    },
    providerMessageId: original.providerMessageId || original.meta?.providerMessageId || null
  };
};

const sendAgentTextToChannel = async ({ chat, text, message }) => {
  if (!chat || !text) return;

  if (chat.channel === 'telegram' && chat.channelChatId) {
    const config = chat.tenantId ? await getTelegramConfig(chat.tenantId) : null;
    const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
    if (botToken) {
      await sendTelegramMessage(chat.channelChatId, text, null, botToken);
    }
  }

  if (chat.channel === 'whatsapp' && chat.channelUserId) {
    const config = chat.tenantId ? await getWhatsAppConfig(chat.tenantId) : null;
    const accessToken = config?.accessToken || null;
    const phoneNumberId = getChatWhatsAppPhoneNumberId(chat, config);
    if (accessToken && phoneNumberId) {
      const to = normalizeWhatsappWaId(chat.channelUserId);
      const result = await sendWhatsAppText({
        accessToken,
        phoneNumberId,
        to,
        text
      });
      const providerMessageId = result?.messages?.[0]?.id || null;
      if (providerMessageId && message) {
        message.providerMessageId = providerMessageId;
        message.deliveryStatus = 'sent';
        message.deliveryStatusAt = new Date().toISOString();
        message.meta = {
          channel: 'whatsapp',
          providerMessageId,
          deliveryStatus: 'sent',
          deliveryStatusAt: message.deliveryStatusAt
        };
      }
    }
  }
};

const formatWhatsAppSystemNotice = (text) => {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  return `_${normalized.replace(/_/g, '\\_')}_`;
};

const sendSystemNoticeToCustomer = async ({ chat, text }) => {
  if (!chat || !text) return;

  try {
    if (chat.channel === 'telegram' && chat.channelChatId) {
      const config = chat.tenantId ? await getTelegramConfig(chat.tenantId) : null;
      const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
      if (botToken) {
        await sendTelegramMessage(chat.channelChatId, text, null, botToken);
      }
    }

    if (chat.channel === 'whatsapp' && chat.channelUserId) {
      const config = chat.tenantId ? await getWhatsAppConfig(chat.tenantId) : null;
      const accessToken = config?.accessToken || null;
      const phoneNumberId = getChatWhatsAppPhoneNumberId(chat, config);
      if (accessToken && phoneNumberId) {
        await sendWhatsAppText({
          accessToken,
          phoneNumberId,
          to: normalizeWhatsappWaId(chat.channelUserId),
          text: formatWhatsAppSystemNotice(text),
          debugContext: {
            tenantId: chat.tenantId,
            chatId: chat.id,
            operation: 'system_notice'
          }
        });
      }
    }
  } catch (error) {
    console.error('[CHAT] Falha ao enviar aviso de sistema ao cliente', {
      chatId: chat?.id || null,
      channel: chat?.channel || null,
      error: error?.message || error
    });
  }
};

const appendAndEmitChatMessage = async (chat, message, options = {}) => {
  const appended = await appendChatMessage(chat, message, options);
  const io = getIo();
  if (io && chat?.tenantId) {
    io.to(`tenant:${chat.tenantId}`).emit('new_message', {
      chatId: chat.id,
      message: appended.message || message
    });
  }
  return appended.message || message;
};

const findTelegramSessionForChat = async (chat) => {
  if (!chat || chat.channel !== 'telegram') return null;

  const tenantId = chat.tenantId || null;
  const orFilter = [];
  if (chat.channelUserId) orFilter.push({ userId: String(chat.channelUserId) });
  if (chat.channelChatId) orFilter.push({ telegramChatId: String(chat.channelChatId) });
  if (!orFilter.length) return null;

  const sessions = await adapter.findDocuments('telegramSessions', { $or: orFilter });
  if (!Array.isArray(sessions) || sessions.length === 0) return null;

  const sameTenant = (session) => {
    if (!tenantId) return true;
    return !session?.tenantId || String(session.tenantId) === String(tenantId);
  };

  if (chat.channelUserId) {
    const sessionByUser = sessions.find(
      (session) =>
        sameTenant(session) &&
        String(session.userId || '') === String(chat.channelUserId)
    );
    if (sessionByUser) {
      return sessionByUser;
    }
  }

  if (chat.channelChatId) {
    const sessionByChat = sessions.find(
      (session) =>
        sameTenant(session) &&
        String(session.telegramChatId || '') === String(chat.channelChatId)
    );
    if (sessionByChat) {
      return sessionByChat;
    }
  }

  return null;
};

const isActiveTelegramSessionForChat = async (chat) => {
  const session = await findTelegramSessionForChat(chat);
  if (!session) return false;
  return String(session.chatId || '') === String(chat.id);
};

const resolveFlowForResume = async (tenantId, flowId) => getCachedRuntimeFlow({
  tenantId,
  flowId,
  loader: async () => {
    const flows = await adapter.getCollection('flows', tenantId);
    if (!Array.isArray(flows) || !flows.length) return null;
    let flow = null;
    if (flowId) {
      flow = flows.find((item) => item.id === flowId) || null;
    }
    if (!flow) {
      flow = flows.find((item) => item.published && item.published.nodes && item.published.nodes.length > 0) || flows[0] || null;
    }
    return toRuntimeFlow(flow);
  }
});

const resumeFlowAfterAgentClose = async (chat) => {
  if (!chat?.resumeNodeId) return false;
  const resumeNodeId = chat.resumeNodeId;

  const tenantId = chat.tenantId || null;
  let flowId = null;
  let sendMessage = null;

  if (chat.channel === 'telegram') {
    const config = tenantId ? await getTelegramConfig(tenantId) : null;
    const session = await findTelegramSessionForChat(chat);
    const sessionMismatch = session && String(session.chatId || '') !== String(chat.id);
    const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;

    if (sessionMismatch) {
      console.warn(`[CHAT_CLOSE] Telegram session divergente para chat ${chat.id}; retomando com flowId da sessao.`);
    }

    flowId = config?.flowId || session?.flowId || null;

    if (botToken && chat.channelChatId) {
      sendMessage = async (msgText, buttons) => {
        await sendTelegramMessage(chat.channelChatId, msgText, buttons, botToken);
      };
      sendMessage.__sendMedia = async ({ mediaType, mediaUrl, caption }) => {
        await sendTelegramMedia({
          chatId: chat.channelChatId,
          mediaType,
          mediaUrl,
          caption,
          token: botToken
        });
      };
    }
  }

  if (chat.channel === 'whatsapp') {
    const config = tenantId ? await getWhatsAppConfig(tenantId) : null;
    const accessToken = config?.accessToken || null;
    const phoneNumberId = getChatWhatsAppPhoneNumberId(chat, config);
    // Mesmo fluxo que a conversa usava: o da rota do numero. So config.flowId
    // (vazio quando o tenant usa rotas) caia no primeiro fluxo publicado da
    // lista, que nao tinha o no de volta, e a conversa ficava parada.
    flowId = flowId || resolveWhatsAppFlowId(config, phoneNumberId) || null;

    if (accessToken && phoneNumberId && chat.channelUserId) {
      sendMessage = async (msgText) => {
        const to = normalizeWhatsappWaId(chat.channelUserId);
        return await sendWhatsAppText({
          accessToken,
          phoneNumberId,
          to,
          text: msgText
        });
      };
      sendMessage.__sendMedia = async ({ mediaType, mediaUrl, caption, fileName }) => {
        const to = normalizeWhatsappWaId(chat.channelUserId);
        return await sendWhatsAppMedia({
          accessToken,
          phoneNumberId,
          to,
          mediaType,
          mediaUrl,
          caption,
          filename: fileName
        });
      };
    }
  }

  const flowData = await resolveFlowForResume(tenantId, flowId);
  if (!flowData?.nodes) {
    return false;
  }

  const [templates, schedules] = await Promise.all([
    getCachedRuntimeTemplates({
      tenantId,
      loader: async () => {
        const scoped = await adapter.getCollection('templates', tenantId);
        if (Array.isArray(scoped) && scoped.length) return scoped;
        const fallback = await adapter.getCollection('messageTemplates', tenantId);
        return Array.isArray(fallback) ? fallback : [];
      }
    }),
    getCachedRuntimeSchedules({
      tenantId,
      loader: async () => {
        const s = await adapter.getCollection('schedules', tenantId);
        return Array.isArray(s) ? s : [];
      }
    })
  ]);

  chat.resumePending = false;
  chat.status = 'bot';
  chat.currentNodeId = null;
  chat.resumeNodeId = null;
  chat.continueFlowAfterQueue = false;
  chat.catalogContext = null;
  chat.updatedAt = new Date().toISOString();
  await adapter.saveDocument('activeChats', chat);

  await runFlow({
    nodeId: resumeNodeId,
    flowData,
    currentVars: chat.vars || {},
    chatId: chat.id,
    templates: templates || [],
    schedules: schedules || [],
    sendMessage
  });

  return true;
};

// Iniciar ou buscar chat de simulação
router.post('/init', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { permission: 'atendimento.fila' }), requireTenant, async (req, res) => {
  try {
    const customerCpf = asIdentifier(req.body?.customerCpf, { maxLength: 64 });
    const tenantId = req.tenantId || req.user?.tenantId || null;

    if (!customerCpf) {
      return res.status(400).json({ error: 'customerCpf é obrigatório' });
    }
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId é obrigatório' });
    }

    // Verificar se já existe chat ativo para este CPF
    const existing = await adapter.findDocuments('activeChats', {
      tenantId,
      customerCpf,
      status: { $ne: 'closed' }
    });
    let chat = Array.isArray(existing) ? existing[0] || null : null;

    const isNew = !chat;
    if (isNew) {
      await ensureTenantLimit(tenantId, 'chats');
      // Criar novo chat
      chat = {
        id: generateId('chat'),
        customerCpf,
        status: 'bot',
        messages: [],
        lastMessage: null,
        lastMessageAt: null,
        messageCount: 0,
        unreadByAgentCount: 0,
        vars: {},
        tenantId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await adapter.saveDocument('activeChats', chat);
    } else {
      // Retornar chat existente
      chat.updatedAt = new Date().toISOString();
      await adapter.saveDocument('activeChats', chat);
    }

    res.json(await sanitizeChatPayloadForViewer(tenantId, chat));
    await createLog('CHAT_START', { chatId: chat.id, customerCpf: chat.customerCpf, tenantId: chat.tenantId }, req.user?.id || 'system');
    if (isNew) {
      await emitChatEvent({
        tenantId,
        chatId: chat.id,
        type: CHAT_EVENT_TYPES.CHAT_OPENED,
        actor: { kind: 'customer', id: customerCpf },
        context: { channel: chat.channel || 'simulator', customerCpf, source: 'init' }
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adicionar mensagem ao chat
router.post('/:id/messages', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { permission: 'atendimento.fila' }), requireTenant, async (req, res) => {
  try {
    const sender = asIdentifier(req.body?.sender, { maxLength: 32 });
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const buttons = Array.isArray(req.body?.buttons) ? req.body.buttons : null;
    const replyToMessageId = asIdentifier(req.body?.replyToMessageId);
    const id = asIdentifier(req.params?.id);
    if (!id) {
      return res.status(400).json({ error: 'id inválido' });
    }
    await withChatLock(id, async () => {
      const chat = await loadChatById(req, res, id);
      if (!chat) return;

      if (sender === 'agent' && chat.outreachPendingReply === true) {
        res.status(409).json({
          error: 'Aguarde a primeira resposta do cliente antes de enviar mensagens manuais neste atendimento ativo.'
        });
        return;
      }

      const replyContext = await buildReplyContext(chat, replyToMessageId);
      const message = {
        id: generateId('msg'),
        sender,
        text,
        buttons: buttons || null,
        providerMessageId: null,
        deliveryStatus: null,
        deliveryStatusAt: null,
        meta: null,
        replyTo: replyContext?.replyTo || null,
        timestamp: new Date().toISOString()
      };

      if (sender === 'agent') {
        if (chat.channel === 'telegram' && chat.channelChatId) {
          const config = chat.tenantId ? await getTelegramConfig(chat.tenantId) : null;
          const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
          if (botToken) {
            await sendTelegramMessage(chat.channelChatId, text, buttons || null, botToken, {
              replyToMessageId: replyContext?.providerMessageId || null
            });
          }
        }

        if (chat.channel === 'whatsapp' && chat.channelUserId) {
          const config = chat.tenantId ? await getWhatsAppConfig(chat.tenantId) : null;
          const accessToken = config?.accessToken || null;
          const phoneNumberId = getChatWhatsAppPhoneNumberId(chat, config);
          if (accessToken && phoneNumberId) {
            const to = normalizeWhatsappWaId(chat.channelUserId);
            try {
              const result = await sendWhatsAppText({
                accessToken,
                phoneNumberId,
                to,
                text,
                contextMessageId: replyContext?.providerMessageId || null
              });
              const providerMessageId = result?.messages?.[0]?.id || null;
              if (providerMessageId) {
                message.providerMessageId = providerMessageId;
                message.deliveryStatus = 'sent';
                message.deliveryStatusAt = new Date().toISOString();
                message.meta = {
                  channel: 'whatsapp',
                  providerMessageId,
                  deliveryStatus: 'sent',
                  deliveryStatusAt: message.deliveryStatusAt
                };
              }
            } catch (err) {
              console.error('[WHATSAPP] Falha ao enviar mensagem do agente', err?.message || err);
              throw err;
            }
          }
        }

        // Genesys fase 4: relay para extensao (app → Genesys)
        if (isGenesysChat(chat)) {
          message.meta = {
            ...(message.meta || {}),
            channel: 'genesys',
            deliveryStatus: 'pending',
            source: 'agent_app'
          };
          message.deliveryStatus = 'pending';
        }
      }

      await appendAndEmitChatMessage(chat, message, { incrementUnread: sender === 'user' });
      await createLog('CHAT_MESSAGE', { chatId: id, sender, text, tenantId: chat.tenantId }, req.user?.id || 'system');

      let genesysRelay = null;
      if (sender === 'agent' && isGenesysChat(chat)) {
        genesysRelay = await relayAgentMessageToGenesys({
          chat,
          message,
          agentId: req.user?.id || chat.agentId || null,
          agentName: req.user?.name || chat.agentName || null,
          replyTo: replyContext?.replyTo || null
        });
        if (genesysRelay && genesysRelay.relayed === false && !genesysRelay.skipped) {
          console.warn('[GENESYS] Mensagem salva localmente, mas extensao offline/indisponivel', {
            chatId: chat.id,
            reason: genesysRelay.reason
          });
        }
      }

      res.json({
        ...message,
        ...(genesysRelay ? { genesys: genesysRelay } : {})
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/media', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { permission: 'atendimento.fila' }), requireTenant, async (req, res) => {
  try {
    const id = asIdentifier(req.params?.id);
    if (!id) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const sender = asIdentifier(req.body?.sender, { maxLength: 32 }) || 'agent';
    const mediaType = asIdentifier(req.body?.mediaType, { maxLength: 32 });
    const mediaUrl = asIdentifier(req.body?.mediaUrl, { maxLength: 4096 });
    const caption = typeof req.body?.caption === 'string' ? req.body.caption : '';
    const fileName = req.body?.fileName === null || req.body?.fileName === undefined
      ? null
      : asIdentifier(req.body.fileName, { maxLength: 300 });
    const mimeType = req.body?.mimeType === null || req.body?.mimeType === undefined
      ? null
      : asIdentifier(req.body.mimeType, { maxLength: 128 });
    const replyToMessageId = asIdentifier(req.body?.replyToMessageId);
    const durationSeconds = Number.isFinite(Number(req.body?.durationSeconds)) ? Math.max(0, Math.round(Number(req.body.durationSeconds))) : null;

    const normalizedMediaType = ['image', 'video', 'audio', 'document'].includes(mediaType.toLowerCase())
      ? mediaType.toLowerCase()
      : 'document';
    const normalizedCaption = caption.trim();
    // Gravado no painel em OGG/OPUS: vai como mensagem de voz, nao como arquivo de musica.
    const isVoiceNote = normalizedMediaType === 'audio' && req.body?.voice === true;

    if (!mediaUrl) {
      return res.status(400).json({ error: 'mediaUrl e obrigatorio' });
    }
    await withChatLock(id, async () => {
      const chat = await loadChatById(req, res, id);
      if (!chat) return;

      if (sender === 'agent' && chat.status === 'waiting') {
        res.status(409).json({ error: 'Puxe o atendimento antes de enviar mensagens.' });
        return;
      }

      if (sender === 'agent' && chat.outreachPendingReply === true) {
        res.status(409).json({
          error: 'Aguarde a primeira resposta do cliente antes de enviar mensagens manuais neste atendimento ativo.'
        });
        return;
      }

      const replyContext = await buildReplyContext(chat, replyToMessageId);
      const message = {
        id: generateId('msg'),
        sender,
        text: normalizedCaption || `[${normalizedMediaType}]`,
        media: {
          type: normalizedMediaType,
          url: mediaUrl,
          caption: normalizedCaption,
          fileName: fileName || null,
          mimeType: mimeType || null,
          ...(isVoiceNote ? { voice: true, durationSeconds } : {})
        },
        providerMessageId: null,
        deliveryStatus: null,
        deliveryStatusAt: null,
        meta: null,
        replyTo: replyContext?.replyTo || null,
        timestamp: new Date().toISOString()
      };

      if (sender === 'agent') {
        if (chat.channel === 'telegram' && chat.channelChatId) {
          const config = chat.tenantId ? await getTelegramConfig(chat.tenantId) : null;
          const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
          if (botToken) {
            await sendTelegramMedia({
              chatId: chat.channelChatId,
              mediaType: normalizedMediaType,
              mediaUrl,
              caption: normalizedCaption,
              token: botToken,
              replyToMessageId: replyContext?.providerMessageId || null
            });
          }
        }

        if (chat.channel === 'whatsapp' && chat.channelUserId) {
          const config = chat.tenantId ? await getWhatsAppConfig(chat.tenantId) : null;
          const accessToken = config?.accessToken || null;
          const phoneNumberId = getChatWhatsAppPhoneNumberId(chat, config);
          if (accessToken && phoneNumberId) {
            const to = normalizeWhatsappWaId(chat.channelUserId);
            try {
              const result = await sendWhatsAppMedia({
                accessToken,
                phoneNumberId,
                to,
                mediaType: normalizedMediaType,
                mediaUrl,
                caption: normalizedCaption,
                filename: fileName || null,
                contextMessageId: replyContext?.providerMessageId || null,
                voice: isVoiceNote
              });
              const providerMessageId = result?.messages?.[0]?.id || null;
              if (providerMessageId) {
                message.providerMessageId = providerMessageId;
                message.deliveryStatus = 'sent';
                message.deliveryStatusAt = new Date().toISOString();
                message.meta = {
                  channel: 'whatsapp',
                  providerMessageId,
                  deliveryStatus: 'sent',
                  deliveryStatusAt: message.deliveryStatusAt
                };
              }
            } catch (err) {
              console.error('[WHATSAPP] Falha ao enviar midia do agente', err?.message || err);
              throw err;
            }
          }
        }
      }

      await appendAndEmitChatMessage(chat, message, { incrementUnread: sender === 'user' });
      await createLog('CHAT_MEDIA', {
        chatId: id,
        sender,
        mediaType: normalizedMediaType,
        mediaUrl,
        fileName: fileName || null,
        tenantId: chat.tenantId
      }, req.user?.id || 'system');

      res.json(message);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Atualizar variáveis do chat
router.put('/:id/vars', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { permission: 'atendimento.fila' }), requireTenant, async (req, res) => {
  try {
    const vars = req.body?.vars !== undefined ? req.body.vars : req.body;
    if (!isPlainObject(vars)) {
      return res.status(400).json({ error: 'vars deve ser um objeto' });
    }
    if (hasMongoOperatorKey(vars)) {
      return res.status(400).json({ error: 'vars contém chaves inválidas' });
    }
    const { id } = req.params;
    await withChatLock(id, async () => {
      const chat = await loadChatById(req, res, id);
      if (!chat) return;

      chat.vars = vars;
      chat.updatedAt = new Date().toISOString();
      await adapter.saveDocument('activeChats', chat);
      await createLog('CHAT_VARS_UPDATE', {
        chatId: id,
        queue: chat.queue || null,
        tenantId: chat.tenantId,
        preferredAgentId: chat.preferredAgentId || null
      }, req.user?.id || 'system');

      const io = getIo();
      if (io) {
        const { secureVars: _sv1, secureVarNames: _svn1, ...chatForQueue } = chat;
        io.to(`tenant:${chatForQueue.tenantId}`).emit('new_chat_in_queue', { chat: chatForQueue });
      }

      res.json(chat.vars);
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/agent-dashboard/me', authenticate, requireTenant, async (req, res) => {
  try {
    if (req.user?.role !== 'AGENT') {
      return res.status(403).json({ error: 'Dashboard disponivel apenas para agentes.' });
    }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    const ownChats = await adapter.findMany('activeChats', {
      query: {
        tenantId: req.tenantId,
        agentId: req.user.id
      },
      sort: { updatedAt: -1, closedAt: -1, createdAt: -1 },
      limit: 1000
    });
    // Conversa devolvida ao fluxo deixa de ter agentId, mas continua sendo um
    // atendimento dele: entra pelo evento "atendente assumiu". So as mais
    // recentes, buscadas por id (consulta por id vai direto ao banco).
    const assumedEvents = await adapter.findMany('chatEvents', {
      query: { tenantId: req.tenantId, type: CHAT_EVENT_TYPES.AGENT_ASSUMED },
      sort: { timestamp: -1 },
      limit: 5000
    });
    const ownIds = new Set(ownChats.map((chat) => chat.id));
    const releasedIds = [...new Set(assumedEvents
      .filter((event) => String(event.actor?.id || '') === String(req.user.id))
      .map((event) => event.chatId))]
      .filter((chatId) => chatId && !ownIds.has(chatId))
      .slice(0, 300);
    const releasedChats = (await Promise.all(releasedIds.map((chatId) => (
      adapter.findOne('activeChats', { tenantId: req.tenantId, id: chatId }).catch(() => null)
    )))).filter(Boolean);
    const rawChats = [...ownChats, ...releasedChats].sort((a, b) => (
      parseTimeMs(b.updatedAt || b.closedAt || b.createdAt) - parseTimeMs(a.updatedAt || a.closedAt || a.createdAt)
    ));
    const chats = await hydrateChatsWithMessages(rawChats, { limit: 500 });

    const inRange = (value, start, end) => {
      const time = parseTimeMs(value);
      return time >= start.getTime() && time < end.getTime();
    };
    const closedAtInRange = (chat, start, end) => (
      chat.status === 'closed' && inRange(chat.closedAt || chat.updatedAt, start, end)
    );

    const monthChats = chats.filter((chat) => closedAtInRange(chat, monthStart, monthEnd));
    const dayChats = chats.filter((chat) => closedAtInRange(chat, dayStart, dayEnd));
    const monthWaitTimes = monthChats.map(getChatQueueWaitMinutes).filter(Number.isFinite);
    const dayWaitTimes = dayChats.map(getChatQueueWaitMinutes).filter(Number.isFinite);
    // Notas registradas quando o cliente respondeu, atribuidas a quem atendeu
    // (mesmo que a conversa tenha voltado ao fluxo). Conversas antigas, sem
    // evento, ainda usam a variavel da conversa.
    const ratingEvents = await adapter.findMany('chatEvents', {
      query: { tenantId: req.tenantId, type: CHAT_EVENT_TYPES.RATING_SUBMITTED },
      sort: { timestamp: -1 },
      limit: 5000
    });
    const chatsWithRatingEvent = new Set(ratingEvents.map((event) => event.chatId));
    const myRatingEvents = ratingEvents.filter((event) => String(event.context?.agentId || '') === String(req.user.id));
    const latestRatingByChat = new Map();
    for (const event of myRatingEvents) {
      if (!latestRatingByChat.has(event.chatId)) latestRatingByChat.set(event.chatId, Number(event.context?.value));
    }
    const allRatings = [
      ...myRatingEvents.map((event) => ({ rating: Number(event.context?.value), at: parseTimeMs(event.timestamp) })),
      ...chats
        .filter((chat) => !chatsWithRatingEvent.has(chat.id))
        .map((chat) => ({ rating: getChatRatingValue(chat), at: parseTimeMs(chat.closedAt || chat.updatedAt) }))
    ]
      .filter((item) => Number.isFinite(item.rating) && item.rating >= 1 && item.rating <= 5)
      .sort((a, b) => b.at - a.at);
    const userRecord = await adapter.getDocument('users', { id: req.user.id, tenantId: req.tenantId });
    const history = chats.slice(0, 30).map((chat) => ({
      id: chat.id,
      customerName: getAgentChatDisplayName(chat),
      channel: chat.channel || null,
      queue: chat.queue || null,
      status: chat.status || null,
      createdAt: chat.createdAt || null,
      updatedAt: chat.updatedAt || null,
      closedAt: chat.closedAt || null,
      queueWaitMinutes: getChatQueueWaitMinutes(chat),
      rating: latestRatingByChat.get(chat.id) ?? (chatsWithRatingEvent.has(chat.id) ? null : getChatRatingValue(chat))
    }));

    res.json({
      agent: {
        id: req.user.id,
        name: req.user.name,
        ratingAvg: Number(userRecord?.ratingAvg || 0),
        ratingCount: Number(userRecord?.ratingCount || 0),
        latestRating: allRatings[0]?.rating || null
      },
      month: {
        atendimentos: monthChats.length,
        tmeMinutes: average(monthWaitTimes),
        ratingAvg: average(allRatings
          .filter((item) => item.at >= monthStart.getTime() && item.at < monthEnd.getTime())
          .map((item) => item.rating))
      },
      today: {
        atendimentos: dayChats.length,
        tmeMinutes: average(dayWaitTimes),
        ratingAvg: average(allRatings
          .filter((item) => item.at >= dayStart.getTime() && item.at < dayEnd.getTime())
          .map((item) => item.rating))
      },
      // "Agora" so conta o que esta com ele: uma conversa devolvida pode ter
      // voltado a fila e estar com outra pessoa.
      active: {
        open: chats.filter((chat) => chat.status === 'open' && String(chat.agentId || '') === String(req.user.id)).length,
        waitingOwned: chats.filter((chat) => chat.status === 'waiting' && String(chat.agentId || '') === String(req.user.id)).length
      },
      history: await sanitizeChatPayloadForViewer(req.tenantId, history)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/transfer-options', authenticate, requireTenant, async (req, res) => {
  try {
    const [queues, users] = await Promise.all([
      adapter.getCollection('queues', req.tenantId),
      adapter.getCollection('users', req.tenantId)
    ]);

    const agents = (Array.isArray(users) ? users : [])
      .filter((user) => user.role === 'AGENT' && user.id !== req.user?.id)
      .map(({ password, ...agent }) => ({
        id: agent.id,
        name: agent.name,
        username: agent.username,
        queues: Array.isArray(agent.queues) ? agent.queues : [],
        isOnline: Boolean(agent.isOnline),
        lastSeen: agent.lastSeen || null
      }));

    res.json({
      queues: (Array.isArray(queues) ? queues : []).filter((queue) => queue.active !== false),
      agents
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/transfer', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { manager: 'conversas', permission: ['atendimento.fila', 'operacao.intervir'] }), requireTenant, async (req, res, next) => {
  try {
    const chatId = asIdentifier(req.body?.chatId);
    const queue = asIdentifier(req.body?.queue);
    const reason = asIdentifier(req.body?.reason, { maxLength: 500 });
    const resumeNodeId = req.body?.resumeNodeId === null || req.body?.resumeNodeId === undefined
      ? null
      : asIdentifier(req.body.resumeNodeId);
    const agentId = req.body?.agentId === null || req.body?.agentId === undefined
      ? null
      : asIdentifier(req.body.agentId);
    const continueFlow = req.body?.continueFlow !== false;

    if (!chatId) return res.status(400).json({ error: 'chatId e obrigatorio' });

    await withChatLock(chatId, async () => {
      const chat = await loadChatById(req, res, chatId);
      if (!chat) return;

      const now = new Date().toISOString();
      const previousStatus = chat.status;
      const previousQueue = chat.queue || null;
      const previousAgentId = chat.agentId || null;
      const previousAgentName = chat.agentName || null;
      const previousAttendance = {
        agentId: previousAgentId,
        agentName: previousAgentName,
        queue: previousQueue,
        queueId: chat.queueId || null,
        status: previousStatus
      };

      if (req.user?.role === 'AGENT' && previousAgentId !== req.user.id) {
        return res.status(403).json({ error: 'Voce so pode transferir atendimentos sob sua responsabilidade.' });
      }

      let targetAgent = null;
      let targetQueue = null;
      if (agentId) {
        targetAgent = await adapter.getDocument('users', {
          id: agentId,
          tenantId: chat.tenantId,
          role: 'AGENT'
        });
        if (!targetAgent) return res.status(400).json({ error: 'Agente de destino invalido.' });
      }

      if (!queue && !targetAgent) {
        return res.status(400).json({ error: 'Informe uma fila ou agente de destino.' });
      }
      let resolvedQueueName = queue;
      if (queue) {
        targetQueue = await adapter.getDocument('queues', { tenantId: chat.tenantId, name: queue });
        if (!targetQueue) {
          // Sem agente de destino, uma fila inexistente e erro real. Com agente,
          // a fila e secundaria: ignoramos um nome invalido (fila renomeada ou
          // removida) para nao travar a atribuicao direta do agente.
          if (!targetAgent) {
            return res.status(400).json({ error: 'Fila de destino invalida.' });
          }
          resolvedQueueName = null;
        }
      }

      chat.transferReason = reason || 'Transferencia manual';
      chat.transferredAt = now;
      chat.continueFlowAfterQueue = continueFlow;
      chat.resumeNodeId = continueFlow ? resumeNodeId : null;
      chat.resumePending = false;
      chat.updatedAt = now;
      let transferNotice = '';

      if (targetAgent) {
        chat.status = 'open';
        chat.transferredTo = targetAgent.name || targetAgent.id;
        chat.waitingSince = null;
        chat.queue = resolvedQueueName || (Array.isArray(targetAgent.queues) ? targetAgent.queues[0] : null) || previousQueue || null;
        chat.queueId = targetQueue?.id || (chat.queue === previousQueue ? chat.queueId || null : null);
        chat.agentId = targetAgent.id;
        chat.agentName = targetAgent.name || targetAgent.username || targetAgent.id;
        chat.assignedAt = now;
        chat.preferredAgentId = null;
        chat.preferredAgentName = null;
        transferNotice = `Atendimento transferido de ${previousAgentName || 'agente'} para ${chat.agentName}.`;
        await sendSystemNoticeToCustomer({ chat, text: transferNotice });
      } else {
        chat.status = 'waiting';
        chat.transferredTo = queue;
        chat.waitingSince = now;
        chat.queue = queue;
        chat.queueId = targetQueue.id;
        chat.agentId = null;
        chat.agentName = null;
        chat.assignedAt = null;
        chat.preferredAgentId = null;
        chat.preferredAgentName = null;
        transferNotice = `Atendimento transferido para a fila ${queue}.`;
        await sendSystemNoticeToCustomer({ chat, text: transferNotice });
      }

      await adapter.saveDocument('activeChats', chat);
      await syncAttendanceLifecycle({ type: 'transferred', chat, previous: previousAttendance, actor: req.user });
      await appendAndEmitChatMessage(chat, {
        id: generateId('msg'),
        sender: 'system',
        text: transferNotice,
        timestamp: now
      }, { incrementUnread: false });
      await createLog('CHAT_TRANSFER', {
        chatId,
        queue: chat.queue || queue || null,
        reason: reason || null,
        tenantId: chat.tenantId,
        fromAgentId: previousAgentId || null,
        targetAgentId: targetAgent?.id || null
      }, req.user.id);

      const isRetransfer = previousStatus === 'waiting' || previousStatus === 'open' || Boolean(previousQueue);
      await emitChatEvent({
        tenantId: chat.tenantId,
        chatId,
        type: isRetransfer ? CHAT_EVENT_TYPES.QUEUE_TRANSFERRED : CHAT_EVENT_TYPES.QUEUE_ENTERED,
        actor: { kind: previousAgentId ? 'agent' : 'flow', id: previousAgentId || req.user?.id || null, name: req.user?.name || null },
        context: {
          queue: chat.queue || queue || null,
          fromQueue: previousQueue,
          fromStatus: previousStatus,
          fromAgentId: previousAgentId,
          reason: reason || null,
          continueFlow: Boolean(continueFlow),
          targetAgentId: targetAgent?.id || null,
          targetAgentName: targetAgent?.name || null
        }
      });

      const io = getIo();
      if (io) {
        const { secureVars: _sv2, secureVarNames: _svn2, ...chatForTransfer } = chat;
        io.to(`tenant:${chatForTransfer.tenantId}`).emit('agent_assigned', { chat: chatForTransfer });
      }

      res.json({
        success: true,
        message: targetAgent
          ? `Chat transferido para ${chat.agentName}`
          : `Chat transferido para a fila ${queue}`,
        chat: await sanitizeChatPayloadForViewer(req.tenantId, chat)
      });
    });
  } catch (error) {
    next(error);
  }
});

// Legacy transfer implementation kept disabled after the unified transfer route above.
router.post('/transfer-legacy-disabled', authenticate, requireTenant, async (req, res) => {
  try {
    const chatId = asIdentifier(req.body?.chatId);
    const queue = asIdentifier(req.body?.queue);
    const reason = asIdentifier(req.body?.reason, { maxLength: 500 });
    const resumeNodeId = req.body?.resumeNodeId === null || req.body?.resumeNodeId === undefined
      ? null
      : asIdentifier(req.body.resumeNodeId);
    const agentId = req.body?.agentId === null || req.body?.agentId === undefined
      ? null
      : asIdentifier(req.body.agentId);
    const agentName = req.body?.agentName === null || req.body?.agentName === undefined
      ? null
      : asIdentifier(req.body.agentName, { maxLength: 200 });
    const continueFlow = req.body?.continueFlow !== false;

    if (!chatId) {
      return res.status(400).json({ error: 'chatId é obrigatório' });
    }

    await withChatLock(chatId, async () => {
      const chat = await loadChatById(req, res, chatId);
      if (!chat) return;

      const now = new Date().toISOString();
      const previousStatus = chat.status;
      const previousQueue = chat.queue || null;
      const previousAgentId = chat.agentId || null;

      chat.status = 'waiting';
      chat.transferredTo = queue;
      chat.transferReason = reason || 'Fluxo automático';
      chat.transferredAt = now;
      chat.waitingSince = now;
      chat.continueFlowAfterQueue = continueFlow;
      chat.resumeNodeId = continueFlow ? resumeNodeId : null;
      chat.resumePending = false;
      chat.updatedAt = now;
      chat.queue = queue;
      chat.agentId = null;
      chat.agentName = null;
      if (agentId) {
        chat.preferredAgentId = agentId;
        chat.preferredAgentName = agentName || null;
      } else {
        chat.preferredAgentId = null;
        chat.preferredAgentName = null;
      }

      await adapter.saveDocument('activeChats', chat);
      await createLog('CHAT_TRANSFER', {
        chatId,
        queue,
        reason: reason || null,
        tenantId: chat.tenantId,
        preferredAgentId: agentId || null
      }, req.user.id);

      const isRetransfer = previousStatus === 'waiting' || previousStatus === 'open' || Boolean(previousQueue);
      await emitChatEvent({
        tenantId: chat.tenantId,
        chatId,
        type: isRetransfer ? CHAT_EVENT_TYPES.QUEUE_TRANSFERRED : CHAT_EVENT_TYPES.QUEUE_ENTERED,
        actor: { kind: previousAgentId ? 'agent' : 'flow', id: previousAgentId || req.user?.id || null, name: req.user?.name || null },
        context: {
          queue,
          fromQueue: previousQueue,
          fromStatus: previousStatus,
          fromAgentId: previousAgentId,
          reason: reason || null,
          continueFlow: Boolean(continueFlow),
          preferredAgentId: agentId || null
        }
      });

      const io = getIo();
      if (io) {
        const { secureVars: _sv2, secureVarNames: _svn2, ...chatForTransfer } = chat;
        io.to(`tenant:${chatForTransfer.tenantId}`).emit('agent_assigned', { chat: chatForTransfer });
      }

      res.json({
        success: true,
        message: `Chat transferido para a fila ${queue}`,
        chat: await sanitizeChatPayloadForViewer(req.tenantId, chat)
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const agentQueuesForUser = (user) => {
  const queues = (user && Array.isArray(user.queues)) ? user.queues : [];
  return queues
    .map(q => (typeof q === 'string' ? q.toUpperCase() : '').trim())
    .filter(Boolean);
};

router.get('/my-queues', authenticate, requireTenant, async (req, res) => {
  try {
    const normalizedQueues = agentQueuesForUser(req.user);

    const [waitingAll, active] = await Promise.all([
      adapter.findDocuments('activeChats', {
        tenantId: req.tenantId,
        status: 'waiting'
      }, { projection: CHAT_SUMMARY_PROJECTION }),
      adapter.findDocuments('activeChats', {
        tenantId: req.tenantId,
        agentId: req.user.id,
        status: 'open'
      }, { projection: CHAT_SUMMARY_PROJECTION })
    ]);

    const waiting = waitingAll.filter(chat =>
      chat.queue && normalizedQueues.includes(chat.queue.toUpperCase())
    );

    res.json({
      waiting: await sanitizeChatPayloadForViewer(req.tenantId, waiting),
      active: await sanitizeChatPayloadForViewer(req.tenantId, active)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/agent/:agentId', authenticate, requireTenant, async (req, res) => {
  try {
    const agentId = asIdentifier(req.params?.agentId);
    if (!agentId) {
      return res.status(400).json({ error: 'agentId inválido' });
    }
    const canInspectOtherAgents = ['MANAGER', 'ADMIN', 'SUPER_ADMIN'].includes(req.user?.role);
    if (!canInspectOtherAgents && agentId !== req.user?.id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const limit = Number(req.query.limit || 50);
    const query = { tenantId: req.tenantId, agentId };
    const total = await adapter.countDocuments('activeChats', query);
    const allChats = await adapter.findMany('activeChats', {
      query,
      projection: CHAT_SUMMARY_PROJECTION,
      sort: { updatedAt: -1, createdAt: -1 },
      limit: Math.max(1, limit)
    });
    const filtered = allChats;

    filtered.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

    const uniqueCustomers = new Set(
      filtered
        .map(chat => chat.customerCpf || chat.channelUserId || chat.channelChatId)
        .filter(Boolean)
    );

    res.json({
      total,
      uniqueCustomers: uniqueCustomers.size,
      chats: await sanitizeChatPayloadForViewer(req.tenantId, filtered.slice(0, Math.max(1, limit)))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/pickup-all', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { permission: 'atendimento.fila' }), requireTenant, async (req, res) => {
  try {
    const normalizedQueues = agentQueuesForUser(req.user);
    if (!normalizedQueues.length) {
      return res.status(403).json({ error: 'Voce nao esta alocado em nenhuma fila.' });
    }

    const openingMessage = String(req.body?.message ?? '').trim();
    const tenantSettings = await getTenantSettings(req.tenantId);
    const notifyPickup = tenantSettings?.silentPickup !== true;
    const waitingAll = await adapter.findDocuments('activeChats', {
      tenantId: req.tenantId,
      status: 'waiting'
    });
    const candidates = (Array.isArray(waitingAll) ? waitingAll : []).filter(chat =>
      chat?.id && chat.queue && normalizedQueues.includes(String(chat.queue).toUpperCase())
    );

    const picked = [];
    const failed = [];

    for (const candidate of candidates) {
      try {
        await withChatLock(candidate.id, async () => {
          const chat = await adapter.getDocument('activeChats', { id: candidate.id });
          if (!chat || chat.tenantId !== req.tenantId || chat.status !== 'waiting') return;
          if (!chat.queue || !normalizedQueues.includes(String(chat.queue).toUpperCase())) return;

          const now = new Date().toISOString();
          chat.status = 'open';
          chat.agentId = req.user.id;
          chat.agentName = req.user.name;
          chat.assignedAt = now;
          chat.updatedAt = now;
          chat.waitingSince = null;
          const pickupNotice = `O agente ${req.user.name} assumiu o atendimento.`;
          const claim = await adapter.updateOne('activeChats', {
            id: chat.id,
            tenantId: chat.tenantId,
            status: 'waiting'
          }, {
            $set: {
              status: 'open', agentId: chat.agentId, agentName: chat.agentName,
              assignedAt: chat.assignedAt, updatedAt: chat.updatedAt, waitingSince: null
            }
          });
          if (claim?.matchedCount !== 1) return;
          if (notifyPickup) await sendSystemNoticeToCustomer({ chat, text: pickupNotice });

          await syncAttendanceLifecycle({ type: 'assigned', chat, actor: req.user });
          await appendAndEmitChatMessage(chat, {
            id: generateId('msg'),
            sender: 'system',
            text: pickupNotice,
            timestamp: now
          }, { incrementUnread: false });

          if (openingMessage) {
            const message = {
              id: generateId('msg'),
              sender: 'agent',
              text: openingMessage,
              buttons: null,
              providerMessageId: null,
              deliveryStatus: null,
              deliveryStatusAt: null,
              meta: null,
              timestamp: new Date().toISOString()
            };
            await sendAgentTextToChannel({ chat, text: openingMessage, message });
            await appendAndEmitChatMessage(chat, message, { incrementUnread: false });
          }

          await createLog('CHAT_PICKUP_ALL_ITEM', {
            chatId: chat.id,
            tenantId: chat.tenantId,
            queue: chat.queue || null,
            agentId: req.user.id,
            withOpeningMessage: Boolean(openingMessage)
          }, req.user.id);
          await emitChatEvent({
            tenantId: chat.tenantId,
            chatId: chat.id,
            type: CHAT_EVENT_TYPES.AGENT_ASSUMED,
            actor: { kind: 'agent', id: req.user.id, name: req.user.name || null },
            context: { queue: chat.queue || null, source: 'pickup-all', withOpeningMessage: Boolean(openingMessage) }
          });

          const io = getIo();
          if (io) {
            const { secureVars: _sv, secureVarNames: _svn, ...chatForPickup } = chat;
            io.to(`tenant:${chatForPickup.tenantId}`).emit('agent_assigned', { chat: chatForPickup });
          }

          picked.push(chat);
        });
      } catch (error) {
        failed.push({
          chatId: candidate.id,
          error: error?.message || 'Falha ao puxar atendimento'
        });
      }
    }

    await createLog('CHAT_PICKUP_ALL', {
      tenantId: req.tenantId,
      agentId: req.user.id,
      totalCandidates: candidates.length,
      picked: picked.length,
      failed: failed.length,
      withOpeningMessage: Boolean(openingMessage)
    }, req.user.id);

    res.json({
      success: true,
      totalCandidates: candidates.length,
      pickedCount: picked.length,
      failedCount: failed.length,
      chats: await sanitizeChatPayloadForViewer(req.tenantId, picked),
      failed
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/pickup', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { permission: 'atendimento.fila' }), requireTenant, async (req, res) => {
  try {
    const chatId = asIdentifier(req.body?.chatId);
    if (!chatId) {
      return res.status(400).json({ error: 'chatId é obrigatório' });
    }

    await withChatLock(chatId, async () => {
    const normalizedQueues = agentQueuesForUser(req.user);
    const chat = await loadChatById(req, res, chatId);
    if (!chat) return;
    if (chat.status !== 'waiting') {
      return res.status(400).json({ error: 'Chat não está em fila' });
    }

    if (!chat.queue || !normalizedQueues.includes(chat.queue.toUpperCase())) {
      return res.status(403).json({ error: 'Você não pertence a essa fila' });
    }

    chat.status = 'open';
    chat.agentId = req.user.id;
    chat.agentName = req.user.name;
    chat.assignedAt = new Date().toISOString();
    chat.updatedAt = chat.assignedAt;
    chat.waitingSince = null;
    const pickupNotice = `O agente ${req.user.name} assumiu o atendimento.`;

    const claim = await adapter.updateOne('activeChats', {
      id: chat.id,
      tenantId: chat.tenantId,
      status: 'waiting'
    }, {
      $set: {
        status: 'open', agentId: chat.agentId, agentName: chat.agentName,
        assignedAt: chat.assignedAt, updatedAt: chat.updatedAt, waitingSince: null
      }
    });
    if (claim?.matchedCount !== 1) {
      return res.status(409).json({ error: 'Este atendimento ja foi assumido por outro agente.' });
    }
    await syncAttendanceLifecycle({ type: 'assigned', chat, actor: req.user });
    const pickupSettings = await getTenantSettings(chat.tenantId);
    if (pickupSettings?.silentPickup !== true) {
      await sendSystemNoticeToCustomer({ chat, text: pickupNotice });
    }
    await appendAndEmitChatMessage(chat, {
      id: generateId('msg'),
      sender: 'system',
      text: pickupNotice,
      timestamp: new Date().toISOString()
    }, { incrementUnread: false });
    await createLog('CHAT_PICKUP', {
      chatId,
      tenantId: chat.tenantId,
      queue: chat.queue || null,
      agentId: req.user.id
    }, req.user.id);
    await emitChatEvent({
      tenantId: chat.tenantId,
      chatId,
      type: CHAT_EVENT_TYPES.AGENT_ASSUMED,
      actor: { kind: 'agent', id: req.user.id, name: req.user.name || null },
      context: { queue: chat.queue || null, source: 'pickup' }
    });

    const io = getIo();
    if (io) {
      const { secureVars: _sv3, secureVarNames: _svn3, ...chatForPickup } = chat;
      io.to(`tenant:${chatForPickup.tenantId}`).emit('agent_assigned', { chat: chatForPickup });
    }

    res.json(await sanitizeChatPayloadForViewer(req.tenantId, chat));
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fechar chat
router.put('/:id/close', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { manager: 'conversas', permission: ['atendimento.fila', 'operacao.intervir'] }), requireTenant, async (req, res) => {
  try {
    const { continueFlow, silent } = req.body || {};
    const id = asIdentifier(req.params?.id);
    if (!id) {
      return res.status(400).json({ error: 'id inválido' });
    }
    await withChatLock(id, async () => {

    const chat = await loadChatById(req, res, id);
    if (!chat) return;
    if (isTurizmoProtectedAttendance(chat)) {
      return res.status(409).json({
        error: 'Este atendimento esta protegido pelo Turizmo e exige close_attendance com confirmacao manual.',
        code: 'turizmo_protected_attendance'
      });
    }
    const wantsContinue = continueFlow && chat.continueFlowAfterQueue && chat.resumeNodeId;
    let shouldContinue = Boolean(wantsContinue);

    if (shouldContinue && chat.channel === 'telegram') {
      const isActiveSession = await isActiveTelegramSessionForChat(chat);
      if (!isActiveSession) {
        shouldContinue = false;
        console.warn(
          `[CHAT_CLOSE] Telegram resume bloqueado para chat ${chat.id}: sessão ativa divergente.`
        );
      }
    }

    if (shouldContinue) {
      chat.status = 'bot';
      chat.resumePending = true;
      chat.continueFlowAfterQueue = false;
      chat.currentNodeId = null;
      chat.catalogContext = null;
      chat.transferredTo = null;
      chat.updatedAt = new Date().toISOString();
    } else {
      applyFlowRuntimeReset(chat);
      chat.status = 'closed';
      chat.closedAt = new Date().toISOString();
      chat.outreachPendingReply = false;
    }

    // Nota do atendente nao e somada aqui: ao encerrar ou devolver ao fluxo o
    // cliente ainda nao avaliou. Ela entra quando o cliente responde o no de
    // nota (services/ratings.js).

    if (!shouldContinue && isGenesysChat(chat)) {
      chat.closeReason = chat.closeReason || 'app_agente';
    }

    await adapter.saveDocument('activeChats', chat);
    if (!shouldContinue) {
      await syncAttendanceLifecycle({ type: 'closed', chat, actor: req.user, result: chat.closeReason || 'closed_by_agent' });
    }
    await createLog('CHAT_CLOSE', { chatId: id, tenantId: chat.tenantId, continueFlow: shouldContinue }, req.user.id);
    await emitChatEvent({
      tenantId: chat.tenantId,
      chatId: id,
      type: shouldContinue ? CHAT_EVENT_TYPES.RESUME_TO_FLOW : CHAT_EVENT_TYPES.AGENT_CLOSED,
      actor: { kind: 'agent', id: req.user.id, name: req.user.name || null },
      context: {
        queue: chat.queue || null,
        agentId: chat.agentId || null,
        silent: silent === true,
        resumeNodeId: shouldContinue ? chat.resumeNodeId : null
      }
    });

    // Genesys fase 4: pede para a extensao encerrar no Genesys
    let genesysRelay = null;
    if (!shouldContinue && isGenesysChat(chat)) {
      genesysRelay = await relayAgentCloseToGenesys({
        chat,
        agentId: req.user?.id || chat.agentId || null,
        motivo: 'app_agente',
        silent: silent === true
      });
      if (genesysRelay && genesysRelay.relayed === false && !genesysRelay.skipped) {
        console.warn('[GENESYS] Chat fechado no app, mas extensao offline/indisponivel', {
          chatId: chat.id,
          reason: genesysRelay.reason
        });
      }
    }

    const io = getIo();
    if (io) {
      io.to(`tenant:${chat.tenantId}`).emit('chat_closed', {
        chatId: id,
        ...(genesysRelay ? { genesys: genesysRelay } : {})
      });
    }

    if (shouldContinue && chat.resumeNodeId) {
      await resumeFlowAfterAgentClose(chat);
    }

    if (!shouldContinue && chat.activeOutreach === true && silent !== true) {
      const closingText = 'Atendimento encerrado.';

      if (chat.channel === 'telegram' && chat.channelChatId) {
        const config = chat.tenantId ? await getTelegramConfig(chat.tenantId) : null;
        const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
        if (botToken) {
          await sendTelegramMessage(chat.channelChatId, closingText, null, botToken);
        }
      }

      if (chat.channel === 'whatsapp' && chat.channelUserId) {
        const config = chat.tenantId ? await getWhatsAppConfig(chat.tenantId) : null;
        const accessToken = config?.accessToken || null;
        const phoneNumberId = getChatWhatsAppPhoneNumberId(chat, config);
        if (accessToken && phoneNumberId) {
          const to = normalizeWhatsappWaId(chat.channelUserId);
          try {
            await sendWhatsAppText({
              accessToken,
              phoneNumberId,
              to,
              text: closingText
            });
          } catch (err) {
            console.error('[WHATSAPP] Falha ao enviar encerramento de atendimento ativo', err?.message || err);
          }
        }
      }
    }

    res.json({
      success: true,
      resumePending: shouldContinue,
      silent: silent === true,
      ...(genesysRelay ? { genesys: genesysRelay } : {})
    });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/:id/resume', authenticate, authorize(CHAT_OPERATIONAL_ROLES, { manager: 'conversas', permission: ['atendimento.fila', 'operacao.intervir'] }), requireTenant, async (req, res) => {
  try {
    const id = asIdentifier(req.params?.id);
    if (!id) {
      return res.status(400).json({ error: 'id inválido' });
    }
    await withChatLock(id, async () => {
    const chat = await loadChatById(req, res, id);
    if (!chat) return;

    chat.resumePending = false;
    chat.status = 'open';
    await adapter.saveDocument('activeChats', chat);
    res.json({ success: true });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Linha do tempo de eventos do atendimento
router.get('/:id/timeline', authenticate, requireTenant, async (req, res) => {
  try {
    const id = asIdentifier(req.params?.id);
    if (!id) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const chat = await adapter.getDocument('activeChats', { id });
    if (!chat) return res.status(404).json({ error: 'Chat não encontrado' });
    if (req.user.role !== 'SUPER_ADMIN' && chat.tenantId !== req.tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const events = await queryChatEvents({ tenantId: chat.tenantId, chatId: id, limit: 2000 });

    const isClosed = chat.status === 'closed' || events.some((evt) => (
      evt.type === CHAT_EVENT_TYPES.AGENT_CLOSED
      || evt.type === CHAT_EVENT_TYPES.CLOSED_BY_INACTIVITY
    ));

    const lastMessage = await getLastChatMessage(id, { tenantId: chat.tenantId })
      || (Array.isArray(chat.messages) && chat.messages.length ? chat.messages[chat.messages.length - 1] : null);
    const lastAgentAssumed = [...events].reverse().find((evt) => evt.type === CHAT_EVENT_TYPES.AGENT_ASSUMED) || null;

    if (!isClosed && lastMessage && lastMessage.sender === 'user' && lastAgentAssumed) {
      const lastTs = new Date(lastMessage.timestamp || 0).getTime();
      const assumedTs = new Date(lastAgentAssumed.timestamp || 0).getTime();
      if (Number.isFinite(lastTs) && lastTs > assumedTs) {
        const settings = await getTenantSettings(chat.tenantId);
        const thresholdMin = Number(settings?.disengageThresholdMinutes || 30);
        const minutesSince = (Date.now() - lastTs) / 60000;
        if (thresholdMin > 0 && minutesSince > thresholdMin) {
          events.push({
            id: `evt_inferred_disengage_${id}`,
            tenantId: chat.tenantId,
            chatId: id,
            type: CHAT_EVENT_TYPES.CUSTOMER_DISENGAGED,
            timestamp: new Date(lastTs + thresholdMin * 60000).toISOString(),
            actor: { kind: 'customer' },
            context: {
              inferred: true,
              thresholdMinutes: thresholdMin,
              minutesSinceLastMessage: Math.round(minutesSince),
              lastMessageAt: lastMessage.timestamp || null
            }
          });
          events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        }
      }
    }

    res.json({
      chat: {
        id: chat.id,
        tenantId: chat.tenantId,
        status: chat.status,
        channel: chat.channel || null,
        queue: chat.queue || null,
        agentId: chat.agentId || null,
        agentName: chat.agentName || null,
        customerName: chat.customerName || null,
        customerCpf: chat.customerCpf || null,
        channelUserId: chat.channelUserId || null,
        createdAt: chat.createdAt || null,
        updatedAt: chat.updatedAt || null,
        closedAt: chat.closedAt || null,
        waitingSince: chat.waitingSince || null,
        closedByInactivity: Boolean(chat.closedByInactivity || chat.inactivityClosed)
      },
      events
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/history', authenticate, requireTenant, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), MAX_HISTORY_LIMIT);
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const search = String(req.query.q || req.query.search || '').trim();
    const cpf = String(req.query.cpf || '').trim();
    const agentId = String(req.query.agentId || '').trim();
    const queue = String(req.query.queue || '').trim();
    const channel = String(req.query.channel || '').trim();
    const from = normalizeDate(req.query.from);
    const to = normalizeDate(req.query.to, true);

    const mongoQuery = getScopedChatQuery(req, { status: 'closed' });
    if (cpf) mongoQuery.customerCpf = cpf;
    if (agentId) mongoQuery.agentId = agentId;
    if (queue) mongoQuery.queue = queue;
    if (channel) mongoQuery.channel = channel;
    if (from || to) {
      mongoQuery.updatedAt = {};
      if (from) mongoQuery.updatedAt.$gte = from.toISOString();
      if (to) mongoQuery.updatedAt.$lte = to.toISOString();
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const messageMatches = await adapter.findMany('chatMessages', {
        query: {
          ...(req.tenantId ? { tenantId: req.tenantId } : {}),
          text: regex
        },
        projection: { _id: 0, chatId: 1 },
        limit: 500
      });
      const matchedChatIds = [...new Set((messageMatches || []).map((item) => item.chatId).filter(Boolean))];
      mongoQuery.$or = [
        { id: regex },
        { customerCpf: regex },
        { channelUserId: regex },
        { channelChatId: regex },
        { agentName: regex },
        { queue: regex },
        { transferReason: regex },
        { closeReason: regex },
        { customerName: regex },
        { 'messages.text': regex },
        ...(matchedChatIds.length ? [{ id: { $in: matchedChatIds } }] : []),
        { 'variables.nome_cliente': regex },
        { 'vars.nome_cliente': regex }
      ];
    }

    const total = await adapter.countDocuments('activeChats', mongoQuery);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const items = await adapter.findMany('activeChats', {
      query: mongoQuery,
      projection: CHAT_SUMMARY_PROJECTION,
      sort: { updatedAt: -1, closedAt: -1, createdAt: -1 },
      skip: start,
      limit
    });

    res.json({
      items: await sanitizeChatPayloadForViewer(req.tenantId, await attachContactNames(req.tenantId, items)),
      total,
      page,
      totalPages,
      limit
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/history/:cpf', authenticate, requireTenant, async (req, res) => {
  try {
    const cpf = String(req.params.cpf || '').trim();
    if (!cpf) {
      return res.status(400).json({ error: 'CPF é obrigatório' });
    }

    const history = await adapter.findMany('activeChats', {
      query: getScopedChatQuery(req, { customerCpf: cpf }),
      projection: CHAT_SUMMARY_PROJECTION,
      sort: { updatedAt: -1, closedAt: -1, createdAt: -1 },
      limit: MAX_HISTORY_LIMIT
    });

    res.json(await sanitizeChatPayloadForViewer(req.tenantId, history));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/', authenticate, requireTenant, async (req, res) => {
  try {
    const summaryOnly = req.query.summary === '1' || req.query.summary === 'true';
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const limitRaw = parseInt(req.query.limit || '0', 10) || 0;
    const limit = limitRaw > 0 ? Math.min(Math.max(limitRaw, 1), 500) : 0;
    const query = getScopedChatQuery(req, { status: { $ne: 'closed' } });

    if (!limit) {
      const chats = await adapter.findMany('activeChats', {
        query,
        projection: CHAT_SUMMARY_PROJECTION,
        sort: { updatedAt: -1, createdAt: -1 }
      });
      const sanitized = await sanitizeChatPayloadForViewer(req.tenantId, chats);
      return res.json(summaryOnly ? buildChatSummaryCollection(sanitized) : sanitized);
    }

    const total = await adapter.countDocuments('activeChats', query);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const items = await adapter.findMany('activeChats', {
      query,
      projection: CHAT_SUMMARY_PROJECTION,
      sort: { updatedAt: -1, createdAt: -1 },
      skip: start,
      limit
    });
    const sanitizedItems = await sanitizeChatPayloadForViewer(req.tenantId, items);
    res.json({
      items: summaryOnly ? buildChatSummaryCollection(sanitizedItems) : sanitizedItems,
      total,
      page,
      totalPages,
      limit
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', authenticate, requireTenant, async (req, res) => {
  try {
    const id = asIdentifier(req.params?.id);
    if (!id) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const chat = await adapter.getDocument('activeChats', { id });

    if (!chat) return res.status(404).json({ error: 'Chat não encontrado' });

    if (req.user.role !== 'SUPER_ADMIN' && chat.tenantId !== req.tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const hydrated = await hydrateChatWithMessages(chat, {
      limit: Math.min(Math.max(parseInt(req.query.limit || '1000', 10) || 1000, 1), 2000),
      before: req.query.before || null,
      after: req.query.after || null
    });
    await attachContactNames(chat.tenantId || req.tenantId, hydrated);
    const payload = await sanitizeChatPayloadForViewer(req.tenantId, hydrated);
    const latestClassifications = await adapter.findMany('messageClassifications', {
      query: { tenantId: chat.tenantId, chatId: chat.id },
      projection: {
        _id: 0, id: 1, intent: 1, sentiment: 1, confidence: 1, reason: 1,
        nextAction: 1, suggestedReply: 1, requiresHumanReview: 1, createdAt: 1
      },
      sort: { createdAt: -1 },
      limit: 1
    });
    res.json({ ...payload, commercialInsights: latestClassifications[0] || null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
