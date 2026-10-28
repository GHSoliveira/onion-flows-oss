import adapter from '../../db/DatabaseAdapter.js';
import { addUserMedia, addUserMessage, applyUserInput, getChatById, mergeChatVars, runFlow, startChatFlow, tryHandleGlobalCommand, updateChatMessageDeliveryStatusByProviderMessageId } from './flowRunner.js';
import { isTenantBillingPaused, markChatBillingPaused } from './billingGuard.js';
import { buildOrderCart, extractWhatsAppOrder } from './whatsappOrders.js';
import { findWhatsAppConfigByPhoneNumberId, getWhatsAppConfig, resolveWhatsAppFlowId, resolveWhatsAppSender } from './channelConfig.js';
import { downloadWhatsAppMedia, getWhatsAppMediaMetadata, sendWhatsAppMedia, sendWhatsAppText } from './whatsappApi.js';
import { createLog } from './logs.js';
import { ensureTenantLimit } from './tenantLimits.js';
import { normalizeWhatsappWaId } from './activeOutreach.js';
import { updateOutreachStatusByProviderMessageId } from './outreachHistory.js';
import { storeTenantMediaBuffer } from './mediaStorage.js';
import { withChannelUserLock, withChatLock } from './chatLocks.js';
import { sanitizeChatState } from './chatStateGuard.js';
import { getCachedRuntimeFlow, toRuntimeFlow, getCachedRuntimeSchedules, getCachedRuntimeTemplates } from './flowRuntimeCache.js';
import { notifyWhatsAppProblem } from './whatsappAlerts.js';
import { generateId } from '../utils/helpers.js';
import { CHAT_EVENT_TYPES, emitChatEvent } from './chatEvents.js';
import { upsertContactFromChannel } from './contactIdentity.js';
import { getChatMessageByProviderId } from './chatMessages.js';
import { attributeInboundReply } from './replyAttribution.js';
import { notifyProtectedAttendanceInbound } from './protectedAttendance.js';
import { handleWhatsAppAccountWebhook } from './whatsappAccountAlerts.js';
import { handleVoiceCallWebhook } from './voiceCalls.js';

// Resolve o objeto replyTo quando o cliente cita uma mensagem (reply nativo).
// Busca a mensagem original pelo providerMessageId citado e monta o preview.
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

// Conta oficial "WhatsApp Business" da Meta: manda avisos de configuracao para
// todo numero novo. Nao e cliente e nao aceita resposta, entao nao abre conversa
// nem dispara fluxo. Outros remetentes podem ser somados por
// WHATSAPP_IGNORED_SENDERS (numeros separados por virgula).
const META_OFFICIAL_SENDERS = ['16465894168'];

export const isIgnoredWhatsAppSender = (from) => {
  const digits = String(from || '').replace(/\D/g, '');
  if (!digits) return false;
  const extras = String(process.env.WHATSAPP_IGNORED_SENDERS || '')
    .split(',')
    .map((item) => item.replace(/\D/g, ''))
    .filter(Boolean);
  return META_OFFICIAL_SENDERS.includes(digits) || extras.includes(digits);
};

const normalizeEnvValue = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};

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

