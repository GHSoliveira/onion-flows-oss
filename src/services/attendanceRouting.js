import adapter from '../../db/DatabaseAdapter.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';
import { withChatLock, withLock } from './chatLocks.js';
import { CHAT_EVENT_TYPES, emitChatEvent } from './chatEvents.js';
import { buildChatSummary } from './chatSummaries.js';
import { createLog, getIo } from './logs.js';
import { createTurizmoEvent, enqueueTurizmoEvent } from './integrationOutbox.js';
import { isTurizmoProtectedAttendance } from './protectedAttendance.js';
import {
  COLLECTIONS,
  nowIso,
  stableHash
} from './outreachDomain.js';

export const ATTENDANCE_ROUTING_TRIGGERS = Object.freeze([
  'campaign_reply',
  'organic_whatsapp',
  'manual',
  'integration'
]);

export const ATTENDANCE_ROUTING_ACTIONS = Object.freeze(['enqueue', 'suppress', 'ignore']);
export const ATTENDANCE_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

const HUMAN_ACTIONS = new Set(['notify_sales', 'create_task', 'request_human_review']);
const NEGATIVE_INTENTS = new Set(['negativo', 'numero_invalido', 'fora_de_contexto']);
const COMMERCIAL_INTENTS = new Set(['positivo', 'pediu_demo', 'pediu_preco', 'pediu_proposta', 'interessado_depois']);

const defaultRules = () => [
  {
    id: 'opt_out', order: 10, enabled: true,
    conditions: { optOutDetected: true },
    action: { type: 'suppress', priority: 'normal', stopAutomation: true, closeTask: true }
  },
  {
    id: 'human_review', order: 20, enabled: true,
    conditions: { any: [{ requiresHumanReview: true }, { nextActionIn: ['request_human_review'] }, { confidenceLt: 0.6 }] },
    action: { type: 'enqueue', queueRef: 'review', priority: 'normal', stopAutomation: true, createTask: true }
  },
  {
    id: 'commercial_intent', order: 30, enabled: true,
    conditions: { intentIn: Array.from(COMMERCIAL_INTENTS) },
    action: { type: 'enqueue', queueRef: 'default', priority: 'high', stopAutomation: true, createTask: true }
  },
  {
    id: 'notify_sales', order: 40, enabled: true,
    conditions: { nextActionIn: ['notify_sales'] },
    action: { type: 'enqueue', queueRef: 'default', priority: 'high', stopAutomation: true, createTask: true }
  },
  {
    id: 'create_task', order: 50, enabled: true,
    conditions: { nextActionIn: ['create_task'] },
    action: { type: 'enqueue', queueRef: 'default', priority: 'normal', stopAutomation: true, createTask: true }
  },
  {
    id: 'negative_without_handoff', order: 60, enabled: true,
    conditions: { sentimentIn: ['negative'], nextActionNotIn: Array.from(HUMAN_ACTIONS) },
    action: { type: 'ignore', priority: 'normal', stopAutomation: true }
  },
  {
    id: 'negative_intent', order: 70, enabled: true,
    conditions: { intentIn: Array.from(NEGATIVE_INTENTS), nextActionNotIn: Array.from(HUMAN_ACTIONS) },
    action: { type: 'ignore', priority: 'normal', stopAutomation: true }
  },
  {
    id: 'campaign_reply_fallback', order: 1000, enabled: true,
    conditions: {},
    action: { type: 'enqueue', queueRef: 'default', priority: 'normal', stopAutomation: true, createTask: true }
  }
];

const normalizeList = (value) => Array.isArray(value) ? value.map(String) : [];

