import crypto from 'crypto';
import { generateId } from '../utils/helpers.js';

export const COLLECTIONS = Object.freeze({
  campaigns: 'outreachCampaigns',
  campaignItems: 'outreachCampaignItems',
  outreachHistory: 'contactOutreachHistory',
  classifications: 'messageClassifications',
  cadences: 'cadences',
  cadenceExecutions: 'cadenceExecutions',
  suppression: 'contactSuppression',
  outbox: 'integrationOutbox',
  metricEvents: 'outreachMetricEvents',
  attendanceRoutingProfiles: 'attendanceRoutingProfiles',
  attendanceRoutingDecisions: 'attendanceRoutingDecisions'
});

export const CAMPAIGN_STATUSES = Object.freeze([
  'draft', 'scheduled', 'pending', 'processing', 'paused', 'completed',
  'completed_with_errors', 'cancelled', 'failed'
]);

export const ITEM_STATUSES = Object.freeze([
  'pending', 'scheduled', 'sending', 'sent', 'delivered', 'read', 'replied',
  'classified', 'qualified', 'opted_out', 'suppressed', 'failed', 'cancelled'
]);

export const INTENTS = Object.freeze([
  'sem_resposta', 'resposta_automatica', 'positivo', 'interessado_depois',
  'pediu_preco', 'pediu_demo', 'pediu_proposta', 'objecao_preco',
  'objecao_tempo', 'ja_possui_sistema', 'nao_decisor', 'encaminhou_decisor',
  'duvida', 'negativo', 'opt_out', 'numero_invalido', 'fora_de_contexto',
  'revisao_humana'
]);

export const SENTIMENTS = Object.freeze(['positive', 'neutral', 'negative', 'unknown']);
export const NEXT_ACTIONS = Object.freeze([
  'notify_sales', 'create_task', 'schedule_follow_up', 'send_automatic_reply',
  'request_human_review', 'stop_cadence', 'suppress_contact', 'do_nothing'
]);

export const nowIso = () => new Date().toISOString();

export const stableHash = (value) => crypto
  .createHash('sha256')
  .update(String(value ?? ''))
  .digest('hex');

export const createDomainId = (prefix) => generateId(prefix);

export const normalizeIdentifier = (value) => String(value || '').replace(/\D/g, '');

export const clampConfidence = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
};

export const sanitizeIntegrationError = (error) => ({
  message: String(error?.message || 'integration_error').slice(0, 500),
  code: String(error?.code || error?.status || error?.response?.status || 'unknown').slice(0, 80),
  retryable: error?.retryable !== false
});

export const pageFromQuery = (query = {}, { defaultLimit = 25, maxLimit = 100 } = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};
