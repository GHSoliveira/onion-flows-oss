import adapter from '../../db/DatabaseAdapter.js';
import { getTelegramConfig, getWhatsAppConfig, resolveWhatsAppFlowId, resolveWhatsAppSender } from './channelConfig.js';
import { addBotMessage, applyFlowRuntimeReset, runFlow } from './flowRunner.js';
import { sendTelegramMedia, sendTelegramMessage } from './telegramApi.js';
import { sendWhatsAppMedia, sendWhatsAppText } from './whatsappApi.js';
import { normalizeWhatsappWaId } from './activeOutreach.js';
import { withChatLock } from './chatLocks.js';
import { getTenantSettings } from './tenantSettings.js';
import { getCachedRuntimeFlow, toRuntimeFlow, getCachedRuntimeSchedules, getCachedRuntimeTemplates } from './flowRuntimeCache.js';
import { CHAT_EVENT_TYPES, emitChatEvent } from './chatEvents.js';
import { isTurizmoProtectedAttendance } from './protectedAttendance.js';
import { setDelayResumeHandler } from './delayResumeScheduler.js';

const normalizeWatchIntervalMs = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 30 * 1000;
  return Math.min(Math.max(Math.round(numeric), 1000), 60 * 1000);
};

const WATCH_INTERVAL_MS = normalizeWatchIntervalMs(process.env.CHAT_RUNTIME_WATCHER_INTERVAL_MS);
const TIMEOUT_NODE_TYPES = new Set(['inputNode', 'menuNode', 'ratingNode', 'whatsappTemplateNode', 'sequentialNode', 'holderNode']);
let watcherStarted = false;
let watcherTimer = null;
let watcherRunning = false;

// Delay, timeout de node e inatividade so agem em chat com o bot rodando, entao
// o filtro e `status: 'bot'` e nao `$ne: 'closed'`. A diferenca importa no
// Postgres: igualdade vira clausula SQL, `$ne` nao, e a consulta antiga baixava
// a colecao inteira (inclusive todo o historico fechado) a cada tick.
const getOperationalChats = async () => {
  const chats = await adapter.findDocuments('activeChats', {
    status: 'bot',
    isFlowTest: { $ne: true }
  });
  return Array.isArray(chats) ? chats : [];
};

const getLastMessageTimestamp = (chat) => {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  if (!messages.length) return null;
  const last = messages[messages.length - 1];
  const timestamp = new Date(last?.timestamp || last?.createdAt || 0);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
};

const getChatActivityDate = (chat) => {
  const lastMessageAt = getLastMessageTimestamp(chat);
  if (lastMessageAt) return lastMessageAt;
  const updatedAt = new Date(chat?.updatedAt || chat?.createdAt || 0);
  return Number.isNaN(updatedAt.getTime()) ? new Date() : updatedAt;
};