const matchesConditionSet = (conditions = {}, context = {}) => {
  if (Array.isArray(conditions.any) && conditions.any.length) {
    if (!conditions.any.some((entry) => matchesConditionSet(entry, context))) return false;
  }
  if (Array.isArray(conditions.all) && conditions.all.length) {
    if (!conditions.all.every((entry) => matchesConditionSet(entry, context))) return false;
  }
  if (conditions.optOutDetected !== undefined && Boolean(context.optOutDetected) !== conditions.optOutDetected) return false;
  if (conditions.requiresHumanReview !== undefined && Boolean(context.requiresHumanReview) !== conditions.requiresHumanReview) return false;
  if (normalizeList(conditions.intentIn).length && !normalizeList(conditions.intentIn).includes(String(context.intent))) return false;
  if (normalizeList(conditions.sentimentIn).length && !normalizeList(conditions.sentimentIn).includes(String(context.sentiment))) return false;
  if (normalizeList(conditions.nextActionIn).length && !normalizeList(conditions.nextActionIn).includes(String(context.nextAction))) return false;
  if (normalizeList(conditions.nextActionNotIn).length && normalizeList(conditions.nextActionNotIn).includes(String(context.nextAction))) return false;
  if (conditions.confidenceLt !== undefined && !(Number(context.confidence) < Number(conditions.confidenceLt))) return false;
  if (conditions.confidenceGte !== undefined && !(Number(context.confidence) >= Number(conditions.confidenceGte))) return false;
  if (normalizeList(conditions.sourceIn).length && !normalizeList(conditions.sourceIn).includes(String(context.source))) return false;
  return true;
};

export const evaluateAttendanceRouting = ({ profile, context }) => {
  const rules = Array.isArray(profile?.rules) ? profile.rules : [];
  const matchedRule = [...rules]
    .filter((rule) => rule?.enabled !== false)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .find((rule) => matchesConditionSet(rule.conditions || {}, context || {}));
  if (!matchedRule) return { action: { type: 'ignore', priority: 'normal' }, matchedRuleId: null };
  return { action: matchedRule.action || { type: 'ignore', priority: 'normal' }, matchedRuleId: matchedRule.id || null };
};

const findPreferredQueue = (queues, patterns) => {
  const active = queues.filter((queue) => queue?.active !== false);
  return active.find((queue) => patterns.some((pattern) => pattern.test(String(queue.name || '')))) || active[0] || null;
};

export const ensureDefaultAttendanceRoutingProfile = async ({ tenantId, trigger = 'campaign_reply' }) => {
  const existing = await adapter.findMany(COLLECTIONS.attendanceRoutingProfiles, {
    query: { tenantId, trigger, active: true }, sort: { updatedAt: -1 }, limit: 1
  });
  if (existing[0]) return existing[0];

  const queues = await adapter.findMany('queues', { query: { tenantId }, limit: 500 });
  const commercialQueue = findPreferredQueue(queues, [/COMERCIAL/i, /VENDAS/i, /ATENDIMENTO/i]);
  const reviewQueue = findPreferredQueue(queues, [/REVISAO/i, /REVISÃO/i]) || commercialQueue;
  const now = nowIso();
  const profile = {
    id: `routing_profile_${stableHash(`${tenantId}:${trigger}`).slice(0, 24)}`,
    tenantId,
    name: 'Roteamento padrao de respostas de campanha',
    trigger,
    active: true,
    version: 1,
    defaultQueueId: commercialQueue?.id || null,
    reviewQueueId: reviewQueue?.id || commercialQueue?.id || null,
    waitingWarningMinutes: 5,
    rules: defaultRules(),
    createdBy: 'system',
    createdAt: now,
    updatedAt: now
  };
  await adapter.updateOne(
    COLLECTIONS.attendanceRoutingProfiles,
    { tenantId, id: profile.id },
    { $set: profile },
    { upsert: true }
  );
  return adapter.findOne(COLLECTIONS.attendanceRoutingProfiles, { tenantId, id: profile.id });
};

export const getAttendanceRoutingProfile = async ({ tenantId, trigger = 'campaign_reply', createDefault = true }) => {
  const rows = await adapter.findMany(COLLECTIONS.attendanceRoutingProfiles, {
    query: { tenantId, trigger, active: true }, sort: { updatedAt: -1 }, limit: 1
  });
  if (rows[0] || !createDefault) return rows[0] || null;
  return ensureDefaultAttendanceRoutingProfile({ tenantId, trigger });
};

const resolveQueue = async ({ tenantId, profile, action }) => {
  const queueId = action.queueId
    || (action.queueRef === 'review' ? profile.reviewQueueId : profile.defaultQueueId)
    || null;
  if (!queueId) return null;
  return adapter.findOne('queues', { tenantId, id: queueId, active: { $ne: false } });
};

const attendanceRoutingError = (status, code, message) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

