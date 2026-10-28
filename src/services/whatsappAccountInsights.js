import adapter from '../../db/DatabaseAdapter.js';
import { getAllWhatsAppConfigs, getWhatsAppConfig } from './channelConfig.js';
import { withLock } from './chatLocks.js';
import { envFlag, envInt } from '../utils/env.js';
import { diffInsightsToAlerts, recordAccountAlerts } from './whatsappAccountAlerts.js';
import { enforceOutreachQualityFromInsights } from './outreachQualityGuard.js';

/**
 * Retrato da conta WhatsApp do tenant para o dashboard: numero, conta,
 * templates, mensagens e custo dos ultimos 30 dias.
 *
 * Tudo sai da Graph API com o token do proprio canal (Embedded Signup ou
 * manual). O retrato fica salvo: o dashboard le dali, e cada retrato novo e
 * comparado com o anterior para gerar alertas mesmo sem webhook de conta.
 */

export const ACCOUNT_SNAPSHOTS_COLLECTION = 'whatsappAccountSnapshots';
export const INSIGHTS_DAYS = 30;

// pricing_analytics e template_analytics foram conferidos na v24.0 com a conta
// real. Nao herda WHATSAPP_GRAPH_VERSION, que nos outros modulos cai em v21.0.
const GRAPH_VERSION = process.env.WHATSAPP_INSIGHTS_GRAPH_VERSION || 'v24.0';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_AGE_MS = 15 * 60 * 1000;
// "Atualizar" apertado varias vezes seguidas nao vira uma rajada na Meta.
const MIN_REFRESH_MS = 60 * 1000;
const MAX_TEMPLATE_PAGES = 5;
const MAX_TEMPLATES_WITH_PERFORMANCE = 50;

const PHONE_FIELDS = 'display_phone_number,verified_name,name_status,new_name_status,quality_rating,messaging_limit_tier,throughput,code_verification_status,platform_type,status,account_mode,health_status,is_official_business_account';
const WABA_FIELDS = 'name,currency,timezone_id,account_review_status,business_verification_status,ownership_type,health_status,owner_business_info,is_enabled_for_insights';
const TEMPLATE_FIELDS = 'id,name,status,category,language,quality_score,rejected_reason';

const DAY_MS = 24 * 60 * 60 * 1000;

const texto = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};
const maiusculo = (value) => texto(value)?.toUpperCase() || null;
const numero = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const somaDinheiro = (a, b) => Math.round((a + b) * 10000) / 10000;

/* ------------------------------ Graph API ------------------------------ */

const graphFetch = async (url, accessToken) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data?.error?.message || `Graph API respondeu ${res.status}`);
      error.graphCode = data?.error?.code ?? null;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('A Meta não respondeu a tempo.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const graphGet = (resource, accessToken, query = {}) => {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${resource}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return graphFetch(url.toString(), accessToken);
};

/* ----------------------------- normalizacao ----------------------------- */

export const buildDateRange = (days = INSIGHTS_DAYS, now = new Date()) => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const first = today - (days - 1) * DAY_MS;
  const dates = Array.from({ length: days }, (_, index) => new Date(first + index * DAY_MS).toISOString().slice(0, 10));
  return { dates, since: Math.floor(first / 1000), until: Math.floor(now.getTime() / 1000) };
};