const parseWebhookMessages = (payload) => {
  const results = [];
  const supportedMediaTypes = new Set(['image', 'video', 'audio', 'document']);
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  entries.forEach((entry) => {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    changes.forEach((change) => {
      const value = change?.value || {};
      const phoneNumberId = value?.metadata?.phone_number_id || null;
      // Indexa profile name por wa_id para anexar a cada mensagem do contato.
      const profileByWaId = new Map();
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      contacts.forEach((entry) => {
        const waId = String(entry?.wa_id || '').replace(/\D/g, '');
        const name = String(entry?.profile?.name || '').trim();
        if (waId && name) profileByWaId.set(waId, name);
      });
      const messages = Array.isArray(value.messages) ? value.messages : [];
      messages.forEach((msg) => {
        const type = String(msg?.type || '').toLowerCase();
        // context.id = id da mensagem citada quando o cliente responde (reply nativo).
        const replyToProviderId = msg?.context?.id ? String(msg.context.id) : null;
        if (type === 'text') {
          const text = msg?.text?.body || '';
          if (!text) return;
          results.push({
            messageId: msg.id,
            kind: 'text',
            from: String(msg.from || ''),
            profileName: profileByWaId.get(String(msg.from || '').replace(/\D/g, '')) || null,
            replyToProviderId,
            text,
            timestamp: msg.timestamp || null,
            phoneNumberId
          });
          return;
        }

        if (type === 'button') {
          const payload = String(msg?.button?.payload || '').trim();
          const buttonText = String(msg?.button?.text || '').trim();
          const text = buttonText || payload;
          if (!text && !payload) return;
          results.push({
            messageId: msg.id,
            kind: 'button',
            from: String(msg.from || ''),
            profileName: profileByWaId.get(String(msg.from || '').replace(/\D/g, '')) || null,
            replyToProviderId,
            text,
            payload: payload || null,
            buttonText: buttonText || null,
            timestamp: msg.timestamp || null,
            phoneNumberId
          });
          return;
        }

        if (type === 'interactive') {
          const interactiveType = String(msg?.interactive?.type || '').toLowerCase();
          const buttonReply = msg?.interactive?.button_reply || null;
          const listReply = msg?.interactive?.list_reply || null;
          const payload = String(
            buttonReply?.id ||
            listReply?.id ||
            ''
          ).trim();
          const buttonText = String(
            buttonReply?.title ||
            listReply?.title ||
            ''
          ).trim();
          const text = buttonText || payload;
          if (!text && !payload) return;
          results.push({
            messageId: msg.id,
            kind: interactiveType === 'list_reply' ? 'list_reply' : 'button',
            from: String(msg.from || ''),
            profileName: profileByWaId.get(String(msg.from || '').replace(/\D/g, '')) || null,
            replyToProviderId,
            text,
            payload: payload || null,
            buttonText: buttonText || null,
            timestamp: msg.timestamp || null,
            phoneNumberId
          });
          return;
        }

        if (type === 'order') {
          // Carrinho nativo do WhatsApp. Antes caia no return abaixo e o pedido
          // sumia sem aviso. O nome dos itens so e resolvido mais adiante, quando
          // o tenant ja e conhecido; aqui fica apenas a leitura estruturada.
          const order = extractWhatsAppOrder(msg?.order);
          if (!order) return;
          results.push({
            messageId: msg.id,
            kind: 'order',
            from: String(msg.from || ''),
            profileName: profileByWaId.get(String(msg.from || '').replace(/\D/g, '')) || null,
            replyToProviderId,
            text: null,
            order,
            timestamp: msg.timestamp || null,
            phoneNumberId
          });
          return;
        }

        if (!supportedMediaTypes.has(type)) return;
        const mediaPayload = msg?.[type] || {};
        const caption = String(mediaPayload?.caption || '').trim();
        results.push({
          messageId: msg.id,
          kind: 'media',
          messageType: type,
          from: String(msg.from || ''),
          profileName: profileByWaId.get(String(msg.from || '').replace(/\D/g, '')) || null,
          replyToProviderId,
          text: caption || null,
          caption,
          timestamp: msg.timestamp || null,
          phoneNumberId,
          mediaId: String(mediaPayload?.id || '').trim(),
          mimeType: String(mediaPayload?.mime_type || '').trim().toLowerCase() || null,
          fileName: String(mediaPayload?.filename || '').trim() || null,
          sha256: String(mediaPayload?.sha256 || '').trim() || null
        });
      });
    });
  });
  return results;
};

const parseWebhookStatuses = (payload) => {
  const results = [];
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  entries.forEach((entry) => {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    changes.forEach((change) => {
      const value = change?.value || {};
      const phoneNumberId = value?.metadata?.phone_number_id || null;
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      statuses.forEach((st) => {
        results.push({
          id: st.id,
          status: st.status,
          recipientId: st.recipient_id,
          timestamp: st.timestamp || null,
          phoneNumberId,
          errors: Array.isArray(st.errors) ? st.errors : null
        });
      });
    });
  });
  return results;
};

