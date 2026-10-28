import adapter from '../../db/DatabaseAdapter.js';
import { COLLECTIONS, createDomainId, nowIso } from './outreachDomain.js';
import { envFlag } from '../utils/env.js';

const QUALIFIED_INTENTS = Object.freeze(['pediu_demo', 'pediu_preco', 'pediu_proposta']);
const POSITIVE_INTENTS = Object.freeze(['positivo', ...QUALIFIED_INTENTS]);

export const recordCampaignMetricOnce = async ({
  tenantId,
  campaignId,
  campaignItemId = null,
  type,
  sourceId,
  occurredAt = null,
  dimensions = {}
}) => {
  if (!tenantId || !campaignId || !type || !sourceId) return false;
  const dedupeKey = `${tenantId}:${campaignId}:${campaignItemId || '-'}:${type}:${sourceId}`;
  const existing = await adapter.findOne(COLLECTIONS.metricEvents, { dedupeKey });
  if (existing) return false;
  const event = {
    id: createDomainId('metric'),
    tenantId,
    campaignId,
    campaignItemId,
    type,
    sourceId,
    dedupeKey,
    occurredAt: occurredAt || nowIso(),
    dimensions,
    createdAt: nowIso()
  };
  try {
    await adapter.insertOne(COLLECTIONS.metricEvents, event);
  } catch (error) {
    if (String(error?.code) === '11000') return false;
    throw error;
  }

  // Antes cada evento mexia em um contador so: "pediu_demo" subia o de
  // demonstracao e deixava positivas e qualificadas em zero. Agora todos os
  // contadores saem da mesma leitura dos contatos.
  await syncCampaignCounters({ tenantId, campaignId });
  return true;
};

// Contadores da campanha derivados dos contatos. A tela ja calculava assim; o
// documento da campanha guarda os mesmos numeros porque e deles que saem os
// eventos para o Turizmo.
export const aggregateCampaignItems = (items = []) => {
  const count = (predicate) => items.filter(predicate).length;
  const responseTimes = items.map((item) => Number(item.firstResponseTimeMs)).filter(Number.isFinite);
  const classifiedCount = count((item) => Boolean(item.classificationId));
  const positiveCount = count((item) => POSITIVE_INTENTS.includes(item.intent));
  const negativeCount = count((item) => ['negativo', 'opt_out'].includes(item.intent));
  return {
    sentCount: count((item) => Boolean(item.sentAt) || ['sent', 'delivered', 'read', 'replied', 'classified', 'qualified'].includes(item.status)),
    deliveredCount: count((item) => Boolean(item.deliveredAt) || ['delivered', 'read', 'replied', 'classified', 'qualified'].includes(item.status)),
    readCount: count((item) => Boolean(item.readAt) || ['read', 'replied', 'classified', 'qualified'].includes(item.status)),
    repliedCount: count((item) => Boolean(item.repliedAt)),
    classifiedCount,
    positiveCount,
    negativeCount,
    neutralCount: Math.max(0, classifiedCount - positiveCount - negativeCount),
    qualifiedCount: count((item) => item.status === 'qualified' || QUALIFIED_INTENTS.includes(item.intent)),
    demoRequestedCount: count((item) => item.intent === 'pediu_demo'),
    optOutCount: count((item) => Boolean(item.optedOutAt) || item.intent === 'opt_out'),
    failedCount: count((item) => item.status === 'failed'),
    firstResponseTimeAverageMs: responseTimes.length ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length) : 0,
    firstResponseTimeMedianMs: percentile(responseTimes, 0.5)
  };
};

// Status, pendencias e progresso continuam com o motor de envio; aqui so os
// contadores, que saem dos mesmos contatos.
const COUNTER_FIELDS = Object.freeze([
  'sentCount', 'failedCount',
  'deliveredCount', 'readCount', 'repliedCount', 'classifiedCount', 'positiveCount',
  'negativeCount', 'neutralCount', 'qualifiedCount', 'demoRequestedCount', 'optOutCount',
  'firstResponseTimeAverageMs', 'firstResponseTimeMedianMs'
]);

