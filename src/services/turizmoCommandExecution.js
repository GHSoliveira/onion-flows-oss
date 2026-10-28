import { z } from 'zod';
import adapter from '../../db/DatabaseAdapter.js';
import { getWhatsAppConfig, resolveWhatsAppSender } from './channelConfig.js';
import { appendChatMessage } from './chatMessages.js';
import { sendWhatsAppMedia, sendWhatsAppText } from './whatsappApi.js';
import { createDomainId, nowIso } from './outreachDomain.js';
import { enqueueTurizmoEvent, createTurizmoEvent } from './integrationOutbox.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';
import { routeAutomationCommandToAttendance } from './attendanceRouting.js';
import { withChatLock, withLock } from './chatLocks.js';
import { createOutreachRecord } from './outreachHistory.js';
import {
  calculateProtectedUntil,
  isTurizmoProtectedAttendance,
  normalizePostHandoff
} from './protectedAttendance.js';
import { createLog, getIo } from './logs.js';

export const turizmoCommandSchema = z.object({
  tenantId: z.string().trim().min(1).max(160),
  commandId: z.string().trim().min(1).max(200),
  type: z.enum([
    'send_text',
    'send_media',
    'pause_automation',
    'handoff_to_attendance',
    'hold_attendance',
    'close_attendance'
  ]),
  turizmoLeadId: z.string().trim().min(1).max(160),
  campaignId: z.string().trim().min(1).max(200).nullable().optional(),
  chatId: z.string().trim().min(1).max(200).nullable().optional(),
  expectedStage: z.string().trim().min(1).max(80),
  nextStage: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(4096).nullable().optional(),
  media: z.object({
    type: z.enum(['video', 'image', 'document', 'audio']),
    url: z.string().url().max(2048),
    caption: z.string().max(1024).nullable().optional(),
    filename: z.string().max(255).nullable().optional()
  }).strict().nullable().optional(),
  reason: z.string().max(1000).nullable().optional(),
  decisionId: z.string().trim().max(200).nullable().optional(),
  holdHours: z.number().int().min(1).max(168).nullable().optional(),
  confirmation: z.object({
    manual: z.literal(true),
    confirmedBy: z.string().trim().min(1).max(200),
    confirmedAt: z.string().datetime()
  }).strict().nullable().optional(),
  handoff: z.object({
    queueId: z.string().trim().min(1).max(200).nullable().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    title: z.string().trim().max(300).nullable().optional(),
    reason: z.string().trim().max(1000).nullable().optional(),
    autoClose: z.literal(false).default(false),
    holdHours: z.number().int().min(1).max(168).default(72),
    inboundDuringHold: z.literal('notify_turizmo').default('notify_turizmo')
  }).strict().nullable().optional()
}).strict().superRefine((value, ctx) => {
  if (value.type === 'send_text' && !value.text) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'Texto obrigatorio.' });
  if (value.type === 'send_media' && !value.media) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['media'], message: 'Midia obrigatoria.' });
  if (value.type === 'handoff_to_attendance') {
    if (!value.decisionId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decisionId'], message: 'decisionId obrigatorio para handoff.' });
    if (!value.handoff) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['handoff'], message: 'handoff obrigatorio.' });
    if (value.nextStage !== 'human_handoff') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nextStage'], message: 'nextStage deve ser human_handoff.' });
  }
  if (value.type === 'hold_attendance' && !value.holdHours && !value.handoff?.holdHours) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['holdHours'], message: 'holdHours obrigatorio para renovar a protecao.' });
  }
  if (value.type === 'close_attendance' && !value.confirmation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmation'], message: 'Confirmacao manual obrigatoria para encerrar.' });
  }
});

const findExecutedCommand = async (command) => adapter.findOne('turizmoAutomationCommands', {
  tenantId: command.tenantId,
  status: 'executed',
  $or: [
    { commandId: command.commandId },
    ...(command.decisionId ? [{ decisionId: command.decisionId, type: command.type }] : [])
  ]
});