const resolveConfig = async ({ tenantId, phoneNumberId }) => {
  if (tenantId) {
    const config = await getWhatsAppConfig(tenantId);
    const sender = resolveWhatsAppSender(config, phoneNumberId || null);
    return config ? { ...config, sender } : null;
  }
  if (!phoneNumberId) return null;
  const match = await findWhatsAppConfigByPhoneNumberId(phoneNumberId);
  return match ? { ...match.whatsapp, tenantId: match.tenantId, sender: match.sender } : null;
};

const getFilenameFromDisposition = (value) => {
  const source = String(value || '').trim();
  if (!source) return null;
  const utf8Match = source.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const simpleMatch = source.match(/filename="?([^";]+)"?/i);
  return simpleMatch?.[1] || null;
};

const downloadInboundMedia = async ({ tenantId, accessToken, mediaMessage }) => {
  if (!tenantId || !accessToken || !mediaMessage?.mediaId) {
    throw new Error('Parametros invalidos para download de midia inbound');
  }

  const metadata = await getWhatsAppMediaMetadata({
    accessToken,
    mediaId: mediaMessage.mediaId
  });
  const mediaUrl = String(metadata?.url || '').trim();
  if (!mediaUrl) {
    throw new Error('URL da midia WhatsApp nao encontrada');
  }

  const download = await downloadWhatsAppMedia({
    accessToken,
    mediaUrl
  });
  const originalName = mediaMessage.fileName
    || getFilenameFromDisposition(download.contentDisposition)
    || `${mediaMessage.messageType || 'media'}_${mediaMessage.mediaId}`;

  const stored = await storeTenantMediaBuffer({
    tenantId,
    buffer: download.buffer,
    mimeType: download.mimeType || mediaMessage.mimeType || metadata?.mime_type || '',
    originalName,
    prefix: `wa_${mediaMessage.messageType || 'media'}`
  });

  return {
    ...stored,
    mimeType: stored.mimeType || mediaMessage.mimeType || metadata?.mime_type || null
  };
};