export const syncCampaignCounters = async ({ tenantId, campaignId }) => {
  if (!tenantId || !campaignId) return null;
  const items = await adapter.findMany(COLLECTIONS.campaignItems, {
    query: { tenantId, campaignId },
    projection: { _id: 0 },
    limit: 100000
  });
  if (!items.length) return null;
  const agregado = aggregateCampaignItems(items);
  const contadores = Object.fromEntries(COUNTER_FIELDS.map((field) => [field, agregado[field]]));
  await adapter.updateOne(COLLECTIONS.campaigns, { tenantId, id: campaignId }, {
    $set: { ...contadores, countersUpdatedAt: nowIso(), updatedAt: nowIso() }
  });
  return contadores;
};

const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
};

export const calculateCampaignMetrics = async ({ tenantId, campaignId }) => {
  const campaign = await adapter.findOne(COLLECTIONS.campaigns, { tenantId, id: campaignId }, { projection: { _id: 0, items: 0 } });
  if (!campaign) return null;
  if (!envFlag('OUTREACH_METRICS_V2_ENABLED', true)) {
    const total = Number(campaign.totalContacts || 0);
    const sentCount = Number(campaign.sentCount ?? campaign.successCount ?? 0);
    const deliveredCount = Number(campaign.deliveredCount || 0);
    const readCount = Number(campaign.readCount || 0);
    const repliedCount = Number(campaign.repliedCount || 0);
    const positiveCount = Number(campaign.positiveCount || 0);
    const qualifiedCount = Number(campaign.qualifiedCount || 0);
    const rate = (value, base) => base ? Number(((value / base) * 100).toFixed(2)) : 0;
    return {
      tenantId, campaignId, timezone: campaign.timezone || 'America/Sao_Paulo',
      totalContacts: total, scheduledCount: Number(campaign.scheduledCount || 0), sentCount,
      deliveredCount, readCount, repliedCount,
      classifiedCount: Number(campaign.classifiedCount || 0), positiveCount,
      negativeCount: Number(campaign.negativeCount || 0), neutralCount: Number(campaign.neutralCount || 0),
      qualifiedCount, demoRequestedCount: Number(campaign.demoRequestedCount || 0),
      optOutCount: Number(campaign.optOutCount || 0), failedCount: Number(campaign.failedCount || 0),
      deliveryRate: rate(deliveredCount, sentCount), readRate: rate(readCount, deliveredCount || sentCount),
      replyRate: rate(repliedCount, sentCount), positiveReplyRate: rate(positiveCount, repliedCount),
      qualificationRate: rate(qualifiedCount, repliedCount),
      firstResponseTimeAverageMs: Number(campaign.firstResponseTimeAverageMs || 0),
      firstResponseTimeMedianMs: Number(campaign.firstResponseTimeMedianMs || 0),
      source: 'legacy_aggregate', generatedAt: nowIso()
    };
  }
  const items = await adapter.findMany(COLLECTIONS.campaignItems, {
    query: { tenantId, campaignId },
    projection: { _id: 0 },
    limit: 100000
  });
  const contadores = aggregateCampaignItems(items);
  const total = items.length || Number(campaign.totalContacts || 0);
  const { sentCount, deliveredCount, readCount, repliedCount, positiveCount, qualifiedCount } = contadores;
  const rate = (value, base = total) => base ? Number(((value / base) * 100).toFixed(2)) : 0;
  return {
    tenantId,
    campaignId,
    timezone: campaign.timezone || 'America/Sao_Paulo',
    totalContacts: total,
    scheduledCount: items.filter((item) => item.status === 'scheduled').length,
    ...contadores,
    deliveryRate: rate(deliveredCount, sentCount),
    readRate: rate(readCount, deliveredCount || sentCount),
    replyRate: rate(repliedCount, sentCount),
    positiveReplyRate: rate(positiveCount, repliedCount),
    qualificationRate: rate(qualifiedCount, repliedCount),
    generatedAt: nowIso()
  };
};