export const resolveAttendanceQueueForHandoff = async ({ tenantId, queueId = null }) => {
  const explicitQueueId = String(queueId || '').trim();
  if (explicitQueueId) {
    const explicitQueue = await adapter.findOne('queues', {
      tenantId,
      id: explicitQueueId,
      active: { $ne: false }
    });
    if (!explicitQueue) {
      throw attendanceRoutingError(404, 'attendance_queue_not_found', 'Fila de atendimento informada nao encontrada ou inativa.');
    }
    return { queue: explicitQueue, profile: null, source: 'explicit' };
  }

  const integrationProfile = await getAttendanceRoutingProfile({
    tenantId,
    trigger: 'integration',
    createDefault: false
  });
  const profile = integrationProfile?.defaultQueueId
    ? integrationProfile
    : await getAttendanceRoutingProfile({
        tenantId,
        trigger: 'campaign_reply',
        createDefault: true
      });
  const configuredQueueId = profile?.defaultQueueId || null;
  if (configuredQueueId) {
    const configuredQueue = await adapter.findOne('queues', {
      tenantId,
      id: configuredQueueId,
      active: { $ne: false }
    });
    if (configuredQueue) return { queue: configuredQueue, profile, source: 'profile' };
  }

  const queues = await adapter.findMany('queues', {
    query: { tenantId, active: { $ne: false } },
    limit: 500
  });
  const fallbackQueue = findPreferredQueue(queues, [/COMERCIAL/i, /VENDAS/i, /ATENDIMENTO/i]);
  if (!fallbackQueue) {
    throw attendanceRoutingError(409, 'attendance_queue_not_configured', 'Nenhuma fila comercial ativa esta configurada para o tenant.');
  }
  return { queue: fallbackQueue, profile, source: 'default' };
};

const updateCommercialTask = async ({ classification, chat, queue = null, status = 'open', assignedTo = null, assignedToName = null }) => {
  if (!classification?.id) return null;
  const now = nowIso();
  const taskId = `commercial_task_${classification.id}`;
  await adapter.updateOne('commercialTasks', { tenantId: classification.tenantId, id: taskId }, {
    $set: {
      id: taskId,
      tenantId: classification.tenantId,
      contactId: classification.contactId || null,
      turizmoLeadId: classification.turizmoLeadId || null,
      chatId: chat?.id || classification.chatId || null,
      attendanceId: chat?.id || classification.chatId || null,
      campaignId: classification.campaignId || null,
      campaignItemId: classification.campaignItemId || null,
      classificationId: classification.id,
      title: classification.requiresHumanReview ? 'Revisar resposta comercial' : 'Lead requer atendimento comercial',
      description: classification.reason || '',
      priority: chat?.priority || (['pediu_demo', 'pediu_proposta'].includes(classification.intent) ? 'high' : 'normal'),
      queueId: queue?.id || chat?.queueId || null,
      queueName: queue?.name || chat?.queue || null,
      status,
      assignedTo,
      assignedToName,
      dueAt: classification.followUpAt || now,
      updatedAt: now
    },
    $setOnInsert: { createdAt: now }
  }, { upsert: true });
  return adapter.findOne('commercialTasks', { tenantId: classification.tenantId, id: taskId });
};

const queueTurizmoEvent = async ({ tenantId, type, chat, data, idempotencyKey }) => {
  try {
    const event = await enqueueTurizmoEvent(createTurizmoEvent({
      tenantId,
      type,
      aggregateType: 'attendance',
      aggregateId: chat.id,
      idempotencyKey,
      data
    }));
    if (event) enqueueTurizmoDelivery({ outboxId: event.id }).catch(() => {});
    return event;
  } catch (error) {
    console.warn('[ATTENDANCE_ROUTING] Falha nao bloqueante ao registrar evento externo', {
      tenantId, chatId: chat?.id || null, type, error: error?.message || 'outbox_failed'
    });
    return null;
  }
};

const clearDeferredOutreach = async (classification) => {
  if (!classification?.chatId) return;
  await withChatLock(classification.chatId, async () => {
    const chat = await adapter.findOne('activeChats', { tenantId: classification.tenantId, id: classification.chatId });
    if (!chat || chat.status === 'open' || chat.status === 'waiting') return;
    await adapter.updateOne('activeChats', { tenantId: classification.tenantId, id: chat.id }, {
      $set: {
        activeOutreach: false,
        attendanceDeferred: false,
        outreachPendingReply: false,
        updatedAt: nowIso()
      }
    });
  });
};