const resolveFlowForChat = async (chat) => {
  if (!chat?.tenantId) return null;

  let flowId = null;
  if (chat.channel === 'telegram') {
    const config = await getTelegramConfig(chat.tenantId);
    flowId = config?.flowId || null;
  } else if (chat.channel === 'whatsapp') {
    const config = await getWhatsAppConfig(chat.tenantId);
    flowId = resolveWhatsAppFlowId(config, chat.whatsappPhoneNumberId) || null;
  }

  return getCachedRuntimeFlow({
    tenantId: chat.tenantId,
    flowId,
    loader: async () => {
      const flows = await adapter.getCollection('flows', chat.tenantId);
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
};

const loadTemplates = async (tenantId) => getCachedRuntimeTemplates({
  tenantId,
  loader: async () => {
    const scoped = await adapter.getCollection('templates', tenantId);
    if (Array.isArray(scoped) && scoped.length) return scoped;
    const fallback = await adapter.getCollection('messageTemplates', tenantId);
    return Array.isArray(fallback) ? fallback : [];
  }
});

const loadSchedules = async (tenantId) => getCachedRuntimeSchedules({
  tenantId,
  loader: async () => {
    const schedules = await adapter.getCollection('schedules', tenantId);
    return Array.isArray(schedules) ? schedules : [];
  }
});

const resolveWhatsAppPhoneNumberId = (chat, config) => (
  chat?.whatsappPhoneNumberId
  || resolveWhatsAppSender(config)?.phoneNumberId
  || config?.phoneNumberId
  || null
);

const buildChatTransport = async (chat) => {
  if (!chat) return { sendMessage: null, sendMedia: null };

  if (chat.channel === 'telegram' && chat.channelChatId) {
    const config = chat.tenantId ? await getTelegramConfig(chat.tenantId) : null;
    const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
    if (!botToken) return { sendMessage: null, sendMedia: null };
    return {
      sendMessage: async (text, buttons) => {
        await sendTelegramMessage(chat.channelChatId, text, buttons || null, botToken);
        return null;
      },
      sendMedia: async ({ mediaType, mediaUrl, caption }) => (
        sendTelegramMedia({
          chatId: chat.channelChatId,
          mediaType,
          mediaUrl,
          caption,
          token: botToken
        })
      )
    };
  }

  if (chat.channel === 'whatsapp' && chat.channelUserId) {
    const config = chat.tenantId ? await getWhatsAppConfig(chat.tenantId) : null;
    const accessToken = config?.accessToken || null;
    const phoneNumberId = resolveWhatsAppPhoneNumberId(chat, config);
    if (!accessToken || !phoneNumberId) return { sendMessage: null, sendMedia: null };
    const to = normalizeWhatsappWaId(chat.channelUserId);
    return {
      sendMessage: async (text) => (
        sendWhatsAppText({
          accessToken,
          phoneNumberId,
          to,
          text
        })
      ),
      sendMedia: async ({ mediaType, mediaUrl, caption, fileName }) => (
        sendWhatsAppMedia({
          accessToken,
          phoneNumberId,
          to,
          mediaType,
          mediaUrl,
          caption,
          filename: fileName || null
        })
      )
    };
  }

  return { sendMessage: null, sendMedia: null };
};

const buildChatSendMessage = async (chat) => {
  const { sendMessage, sendMedia } = await buildChatTransport(chat);
  if (sendMessage && sendMedia) {
    sendMessage.__sendMedia = sendMedia;
  }
  return sendMessage;
};

const buildChatSendMedia = async (chat) => {
  const { sendMedia } = await buildChatTransport(chat);
  return sendMedia;
};

const resolveNodeTimeoutTarget = (flowData, node) => {
  if (!flowData || !node) return null;

  if (node.type === 'menuNode') {
    const elseEdge = flowData.edges.find(
      (edge) => edge.source === node.id && String(edge.sourceHandle || '') === 'else'
    );
    if (elseEdge) {
      const nextEdge = flowData.edges.find((edge) => edge.source === elseEdge.target);
      return nextEdge?.target || null;
    }
  }

  const directEdge = flowData.edges.find((edge) => edge.source === node.id);
  if (!directEdge) return null;

  const targetNode = flowData.nodes.find((item) => item.id === directEdge.target);
  if (targetNode?.type === 'caseNode') {
    const nextEdge = flowData.edges.find((edge) => edge.source === targetNode.id);
    return nextEdge?.target || null;
  }

  return directEdge.target || null;
};

// Devolve true quando retomou o fluxo (a conversa mudou e precisa ser relida).
const handleDelayedFlow = async (chat) => {
  if (!chat?.tenantId || chat?.status !== 'bot') return false;
  if (!chat?.delayUntil || !chat?.delayNextNodeId) return false;

  return withChatLock(chat.id, async () => {
    const liveChat = await adapter.getDocument('activeChats', { id: chat.id });
    // Revalida dentro do lock: timer pontual e tick podem chegar juntos (o
    // segundo encontra o delay ja consumido), e o agente pode ter puxado o chat
    // entre a leitura e agora.
    if (!liveChat || liveChat.status !== 'bot' || !liveChat.delayUntil || !liveChat.delayNextNodeId) return false;

    const resumeAt = new Date(liveChat.delayUntil);
    if (Number.isNaN(resumeAt.getTime()) || resumeAt.getTime() > Date.now()) return false;

    const flowData = await resolveFlowForChat(liveChat);
    if (!flowData?.nodes) return false;

    const nextNodeId = liveChat.delayNextNodeId;
    if (!nextNodeId) return false;

    liveChat.delayNodeId = null;
    liveChat.delayNextNodeId = null;
    liveChat.delayUntil = null;
    liveChat.currentNodeId = null;
    liveChat.currentNodeEnteredAt = null;
    liveChat.holderContext = null;
    liveChat.updatedAt = new Date().toISOString();
    await adapter.saveDocument('activeChats', liveChat);

    const templates = await loadTemplates(liveChat.tenantId);
    const schedules = await loadSchedules(liveChat.tenantId);
    const sendMessage = await buildChatSendMessage(liveChat);
    const sendMedia = await buildChatSendMedia(liveChat);
    await runFlow({
      nodeId: nextNodeId,
      flowData,
      currentVars: liveChat.vars || {},
      chatId: liveChat.id,
      templates,
      schedules,
      sendMessage,
      sendMedia
    });
    return true;
  });
};

// O timer pontual do delayNode (delayResumeScheduler) usa esta mesma rotina.
// Registrado no import, entao vale mesmo com o watcher desligado.
setDelayResumeHandler(async (chatId) => {
  const chat = await adapter.getDocument('activeChats', { id: chatId });
  await handleDelayedFlow(chat);
});

// No em espera cujo prazo ja venceu (sem tocar no banco: o fluxo vem do cache).
const findDueNodeTimeout = async (chat) => {
  if (!chat?.currentNodeId || !chat?.tenantId) return null;

  const flowData = await resolveFlowForChat(chat);
  if (!flowData?.nodes) return null;

  const node = flowData.nodes.find((item) => item.id === chat.currentNodeId);
  if (!node || !TIMEOUT_NODE_TYPES.has(node.type)) return null;

  // whatsappTemplateNode só aguarda resposta quando waitForReply está habilitado
  if (node.type === 'whatsappTemplateNode' && !node.data?.waitForReply) return null;

  const timeoutMinutes = Number(node.data?.timeoutMinutes || 0);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return null;

  const enteredAt = new Date(chat.currentNodeEnteredAt || chat.updatedAt || chat.createdAt || 0);
  if (Number.isNaN(enteredAt.getTime())) return null;

  if ((Date.now() - enteredAt.getTime()) < timeoutMinutes * 60 * 1000) return null;
  return { flowData, node, timeoutMinutes };
};

// Devolve true quando tratou o prazo vencido (a conversa mudou e precisa ser relida).
const handleNodeTimeout = async (listedChat) => {
  const listedDue = await findDueNodeTimeout(listedChat);
  if (!listedDue) return false;

  return withChatLock(listedChat.id, async () => {
    // A lista do tick pode estar segundos atrasada: o cliente pode ter respondido
    // o no nesse meio tempo. So age se a conversa relida ainda estiver vencida.
    const chat = await adapter.getDocument('activeChats', { id: listedChat.id });
    if (!chat || chat.status === 'closed') return false;
    const due = await findDueNodeTimeout(chat);
    if (!due || due.node.id !== listedDue.node.id) return false;
    const { flowData, node, timeoutMinutes } = due;

    const sendMessage = await buildChatSendMessage(chat);
    const sendMedia = await buildChatSendMedia(chat);
    const timeoutMessage = String(node.data?.timeoutMessage || '').trim();
    if (timeoutMessage) {
      await addBotMessage(chat.id, timeoutMessage, null, sendMessage);
    }

    const nextNodeId = resolveNodeTimeoutTarget(flowData, node);
    const liveChat = await adapter.getDocument('activeChats', { id: chat.id });
    if (!liveChat) return;

    const expiredNodeId = liveChat.currentNodeId;
    liveChat.currentNodeId = null;
    liveChat.currentNodeEnteredAt = null;
    liveChat.updatedAt = new Date().toISOString();
    await adapter.saveDocument('activeChats', liveChat);

    await emitChatEvent({
      tenantId: liveChat.tenantId,
      chatId: liveChat.id,
      type: CHAT_EVENT_TYPES.FLOW_TIMEOUT,
      actor: { kind: 'system' },
      context: {
        nodeId: expiredNodeId,
        nodeType: node.type,
        nodeLabel: node.data?.label || null,
        timeoutMinutes,
        nextNodeId: nextNodeId || null
      }
    });

    if (!nextNodeId) return;

    const templates = await loadTemplates(chat.tenantId);
    const schedules = await loadSchedules(chat.tenantId);
    await runFlow({
      nodeId: nextNodeId,
      flowData,
      currentVars: liveChat.vars || {},
      chatId: chat.id,
      templates,
      schedules,
      sendMessage,
      sendMedia
    });
    return true;
  });
};

const handleGlobalInactivity = async (chat) => {
  if (!chat?.tenantId) return;
  if (isTurizmoProtectedAttendance(chat)) return;

  // Inatividade global só encerra conversas presas no fluxo automático (bot).
  // Atendimento humano (open) e fila (waiting) não são encerrados por este
  // mecanismo — quem decide é o agente/fila. Evita fechar um atendimento ativo
  // só porque ninguém digitou por X tempo.
  if (chat.status !== 'bot') return;
  // Conversa de campanha espera a resposta do lead e quem decide e o Turizmo.
  // Encerrar por inatividade mandava "Atendimento encerrado" para quem so
  // recebeu o template, e o robo da loja respondia ao encerramento.
  if (chat.activeOutreach === true) return;
  // Opt-out e classificacao tiram activeOutreach mas deixam a conversa em bot;
  // outreachLastSentAt fica. Sem fluxo rodando, quem recebeu campanha nao e encerrado.
  if (chat.outreachLastSentAt && !chat.currentNodeId) return;

  const settings = await getTenantSettings(chat.tenantId);
  const inactivityHours = Number(settings?.inactivityMaxHours || 0);
  if (!Number.isFinite(inactivityHours) || inactivityHours <= 0) return;

  const activityDate = getChatActivityDate(chat);
  if ((Date.now() - activityDate.getTime()) < inactivityHours * 60 * 60 * 1000) {
    return;
  }

  await withChatLock(chat.id, async () => {
    const liveChat = await adapter.getDocument('activeChats', { id: chat.id });
    if (!liveChat) return;
    if (isTurizmoProtectedAttendance(liveChat)) return;
    // Revalida dentro do lock: se o agente puxou o chat (open) ou foi pra fila
    // (waiting) entre a leitura e agora, não encerra.
    if (liveChat.status !== 'bot' || liveChat.activeOutreach === true) return;
    if (liveChat.outreachLastSentAt && !liveChat.currentNodeId) return;
    // A lista do tick pode estar atrasada: mensagem nova nesse meio tempo nao encerra.
    if ((Date.now() - getChatActivityDate(liveChat).getTime()) < inactivityHours * 60 * 60 * 1000) return;

    const sendMessage = await buildChatSendMessage(liveChat);
    const closingText = String(settings?.inactivityMessage || '').trim();
    if (closingText) {
      await addBotMessage(liveChat.id, closingText, null, sendMessage);
    }

    applyFlowRuntimeReset(liveChat);
    liveChat.status = 'closed';
    liveChat.closedAt = new Date().toISOString();
    liveChat.closedByInactivity = true;
    liveChat.outreachPendingReply = false;
    liveChat.updatedAt = new Date().toISOString();
    await adapter.saveDocument('activeChats', liveChat);

    await emitChatEvent({
      tenantId: liveChat.tenantId,
      chatId: liveChat.id,
      type: CHAT_EVENT_TYPES.CLOSED_BY_INACTIVITY,
      actor: { kind: 'system' },
      context: {
        inactivityHours,
        lastActivityAt: activityDate.toISOString(),
        queue: liveChat.queue || null,
        agentId: liveChat.agentId || null,
        fromStatus: chat.status
      }
    });
  });
};

const processWatcherTick = async () => {
  if (watcherRunning) return;
  watcherRunning = true;

  try {
    // Antes cada conversa em bot era relida duas vezes por tick, mesmo sem nada
    // vencido: com mil conversas abertas eram milhares de leituras disputando o
    // banco com o atendimento. Agora a lista ja basta para a triagem; so rele
    // quando uma etapa mudou a conversa (e cada etapa revalida dentro do lock).
    const chats = await getOperationalChats();
    for (const chat of chats) {
      let current = chat;
      if (await handleDelayedFlow(current)) {
        current = await adapter.getDocument('activeChats', { id: chat.id });
        if (!current || current.status === 'closed') continue;
      }
      if (await handleNodeTimeout(current)) {
        current = await adapter.getDocument('activeChats', { id: chat.id });
        if (!current || current.status === 'closed') continue;
      }
      await handleGlobalInactivity(current);
    }
  } catch (error) {
    console.error('[CHAT_RUNTIME_WATCHER] Erro no watcher de runtime:', error?.message || error);
  } finally {
    watcherRunning = false;
  }
};

// Um tick avulso, para teste. Em producao quem chama e o setInterval abaixo.
export const runChatRuntimeWatcherTick = () => processWatcherTick();

export const startChatRuntimeWatcher = () => {
  if (watcherStarted) return;
  watcherStarted = true;
  watcherTimer = setInterval(processWatcherTick, WATCH_INTERVAL_MS);
  if (typeof watcherTimer?.unref === 'function') {
    watcherTimer.unref();
  }
  setTimeout(() => {
    processWatcherTick().catch(() => {});
  }, 5000);
  console.log(`[CHAT_RUNTIME_WATCHER] Ativo com intervalo de ${WATCH_INTERVAL_MS}ms`);
};
