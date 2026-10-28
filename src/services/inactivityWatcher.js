import adapter from '../../db/DatabaseAdapter.js';
import { sendTelegramMedia, sendTelegramMessage } from './telegramApi.js';
import { sendWhatsAppMedia, sendWhatsAppText } from './whatsappApi.js';
import { getTelegramConfig, getWhatsAppConfig } from './channelConfig.js';
import { createLog } from './logs.js';
import { runFlow } from './flowRunner.js';
import { generateId } from '../utils/helpers.js';
import { appendChatMessage } from './chatMessages.js';
import { isTurizmoProtectedAttendance } from './protectedAttendance.js';
import { normalizeWhatsappWaId } from './activeOutreach.js';
import { toRuntimeFlow } from './flowRuntimeCache.js';

const DEFAULT_GLOBAL_INACTIVITY_HOURS = Number(process.env.GLOBAL_INACTIVITY_HOURS || 8);
const DEFAULT_GLOBAL_MESSAGE = process.env.GLOBAL_INACTIVITY_MESSAGE || 'Atendimento encerrado por inatividade.';
const INACTIVITY_CHECK_INTERVAL_MS = Number(process.env.INACTIVITY_CHECK_INTERVAL_MS || 60000);

const ensureTemplates = async (tenantId) => {
  const scoped = await adapter.getCollection('templates', tenantId);
  if (scoped && scoped.length) return scoped;
  const scopedAlt = await adapter.getCollection('messageTemplates', tenantId);
  if (scopedAlt && scopedAlt.length) return scopedAlt;
  const all = await adapter.getCollection('templates');
  if (all && all.length) return all;
  return adapter.getCollection('messageTemplates');
};

const ensureSchedules = async (tenantId) => {
  const scoped = await adapter.getCollection('schedules', tenantId);
  if (scoped && scoped.length) return scoped;
  return adapter.getCollection('schedules');
};

const resolveFlowForChat = async (tenantId, flowId) => {
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
};

const buildSenders = async (chat) => {
  if (!chat) return { sendMessage: null, sendMedia: null };
  const tenantId = chat.tenantId || null;

  if (chat.channel === 'telegram' && chat.channelChatId) {
    const config = tenantId ? await getTelegramConfig(tenantId) : null;
    const botToken = config?.botToken || process.env.TELEGRAM_BOT_TOKEN || null;
    if (!botToken) return { sendMessage: null, sendMedia: null };

    const sendMessage = async (msgText, buttons) => {
      await sendTelegramMessage(chat.channelChatId, msgText, buttons || null, botToken);
    };
    const sendMedia = async ({ mediaType, mediaUrl, caption }) => {
      await sendTelegramMedia({
        chatId: chat.channelChatId,
        mediaType,
        mediaUrl,
        caption,
        token: botToken
      });
    };
    sendMessage.__sendMedia = sendMedia;
    return { sendMessage, sendMedia };
  }

  if (chat.channel === 'whatsapp' && chat.channelUserId) {
    const config = tenantId ? await getWhatsAppConfig(tenantId) : null;
    const accessToken = config?.accessToken || null;
    const phoneNumberId = config?.phoneNumberId || null;
    if (!accessToken || !phoneNumberId) return { sendMessage: null, sendMedia: null };

    const sendMessage = async (msgText) => {
      const to = normalizeWhatsappWaId(chat.channelUserId);
      await sendWhatsAppText({
        accessToken,
        phoneNumberId,
        to,
        text: msgText
      });
    };
    const sendMedia = async ({ mediaType, mediaUrl, caption, fileName }) => {
      const to = normalizeWhatsappWaId(chat.channelUserId);
      await sendWhatsAppMedia({
        accessToken,
        phoneNumberId,
        to,
        mediaType,
        mediaUrl,
        caption,
        filename: fileName
      });
    };
    sendMessage.__sendMedia = sendMedia;
    return { sendMessage, sendMedia };
  }

  return { sendMessage: null, sendMedia: null };
};

const addChatMessage = async (chat, message) => {
  const appended = await appendChatMessage(chat, message, { incrementUnread: false });
  Object.assign(chat, appended.chat || {});
};

const createMessage = (sender, text, buttons = null) => ({
  id: generateId('msg'),
  sender,
  text,
  buttons: buttons || null,
  timestamp: new Date().toISOString()
});

const resolveTimeoutTarget = (flowData, node, mode = 'default') => {
  if (!flowData || !node) return null;
  const edgesFromNode = flowData.edges.filter((e) => e.source === node.id);
  if (!edgesFromNode.length) return null;

  let targetEdge = null;
  if (node.type === 'menuNode' && mode === 'menu') {
    targetEdge = edgesFromNode.find((e) => String(e.sourceHandle) === 'else') || edgesFromNode[0];
  } else {
    targetEdge = edgesFromNode[0];
  }

  if (!targetEdge) return null;
  let targetNodeId = targetEdge.target;
  const targetNode = flowData.nodes.find((n) => n.id === targetNodeId);
  if (targetNode?.type === 'caseNode') {
    const edgeFromCase = flowData.edges.find((e) => e.source === targetNodeId);
    targetNodeId = edgeFromCase?.target || null;
  }
  return targetNodeId || null;
};