const routeClassifiedReplyToAttendanceUnlocked = async ({ classification, trigger = 'campaign_reply', force = false }) => {
  const tenantId = classification?.tenantId;
  if (!tenantId || !classification?.messageId || !classification?.chatId) return { skipped: true, reason: 'missing_context' };
  if (!classification.campaignId && !classification.campaignItemId && !classification.outreachId) {
    return { skipped: true, reason: 'not_campaign_reply' };
  }

  const profile = await getAttendanceRoutingProfile({ tenantId, trigger });
  const routingKey = stableHash(`${tenantId}:${classification.messageId}:${profile.id}:${profile.version}`);
  const existing = await adapter.findOne(COLLECTIONS.attendanceRoutingDecisions, { routingKey });
  if (existing && !force && !['routing_pending', 'error'].includes(existing.status)) return existing;

  const evaluated = evaluateAttendanceRouting({
    profile,
    context: { ...classification, source: trigger }
  });
  const action = evaluated.action;
  const decisionId = existing?.id || `routing_decision_${routingKey.slice(0, 24)}`;
  const now = nowIso();

  if (action.type === 'suppress' || action.type === 'ignore') {
    await clearDeferredOutreach(classification);
    if (action.closeTask || action.type === 'suppress') {
      await adapter.updateOne('commercialTasks', { tenantId, classificationId: classification.id }, {
        $set: { status: 'closed', result: action.type, closedAt: now, updatedAt: now }
      });
    }
    const decision = {
      id: decisionId, routingKey, tenantId, trigger, profileId: profile.id, profileVersion: profile.version,
      classificationId: classification.id, messageId: classification.messageId, chatId: classification.chatId,
      matchedRuleId: evaluated.matchedRuleId, action, status: action.type === 'suppress' ? 'suppressed' : 'ignored',
      createdAt: existing?.createdAt || now, updatedAt: now
    };
    await adapter.updateOne(COLLECTIONS.attendanceRoutingDecisions, { routingKey }, { $set: decision }, { upsert: true });
    return decision;
  }

  const queue = await resolveQueue({ tenantId, profile, action });
  if (!queue) {
    const pending = {
      id: decisionId, routingKey, tenantId, trigger, profileId: profile.id, profileVersion: profile.version,
      classificationId: classification.id, messageId: classification.messageId, chatId: classification.chatId,
      matchedRuleId: evaluated.matchedRuleId, action, status: 'routing_pending',
      errorCode: 'queue_not_configured', createdAt: existing?.createdAt || now, updatedAt: now
    };
    await adapter.updateOne(COLLECTIONS.attendanceRoutingDecisions, { routingKey }, { $set: pending }, { upsert: true });
    await createLog('ATTENDANCE_ROUTING_FAILED', { tenantId, chatId: classification.chatId, classificationId: classification.id, reason: 'queue_not_configured' });
    return pending;
  }

  let routedChat = null;
  await withChatLock(classification.chatId, async () => {
    const chat = await adapter.findOne('activeChats', { tenantId, id: classification.chatId });
    if (!chat) throw new Error('Chat da resposta de campanha nao encontrado');
    if (chat.status === 'closed') throw new Error('Chat da resposta de campanha ja esta encerrado');

    const waitingSince = chat.waitingSince || now;
    const preserveAssignedAgent = chat.status === 'open' && Boolean(chat.agentId);
    routedChat = {
      ...chat,
      status: preserveAssignedAgent ? 'open' : 'waiting',
      mode: 'human',
      queue: preserveAssignedAgent ? (chat.queue || queue.name) : queue.name,
      queueId: preserveAssignedAgent ? (chat.queueId || queue.id) : queue.id,
      agentId: preserveAssignedAgent ? chat.agentId : null,
      agentName: preserveAssignedAgent ? chat.agentName : null,
      source: 'campaign_reply',
      priority: action.priority || 'normal',
      campaignId: classification.campaignId || chat.campaignId || null,
      campaignItemId: classification.campaignItemId || chat.campaignItemId || null,
      outreachId: classification.outreachId || chat.outreachId || null,
      contactId: classification.contactId || chat.contactId || null,
      turizmoLeadId: classification.turizmoLeadId || chat.turizmoLeadId || null,
      classificationId: classification.id,
      classification: {
        intent: classification.intent,
        sentiment: classification.sentiment,
        confidence: classification.confidence,
        nextAction: classification.nextAction,
        reason: classification.reason,
        requiresHumanReview: classification.requiresHumanReview
      },
      waitingSince: preserveAssignedAgent ? null : waitingSince,
      queuedAt: chat.queuedAt || waitingSince,
      assignedAt: preserveAssignedAgent ? (chat.assignedAt || now) : null,
      activeOutreach: true,
      attendanceDeferred: false,
      outreachPendingReply: false,
      automationLocked: true,
      currentNodeId: null,
      currentNodeEnteredAt: null,
      flowStarted: false,
      resumePending: false,
      continueFlowAfterQueue: false,
      updatedAt: now
    };
    await adapter.updateOne('activeChats', { tenantId, id: chat.id }, { $set: routedChat });
  });

  await updateCommercialTask({
    classification,
    chat: routedChat,
    queue,
    assignedTo: routedChat.agentId || null,
    assignedToName: routedChat.agentName || null
  });

  const decision = {
    id: decisionId, routingKey, tenantId, trigger, profileId: profile.id, profileVersion: profile.version,
    classificationId: classification.id, messageId: classification.messageId, chatId: routedChat.id,
    attendanceId: routedChat.id, queueId: queue.id, queueName: queue.name,
    matchedRuleId: evaluated.matchedRuleId, action, status: routedChat.agentId ? 'assigned' : 'queued',
    createdAt: existing?.createdAt || now, updatedAt: now
  };
  await adapter.updateOne(COLLECTIONS.attendanceRoutingDecisions, { routingKey }, { $set: decision }, { upsert: true });

  await emitChatEvent({
    tenantId, chatId: routedChat.id, type: CHAT_EVENT_TYPES.QUEUE_ENTERED,
    actor: { kind: 'automation', id: 'attendance-router' },
    context: { queue: queue.name, queueId: queue.id, source: 'campaign_reply', priority: routedChat.priority, classificationId: classification.id }
  });
  const io = getIo();
  if (io) io.to(`tenant:${tenantId}`).emit('agent_assigned', { chat: buildChatSummary(routedChat) });
  await createLog('ATTENDANCE_ROUTED', {
    tenantId, chatId: routedChat.id, queueId: queue.id, priority: routedChat.priority,
    classificationId: classification.id, matchedRuleId: evaluated.matchedRuleId
  });
  await queueTurizmoEvent({
    tenantId,
    type: 'attendance.queued',
    chat: routedChat,
    idempotencyKey: `attendance-queued:${routingKey}`,
    data: {
      attendanceId: routedChat.id, chatId: routedChat.id,
      campaignId: classification.campaignId, campaignItemId: classification.campaignItemId,
      contactId: classification.contactId, turizmoLeadId: classification.turizmoLeadId,
      queueId: queue.id, queueName: queue.name, priority: routedChat.priority,
      intent: classification.intent, sentiment: classification.sentiment, confidence: classification.confidence
    }
  });
  return decision;
};