const findChat = async (command) => {
  if (command.chatId) {
    const exact = await adapter.findOne('activeChats', { tenantId: command.tenantId, id: command.chatId });
    if (exact) return exact;
  }
  const direct = await adapter.findOne('activeChats', {
    tenantId: command.tenantId,
    turizmoLeadId: command.turizmoLeadId,
    status: { $ne: 'closed' }
  });
  if (direct) return direct;

  const contact = await adapter.findOne('contacts', {
    tenantId: command.tenantId,
    turizmoLeadId: command.turizmoLeadId
  });
  if (!contact) return null;

  const byContact = await adapter.findMany('activeChats', {
    query: { tenantId: command.tenantId, contactId: contact.id, status: { $ne: 'closed' } },
    sort: { updatedAt: -1 },
    limit: 1
  });
  if (byContact[0]) return byContact[0];

  const phoneCandidates = [
    contact.normalizedPrimaryPhone,
    ...(Array.isArray(contact.phones) ? contact.phones.map((phone) => phone?.normalizedNumber || phone?.number) : []),
    ...(Array.isArray(contact.channelIdentities)
      ? contact.channelIdentities.filter((identity) => identity?.channel === 'whatsapp')
        .map((identity) => identity.normalizedIdentifier || identity.identifier)
      : [])
  ].map((value) => String(value || '').replace(/\D/g, '')).filter(Boolean);
  for (const channelUserId of [...new Set(phoneCandidates)]) {
    const byPhone = await adapter.findMany('activeChats', {
      query: {
        tenantId: command.tenantId,
        channel: 'whatsapp',
        channelUserId,
        status: { $ne: 'closed' }
      },
      sort: { updatedAt: -1 },
      limit: 1
    });
    if (byPhone[0]) return byPhone[0];
  }
  return null;
};

const rejectHumanAttendance = (chat) => {
  if (chat?.automationLocked || chat?.automationMode === 'human' || chat?.mode === 'human' || ['open', 'waiting'].includes(chat?.status)) {
    const error = new Error('Conversa em atendimento humano; automacao bloqueada.');
    error.status = 409;
    error.code = 'human_attendance_active';
    throw error;
  }
};

const emitResult = async ({ command, status, providerMessageId = null, error = null, data = {} }) => {
  const event = await enqueueTurizmoEvent(createTurizmoEvent({
    tenantId: command.tenantId,
    type: status === 'executed' ? 'automation.command.executed' : 'automation.command.failed',
    aggregateType: 'lead',
    aggregateId: command.turizmoLeadId,
    idempotencyKey: `automation-command:${command.commandId}:${status}`,
    data: {
      commandId: command.commandId,
      decisionId: command.decisionId || null,
      turizmoLeadId: command.turizmoLeadId,
      campaignId: command.campaignId || null,
      chatId: command.chatId || null,
      action: command.type,
      expectedStage: command.expectedStage,
      nextStage: command.nextStage,
      providerMessageId,
      status,
      error,
      ...(status === 'failed' ? { failedAt: nowIso() } : {}),
      ...data
    }
  }));
  if (event) enqueueTurizmoDelivery({ outboxId: event.id }).catch(() => {});
  return event;
};

const validateCampaignOwnership = async ({ command, chat, state }) => {
  if (!command.campaignId) return;
  const knownCampaignIds = new Set([
    chat?.campaignId,
    state?.campaignId
  ].map((value) => String(value || '').trim()).filter(Boolean));
  if (knownCampaignIds.has(command.campaignId)) return;

  const campaignItem = await adapter.findOne('outreachCampaignItems', {
    tenantId: command.tenantId,
    campaignId: command.campaignId,
    $or: [
      { chatId: chat.id },
      { contactId: chat.contactId },
      { turizmoLeadId: command.turizmoLeadId }
    ]
  });
  if (campaignItem) return;

  const error = new Error('A conversa nao pertence a campanha informada.');
  error.status = 409;
  error.code = 'campaign_mismatch';
  throw error;
};

const findCampaignItemForCommand = async ({ command, chat }) => {
  if (!command.campaignId) return null;
  return adapter.findOne('outreachCampaignItems', {
    tenantId: command.tenantId,
    campaignId: command.campaignId,
    $or: [
      { turizmoLeadId: command.turizmoLeadId },
      ...(chat?.contactId ? [{ contactId: chat.contactId }] : []),
      ...(chat?.id ? [{ chatId: chat.id }] : [])
    ]
  });
};

