import adapter from '../../db/DatabaseAdapter.js';
import { redisDelete, redisGetJson, redisSetJson } from './redisClient.js';

const DEFAULT_INACTIVITY_HOURS = Number(process.env.GLOBAL_INACTIVITY_HOURS || 8);
const DEFAULT_INACTIVITY_MESSAGE = String(
  process.env.GLOBAL_INACTIVITY_MESSAGE || 'Atendimento encerrado por inatividade.'
).trim();
const DEFAULT_TIMEZONE = String(
  process.env.DEFAULT_TIMEZONE || process.env.TZ || 'America/Sao_Paulo'
).trim() || 'America/Sao_Paulo';

const DEFAULT_SETTINGS = {
  agentViewVars: [],
  inactivityMaxHours: Number.isFinite(DEFAULT_INACTIVITY_HOURS) ? DEFAULT_INACTIVITY_HOURS : 8,
  inactivityMessage: DEFAULT_INACTIVITY_MESSAGE || 'Atendimento encerrado por inatividade.',
  timezone: DEFAULT_TIMEZONE,
  disengageThresholdMinutes: 30,
  // LGPD retention: dias após o fechamento do chat para apagar o registro e
  // seus eventos. 0 ou null = retenção indefinida (default). Aplicado pelo
  // worker dataRetention; alterações tomam efeito no próximo ciclo.
  chatRetentionDays: 0,
  logRetentionDays: 30,
  mediaRetentionDays: 0,
  aiClassificationEnabled: true,
  // Quando true, o cliente nao recebe "O agente X assumiu o atendimento." ao
  // ter o chat assumido. Default false = comportamento historico (envia).
  silentPickup: false
};

const TENANT_SETTINGS_TTL_SECONDS = Math.max(
  5,
  Math.ceil(Number(process.env.TENANT_SETTINGS_CACHE_TTL_MS || 60000) / 1000)
);
const settingsCache = new Map();

const settingsKey = (tenantId) => `tenantSettings:${tenantId}`;
const isFresh = (entry) => Boolean(entry?.at) && Date.now() - entry.at < TENANT_SETTINGS_TTL_SECONDS * 1000;

const normalizeDisengageThreshold = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.disengageThresholdMinutes;
  if (numeric < 0) return 0;
  return numeric;
};

const normalizeRetentionDays = (value) => {
  if (value === null || value === undefined || value === '') return DEFAULT_SETTINGS.chatRetentionDays;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_SETTINGS.chatRetentionDays;
  // Limite alto pra evitar overflow acidental (50 anos)
  return Math.min(Math.floor(numeric), 365 * 50);
};

const normalizeList = (list) => {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => String(item || '').trim())
    .filter((item) => item.length);
};

const normalizeInactivityHours = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.inactivityMaxHours;
  if (numeric < 0) return 0;
  return numeric;
};

const normalizeInactivityMessage = (value) => {
  const text = String(value || '').trim();
  return text || DEFAULT_SETTINGS.inactivityMessage;
};

const normalizeTimezone = (value) => {
  const timeZone = String(value || '').trim() || DEFAULT_SETTINGS.timezone;
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_SETTINGS.timezone;
  }
};

export const getTenantSettings = async (tenantId) => {
  if (!tenantId) return { ...DEFAULT_SETTINGS, tenantId: null };
  const memoryEntry = settingsCache.get(tenantId);
  if (memoryEntry && isFresh(memoryEntry)) return memoryEntry.value;

  const redisKey = settingsKey(tenantId);
  const redisValue = await redisGetJson(redisKey);
  if (redisValue !== undefined && redisValue !== null) {
    settingsCache.set(tenantId, { value: redisValue, at: Date.now() });
    return redisValue;
  }

  const stored = await adapter.findOne('tenantSettings', { tenantId }, { projection: { _id: 0 } });
  const normalized = {
    tenantId,
    ...DEFAULT_SETTINGS,
    ...(stored || {}),
    agentViewVars: normalizeList(stored?.agentViewVars || []),
    inactivityMaxHours: normalizeInactivityHours(stored?.inactivityMaxHours),
    inactivityMessage: normalizeInactivityMessage(stored?.inactivityMessage),
    timezone: normalizeTimezone(stored?.timezone),
    disengageThresholdMinutes: normalizeDisengageThreshold(stored?.disengageThresholdMinutes),
    chatRetentionDays: normalizeRetentionDays(stored?.chatRetentionDays),
    logRetentionDays: normalizeRetentionDays(stored?.logRetentionDays ?? 30),
    mediaRetentionDays: normalizeRetentionDays(stored?.mediaRetentionDays),
    aiClassificationEnabled: stored?.aiClassificationEnabled !== false,
    silentPickup: stored?.silentPickup === true
  };
  settingsCache.set(tenantId, { value: normalized, at: Date.now() });
  redisSetJson(redisKey, normalized, TENANT_SETTINGS_TTL_SECONDS).catch(() => null);
  return normalized;
};

export const saveTenantSettings = async (tenantId, payload) => {
  if (!tenantId) return null;
  const all = await adapter.getCollection('tenantSettings');
  const now = new Date().toISOString();
  const index = all.findIndex((settings) => settings.tenantId === tenantId);
  const current = index === -1 ? null : all[index];
  const next = {
    agentViewVars: payload?.agentViewVars !== undefined
      ? normalizeList(payload.agentViewVars)
      : normalizeList(current?.agentViewVars || []),
    inactivityMaxHours: payload?.inactivityMaxHours !== undefined
      ? normalizeInactivityHours(payload.inactivityMaxHours)
      : normalizeInactivityHours(current?.inactivityMaxHours),
    inactivityMessage: payload?.inactivityMessage !== undefined
      ? normalizeInactivityMessage(payload.inactivityMessage)
      : normalizeInactivityMessage(current?.inactivityMessage),
    timezone: payload?.timezone !== undefined
      ? normalizeTimezone(payload.timezone)
      : normalizeTimezone(current?.timezone),
    disengageThresholdMinutes: payload?.disengageThresholdMinutes !== undefined
      ? normalizeDisengageThreshold(payload.disengageThresholdMinutes)
      : normalizeDisengageThreshold(current?.disengageThresholdMinutes),
    chatRetentionDays: payload?.chatRetentionDays !== undefined
      ? normalizeRetentionDays(payload.chatRetentionDays)
      : normalizeRetentionDays(current?.chatRetentionDays),
    logRetentionDays: payload?.logRetentionDays !== undefined
      ? normalizeRetentionDays(payload.logRetentionDays)
      : normalizeRetentionDays(current?.logRetentionDays ?? 30),
    mediaRetentionDays: payload?.mediaRetentionDays !== undefined
      ? normalizeRetentionDays(payload.mediaRetentionDays)
      : normalizeRetentionDays(current?.mediaRetentionDays),
    aiClassificationEnabled: payload?.aiClassificationEnabled !== undefined
      ? payload.aiClassificationEnabled !== false
      : current?.aiClassificationEnabled !== false,
    silentPickup: payload?.silentPickup !== undefined
      ? payload.silentPickup === true
      : current?.silentPickup === true,
    updatedAt: now
  };

  if (index === -1) {
    all.push({
      id: `settings_${tenantId}`,
      tenantId,
      ...next,
      createdAt: now
    });
  } else {
    all[index] = {
      ...all[index],
      ...next,
      updatedAt: now
    };
  }

  await adapter.saveCollection('tenantSettings', all);
  settingsCache.delete(tenantId);
  redisDelete(settingsKey(tenantId)).catch(() => null);
  return getTenantSettings(tenantId);
};