export const routeClassifiedReplyToAttendance = async (args = {}) => {
  const classification = args.classification || {};
  const lockKey = classification.tenantId && classification.messageId
    ? `attendance-routing:${classification.tenantId}:${classification.messageId}`
    : null;
  return withLock(lockKey, () => routeClassifiedReplyToAttendanceUnlocked(args));
};

const HANDOFF_CHAT_FIELDS = [
  'status', 'mode', 'automationMode', 'queue', 'queueId', 'agentId', 'agentName',
  'source', 'priority', 'campaignId', 'contactId', 'turizmoLeadId', 'waitingSince',
  'queuedAt', 'assignedAt', 'activeOutreach', 'attendanceDeferred',
  'outreachPendingReply', 'automationLocked', 'attendanceStatus', 'currentNodeId',
  'currentNodeEnteredAt', 'flowStarted', 'resumePending', 'continueFlowAfterQueue',
  'journeyStage', 'handoffCommandId', 'handoffDecisionId', 'protectedAttendance',
  'protectedUntil', 'postHandoff', 'turizmoCampaignId', 'messageWaitingAt',
  'messageWaitingId', 'updatedAt'
];

const restoreChatFields = async ({ tenantId, chatId, snapshot }) => {
  const set = {};
  const unset = {};
  for (const field of HANDOFF_CHAT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, field)) set[field] = snapshot[field];
    else unset[field] = '';
  }
  await adapter.updateOne('activeChats', { tenantId, id: chatId }, {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(unset).length ? { $unset: unset } : {})
  });
};