const restoreAutomationState = async ({ tenantId, turizmoLeadId, snapshot }) => {
  await adapter.deleteMany('turizmoAutomationStates', { tenantId, turizmoLeadId });
  if (snapshot) await adapter.insertOne('turizmoAutomationStates', snapshot);
};

const executeHandoffCommand = async (command) => {
  const executed = await findExecutedCommand(command);
  if (executed) return { ...executed.result, duplicate: true };
  const existing = await adapter.findOne('turizmoAutomationCommands', {
    tenantId: command.tenantId,
    commandId: command.commandId
  });
  if (existing?.status === 'executed') return { ...existing.result, duplicate: true };

  let chat = null;
  let state = null;
  let routing = null;
  let stateChanged = false;
  try {
    chat = await findChat(command);
    if (!chat) {
      const error = new Error('Conversa ativa do lead nao encontrada.');
      error.status = 404;
      error.code = 'chat_not_found';
      throw error;
    }

    const recovering = chat.handoffCommandId === command.commandId
      && chat.automationLocked === true
      && ['waiting', 'open'].includes(chat.status);
    const requeueing = !recovering && (
      chat.automationLocked === true
      || chat.automationMode === 'human'
      || chat.mode === 'human'
      || ['waiting', 'open'].includes(chat.status)
    );

    state = await adapter.findOne('turizmoAutomationStates', {
      tenantId: command.tenantId,
      turizmoLeadId: command.turizmoLeadId
    });
    const previousStage = state?.stage || chat.journeyStage || null;
    if (!recovering && !requeueing && previousStage !== command.expectedStage) {
      const error = new Error(`Etapa divergente: esperado ${command.expectedStage}, atual ${previousStage || 'nao definida'}.`);
      error.status = 409;
      error.code = 'automation_stage_conflict';
      throw error;
    }
    await validateCampaignOwnership({ command, chat, state });
    const campaign = command.campaignId
      ? await adapter.findOne('outreachCampaigns', { tenantId: command.tenantId, id: command.campaignId })
      : null;
    const postHandoff = normalizePostHandoff({
      ...(campaign?.postHandoff || {}),
      ...(state?.postHandoff || {}),
      ...(command.handoff || {})
    });
    const protectedUntil = calculateProtectedUntil(postHandoff.holdHours);
    const protectedCommand = {
      ...command,
      postHandoff,
      protectedUntil,
      turizmoCampaignId: campaign?.turizmoCampaignId || state?.turizmoCampaignId || null
    };

    const startedAt = nowIso();
    await adapter.updateOne('turizmoAutomationCommands', {
      tenantId: command.tenantId,
      commandId: command.commandId
    }, {
      $set: {
        ...command,
        id: existing?.id || createDomainId('turizmo_cmd'),
        status: 'processing',
        chatId: chat.id,
        lastError: null,
        updatedAt: startedAt
      },
      $setOnInsert: { createdAt: startedAt }
    }, { upsert: true });

    routing = await routeAutomationCommandToAttendance({ command: protectedCommand, chat });
    const routedAt = nowIso();
    const result = {
      ok: true,
      duplicate: false,
      commandId: command.commandId,
      decisionId: command.decisionId,
      chatId: routing.chat.id,
      attendanceId: routing.attendanceId,
      taskId: routing.taskId,
      queueId: routing.queue.id,
      priority: routing.priority,
      protectedUntil,
      postHandoff,
      requeued: requeueing,
      previousStage: previousStage || command.expectedStage,
      stage: command.nextStage,
      nextStage: command.nextStage
    };

    await adapter.updateOne('turizmoAutomationStates', {
      tenantId: command.tenantId,
      turizmoLeadId: command.turizmoLeadId
    }, {
      $set: {
        id: state?.id || createDomainId('turizmo_state'),
        tenantId: command.tenantId,
        turizmoLeadId: command.turizmoLeadId,
        campaignId: command.campaignId || state?.campaignId || null,
        turizmoCampaignId: campaign?.turizmoCampaignId || state?.turizmoCampaignId || null,
        chatId: routing.chat.id,
        stage: command.nextStage,
        automationLocked: true,
        protectedAttendance: true,
        protectedUntil,
        postHandoff,
        automationMode: 'human',
        activeOutreach: false,
        attendanceDeferred: false,
        outreachPendingReply: false,
        attendanceStatus: 'waiting',
        journeyStage: command.nextStage,
        attendanceId: routing.attendanceId,
        taskId: routing.taskId,
        queueId: routing.queue.id,
        lastCommandId: command.commandId,
        lastDecisionId: command.decisionId || state?.lastDecisionId || null,
        updatedAt: routedAt
      },
      $setOnInsert: { createdAt: routedAt }
    }, { upsert: true });
    stateChanged = true;

    await adapter.updateOne('turizmoAutomationCommands', {
      tenantId: command.tenantId,
      commandId: command.commandId
    }, {
      $set: {
        status: 'executed',
        result,
        attendanceId: routing.attendanceId,
        taskId: routing.taskId,
        queueId: routing.queue.id,
        executedAt: routedAt,
        updatedAt: routedAt
      }
    });
    await emitResult({
      command: { ...command, chatId: routing.chat.id },
      status: 'executed',
      data: {
        previousStage: result.previousStage,
        nextStage: command.nextStage,
        attendanceId: routing.attendanceId,
        taskId: routing.taskId,
        queueId: routing.queue.id,
        priority: routing.priority,
        protectedUntil,
        postHandoff,
        requeued: requeueing,
        routedAt
      }
    });
    await routing.commit();
    return result;
  } catch (error) {
    if (routing) await routing.rollback().catch(() => {});
    if (stateChanged) {
      await restoreAutomationState({
        tenantId: command.tenantId,
        turizmoLeadId: command.turizmoLeadId,
        snapshot: state
      }).catch(() => {});
    }
    await adapter.updateOne('turizmoAutomationCommands', {
      tenantId: command.tenantId,
      commandId: command.commandId
    }, {
      $set: {
        ...command,
        id: existing?.id || createDomainId('turizmo_cmd'),
        status: 'failed',
        chatId: chat?.id || command.chatId || null,
        error: {
          code: error.code || 'command_failed',
          message: String(error.message || 'Falha no handoff').slice(0, 500)
        },
        updatedAt: nowIso()
      },
      $setOnInsert: { createdAt: nowIso() }
    }, { upsert: true }).catch(() => {});
    await emitResult({
      command: { ...command, chatId: chat?.id || command.chatId || null },
      status: 'failed',
      error: {
        code: error.code || 'command_failed',
        message: String(error.message || 'Falha no handoff').slice(0, 500)
      }
    }).catch(() => {});
    throw error;
  }
};

