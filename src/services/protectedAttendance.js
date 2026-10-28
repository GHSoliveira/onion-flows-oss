import adapter from '../../db/DatabaseAdapter.js';
import { enqueueLeadClassification } from '../queues/classificationQueue.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';
import { buildChatSummary } from './chatSummaries.js';
import { createTurizmoEvent, enqueueTurizmoEvent } from './integrationOutbox.js';
import { getIo } from './logs.js';
import { nowIso } from './outreachDomain.js';

export const DEFAULT_POST_HANDOFF = Object.freeze({
  autoClose: false,
  holdHours: 72,
  inboundDuringHold: 'notify_turizmo',
  closureMode: 'manual'
});

export const normalizePostHandoff = (value = {}) => ({
  autoClose: false,
  holdHours: Math.min(168, Math.max(1, Number.parseInt(value?.holdHours, 10) || DEFAULT_POST_HANDOFF.holdHours)),
  inboundDuringHold: 'notify_turizmo',
  closureMode: 'manual'
});

export const calculateProtectedUntil = (holdHours, from = Date.now()) => (
  new Date(from + normalizePostHandoff({ holdHours }).holdHours * 60 * 60 * 1000).toISOString()
);

export const isTurizmoProtectedAttendance = (chat) => Boolean(
  chat?.protectedAttendance === true
  || (chat?.source === 'turizmo_handoff' && chat?.automationLocked === true)
);

const resolveCampaignContext = async ({ tenantId, chat, state }) => {
  const campaignId = chat?.campaignId || state?.campaignId || null;
  const campaign = campaignId
    ? await adapter.findOne('outreachCampaigns', { tenantId, id: campaignId })
    : null;
  const turizmoLeadId = chat?.turizmoLeadId || state?.turizmoLeadId || null;
  const itemSelectors = [
    ...(turizmoLeadId ? [{ turizmoLeadId }] : []),
    ...(chat?.contactId ? [{ contactId: chat.contactId }] : []),
    ...(chat?.id ? [{ chatId: chat.id }] : [])
  ];
  const campaignItems = campaignId && itemSelectors.length > 0
    ? await adapter.findMany('outreachCampaignItems', {
      query: { tenantId, campaignId, $or: itemSelectors },
      projection: { id: 1, turizmoLeadId: 1 },
      sort: { createdAt: -1 },
      limit: 1
    })
    : [];
  const campaignItem = campaignItems[0] || null;
  return {
    campaignId,
    campaignItemId: campaignItem?.id || null,
    turizmoLeadId: turizmoLeadId || campaignItem?.turizmoLeadId || null,
    turizmoCampaignId: chat?.turizmoCampaignId || state?.turizmoCampaignId || campaign?.turizmoCampaignId || null
  };
};

export const notifyProtectedAttendanceInbound = async ({
  chat,
  message,
  direction = 'inbound',
  queueClassification = true
}) => {
  if (!chat?.tenantId || !chat?.id || !message?.id) {
    return { handled: false };
  }

  const state = await adapter.findOne('turizmoAutomationStates', {
    tenantId: chat.tenantId,
    $or: [
      ...(chat.turizmoLeadId ? [{ turizmoLeadId: chat.turizmoLeadId }] : []),
      { chatId: chat.id }
    ]
  });
  const protectedByTurizmoState = chat.automationLocked === true && Boolean(
    state?.turizmoLeadId || state?.campaignId || chat?.turizmoLeadId || chat?.turizmoCampaignId
  );
  if (!isTurizmoProtectedAttendance(chat) && !protectedByTurizmoState) {
    return { handled: false };
  }
  const policy = normalizePostHandoff(chat.postHandoff || state?.postHandoff || {});
  const campaign = await resolveCampaignContext({ tenantId: chat.tenantId, chat, state });
  const updatedAt = nowIso();
  const statusPatch = {
    automationLocked: true,
    protectedAttendance: true,
    attendanceStatus: 'message_waiting',
    messageWaitingAt: message.timestamp || updatedAt,
    messageWaitingId: message.id,
    postHandoff: policy,
    updatedAt
  };

  await adapter.updateOne('activeChats', { tenantId: chat.tenantId, id: chat.id }, { $set: statusPatch });
  if (state?.id) {
    await adapter.updateOne('turizmoAutomationStates', { tenantId: chat.tenantId, id: state.id }, {
      $set: {
        ...statusPatch,
        chatId: chat.id,
        campaignId: campaign.campaignId,
        turizmoCampaignId: campaign.turizmoCampaignId
      }
    });
  }

  const messageContext = {
    chatId: chat.id,
    contactId: message.contactId || chat.contactId || null,
    campaignId: message.campaignId || campaign.campaignId,
    campaignItemId: message.campaignItemId || campaign.campaignItemId,
    turizmoCampaignId: message.turizmoCampaignId || campaign.turizmoCampaignId,
    turizmoLeadId: message.turizmoLeadId || campaign.turizmoLeadId,
    automationManagedBy: 'turizmo',
    protectedAttendance: true,
    updatedAt
  };
  await adapter.updateOne('chatMessages', {
    tenantId: chat.tenantId,
    messageId: message.id
  }, { $set: messageContext });

  let event = null;
  if (policy.inboundDuringHold === 'notify_turizmo') {
    event = await enqueueTurizmoEvent(createTurizmoEvent({
      tenantId: chat.tenantId,
      type: 'attendance.message_waiting',
      aggregateType: 'attendance',
      aggregateId: chat.id,
      idempotencyKey: `attendance-message-waiting:${chat.tenantId}:${message.id}`,
      data: {
        turizmoLeadId: campaign.turizmoLeadId,
        turizmoCampaignId: campaign.turizmoCampaignId,
        campaignId: campaign.campaignId,
        chatId: chat.id,
        attendanceId: chat.id,
        messageId: message.id,
        currentMessage: String(message.text || message.media?.caption || '').slice(0, 4096),
        direction,
        protectedUntil: chat.protectedUntil || state?.protectedUntil || null,
        receivedAt: message.timestamp || updatedAt
      }
    }));
    if (event) enqueueTurizmoDelivery({ outboxId: event.id }).catch(() => {});
  }

  let classificationQueued = false;
  if (queueClassification) {
    try {
      await enqueueLeadClassification({ tenantId: chat.tenantId, messageId: message.id });
      classificationQueued = true;
    } catch (error) {
      console.warn('[AI_CLASSIFICATION] Falha ao enfileirar inbound protegido', {
        tenantId: chat.tenantId,
        chatId: chat.id,
        messageId: message.id,
        error: error?.message || 'classification_enqueue_failed'
      });
    }
  }

  const io = getIo();
  if (io) {
    io.to(`tenant:${chat.tenantId}`).emit('agent_assigned', {
      chat: buildChatSummary({ ...chat, ...statusPatch })
    });
  }
  return {
    handled: true,
    eventId: event?.id || null,
    status: 'message_waiting',
    classificationQueued
  };
};