const clearAwaitingState = (chat) => {
  chat.currentNodeId = null;
  chat.awaitingNodeId = null;
  chat.awaitingNodeType = null;
  chat.awaitingNodeSince = null;
  chat.awaitingNodeTimeoutMs = null;
  chat.awaitingNodeMessage = null;
};

const handleNodeTimeout = async (chat, flowData) => {
  if (!chat?.currentNodeId) return false;
  const node = flowData.nodes.find((n) => n.id === chat.currentNodeId);
  if (!node) return false;

  const timeoutMessage = String(chat.awaitingNodeMessage || '').trim();
  const now = new Date().toISOString();

  if (node.type === 'inputNode' && node.data?.variableName) {
    chat.vars = { ...(chat.vars || {}), [node.data.variableName]: null };
  }

  if (node.type === 'ratingNode') {
    const varName = node.data?.variableName || 'nota';
    chat.vars = { ...(chat.vars || {}), [varName]: null };
  }

  if (node.type === 'menuNode' && node.data?.setVarEnabled && node.data?.variableName) {
    chat.vars = { ...(chat.vars || {}), [node.data.variableName]: null };
  }

  clearAwaitingState(chat);
  chat.updatedAt = now;

  if (timeoutMessage) {
    await addChatMessage(chat, createMessage('bot', timeoutMessage, null));
  }

  const nextNodeId = resolveTimeoutTarget(flowData, node, node.type === 'menuNode' ? 'menu' : 'default');
  if (!nextNodeId) return false;

  const { sendMessage, sendMedia } = await buildSenders(chat);
  if (timeoutMessage && sendMessage) {
    await sendMessage(timeoutMessage, null);
  }

  const templates = await ensureTemplates(chat.tenantId);
  const schedules = await ensureSchedules(chat.tenantId);
  await runFlow({
    nodeId: nextNodeId,
    flowData,
    currentVars: chat.vars || {},
    chatId: chat.id,
    templates,
    schedules,
    sendMessage,
    sendMedia
  });
  return true;
};

const handleGlobalTimeout = async (chat, globalMessage) => {
  const message = String(globalMessage || '').trim();
  const now = new Date().toISOString();
  chat.status = 'closed';
  chat.closedAt = now;
  chat.closeReason = 'inactivity';
  clearAwaitingState(chat);
  chat.updatedAt = now;

  if (message) {
    await addChatMessage(chat, createMessage('bot', message, null));
    const { sendMessage } = await buildSenders(chat);
    if (sendMessage) {
      await sendMessage(message, null);
    }
  }

  await createLog('CHAT_CLOSE', {
    chatId: chat.id,
    tenantId: chat.tenantId,
    reason: 'inactivity'
  });
};

export const startInactivityWatcher = () => {
  if (INACTIVITY_CHECK_INTERVAL_MS <= 0) return;

  setInterval(async () => {
    try {
      const chats = await adapter.getCollection('activeChats');
      if (!Array.isArray(chats) || chats.length === 0) return;
      const tenantSettings = await adapter.getCollection('tenantSettings');
      const settingsByTenant = new Map(
        (Array.isArray(tenantSettings) ? tenantSettings : []).map((s) => [String(s.tenantId), s])
      );

      const now = Date.now();

      let changed = false;

      for (const chat of chats) {
        if (!chat || chat.status === 'closed' || chat.isFlowTest === true) continue;
        if (isTurizmoProtectedAttendance(chat)) continue;

        const tenantKey = String(chat.tenantId || '');
        const settings = settingsByTenant.get(tenantKey) || null;
        const hoursValue = settings?.inactivityMaxHours ?? DEFAULT_GLOBAL_INACTIVITY_HOURS;
        const messageValue = settings?.inactivityMessage ?? DEFAULT_GLOBAL_MESSAGE;
        const globalMs = Number.isFinite(Number(hoursValue)) ? Number(hoursValue) * 60 * 60 * 1000 : 0;

        if (globalMs > 0) {
          const last = new Date(chat.updatedAt || chat.createdAt || 0).getTime();
          if (last && now - last >= globalMs) {
            await handleGlobalTimeout(chat, messageValue);
            changed = true;
            continue;
          }
        }

        const timeoutMs = Number(chat.awaitingNodeTimeoutMs || 0);
        if (timeoutMs > 0 && chat.awaitingNodeSince && chat.currentNodeId) {
          const since = new Date(chat.awaitingNodeSince).getTime();
          if (since && now - since >= timeoutMs) {
            const flowData = await resolveFlowForChat(chat.tenantId, chat.flowId || null);
            if (flowData?.nodes) {
              const handled = await handleNodeTimeout(chat, flowData);
              if (handled) changed = true;
            }
          }
        }
      }

      if (changed) {
        await adapter.saveCollection('activeChats', chats);
      }
    } catch (err) {
      console.warn('[INACTIVITY] falha no watcher:', err?.message || err);
    }
  }, INACTIVITY_CHECK_INTERVAL_MS);
};