const executeLegacyTurizmoCommand = async (command) => {
  const executed = await findExecutedCommand(command);
  if (executed) return { ...executed.result, duplicate: true };
  const existing = await adapter.findOne('turizmoAutomationCommands', { tenantId: command.tenantId, commandId: command.commandId });
  if (existing?.status === 'executed') return { ...existing.result, duplicate: true };

  const chat = await findChat(command);
  if (!chat) {
    const error = new Error('Conversa ativa do lead nao encontrada.');
    error.status = 404;
    error.code = 'chat_not_found';
    throw error;
  }
  rejectHumanAttendance(chat);

  const state = await adapter.findOne('turizmoAutomationStates', { tenantId: command.tenantId, turizmoLeadId: command.turizmoLeadId });
  if (state?.stage && state.stage !== command.expectedStage) {
    const error = new Error(`Etapa divergente: esperado ${command.expectedStage}, atual ${state.stage}.`);
    error.status = 409;
    error.code = 'automation_stage_conflict';
    throw error;
  }

  const now = nowIso();
  await adapter.updateOne('turizmoAutomationCommands', { tenantId: command.tenantId, commandId: command.commandId }, {
    $set: { ...command, id: existing?.id || createDomainId('turizmo_cmd'), status: 'processing', chatId: chat.id, updatedAt: now },
    $setOnInsert: { createdAt: now }
  }, { upsert: true });

  try {
    let providerMessageId = null;
    if (command.type !== 'pause_automation') {
      const config = await getWhatsAppConfig(command.tenantId);
      const sender = resolveWhatsAppSender(config, chat.whatsappPhoneNumberId || null);
      if (!config?.accessToken || !sender?.phoneNumberId) {
        const error = new Error('Canal WhatsApp nao configurado para o tenant.');
        error.status = 503;
        error.code = 'whatsapp_not_configured';
        throw error;
      }
      const common = {
        accessToken: config.accessToken,
        phoneNumberId: sender.phoneNumberId,
        to: chat.channelUserId,
        debugContext: { tenantId: command.tenantId, source: 'turizmo_command', commandId: command.commandId }
      };
      const result = command.type === 'send_text'
        ? await sendWhatsAppText({ ...common, text: command.text })
        : await sendWhatsAppMedia({
          ...common,
          mediaType: command.media.type,
          mediaUrl: command.media.url,
          caption: command.media.caption || null,
          filename: command.media.filename || null
        });
      providerMessageId = result?.messages?.[0]?.id || null;
      await appendChatMessage(chat, {
        id: createDomainId('msg'),
        sender: 'bot',
        text: command.type === 'send_text' ? command.text : (command.media.caption || `[${command.media.type}]`),
        media: command.type === 'send_media' ? { type: command.media.type, url: command.media.url } : null,
        providerMessageId,
        meta: { source: 'turizmo', commandId: command.commandId, decisionId: command.decisionId || null },
        timestamp: now
      }, { incrementUnread: false });
      const campaignItem=await findCampaignItemForCommand({command,chat});
      await createOutreachRecord({
        tenantId:command.tenantId,
        contactId:chat.contactId||campaignItem?.contactId||null,
        chatId:chat.id,
        channel:chat.channel||'whatsapp',
        senderPhoneNumberId:sender.phoneNumberId,
        senderLabel:sender.label||null,
        to:chat.channelUserId,
        previewText:command.type==='send_text'?command.text:(command.media.caption||`[${command.media.type}]`),
        providerMessageId,
        campaignId:command.campaignId||campaignItem?.campaignId||null,
        campaignItemId:campaignItem?.id||null,
        turizmoLeadId:command.turizmoLeadId,
        createdBy:'turizmo',
        kind:command.type,
        source:'turizmo_command',
        commandId:command.commandId,
        decisionId:command.decisionId||null,
        expectedStage:command.expectedStage,
        nextStage:command.nextStage,
        countsTowardCampaignMetrics:false
      });
    }

    const result = { ok: true, duplicate: false, commandId: command.commandId, chatId: chat.id, stage: command.nextStage, providerMessageId };
    await adapter.updateOne('turizmoAutomationStates', { tenantId: command.tenantId, turizmoLeadId: command.turizmoLeadId }, {
      $set: {
        id: state?.id || createDomainId('turizmo_state'), tenantId: command.tenantId,
        turizmoLeadId: command.turizmoLeadId, campaignId: command.campaignId || null,
        chatId: chat.id, stage: command.nextStage, lastCommandId: command.commandId, updatedAt: now
      }, $setOnInsert: { createdAt: now }
    }, { upsert: true });
    await adapter.updateOne('turizmoAutomationCommands', { tenantId: command.tenantId, commandId: command.commandId }, {
      $set: { status: 'executed', result, executedAt: nowIso(), updatedAt: nowIso() }
    });
    await emitResult({ command: { ...command, chatId: chat.id }, status: 'executed', providerMessageId });
    return result;
  } catch (error) {
    await adapter.updateOne('turizmoAutomationCommands', { tenantId: command.tenantId, commandId: command.commandId }, {
      $set: { status: 'failed', error: { code: error.code || 'command_failed', message: error.message }, updatedAt: nowIso() }
    });
    await emitResult({ command: { ...command, chatId: chat.id }, status: 'failed', error: { code: error.code || 'command_failed', message: error.message } }).catch(() => {});
    throw error;
  }
};

