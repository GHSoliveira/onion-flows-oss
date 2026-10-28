import adapter from '../../db/DatabaseAdapter.js';
import { createLog, getIo } from './logs.js';
import { COLLECTIONS, nowIso } from './outreachDomain.js';
import { ACCOUNT_SNAPSHOTS_COLLECTION, snapshotId } from './whatsappAccountInsights.js';
import {
  buildHealthAlert,
  buildPhoneQualityAlert,
  buildTemplateQualityAlert,
  buildTemplateStatusAlert,
  recordAccountAlert
} from './whatsappAccountAlerts.js';

// Pausa automatica do disparo quando a Meta sinaliza queda de qualidade.
// Mandar mais template para quem ja esta bloqueando derruba o numero de vez:
// a campanha para sozinha e so volta quando alguem retomar ciente do motivo.
//
// Cada sinal usa a mesma dedupKey do alerta da conta. A campanha guarda em
// qualityAck os sinais que a pessoa ja viu ao retomar; so um sinal novo (ou
// pior, ex.: media -> baixa) pausa de novo.

const ACTIVE_CAMPAIGN_STATUSES = ['pending', 'processing', 'scheduled'];
const TEMPLATE_BLOCKING_STATUS = /:status:(PAUSED|DISABLED|FLAGGED)$/;

// Numero LIMITED nao entra: e o estado normal enquanto o nome de exibicao nao
// e aprovado, e a propria Meta ja segura o volume. BLOCKED faz todo envio falhar.
export const qualitySignalFromAlert = (alert) => {
  if (!alert?.dedupKey) return null;
  const { kind, severity, dedupKey } = alert;
  const ruim = severity === 'warning' || severity === 'critical';
  let pausa = false;
  switch (kind) {
    case 'phone_quality':
    case 'template_quality':
      pausa = ruim;
      break;
    case 'phone_limit':
    case 'account_ban':
      pausa = severity === 'critical';
      break;
    case 'send_health':
      pausa = /:BLOCKED$/.test(dedupKey);
      break;
    case 'account_restriction':
    case 'account_policy':
      pausa = true;
      break;
    case 'template_status':
      pausa = TEMPLATE_BLOCKING_STATUS.test(dedupKey);
      break;
    default:
      pausa = false;
  }
  if (!pausa) return null;
  const metaTemplateId = alert.entity?.type === 'template' ? String(alert.entity.id) : null;
  return {
    key: dedupKey,
    scope: metaTemplateId ? 'template' : 'tenant',
    metaTemplateId,
    title: alert.title,
    message: alert.message
  };
};

const digitos = (value) => String(value || '').replace(/\D/g, '');

// Estado atual guardado no ultimo retrato da conta, nos mesmos termos do alerta.
export const qualitySignalsFromInsights = (insights) => {
  if (!insights) return [];
  const alerts = [];
  const phone = insights.phone;
  if (phone) {
    const numero = phone.displayPhoneNumber || phone.id;
    alerts.push(buildPhoneQualityAlert({ phone: numero, previous: null, next: phone.qualityRating }));
    alerts.push(buildHealthAlert({ entityType: 'phone', entityId: digitos(numero), previous: null, next: phone.canSendMessage, issues: phone.healthIssues || [] }));
  }
  if (insights.account?.id) {
    alerts.push(buildHealthAlert({ entityType: 'waba', entityId: insights.account.id, previous: null, next: insights.account.canSendMessage, issues: insights.account.healthIssues || [] }));
  }
  for (const template of insights.templates?.items || []) {
    alerts.push(buildTemplateQualityAlert({ id: template.id, name: template.name, language: template.language, previous: null, next: template.quality }));
    alerts.push(buildTemplateStatusAlert({ id: template.id, name: template.name, language: template.language, status: template.status }));
  }
  return uniqueSignals(alerts.map(qualitySignalFromAlert));
};

const uniqueSignals = (signals) => {
  const vistos = new Map();
  for (const signal of signals) {
    if (signal && !vistos.has(signal.key)) vistos.set(signal.key, signal);
  }
  return [...vistos.values()];
};

// Templates que a campanha pode enviar: o principal e os passos da cadencia.
const campaignMetaTemplateIds = async (campaign, extraTemplateIds = []) => {
  const ids = new Set([campaign.templateId, ...extraTemplateIds].filter(Boolean).map(String));
  if (campaign.cadenceId) {
    const cadence = await adapter.findOne(COLLECTIONS.cadences, { tenantId: campaign.tenantId, id: campaign.cadenceId });
    for (const step of cadence?.steps || []) {
      if (step?.templateId) ids.add(String(step.templateId));
    }
  }
  if (!ids.size) return new Set();
  const templates = await adapter.findMany('whatsappTemplates', {
    query: { tenantId: campaign.tenantId, id: { $in: [...ids] } },
    limit: 500
  });
  return new Set(templates.map((template) => String(template.metaTemplateId || '')).filter(Boolean));
};

const relevantSignals = (signals, metaTemplateIds) => signals.filter((signal) => (
  signal.scope === 'tenant' || metaTemplateIds.has(signal.metaTemplateId)
));

const readSnapshotSignals = async (tenantId) => {
  const snapshot = await adapter.getDocument(ACCOUNT_SNAPSHOTS_COLLECTION, { id: snapshotId(tenantId) });
  return qualitySignalsFromInsights(snapshot?.insights);
};