const restoreDocument = async ({ collection, query, snapshot }) => {
  await adapter.deleteMany(collection, query);
  if (snapshot) await adapter.insertOne(collection, snapshot);
};

export const routeAutomationCommandToAttendance = async ({ command, chat }) => {
  const tenantId = command?.tenantId;
  const commandId = command?.commandId;
  if (!tenantId || !commandId || !chat?.id) {
    throw attendanceRoutingError(400, 'handoff_context_required', 'Contexto insuficiente para encaminhar o atendimento.');
  }

  const { queue, profile, source: queueSource } = await resolveAttendanceQueueForHandoff({
    tenantId,
    queueId: command.handoff?.queueId || null
  });
  const priority = ATTENDANCE_PRIORITIES.includes(command.handoff?.priority)
    ? command.handoff.priority
    : 'normal';
  const routingKey = stableHash(`${tenantId}:turizmo-handoff:${command.decisionId || commandId}`);
  const decisionId = `routing_decision_${routingKey.slice(0, 24)}`;
  const lockKey = `attendance-routing:${tenantId}:turizmo-command:${commandId}`;

  return withLock(lockKey, () => withChatLock(chat.id, async () => {
    const currentChat = await adapter.findOne('activeChats', { tenantId, id: chat.id });
    if (!currentChat) throw attendanceRoutingError(404, 'chat_not_found', 'Conversa ativa do lead nao encontrada.');
    if (currentChat.status === 'closed') {
      throw attendanceRoutingError(409, 'chat_closed', 'A conversa informada ja esta encerrada.');
    }

    const recovering = currentChat.handoffCommandId === commandId
      && currentChat.automationLocked === true
      && ['waiting', 'open'].includes(currentChat.status);
    const requeueing = !recovering && (currentChat.automationLocked || currentChat.automationMode === 'human'
      || currentChat.mode === 'human' || ['waiting', 'open'].includes(currentChat.status));

    const activeTasks = await adapter.findMany('commercialTasks', {
      query: {
        tenantId,
        chatId: currentChat.id,
        status: { $in: ['open', 'waiting', 'assigned'] }
      },
      sort: { updatedAt: -1 },
      limit: 1
    });
    const previousTask = activeTasks[0] || null;
    const taskId = previousTask?.id
      || `commercial_task_handoff_${stableHash(`${tenantId}:${currentChat.id}`).slice(0, 24)}`;
    const decisionQuery = { tenantId, routingKey };
    const previousDecision = await adapter.findOne(COLLECTIONS.attendanceRoutingDecisions, decisionQuery);
    const now = nowIso();
    const routedChat = {
      ...currentChat,
      status: 'waiting',
      mode: 'human',
      automationMode: 'human',
      queue: queue.name,
      queueId: queue.id,
      agentId: null,
      agentName: null,
      source: 'turizmo_handoff',
      priority,
      campaignId: command.campaignId || currentChat.campaignId || null,
      turizmoCampaignId: command.turizmoCampaignId || currentChat.turizmoCampaignId || null,
      contactId: currentChat.contactId || null,
      turizmoLeadId: command.turizmoLeadId || currentChat.turizmoLeadId || null,
      waitingSince: requeueing ? now : (currentChat.waitingSince || now),
      queuedAt: requeueing ? now : (currentChat.queuedAt || now),
      assignedAt: null,
      activeOutreach: false,
      attendanceDeferred: false,
      outreachPendingReply: false,
      automationLocked: true,
      protectedAttendance: true,
      protectedUntil: command.protectedUntil || currentChat.protectedUntil || null,
      postHandoff: command.postHandoff || currentChat.postHandoff || null,
      attendanceStatus: 'waiting',
      currentNodeId: null,
      currentNodeEnteredAt: null,
      flowStarted: false,
      resumePending: false,
      continueFlowAfterQueue: false,
      journeyStage: command.nextStage,
      handoffCommandId: commandId,
      handoffDecisionId: command.decisionId,
      updatedAt: now
    };
    delete routedChat._id;
    const task = {
      id: taskId,
      tenantId,
      contactId: routedChat.contactId,
      turizmoLeadId: routedChat.turizmoLeadId,
      chatId: routedChat.id,
      attendanceId: routedChat.id,
      campaignId: routedChat.campaignId,
      campaignItemId: routedChat.campaignItemId || null,
      classificationId: routedChat.classificationId || null,
      commandId: previousTask?.commandId || commandId,
      decisionId: previousTask?.decisionId || command.decisionId,
      lastCommandId: commandId,
      lastDecisionId: command.decisionId || null,
      title: command.handoff?.title || 'Lead comercial requer atendimento',
      description: command.handoff?.reason || command.reason || '',
      priority,
      queueId: queue.id,
      queueName: queue.name,
      status: 'open',
      assignedTo: null,
      assignedToName: null,
      dueAt: now,
      createdAt: previousTask?.createdAt || now,
      updatedAt: now
    };
    const decision = {
      id: decisionId,
      routingKey,
      tenantId,
      trigger: 'integration',
      profileId: profile?.id || null,
      profileVersion: profile?.version || null,
      commandId,
      externalDecisionId: command.decisionId,
      chatId: routedChat.id,
      attendanceId: routedChat.id,
      taskId,
      queueId: queue.id,
      queueName: queue.name,
      queueSource,
      action: { type: 'enqueue', priority, queueId: queue.id, stopAutomation: true, createTask: true },
      status: 'queued',
      createdAt: previousDecision?.createdAt || now,
      updatedAt: now
    };

    try {
      await adapter.updateOne('activeChats', { tenantId, id: currentChat.id }, { $set: routedChat });
      await adapter.updateOne('commercialTasks', { tenantId, id: taskId }, { $set: task }, { upsert: true });
      await adapter.updateOne(COLLECTIONS.attendanceRoutingDecisions, decisionQuery, { $set: decision }, { upsert: true });
    } catch (error) {
      if (!recovering) await restoreChatFields({ tenantId, chatId: currentChat.id, snapshot: currentChat }).catch(() => {});
      await restoreDocument({ collection: 'commercialTasks', query: { tenantId, id: taskId }, snapshot: previousTask }).catch(() => {});
      await restoreDocument({ collection: COLLECTIONS.attendanceRoutingDecisions, query: decisionQuery, snapshot: previousDecision }).catch(() => {});
      throw error;
    }

    let settled = false;
    const rollback = async () => {
      if (settled || recovering) return;
      settled = true;
      await withChatLock(currentChat.id, async () => {
        const latest = await adapter.findOne('activeChats', { tenantId, id: currentChat.id });
        if (latest?.handoffCommandId !== commandId) return;
        await restoreChatFields({ tenantId, chatId: currentChat.id, snapshot: currentChat });
        await restoreDocument({ collection: 'commercialTasks', query: { tenantId, id: taskId }, snapshot: previousTask });
        await restoreDocument({ collection: COLLECTIONS.attendanceRoutingDecisions, query: decisionQuery, snapshot: previousDecision });
      });
    };
    const commit = async () => {
      if (settled) return;
      settled = true;
      const context = {
        queue: queue.name,
        queueId: queue.id,
        source: 'turizmo_handoff',
        priority,
        commandId,
        decisionId: command.decisionId
      };
      await Promise.allSettled([
        emitChatEvent({
          tenantId,
          chatId: routedChat.id,
          type: CHAT_EVENT_TYPES.QUEUE_ENTERED,
          actor: { kind: 'integration', id: 'turizmo' },
          context
        }),
        createLog('ATTENDANCE_ROUTED', {
          tenantId,
          chatId: routedChat.id,
          queueId: queue.id,
          priority,
          commandId,
          decisionId: command.decisionId,
          source: 'turizmo_handoff'
        }),
        queueTurizmoEvent({
          tenantId,
          type: 'attendance.queued',
          chat: routedChat,
          idempotencyKey: `attendance-queued:${routingKey}`,
          data: {
            attendanceId: routedChat.id,
            chatId: routedChat.id,
            taskId,
            campaignId: routedChat.campaignId,
            contactId: routedChat.contactId,
            turizmoLeadId: routedChat.turizmoLeadId,
            queueId: queue.id,
            queueName: queue.name,
            priority,
            commandId,
            decisionId: command.decisionId,
            protectedUntil: routedChat.protectedUntil,
            requeued: requeueing
          }
        })
      ]);
      const io = getIo();
      if (io) io.to(`tenant:${tenantId}`).emit('agent_assigned', { chat: buildChatSummary(routedChat) });
    };

    return {
      chat: routedChat,
      attendanceId: routedChat.id,
      task,
      taskId,
      queue,
      priority,
      decision,
      previousStage: command.expectedStage,
      recovered: recovering,
      rollback,
      commit
    };
  }));
};