const ensureProtectedAttendance = (chat) => {
  if (isTurizmoProtectedAttendance(chat) && chat.status !== 'closed') return;
  const error = new Error('Atendimento protegido do Turizmo nao encontrado ou ja encerrado.');
  error.status = 409;
  error.code = 'protected_attendance_not_active';
  throw error;
};

const startAttendanceCommand = async ({ command, chat }) => {
  const startedAt = nowIso();
  await adapter.updateOne('turizmoAutomationCommands', {
    tenantId: command.tenantId,
    commandId: command.commandId
  }, {
    $set: {
      ...command,
      id: createDomainId('turizmo_cmd'),
      status: 'processing',
      chatId: chat.id,
      lastError: null,
      updatedAt: startedAt
    },
    $setOnInsert: { createdAt: startedAt }
  }, { upsert: true });
};

const completeAttendanceCommand = async ({ command, result }) => {
  const completedAt = nowIso();
  await adapter.updateOne('turizmoAutomationCommands', {
    tenantId: command.tenantId,
    commandId: command.commandId
  }, {
    $set: { status: 'executed', result, executedAt: completedAt, updatedAt: completedAt }
  });
  await emitResult({ command: { ...command, chatId: result.chatId }, status: 'executed', data: result });
  return result;
};

const executeHoldAttendanceCommand = async (command) => {
  const executed = await findExecutedCommand(command);
  if (executed) return { ...executed.result, duplicate: true };
  let chat = await findChat(command);
  if (!chat) {
    const error = new Error('Conversa ativa do lead nao encontrada.');
    error.status = 404;
    error.code = 'chat_not_found';
    throw error;
  }
  return withChatLock(chat.id, async () => {
  chat = await adapter.findOne('activeChats', { tenantId: command.tenantId, id: chat.id });
  if (!chat) {
    const error = new Error('Conversa ativa do lead nao encontrada.');
    error.status = 404;
    error.code = 'chat_not_found';
    throw error;
  }
  ensureProtectedAttendance(chat);
  const state = await adapter.findOne('turizmoAutomationStates', {
    tenantId: command.tenantId,
    turizmoLeadId: command.turizmoLeadId
  });
  const postHandoff = normalizePostHandoff({
    ...(chat.postHandoff || state?.postHandoff || {}),
    holdHours: command.holdHours || command.handoff?.holdHours
  });
  const protectedUntil = calculateProtectedUntil(postHandoff.holdHours);
  const updatedAt = nowIso();
  await startAttendanceCommand({ command, chat });
  await adapter.updateOne('activeChats', { tenantId: command.tenantId, id: chat.id }, {
    $set: {
      automationLocked: true,
      protectedAttendance: true,
      protectedUntil,
      postHandoff,
      protectionRenewedAt: updatedAt,
      protectionRenewedByCommandId: command.commandId,
      updatedAt
    }
  });
  await adapter.updateOne('turizmoAutomationStates', {
    tenantId: command.tenantId,
    turizmoLeadId: command.turizmoLeadId
  }, {
    $set: {
      automationLocked: true,
      protectedAttendance: true,
      protectedUntil,
      postHandoff,
      chatId: chat.id,
      lastCommandId: command.commandId,
      lastDecisionId: command.decisionId || state?.lastDecisionId || null,
      updatedAt
    }
  }, { upsert: false });
  const result = {
    ok: true,
    duplicate: false,
    commandId: command.commandId,
    decisionId: command.decisionId || null,
    chatId: chat.id,
    attendanceId: chat.id,
    stage: state?.stage || chat.journeyStage || command.nextStage,
    protectedUntil,
    postHandoff
  };
  await createLog('ATTENDANCE_PROTECTION_RENEWED', {
    tenantId: command.tenantId,
    chatId: chat.id,
    commandId: command.commandId,
    protectedUntil
  }, 'integration:turizmo');
  return completeAttendanceCommand({ command, result });
  });
};