export const pauseCampaignForQuality = async (campaign, signals, { source = 'send_check' } = {}) => {
  const ack = new Set(campaign.qualityAck || []);
  const novos = uniqueSignals(signals).filter((signal) => !ack.has(signal.key));
  if (!novos.length) return null;

  // Relê: outra pausa (manual ou do webhook) pode ter chegado antes.
  const atual = await adapter.findOne(COLLECTIONS.campaigns, { tenantId: campaign.tenantId, id: campaign.id });
  if (!atual || !ACTIVE_CAMPAIGN_STATUSES.includes(atual.status)) return null;

  const at = nowIso();
  const qualityPause = {
    pausedAt: at,
    source,
    reasons: novos.map(({ key, scope, title, message }) => ({ key, scope, title, message }))
  };
  await adapter.updateOne(COLLECTIONS.campaigns, { tenantId: atual.tenantId, id: atual.id }, {
    $set: { status: 'paused', qualityPause, updatedAt: at }
  });

  const executions = await adapter.findMany(COLLECTIONS.cadenceExecutions, {
    query: { tenantId: atual.tenantId, campaignId: atual.id, status: { $in: ['scheduled', 'waiting'] } },
    limit: 100000
  });
  for (const execution of executions) {
    await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: execution.id }, {
      $set: { status: 'paused', stopReason: 'quality_guard', updatedAt: at }
    });
  }

  const pausada = { ...atual, status: 'paused', qualityPause, updatedAt: at };
  try {
    getIo()?.to(`tenant:${atual.tenantId}`).emit('campaign_update', { campaign: pausada });
  } catch (_) {}
  try {
    await createLog('OUTREACH_CAMPAIGN_QUALITY_PAUSE', {
      tenantId: atual.tenantId,
      campaignId: atual.id,
      source,
      reasons: novos.map((signal) => signal.key)
    }, 'system');
  } catch (_) {}
  const motivos = novos.map((signal) => signal.title).join('; ');
  await recordAccountAlert(atual.tenantId, {
    kind: 'outreach_quality_pause',
    severity: 'critical',
    title: 'Campanha pausada pela qualidade',
    message: `A campanha "${atual.name || atual.id}" foi pausada automaticamente: ${motivos}. Revise a mensagem e o público antes de retomar.`,
    entity: { type: 'campaign', id: String(atual.id), name: atual.name || null },
    dedupKey: `campaign:${atual.id}:quality_pause:${novos.map((signal) => signal.key).sort().join('|')}`
  }, { source }).catch(() => null);

  return pausada;
};

// Antes de cada envio: confere o ultimo retrato da conta. Sinais que ja sumiram
// saem do qualityAck, para que voltarem a aparecer pause de novo.
export const checkCampaignQuality = async (campaign, { extraTemplateIds = [] } = {}) => {
  if (!campaign?.tenantId || !campaign?.id) return null;
  const signals = await readSnapshotSignals(campaign.tenantId);

  const ack = Array.isArray(campaign.qualityAck) ? campaign.qualityAck : [];
  if (ack.length) {
    const presentes = new Set(signals.map((signal) => signal.key));
    const mantidos = ack.filter((key) => presentes.has(key));
    if (mantidos.length !== ack.length) {
      await adapter.updateOne(COLLECTIONS.campaigns, { tenantId: campaign.tenantId, id: campaign.id }, { $set: { qualityAck: mantidos } });
      campaign = { ...campaign, qualityAck: mantidos };
    }
  }

  if (!signals.length) return null;
  const metaTemplateIds = await campaignMetaTemplateIds(campaign, extraTemplateIds);
  return pauseCampaignForQuality(campaign, relevantSignals(signals, metaTemplateIds), { source: 'send_check' });
};

// Chamado quando chega um alerta (webhook) ou um retrato novo (sync).
export const enforceOutreachQuality = async (tenantId, signals, { source = 'webhook' } = {}) => {
  const lista = uniqueSignals(signals || []);
  if (!tenantId || !lista.length) return [];
  const campaigns = await adapter.findMany(COLLECTIONS.campaigns, {
    query: { tenantId, status: { $in: ACTIVE_CAMPAIGN_STATUSES } },
    limit: 1000
  });
  const pausadas = [];
  for (const campaign of campaigns) {
    const metaTemplateIds = await campaignMetaTemplateIds(campaign);
    const pausada = await pauseCampaignForQuality(campaign, relevantSignals(lista, metaTemplateIds), { source });
    if (pausada) pausadas.push(pausada);
  }
  return pausadas;
};

export const enforceOutreachQualityFromInsights = (tenantId, insights, options = {}) => (
  enforceOutreachQuality(tenantId, qualitySignalsFromInsights(insights), { source: 'sync', ...options })
);

// Retomada: devolve os sinais ainda ativos que a pessoa precisa confirmar.
export const pendingQualitySignalsForResume = async (campaign) => {
  const signals = await readSnapshotSignals(campaign.tenantId);
  const metaTemplateIds = signals.length ? await campaignMetaTemplateIds(campaign) : new Set();
  const atuais = relevantSignals(signals, metaTemplateIds);
  return uniqueSignals([...(campaign.qualityPause?.reasons || []), ...atuais]);
};
