import adapter from '../../db/DatabaseAdapter.js';
import { stopCadencesForContact } from './cadenceEngine.js';
import { suppressContact } from './contactSuppression.js';
import { createTurizmoEvent, enqueueTurizmoEvent } from './integrationOutbox.js';
import { recordCampaignMetricOnce } from './outreachMetrics.js';
import { COLLECTIONS, normalizeIdentifier, nowIso } from './outreachDomain.js';
import { enqueueLeadClassification } from '../queues/classificationQueue.js';
import { enqueueTurizmoDelivery } from '../queues/turizmoQueue.js';

const OPT_OUT_PATTERN = /\b(parar|pare|sair|remover|descadastrar|cancelar mensagens|nao me envie|n[aã]o me envie)\b/i;

const unresolvedQuery = (tenantId, chatId, contactId) => ({
  tenantId,
  $and: [
    { $or: [{ repliedAt: { $exists: false } }, { repliedAt: null }] },
    {
      $or: [
        ...(chatId ? [{ chatId }] : []),
        ...(contactId ? [{ contactId }] : [])
      ]
    }
  ]
});

const findOutreach = async ({ tenantId, chatId, contactId, replyToProviderMessageId }) => {
  if (replyToProviderMessageId) {
    const quoted = await adapter.findOne(COLLECTIONS.outreachHistory, { tenantId, providerMessageId: replyToProviderMessageId });
    if (quoted) return quoted;
  }
  const query = unresolvedQuery(tenantId, chatId, contactId);
  const rows = await adapter.findMany(COLLECTIONS.outreachHistory, { query, sort: { createdAt: -1 }, limit: 1 });
  return rows[0] || null;
};

const findResolvedTurizmoOutreach = async ({ tenantId, chat }) => {
  if (!tenantId || !chat?.id || chat.status === 'closed') return null;
  const attributedMessages = await adapter.findMany('chatMessages', {
    query: {
      tenantId,
      chatId: chat.id,
      campaignItemId: { $exists: true, $ne: null }
    },
    projection: { campaignId: 1, campaignItemId: 1, outreachId: 1, timestamp: 1 },
    sort: { timestamp: -1, createdAt: -1 },
    limit: 1
  });
  const context = attributedMessages[0] || null;
  if (!context?.campaignItemId && !context?.outreachId) return null;
  const campaignId = context.campaignId || null;
  const campaign = campaignId
    ? await adapter.findOne(COLLECTIONS.campaigns, { tenantId, id: campaignId }, {
      projection: { automationManagedBy: 1 }
    })
    : null;
  if (campaign?.automationManagedBy !== 'turizmo') return null;
  if (context.outreachId) {
    const outreach = await adapter.findOne(COLLECTIONS.outreachHistory, { tenantId, id: context.outreachId });
    if (outreach) return outreach;
  }
  return adapter.findOne(COLLECTIONS.outreachHistory, {
    tenantId,
    campaignItemId: context.campaignItemId
  });
};

const recoverTurizmoOutreach = async ({ tenantId, chat }) => {
  const state=await adapter.findOne('turizmoAutomationStates',{tenantId,chatId:chat.id});
  if(!state?.lastCommandId||state.automationLocked===true||!['video_sent','values_sent'].includes(state.stage))return null;
  const command=await adapter.findOne('turizmoAutomationCommands',{tenantId,commandId:state.lastCommandId,status:'executed'});
  if(!command||!['send_text','send_media'].includes(command.type))return null;
  const existing=await adapter.findOne(COLLECTIONS.outreachHistory,{tenantId,commandId:command.commandId});
  if(existing)return existing;
  const campaignItem=state.campaignId?await adapter.findOne(COLLECTIONS.campaignItems,{
    tenantId,campaignId:state.campaignId,
    $or:[
      {turizmoLeadId:state.turizmoLeadId},
      ...(chat.contactId?[{contactId:chat.contactId}]:[]),
      {chatId:chat.id}
    ]
  }):null;
  const createdAt=command.executedAt||command.updatedAt||nowIso();
  const record={
    id:`outreach_${command.commandId}`.slice(0,220),tenantId,
    contactId:chat.contactId||campaignItem?.contactId||null,chatId:chat.id,
    channel:chat.channel||'whatsapp',kind:command.type,source:'turizmo_command_recovered',
    senderPhoneNumberId:chat.whatsappPhoneNumberId||null,to:chat.channelUserId||null,
    previewText:command.type==='send_text'?command.text:(command.media?.caption||`[${command.media?.type||'media'}]`),
    providerMessageId:command.result?.providerMessageId||null,campaignId:state.campaignId||null,
    campaignItemId:campaignItem?.id||null,turizmoLeadId:state.turizmoLeadId,
    commandId:command.commandId,decisionId:command.decisionId||null,
    expectedStage:command.expectedStage||null,nextStage:command.nextStage||state.stage,
    countsTowardCampaignMetrics:false,status:'sent',statusHistory:[{status:'sent',at:createdAt,source:'recovery'}],
    lastStatusAt:createdAt,lastError:null,createdBy:'turizmo_recovery',createdAt,updatedAt:nowIso()
  };
  await adapter.updateOne(COLLECTIONS.outreachHistory,{tenantId,id:record.id},{$set:record},{upsert:true});
  return adapter.findOne(COLLECTIONS.outreachHistory,{tenantId,id:record.id});
};