const getOrCreateChat = async ({ from, tenantId, phoneNumberId = null }) => {
  const normalizedFrom = normalizeWhatsappWaId(from);
  const candidates = await adapter.findDocuments('activeChats', {
    tenantId,
    channel: 'whatsapp',
    channelUserId: normalizedFrom,
    status: { $ne: 'closed' }
  });

  const sorted = (Array.isArray(candidates) ? candidates : []).sort((a, b) => {
    const rank = (chat) => {
      if (chat.status === 'open') return 3;
      if (chat.status === 'waiting') return 2;
      if (chat.activeOutreach) return 1;
      return 0;
    };
    const score = rank(b) - rank(a);
    if (score !== 0) return score;
    return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
  });

  let chat = sorted[0] || null;

  if (!chat) {
    await ensureTenantLimit(tenantId, 'chats');
    chat = {
      id: generateId('chat'),
      customerCpf: `wa_${normalizedFrom}`,
      status: 'bot',
      messages: [],
      lastMessage: null,
      lastMessageAt: null,
      messageCount: 0,
      unreadByAgentCount: 0,
      vars: {},
      tenantId,
      channel: 'whatsapp',
      channelUserId: normalizedFrom,
      channelChatId: normalizedFrom,
      whatsappPhoneNumberId: phoneNumberId || null,
      currentNodeId: null,
      processedMessageIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const sanitized = sanitizeChatState(chat);
    chat = sanitized.chat;
    await adapter.saveDocument('activeChats', chat);
    await emitChatEvent({
      tenantId,
      chatId: chat.id,
      type: CHAT_EVENT_TYPES.CHAT_OPENED,
      actor: { kind: 'customer', id: normalizedFrom },
      context: { channel: 'whatsapp', channelUserId: normalizedFrom, phoneNumberId: phoneNumberId || null }
    });
  } else if (phoneNumberId && chat.whatsappPhoneNumberId !== phoneNumberId) {
    chat.whatsappPhoneNumberId = phoneNumberId;
    chat.updatedAt = new Date().toISOString();
    const sanitized = sanitizeChatState(chat);
    chat = sanitized.chat;
    await adapter.saveDocument('activeChats', chat);
  } else {
    const sanitized = sanitizeChatState(chat);
    if (sanitized.changed) {
      chat = sanitized.chat;
      await adapter.saveDocument('activeChats', chat);
    }
  }

  return chat;
};

const unlockActiveOutreachReply = async (chatId) => {
  const chat = await adapter.getDocument('activeChats', { id: chatId });
  if (!chat) return;
  if (chat.outreachPendingReply !== true) return;

  chat.outreachPendingReply = false;
  chat.outreachUnlockedAt = new Date().toISOString();
  chat.updatedAt = new Date().toISOString();
  await adapter.saveDocument('activeChats', chat);
};

const markMessageProcessed = async (chatId, messageId) => {
  if (!messageId) return false;
  const chat = await adapter.getDocument('activeChats', { id: chatId });
  if (!chat) return false;
  const processed = Array.isArray(chat.processedMessageIds) ? chat.processedMessageIds : [];
  if (processed.includes(messageId)) return false;
  processed.push(messageId);
  chat.processedMessageIds = processed.slice(-50);
  chat.updatedAt = new Date().toISOString();
  await adapter.saveDocument('activeChats', chat);
  return true;
};

export const handleWhatsAppWebhook = async ({ payload, tenantId = null }) => {
  // Eventos de conta (qualidade, templates, nome, restricoes) chegam neste mesmo
  // webhook e viram alertas. Falha aqui nunca pode atrapalhar mensagem de cliente.
  await handleWhatsAppAccountWebhook(payload).catch((error) => {
    console.warn('[WHATSAPP_ACCOUNT_ALERT] Falha ao processar evento de conta', error?.message || error);
  });

  // Chamadas de voz chegam no campo "calls" deste mesmo webhook. Conta pausada
  // por cobranca nao toca para ninguem.
  if (!(tenantId && await isTenantBillingPaused(tenantId))) {
    await handleVoiceCallWebhook({ payload, tenantId }).catch((error) => {
      console.warn('[VOICE] Falha ao processar evento de chamada', error?.message || error);
    });
  }

  const messages = parseWebhookMessages(payload).filter((msg) => {
    if (!isIgnoredWhatsAppSender(msg.from)) return true;
    console.log('[WHATSAPP] Aviso da conta oficial da Meta ignorado', {
      messageId: msg.messageId || null,
      phoneNumberId: msg.phoneNumberId || null
    });
    return false;
  });
  const statuses = parseWebhookStatuses(payload);

  if (statuses.length) {
    for (const st of statuses) {
      const config = await resolveConfig({ tenantId, phoneNumberId: st.phoneNumberId });
      const resolvedTenantId = config?.tenantId || tenantId || null;
      await updateOutreachStatusByProviderMessageId({
        providerMessageId: st.id,
        tenantId: resolvedTenantId,
        status: st.status,
        timestamp: st.timestamp,
        errors: st.errors || null
      });
      await updateChatMessageDeliveryStatusByProviderMessageId({
        providerMessageId: st.id,
        status: st.status,
        timestamp: st.timestamp,
        errors: st.errors || null
      });
      const info = {
        messageId: st.id,
        status: st.status,
        recipientId: st.recipientId,
        phoneNumberId: st.phoneNumberId,
        timestamp: st.timestamp,
        errors: st.errors || null,
        tenantId: resolvedTenantId
      };
      console.log('[WHATSAPP] Status update', info);
      await createLog('WHATSAPP_STATUS', info, 'system');
      if (String(st.status || '').toLowerCase() === 'failed') {
        const firstError = Array.isArray(st.errors) ? st.errors[0] : null;
        await notifyWhatsAppProblem({
          operation: 'status_failed',
          tenantId: resolvedTenantId,
          data: { error: firstError || { message: 'Mensagem WhatsApp falhou' } },
          context: {
            recipientId: st.recipientId,
            phoneNumberId: st.phoneNumberId,
            providerMessageId: st.id
          }
        });
      }
    }
  }

  if (!messages.length) return { ok: true, processed: 0 };

  let processed = 0;
  for (const msg of messages) {
    await withChannelUserLock({
      channel: 'whatsapp',
      tenantId: tenantId || msg.phoneNumberId || 'unknown',
      userId: normalizeWhatsappWaId(msg.from)
    }, async () => {
      const config = await resolveConfig({ tenantId, phoneNumberId: msg.phoneNumberId });
      if (!config || !config.enabled || !config.accessToken || !config.phoneNumberId) {
        return;
      }

      const senderPhoneNumberId = config.sender?.phoneNumberId || config.phoneNumberId;
      const resolvedTenantId = config.tenantId || tenantId;
      const chat = await getOrCreateChat({
        from: msg.from,
        tenantId: resolvedTenantId,
        phoneNumberId: senderPhoneNumberId
      });

      // Upsert silencioso do contato com nome de perfil capturado do canal.
      // Best-effort: falha não bloqueia o atendimento.
      upsertContactFromChannel({
        tenantId: resolvedTenantId,
        channel: 'whatsapp',
        rawIdentifier: msg.from,
        channelDisplayName: msg.profileName || null,
        channelMeta: {
          waId: normalizeWhatsappWaId(msg.from),
          phoneNumberId: senderPhoneNumberId || null
        }
      }).catch(() => {});

      await withChatLock(chat.id, async () => {
        const accepted = await markMessageProcessed(chat.id, msg.messageId);
        if (!accepted) return;

        const inboundReplyTo = await resolveInboundReplyTo(chat, msg.replyToProviderId);

        let storedInboundMessage = null;
        if (msg.kind === 'media') {
          try {
            const storedMedia = await downloadInboundMedia({
              tenantId: chat.tenantId,
              accessToken: config.accessToken,
              mediaMessage: msg
            });
            storedInboundMessage = await addUserMedia(chat.id, {
              mediaType: msg.messageType,
              mediaUrl: storedMedia.url,
              caption: msg.caption || '',
              fileName: storedMedia.originalName || msg.fileName || null,
              mimeType: storedMedia.mimeType || msg.mimeType || null,
              providerMediaId: msg.mediaId,
              sha256: msg.sha256 || null,
              providerMessageId: msg.messageId || null,
              replyTo: inboundReplyTo
            });
          } catch (error) {
            console.error('[WHATSAPP] Falha ao processar midia inbound', {
              messageId: msg.messageId,
              mediaId: msg.mediaId,
              error: error?.message || error
            });
            storedInboundMessage = await addUserMessage(chat.id, msg.caption || `[${msg.messageType || 'media'} recebido(a)]`, { providerMessageId: msg.messageId || null, replyTo: inboundReplyTo });
          }
        } else if (msg.kind === 'order') {
          const catalogItems = await adapter.getCollection('catalogItems', chat.tenantId);
          const cart = buildOrderCart(msg.order, catalogItems);
          // O resumo vira o texto da mensagem para aparecer no chat e na lista de
          // atendimentos como qualquer outra; os itens exatos seguem em meta.
          msg.text = cart.texto;
          storedInboundMessage = await addUserMessage(chat.id, cart.texto, {
            providerMessageId: msg.messageId || null,
            replyTo: inboundReplyTo,
            meta: cart.meta
          });
          // A mensagem ja esta salva, que e o que nao pode se perder. Variaveis e
          // log sao secundarios: falha neles nao pode derrubar o webhook.
          try {
            await mergeChatVars(chat.id, cart.vars);
            await createLog('WHATSAPP_ORDER_RECEIVED', {
              tenantId: chat.tenantId,
              chatId: chat.id,
              catalogId: msg.order.catalogId,
              itens: msg.order.itens.length,
              total: cart.total,
              moeda: cart.moeda,
              semPreco: cart.semPreco.length
            }, 'system');
          } catch (error) {
            console.warn('[WHATSAPP] Pedido gravado, mas falhou ao registrar carrinho ou log', {
              chatId: chat.id,
              messageId: msg.messageId,
              error: error?.message || error
            });
          }
        } else {
          storedInboundMessage = await addUserMessage(chat.id, msg.text || msg.buttonText || msg.payload || '[interacao]', { providerMessageId: msg.messageId || null, replyTo: inboundReplyTo });
        }
        if (storedInboundMessage) {
          const protectedChat = await getChatById(chat.id);
          const protectedInbound = await notifyProtectedAttendanceInbound({
            chat: protectedChat,
            message: storedInboundMessage,
            direction: 'inbound'
          });
          if (protectedInbound.handled) {
            processed += 1;
            return;
          }
        }
        await unlockActiveOutreachReply(chat.id);
        if (storedInboundMessage) {
          await attributeInboundReply({
            tenantId: chat.tenantId,
            chat,
            message: storedInboundMessage,
            replyToProviderMessageId: msg.replyToProviderId
          }).catch((error) => {
            console.warn('[OUTREACH_REPLY] Falha de atribuicao', {
              tenantId: chat.tenantId,
              chatId: chat.id,
              messageId: storedInboundMessage.id,
              error: error?.message || error
            });
          });
        }

        // Pausada por cobranca: a mensagem ja esta gravada; o bot nao responde.
        if (await isTenantBillingPaused(chat.tenantId)) {
          await markChatBillingPaused(chat.id);
          processed += 1;
          return;
        }

        const flowId = normalizeEnvValue(resolveWhatsAppFlowId(config, senderPhoneNumberId)) || null;
        const flowData = await ensureFlow(chat.tenantId, flowId);
        if (!flowData || !flowData.nodes) {
          processed += 1;
          return;
        }

        const templates = await ensureTemplates(chat.tenantId);
        const schedules = await ensureSchedules(chat.tenantId);

        const sendMessage = async (text) => {
          const to = normalizeWhatsappWaId(msg.from);
          const liveChat = await getChatById(chat.id);
          return await sendWhatsAppText({
            accessToken: config.accessToken,
            phoneNumberId: liveChat?.whatsappPhoneNumberId || senderPhoneNumberId,
            to,
            text
          });
        };
        const sendMedia = async ({ mediaType, mediaUrl, caption, fileName }) => {
          const to = normalizeWhatsappWaId(msg.from);
          const liveChat = await getChatById(chat.id);
          return await sendWhatsAppMedia({
            accessToken: config.accessToken,
            phoneNumberId: liveChat?.whatsappPhoneNumberId || senderPhoneNumberId,
            to,
            mediaType,
            mediaUrl,
            caption,
            filename: fileName
          });
        };
        sendMessage.__sendMedia = sendMedia;

        let currentChat = await getChatById(chat.id);
        if (currentChat?.status === 'open' || currentChat?.status === 'waiting' || currentChat?.activeOutreach === true) {
          processed += 1;
          return;
        }

        const inboundText = msg.text || msg.buttonText || msg.payload || '';
        const handledCommand = await tryHandleGlobalCommand({
          chat: currentChat,
          flowData,
          text: msg.kind === 'text' ? inboundText : null,
          templates,
          schedules,
          sendMessage,
          sendMedia
        });
        if (handledCommand) {
          processed += 1;
          return;
        }

        const flowJustStarted = !currentChat.currentNodeId;
        if (flowJustStarted) {
          await startChatFlow({
            chatId: currentChat.id,
            flowData,
            templates,
            schedules,
            sendMessage,
            sendMedia
          });
          currentChat = await getChatById(currentChat.id);
          if (!currentChat?.currentNodeId) {
            processed += 1;
            return;
          }
          if (msg.kind === 'text') {
            processed += 1;
            return;
          }
        }

        // Pedido do catalogo nao e resposta ao no em que o fluxo esta parado: um
        // menu responderia "opcao invalida" para uma compra. O pedido ja esta no
        // chat e nas variaveis CARRINHO_*, e o fluxo le dali quando precisar.
        if (msg.kind === 'order') {
          processed += 1;
          return;
        }

        if (inboundText) {
          await applyUserInput({
            chat: currentChat,
            flowData,
            text: inboundText,
            buttonId: msg.payload || null,
            buttonText: msg.buttonText || null,
            responsePayload: msg.payload || null,
            templates,
            schedules,
            sendMessage,
            sendMedia
          });
        }
        processed += 1;
      });
    });
  }

  return { ok: true, processed };
};