// A Meta devolve cada dia com start em unix. O dia do ponto e a data UTC do start:
// analytics comeca 03:00Z (meia-noite em Brasilia) e template_analytics 00:00Z.
const pointDate = (start) => {
  const date = new Date(numero(start) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

const isCallingIssue = (issue) => String(issue.code || '').startsWith('138') || /\b(call|calling|sip)\b/i.test(issue.description || '');

export const normalizeHealth = (health) => {
  const entities = Array.isArray(health?.entities) ? health.entities : [];
  const issues = entities.flatMap((entity) => [
    ...(Array.isArray(entity.errors) ? entity.errors : []).map((error) => ({
      entityType: texto(entity.entity_type),
      code: error.error_code ?? null,
      description: texto(error.error_description),
      solution: texto(error.possible_solution)
    })),
    ...(Array.isArray(entity.additional_info) ? entity.additional_info : []).map((info) => ({
      entityType: texto(entity.entity_type),
      code: null,
      description: texto(info),
      solution: null
    }))
  ]).filter((issue) => issue.description)
    .map((issue) => ({ ...issue, area: isCallingIssue(issue) ? 'calling' : 'messaging' }));

  return { canSendMessage: maiusculo(health?.can_send_message), issues };
};

export const normalizePhone = (raw = {}) => {
  const health = normalizeHealth(raw.health_status);
  return {
    id: texto(raw.id),
    displayPhoneNumber: texto(raw.display_phone_number),
    verifiedName: texto(raw.verified_name),
    nameStatus: maiusculo(raw.name_status),
    newNameStatus: maiusculo(raw.new_name_status),
    qualityRating: maiusculo(raw.quality_rating || raw.quality_score?.score),
    messagingLimitTier: maiusculo(raw.messaging_limit_tier),
    throughput: maiusculo(raw.throughput?.level),
    codeVerificationStatus: maiusculo(raw.code_verification_status),
    platformType: maiusculo(raw.platform_type),
    status: maiusculo(raw.status),
    accountMode: maiusculo(raw.account_mode),
    isOfficialBusinessAccount: Boolean(raw.is_official_business_account),
    canSendMessage: health.canSendMessage,
    healthIssues: health.issues
  };
};

export const normalizeAccount = (raw = {}) => {
  const health = normalizeHealth(raw.health_status);
  return {
    id: texto(raw.id),
    name: texto(raw.name),
    currency: maiusculo(raw.currency),
    timezoneId: texto(raw.timezone_id),
    accountReviewStatus: maiusculo(raw.account_review_status),
    businessVerificationStatus: texto(raw.business_verification_status)?.toLowerCase() || null,
    ownershipType: maiusculo(raw.ownership_type),
    ownerBusinessName: texto(raw.owner_business_info?.name),
    ownerBusinessId: texto(raw.owner_business_info?.id),
    insightsEnabled: raw.is_enabled_for_insights === true,
    canSendMessage: health.canSendMessage,
    healthIssues: health.issues
  };
};

const ATTENTION_STATUSES = new Set(['REJECTED', 'PAUSED', 'DISABLED', 'FLAGGED', 'LIMIT_EXCEEDED', 'LOCKED', 'PENDING_DELETION']);

export const summarizeTemplates = (list = []) => {
  const items = list.map((t) => ({
    id: String(t.id),
    name: texto(t.name),
    language: texto(t.language),
    status: maiusculo(t.status),
    category: maiusculo(t.category),
    quality: maiusculo(t.quality_score?.score),
    rejectedReason: maiusculo(t.rejected_reason) && maiusculo(t.rejected_reason) !== 'NONE' ? maiusculo(t.rejected_reason) : null
  }));
  const contar = (key) => items.reduce((acc, item) => {
    if (item[key]) acc[item[key]] = (acc[item[key]] || 0) + 1;
    return acc;
  }, {});
  return {
    total: items.length,
    byStatus: contar('status'),
    byCategory: contar('category'),
    attention: items.filter((t) => ATTENTION_STATUSES.has(t.status) || ['RED', 'YELLOW'].includes(t.quality)),
    items
  };
};

export const summarizeMessages = (analytics, dates) => {
  const byDate = new Map(dates.map((date) => [date, { date, sent: 0, delivered: 0 }]));
  for (const point of Array.isArray(analytics?.data_points) ? analytics.data_points : []) {
    const row = byDate.get(pointDate(point.start));
    if (!row) continue;
    row.sent += numero(point.sent);
    row.delivered += numero(point.delivered);
  }
  const days = [...byDate.values()];
  return {
    days,
    sent: days.reduce((sum, day) => sum + day.sent, 0),
    delivered: days.reduce((sum, day) => sum + day.delivered, 0)
  };
};

export const summarizePricing = (pricing, dates, currency = 'USD') => {
  const points = (Array.isArray(pricing?.data) ? pricing.data : []).flatMap((block) => (Array.isArray(block?.data_points) ? block.data_points : []));
  const byDate = new Map(dates.map((date) => [date, { date, volume: 0, cost: 0 }]));
  const byCategory = new Map();
  let volume = 0;
  let cost = 0;
  let freeVolume = 0;

  for (const point of points) {
    const row = byDate.get(pointDate(point.start));
    if (!row) continue;
    const pontoVolume = numero(point.volume);
    const pontoCusto = numero(point.cost);
    row.volume += pontoVolume;
    row.cost = somaDinheiro(row.cost, pontoCusto);
    volume += pontoVolume;
    cost = somaDinheiro(cost, pontoCusto);
    if (String(point.pricing_type || '').toUpperCase().startsWith('FREE')) freeVolume += pontoVolume;

    const categoria = maiusculo(point.pricing_category) || 'OUTROS';
    const atual = byCategory.get(categoria) || { category: categoria, volume: 0, cost: 0 };
    atual.volume += pontoVolume;
    atual.cost = somaDinheiro(atual.cost, pontoCusto);
    byCategory.set(categoria, atual);
  }

  return {
    currency: maiusculo(currency) || 'USD',
    days: [...byDate.values()],
    categories: [...byCategory.values()].sort((a, b) => b.volume - a.volume),
    volume,
    cost,
    freeVolume,
    paidVolume: volume - freeVolume
  };
};

const somaCliques = (clicked) => (Array.isArray(clicked)
  ? clicked.reduce((sum, item) => sum + numero(item?.count), 0)
  : numero(clicked));

export const summarizeTemplatePerformance = (responses = [], templates = []) => {
  const nomes = new Map(templates.map((t) => [t.id, t]));
  const porTemplate = new Map();
  for (const response of responses) {
    for (const block of Array.isArray(response?.data) ? response.data : []) {
      for (const point of Array.isArray(block?.data_points) ? block.data_points : []) {
        const id = String(point.template_id || '');
        if (!id) continue;
        const atual = porTemplate.get(id) || { id, sent: 0, delivered: 0, read: 0, clicked: 0 };
        atual.sent += numero(point.sent);
        atual.delivered += numero(point.delivered);
        atual.read += numero(point.read);
        atual.clicked += somaCliques(point.clicked);
        porTemplate.set(id, atual);
      }
    }
  }
  return [...porTemplate.values()]
    .filter((t) => t.sent > 0)
    .map((t) => ({
      ...t,
      name: nomes.get(t.id)?.name || t.id,
      category: nomes.get(t.id)?.category || null,
      readRate: t.delivered ? Math.round((t.read / t.delivered) * 1000) / 1000 : null
    }))
    .sort((a, b) => b.sent - a.sent);
};

/* ------------------------------- coleta ------------------------------- */

const listTemplates = async (wabaId, accessToken) => {
  let page = await graphGet(`${wabaId}/message_templates`, accessToken, { fields: TEMPLATE_FIELDS, limit: 100 });
  const all = [...(page.data || [])];
  for (let i = 1; i < MAX_TEMPLATE_PAGES && page?.paging?.next; i += 1) {
    page = await graphFetch(page.paging.next, accessToken);
    all.push(...(page.data || []));
  }
  return all;
};

const mensagemDeErro = (reason) => String(reason?.message || reason || 'Falha ao consultar a Meta').slice(0, 300);

export const fetchAccountInsights = async ({ accessToken, wabaId, phoneNumberId, now = new Date() }) => {
  const range = buildDateRange(INSIGHTS_DAYS, now);
  const janela = `start(${range.since}).end(${range.until})`;

  const [phoneR, wabaR, templatesR, messagesR, pricingR] = await Promise.allSettled([
    phoneNumberId ? graphGet(phoneNumberId, accessToken, { fields: PHONE_FIELDS }) : Promise.reject(new Error('Nenhum número configurado no canal.')),
    graphGet(wabaId, accessToken, { fields: WABA_FIELDS }),
    listTemplates(wabaId, accessToken),
    graphGet(wabaId, accessToken, { fields: `analytics.${janela}.granularity(DAY)` }),
    graphGet(wabaId, accessToken, { fields: `pricing_analytics.${janela}.granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])` })
  ]);

  const errors = {};
  const pick = (result, section, map) => {
    if (result.status === 'fulfilled') return map(result.value);
    errors[section] = mensagemDeErro(result.reason);
    return null;
  };

  const phone = pick(phoneR, 'phone', normalizePhone);
  const account = pick(wabaR, 'account', normalizeAccount);
  const templates = pick(templatesR, 'templates', summarizeTemplates);
  const messages = pick(messagesR, 'messages', (data) => summarizeMessages(data?.analytics, range.dates));
  const pricing = pick(pricingR, 'pricing', (data) => summarizePricing(data?.pricing_analytics, range.dates, account?.currency));

  let templatePerformance = null;
  const aprovados = (templates?.items || []).filter((t) => t.status === 'APPROVED').slice(0, MAX_TEMPLATES_WITH_PERFORMANCE);
  if (aprovados.length) {
    const lotes = [];
    for (let i = 0; i < aprovados.length; i += 10) lotes.push(aprovados.slice(i, i + 10).map((t) => t.id));
    const respostas = await Promise.allSettled(lotes.map((ids) => graphGet(`${wabaId}/template_analytics`, accessToken, {
      start: range.since,
      end: range.until,
      granularity: 'DAILY',
      template_ids: JSON.stringify(ids),
      metric_types: JSON.stringify(['SENT', 'DELIVERED', 'READ', 'CLICKED'])
    })));
    const ok = respostas.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (ok.length) templatePerformance = summarizeTemplatePerformance(ok, templates.items);
    const falha = respostas.find((r) => r.status === 'rejected');
    if (falha) errors.templatePerformance = mensagemDeErro(falha.reason);
  } else if (templates) {
    templatePerformance = [];
  }

  return {
    version: 1,
    fetchedAt: now.toISOString(),
    range: { days: INSIGHTS_DAYS, from: range.dates[0], to: range.dates.at(-1) },
    phone,
    account,
    templates,
    messages,
    pricing,
    templatePerformance,
    errors
  };
};

/* --------------------------- retrato salvo --------------------------- */

const SECTIONS = ['phone', 'account', 'templates', 'messages', 'pricing', 'templatePerformance'];

export const snapshotId = (tenantId) => `wa_insights_${tenantId}`;

export const getAccountInsights = async (tenantId, { refresh = false, now = new Date() } = {}) => {
  if (!tenantId) return { connected: false, reason: 'missing_tenant' };

  return withLock(`wa-insights:${tenantId}`, async () => {
    const config = await getWhatsAppConfig(tenantId);
    if (!config?.accessToken || !config?.wabaId) {
      return { connected: false, reason: 'missing_credentials' };
    }

    const previous = await adapter.getDocument(ACCOUNT_SNAPSHOTS_COLLECTION, { id: snapshotId(tenantId) });
    const mesmaConta = previous
      && previous.wabaId === config.wabaId
      && (previous.phoneNumberId || null) === (config.phoneNumberId || null);
    const idade = previous?.fetchedAt ? now.getTime() - Date.parse(previous.fetchedAt) : Infinity;

    if (mesmaConta && idade < (refresh ? MIN_REFRESH_MS : MAX_AGE_MS)) {
      return { connected: true, cached: true, fetchedAt: previous.fetchedAt, insights: previous.insights };
    }

    const fresh = await fetchAccountInsights({
      accessToken: config.accessToken,
      wabaId: config.wabaId,
      phoneNumberId: config.phoneNumberId,
      now
    });

    // Secao que falhou agora mantem o ultimo valor bom: uma queda momentanea da
    // Meta nao some com o dashboard nem gera alerta falso na proxima comparacao.
    const insights = { ...fresh };
    if (mesmaConta && previous.insights) {
      for (const section of SECTIONS) {
        if (insights[section] === null && previous.insights[section]) {
          insights[section] = previous.insights[section];
        }
      }
    }

    let alerts = [];
    if (mesmaConta && previous.insights) {
      const candidatos = diffInsightsToAlerts(previous.insights, insights, { wabaId: config.wabaId });
      alerts = await recordAccountAlerts(tenantId, candidatos, { source: 'sync', now });
    }

    await adapter.saveDocument(ACCOUNT_SNAPSHOTS_COLLECTION, {
      id: snapshotId(tenantId),
      tenantId,
      wabaId: config.wabaId,
      phoneNumberId: config.phoneNumberId || null,
      fetchedAt: fresh.fetchedAt,
      insights
    });

    // Qualidade caiu: campanhas em andamento param antes do proximo envio.
    await enforceOutreachQualityFromInsights(tenantId, insights).catch((error) => {
      console.warn('[OUTREACH_QUALITY] Falha ao pausar campanhas pelo sync', { tenantId, error: error?.message || error });
    });

    return { connected: true, cached: false, fetchedAt: fresh.fetchedAt, insights, newAlerts: alerts.length };
  });
};

/* ---------------------------- sync periodico ---------------------------- */

let syncTimer = null;
let syncRunning = false;

export const runWhatsAppInsightsSync = async () => {
  if (syncRunning) return { skipped: true };
  syncRunning = true;
  const result = { tenants: 0, failed: 0, alerts: 0 };
  try {
    const configs = await getAllWhatsAppConfigs();
    const tenants = [...new Set(configs
      .filter((entry) => entry.whatsapp?.accessToken && entry.whatsapp?.wabaId)
      .map((entry) => entry.tenantId))];
    for (const tenantId of tenants) {
      try {
        const snapshot = await getAccountInsights(tenantId, { refresh: true });
        result.tenants += 1;
        result.alerts += snapshot.newAlerts || 0;
      } catch (error) {
        result.failed += 1;
        console.warn('[WHATSAPP_INSIGHTS] Falha ao sincronizar tenant', { tenantId, error: error?.message || error });
      }
    }
  } finally {
    syncRunning = false;
  }
  return result;
};

export const startWhatsAppInsightsSync = () => {
  if (syncTimer) return;
  if (!envFlag('WHATSAPP_INSIGHTS_SYNC_ENABLED', true)) {
    console.log('[WHATSAPP_INSIGHTS] Desligado por configuracao');
    return;
  }
  const intervalMs = envInt('WHATSAPP_INSIGHTS_SYNC_INTERVAL_MIN', 60, { min: 15, max: 1440 }) * 60 * 1000;
  const tick = () => runWhatsAppInsightsSync().catch((error) => {
    console.warn('[WHATSAPP_INSIGHTS] Erro no sync:', error?.message || error);
  });
  syncTimer = setInterval(tick, intervalMs);
  syncTimer.unref?.();
  // Primeira rodada alguns minutos depois do boot, fora do pico de reconexao.
  setTimeout(tick, 2 * 60 * 1000).unref?.();
  console.log(`[WHATSAPP_INSIGHTS] Sync ativo a cada ${intervalMs / 60000} min`);
};