export const attributeInboundReply = async ({ tenantId, chat, message, replyToProviderMessageId = null }) => {
  if (!tenantId || !chat?.id || !message?.id) return { attributed: false };
  const immediateOptOut = OPT_OUT_PATTERN.test(String(message.text || ''));
  const directIdentifier = chat.channelUserId || chat.customerPhone || chat.phone || null;
  if (immediateOptOut && directIdentifier) {
    const directContact = chat.contactId
      ? await adapter.findOne('contacts', { tenantId, id: chat.contactId })
      : null;
    await suppressContact({
      tenantId,
      contactId: chat.contactId || null,
      identifier: directIdentifier,
      reason: 'opt_out',
      source: 'inbound_keyword',
      createdBy: 'system'
    });
    if (chat.contactId) await stopCadencesForContact({ tenantId, contactId: chat.contactId, reason: 'opted_out' });
    const optOutEvent = await enqueueTurizmoEvent(createTurizmoEvent({
      tenantId,
      type: 'lead.opted_out',
      aggregateType: 'lead',
      aggregateId: chat.contactId || normalizeIdentifier(directIdentifier),
      idempotencyKey: `lead-opted-out:${tenantId}:${normalizeIdentifier(directIdentifier)}`,
      data: {
        turizmoLeadId: directContact?.turizmoLeadId || null,
        contactId: chat.contactId || null,
        channel: chat.channel || 'whatsapp',
        identifier: normalizeIdentifier(directIdentifier),
        reason: 'opt_out',
        optedOutAt: message.timestamp || nowIso()
      }
    }));
    if (optOutEvent) enqueueTurizmoDelivery({ outboxId: optOutEvent.id }).catch(() => {});
  }
  const alreadyAttributed = await adapter.findOne('chatMessages', { tenantId, messageId: message.id }, { projection: { campaignItemId: 1 } });
  if (alreadyAttributed?.campaignItemId) return { attributed: true, duplicate: true, campaignItemId: alreadyAttributed.campaignItemId };
  const outreach = await recoverTurizmoOutreach({tenantId,chat})
    || await findOutreach({ tenantId, chatId: chat.id, contactId: chat.contactId, replyToProviderMessageId })
    || await findResolvedTurizmoOutreach({ tenantId, chat });
  if (!outreach) return { attributed: false };
  const campaignItem = outreach.campaignItemId
    ? await adapter.findOne(COLLECTIONS.campaignItems, { tenantId, id: outreach.campaignItemId })
    : await adapter.findOne(COLLECTIONS.campaignItems, { tenantId, outreachId: outreach.id });
  const repliedAt = message.timestamp || nowIso();
  const sentAt = campaignItem?.sentAt || outreach.createdAt || repliedAt;
  const firstResponseTimeMs = Math.max(0, new Date(repliedAt).getTime() - new Date(sentAt).getTime());
  const campaignId = campaignItem?.campaignId || outreach.campaignId || null;
  const campaignItemId = campaignItem?.id || outreach.campaignItemId || null;
  const patch = {
    outreachId: outreach.id,
    campaignId,
    campaignItemId,
    contactId: outreach.contactId || chat.contactId || null,
    turizmoLeadId: campaignItem?.turizmoLeadId || outreach.turizmoLeadId || null
  };
  await adapter.updateOne('chatMessages', { tenantId, messageId: message.id }, { $set: patch });

  if (!outreach.repliedAt) {
    await adapter.updateOne(COLLECTIONS.outreachHistory, { id: outreach.id }, {
      $set: { ...patch, replyMessageId: message.id, repliedAt, firstResponseTimeMs, updatedAt: nowIso() }
    });
  }
  if (campaignItemId && !campaignItem?.repliedAt) {
    await adapter.updateOne(COLLECTIONS.campaignItems, { tenantId, id: campaignItemId }, {
      $set: { status: 'replied', replyMessageId: message.id, repliedAt, firstResponseTimeMs, updatedAt: nowIso() }
    });
    await recordCampaignMetricOnce({ tenantId, campaignId, campaignItemId, type: 'replied', sourceId: message.id, occurredAt: repliedAt });
  }
  if (patch.contactId) await stopCadencesForContact({ tenantId, contactId: patch.contactId, reason: 'stopped_by_reply' });

  if (immediateOptOut && campaignItem?.phoneNumber) {
    await suppressContact({
      tenantId,
      contactId: patch.contactId,
      identifier: campaignItem.phoneNumber,
      reason: 'opt_out',
      source: 'inbound_keyword',
      createdBy: 'system'
    });
    if (campaignItemId) {
      await adapter.updateOne(COLLECTIONS.campaignItems, { tenantId, id: campaignItemId }, {
        $set: { status: 'opted_out', optedOutAt: repliedAt, updatedAt: nowIso() }
      });
      await recordCampaignMetricOnce({ tenantId, campaignId, campaignItemId, type: 'opted_out', sourceId: message.id, occurredAt: repliedAt });
    }
    await adapter.updateOne('activeChats', {
      tenantId,
      id: chat.id,
      status: 'bot',
      attendanceDeferred: true
    }, {
      $set: {
        activeOutreach: false,
        attendanceDeferred: false,
        outreachPendingReply: false,
        updatedAt: nowIso()
      }
    });
  }

  const event = await enqueueTurizmoEvent(createTurizmoEvent({
    tenantId,
    type: 'lead.replied',
    aggregateType: 'lead',
    aggregateId: patch.turizmoLeadId || patch.contactId,
    idempotencyKey: `lead-replied:${message.id}`,
    data: {
      turizmoLeadId: patch.turizmoLeadId, contactId: patch.contactId, chatId: chat.id,
      campaignId, campaignItemId, messageId: message.id, repliedAt, firstResponseTimeMs,
      optOutDetected: immediateOptOut
    }
  }));
  if (event) enqueueTurizmoDelivery({ outboxId: event.id }).catch(() => {});
  enqueueLeadClassification({ tenantId, messageId: message.id }).catch(() => {});
  return { attributed: true, outreachId: outreach.id, campaignId, campaignItemId, firstResponseTimeMs };
};