const getClassificationForChat = async (chat) => {
  if (chat?.classificationId) {
    return adapter.findOne(COLLECTIONS.classifications, { tenantId: chat.tenantId, id: chat.classificationId });
  }
  const rows = await adapter.findMany(COLLECTIONS.classifications, {
    query: { tenantId: chat.tenantId, chatId: chat.id }, sort: { createdAt: -1 }, limit: 1
  });
  return rows[0] || null;
};

export const syncAttendanceLifecycle = async ({ type, chat, previous = null, actor = null, result = null }) => {
  const isTurizmoAttendance = chat?.source === 'campaign_reply'
    || chat?.source === 'turizmo_handoff'
    || isTurizmoProtectedAttendance(chat);
  if (!chat?.tenantId || !chat?.id || !isTurizmoAttendance) return { skipped: true };
  try {
    const classification = await getClassificationForChat(chat);
    if (classification) {
      await updateCommercialTask({
        classification,
        chat,
        status: type === 'closed' ? 'completed' : 'open',
        assignedTo: chat.agentId || null,
        assignedToName: chat.agentName || null
      });
      if (type === 'closed') {
        await adapter.updateOne('commercialTasks', { tenantId: chat.tenantId, classificationId: classification.id }, {
          $set: { result: result || 'attendance_closed', completedAt: chat.closedAt || nowIso(), updatedAt: nowIso() }
        });
      }
    }

    const eventType = {
      assigned: 'attendance.assigned',
      transferred: 'attendance.transferred',
      closed: 'attendance.closed'
    }[type];
    if (!eventType) return { skipped: true };
    const occurredAt = nowIso();
    const queuedAtMs = new Date(chat.queuedAt || chat.waitingSince || chat.createdAt || occurredAt).getTime();
    const assignedAtMs = new Date(chat.assignedAt || occurredAt).getTime();
    const closedAtMs = new Date(chat.closedAt || occurredAt).getTime();
    await queueTurizmoEvent({
      tenantId: chat.tenantId,
      type: eventType,
      chat,
      idempotencyKey: `${eventType}:${chat.id}:${type === 'transferred' ? chat.transferredAt || occurredAt : type === 'closed' ? chat.closedAt || occurredAt : chat.assignedAt || occurredAt}`,
      data: {
        attendanceId: chat.id, chatId: chat.id, campaignId: chat.campaignId || null,
        campaignItemId: chat.campaignItemId || null, contactId: chat.contactId || null,
        turizmoLeadId: chat.turizmoLeadId || null, agentId: chat.agentId || null,
        agentName: chat.agentName || null, queueId: chat.queueId || null, queueName: chat.queue || null,
        fromAgentId: previous?.agentId || null, toAgentId: chat.agentId || null,
        fromQueueId: previous?.queueId || null, toQueueId: chat.queueId || null,
        assignedAt: chat.assignedAt || null, queuedAt: chat.queuedAt || null,
        closedAt: chat.closedAt || null, result: result || null,
        waitingDurationMs: Math.max(0, assignedAtMs - queuedAtMs),
        attendanceDurationMs: type === 'closed' ? Math.max(0, closedAtMs - assignedAtMs) : null,
        actorId: actor?.id || null
      }
    });
    await createLog(`ATTENDANCE_${type.toUpperCase()}`, { tenantId: chat.tenantId, chatId: chat.id, agentId: chat.agentId || null, queueId: chat.queueId || null });
    return { ok: true };
  } catch (error) {
    console.warn('[ATTENDANCE_ROUTING] Falha nao bloqueante ao sincronizar ciclo de atendimento', {
      tenantId: chat.tenantId, chatId: chat.id, type, error: error?.message || 'sync_failed'
    });
    return { ok: false, error: error?.message || 'sync_failed' };
  }
};

export const getDefaultAttendanceRoutingRules = defaultRules;