const executeCloseAttendanceCommand = async (command) => {
  const executed = await findExecutedCommand(command);
  if (executed) return { ...executed.result, duplicate: true };
  let chat = await findChat(command);
  if (!chat) {
    const error = new Error('Conversa ativa do lead nao encontrada.');
    error.status = 404;
    error.code = 'chat_not_found';
    throw error;
  }
  return withChatLock(chat.id, async () => {
  chat = await adapter.findOne('activeChats', { tenantId: command.tenantId, id: chat.id });
  if (!chat) {
    const error = new Error('Conversa ativa do lead nao encontrada.');
    error.status = 404;
    error.code = 'chat_not_found';
    throw error;
  }
  ensureProtectedAttendance(chat);
  const state = await adapter.findOne('turizmoAutomationStates', {
    tenantId: command.tenantId,
    turizmoLeadId: command.turizmoLeadId
  });
  await startAttendanceCommand({ command, chat });
  const closedAt = nowIso();
  const closePatch = {
    status: 'closed',
    attendanceStatus: 'closed',
    automationLocked: false,
    protectedAttendance: false,
    protectedUntil: null,
    activeOutreach: false,
    attendanceDeferred: false,
    outreachPendingReply: false,
    closeReason: 'turizmo_manual_close',
    closedAt,
    closedBy: command.confirmation.confirmedBy,
    manualClosureConfirmation: command.confirmation,
    updatedAt: closedAt
  };
  await adapter.updateOne('activeChats', { tenantId: command.tenantId, id: chat.id }, { $set: closePatch });
  await adapter.updateOne('turizmoAutomationStates', {
    tenantId: command.tenantId,
    turizmoLeadId: command.turizmoLeadId
  }, {
    $set: {
      automationLocked: false,
      protectedAttendance: false,
      protectedUntil: null,
      attendanceStatus: 'closed',
      stage: command.nextStage,
      lastCommandId: command.commandId,
      lastDecisionId: command.decisionId || state?.lastDecisionId || null,
      closedAt,
      manualClosureConfirmation: command.confirmation,
      updatedAt: closedAt
    }
  }, { upsert: false });
  await adapter.updateOne('commercialTasks', {
    tenantId: command.tenantId,
    chatId: chat.id,
    status: { $in: ['open', 'waiting', 'assigned'] }
  }, {
    $set: {
      status: 'completed',
      result: 'turizmo_manual_close',
      completedAt: closedAt,
      updatedAt: closedAt
    }
  });

  const closedEvent = await enqueueTurizmoEvent(createTurizmoEvent({
    tenantId: command.tenantId,
    type: 'attendance.closed',
    aggregateType: 'attendance',
    aggregateId: chat.id,
    idempotencyKey: `attendance-closed:turizmo-command:${command.commandId}`,
    data: {
      attendanceId: chat.id,
      chatId: chat.id,
      campaignId: chat.campaignId || state?.campaignId || null,
      turizmoCampaignId: chat.turizmoCampaignId || state?.turizmoCampaignId || null,
      turizmoLeadId: command.turizmoLeadId,
      commandId: command.commandId,
      decisionId: command.decisionId || null,
      closedAt,
      closureMode: 'manual',
      confirmedBy: command.confirmation.confirmedBy
    }
  }));
  if (closedEvent) enqueueTurizmoDelivery({ outboxId: closedEvent.id }).catch(() => {});

  const result = {
    ok: true,
    duplicate: false,
    commandId: command.commandId,
    decisionId: command.decisionId || null,
    chatId: chat.id,
    attendanceId: chat.id,
    stage: command.nextStage,
    closedAt,
    closureMode: 'manual'
  };
  await createLog('ATTENDANCE_CLOSED', {
    tenantId: command.tenantId,
    chatId: chat.id,
    commandId: command.commandId,
    source: 'turizmo_manual_close'
  }, command.confirmation.confirmedBy);
  const io = getIo();
  if (io) io.to(`tenant:${command.tenantId}`).emit('chat_closed', { chatId: chat.id });
  return completeAttendanceCommand({ command, result });
  });
};

export const executeTurizmoCommand = async (command) => {
  const lockKey = command?.tenantId && command?.turizmoLeadId
    ? `turizmo-automation:${command.tenantId}:${command.turizmoLeadId}`
    : null;
  return withLock(lockKey, () => {
    if (command?.type === 'handoff_to_attendance') return executeHandoffCommand(command);
    if (command?.type === 'hold_attendance') return executeHoldAttendanceCommand(command);
    if (command?.type === 'close_attendance') return executeCloseAttendanceCommand(command);
    return executeLegacyTurizmoCommand(command);
  });
};
