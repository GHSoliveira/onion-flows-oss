import adapter from '../../db/DatabaseAdapter.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { invalidateRuntimeFlowCache } from './flowRuntimeCache.js';
import { encryptString, tryDecrypt } from '../utils/crypto.js';

// Fields persisted in ciphertext when DATA_ENCRYPTION_KEYS is configured.
// Reads decrypt transparently; writes encrypt idempotently.
const TELEGRAM_SECRET_FIELDS = ['botToken', 'webhookSecret'];
// registrationPin: PIN de 6 digitos definido no registro do numero via Embedded
// Signup. E exigido de novo em qualquer novo registro do mesmo numero, entao
// precisa ser guardado, e por ser um segredo entra na lista de criptografados.
const WHATSAPP_SECRET_FIELDS = ['accessToken', 'webhookVerifyToken', 'appSecret', 'registrationPin'];

const decryptInPlace = (target, fields) => {
  if (!target) return target;
  for (const key of fields) {
    if (target[key]) target[key] = tryDecrypt(target[key]);
  }
  return target;
};

const encryptForStorage = (target, fields) => {
  if (!target) return target;
  for (const key of fields) {
    if (target[key]) target[key] = encryptString(target[key]);
  }
  return target;
};

const CACHE_TTL_MS = (() => {
  const parsed = Number.parseInt(String(process.env.CHANNEL_CONFIG_CACHE_TTL_MS || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
})();
let cacheByTenant = new Map();
let cacheAll = null;
let cacheAllAt = 0;

const isFresh = (timestamp) => timestamp && Date.now() - timestamp < CACHE_TTL_MS;

const setCacheEntry = (tenantId, config) => {
  if (!tenantId) return;
  cacheByTenant.set(tenantId, { value: config, at: Date.now() });
  cacheAll = null;
  cacheAllAt = 0;
};

const normalize = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};

const resolveSecretValue = (incoming, existing) => {
  const normalized = normalize(incoming);
  if (!normalized || normalized === '***') return normalize(existing);
  return normalized;
};

const getRecordRecency = (record) => {
  const updatedAt = Date.parse(record?.updatedAt || record?.whatsapp?.updatedAt || record?.telegram?.updatedAt || '');
  if (Number.isFinite(updatedAt)) return updatedAt;
  const createdAt = Date.parse(record?.createdAt || '');
  return Number.isFinite(createdAt) ? createdAt : 0;
};

const dedupeChannelConfigs = (records = []) => {
  const selected = new Map();

  (Array.isArray(records) ? records : []).forEach((record) => {
    const tenantId = normalize(record?.tenantId);
    if (!tenantId) return;

    const current = selected.get(tenantId);
    if (!current || getRecordRecency(record) >= getRecordRecency(current)) {
      selected.set(tenantId, record);
    }
  });

  return Array.from(selected.values());
};

const normalizeSenderNumbers = (whatsappConfig = {}) => {
  const legacyPhoneNumberId = normalize(whatsappConfig.phoneNumberId);
  const rawSenders = Array.isArray(whatsappConfig.senderNumbers) ? whatsappConfig.senderNumbers : [];

  const deduped = [];
  const seen = new Set();

  rawSenders.forEach((item, index) => {
    const phoneNumberId = normalize(item?.phoneNumberId);
    if (!phoneNumberId || seen.has(phoneNumberId)) return;
    seen.add(phoneNumberId);
    deduped.push({
      id: normalize(item?.id) || `wa_sender_${phoneNumberId}`,
      label: normalize(item?.label) || (index === 0 ? 'Principal' : `Numero ${index + 1}`),
      displayNumber: normalize(item?.displayNumber),
      phoneNumberId,
      flowId: normalize(item?.flowId),
      routeUpdatedAt: item?.routeUpdatedAt || null,
      routeUpdatedBy: item?.routeUpdatedBy || null,
      enabled: item?.enabled !== false,
      isDefault: Boolean(item?.isDefault)
    });
  });

  if (legacyPhoneNumberId && !seen.has(legacyPhoneNumberId)) {
    deduped.unshift({
      id: `wa_sender_${legacyPhoneNumberId}`,
      label: 'Principal',
      displayNumber: null,
      phoneNumberId: legacyPhoneNumberId,
      flowId: normalize(whatsappConfig.flowId),
      enabled: true,
      isDefault: true
    });
  }

  if (!deduped.length && legacyPhoneNumberId) {
    deduped.push({
      id: `wa_sender_${legacyPhoneNumberId}`,
      label: 'Principal',
      displayNumber: null,
      phoneNumberId: legacyPhoneNumberId,
      flowId: normalize(whatsappConfig.flowId),
      enabled: true,
      isDefault: true
    });
  }

  if (deduped.length > 0) {
    const preferred = deduped.find((item) => item.isDefault && item.enabled !== false)
      || deduped.find((item) => item.enabled !== false)
      || deduped[0];
    deduped.forEach((item) => {
      item.isDefault = item.phoneNumberId === preferred.phoneNumberId;
    });
  }

  return deduped;
};

const normalizeTelegramPayload = (telegram) => {
  const out = {
    ...telegram,
    botToken: normalize(telegram?.botToken),
    flowId: normalize(telegram?.flowId),
    webhookUrl: normalize(telegram?.webhookUrl),
    webhookSecret: normalize(telegram?.webhookSecret),
    usePolling: telegram?.usePolling !== false
  };
  return decryptInPlace(out, TELEGRAM_SECRET_FIELDS);
};

const normalizeWhatsAppPayload = (whatsapp) => {
  const senderNumbers = normalizeSenderNumbers(whatsapp);
  const defaultSender = senderNumbers.find((item) => item.isDefault) || senderNumbers[0] || null;

  const out = {
    ...whatsapp,
    accessToken: normalize(whatsapp?.accessToken),
    phoneNumberId: defaultSender?.phoneNumberId || normalize(whatsapp?.phoneNumberId),
    senderNumbers,
    wabaId: normalize(whatsapp?.wabaId),
    flowId: normalize(whatsapp?.flowId),
    webhookVerifyToken: normalize(whatsapp?.webhookVerifyToken),
    appSecret: normalize(whatsapp?.appSecret),
    enabled: Boolean(whatsapp?.enabled),
    updatedAt: whatsapp?.updatedAt
  };
  return decryptInPlace(out, WHATSAPP_SECRET_FIELDS);
};

const normalizeChannelConfigRecord = (record) => {
  if (!record) return null;
  return {
    ...record,
    telegram: record.telegram ? normalizeTelegramPayload(record.telegram) : null,
    whatsapp: record.whatsapp ? normalizeWhatsAppPayload(record.whatsapp) : null
  };
};

const hasValidWhatsAppSender = (whatsapp) => {
  const senders = Array.isArray(whatsapp?.senderNumbers) ? whatsapp.senderNumbers : [];
  return Boolean(
    whatsapp?.accessToken &&
    (whatsapp?.phoneNumberId || senders.some((item) => item?.enabled !== false && item?.phoneNumberId))
  );
};

const normalizeWhatsAppRoutingEntries = (entries = []) => (
  (Array.isArray(entries) ? entries : [])
    .filter((entry) => (!entry?.platform || entry.platform === 'whatsapp') && entry?.enabled !== false)
    .map((entry) => ({
      id: normalize(entry?.id),
      platform: 'whatsapp',
      flowId: normalize(entry?.flowId),
      phoneNumberId: normalize(entry?.phoneNumberId),
      senderPhoneNumberIds: [...new Set(
        (Array.isArray(entry?.senderPhoneNumberIds) ? entry.senderPhoneNumberIds : [])
          .map(normalize)
          .filter(Boolean)
      )],
      enabled: entry?.enabled !== false,
      status: normalize(entry?.status)
    }))
);

// Remetente fixado num no de fluxo. Fluxo copiado de outro tenant traz um id
// que este tenant nao conhece: nesse caso usa o remetente da conversa (ou o
// padrao) e devolve o id ignorado para log. Remetente do proprio tenant que foi
// desativado continua sem envio, porque ai a escolha foi do tenant.
export const resolveFlowNodeWhatsAppSender = (config, nodeSenderId = null, chatSenderId = null) => {
  const requested = normalize(nodeSenderId);
  if (!requested) return { sender: resolveWhatsAppSender(config, chatSenderId), ignoredSenderId: null };

  const exact = resolveWhatsAppSender(config, requested);
  if (exact || !config) return { sender: exact, ignoredSenderId: null };

  const knownByTenant = normalizeWhatsAppPayload(config).senderNumbers.some((item) => item.phoneNumberId === requested);
  if (knownByTenant) return { sender: null, ignoredSenderId: null };

  return { sender: resolveWhatsAppSender(config, chatSenderId), ignoredSenderId: requested };
};

export const resolveWhatsAppSender = (config, requestedPhoneNumberId = null) => {
  if (!config) return null;

  const normalized = normalizeWhatsAppPayload(config);
  const senders = Array.isArray(normalized.senderNumbers) ? normalized.senderNumbers : [];
  const enabledSenders = senders.filter((item) => item.enabled !== false && item.phoneNumberId);
  const requested = normalize(requestedPhoneNumberId);

  if (requested) {
    const exact = enabledSenders.find((item) => item.phoneNumberId === requested);
    if (exact) return exact;
    return null;
  }

  return enabledSenders.find((item) => item.isDefault)
    || enabledSenders[0]
    || (normalized.phoneNumberId
      ? {
        id: `wa_sender_${normalized.phoneNumberId}`,
        label: 'Principal',
        displayNumber: null,
        phoneNumberId: normalized.phoneNumberId,
        flowId: normalize(normalized.flowId),
        enabled: true,
        isDefault: true
      }
      : null);
};

export const resolveWhatsAppFlowId = (config, requestedPhoneNumberId = null) => {
  if (!config) return null;
  const requested = normalize(requestedPhoneNumberId);
  const routingEntries = normalizeWhatsAppRoutingEntries(config?.routingEntries);
  const exactEntry = requested
    ? routingEntries.find((entry) => (
      entry.phoneNumberId === requested || entry.senderPhoneNumberIds.includes(requested)
    ))
    : null;
  if (exactEntry?.flowId) return exactEntry.flowId;

  // Entries created before technical identity binding can still be resolved
  // when a single active WhatsApp route exists for the tenant.
  const routedEntries = routingEntries.filter((entry) => entry.flowId);
  if (routedEntries.length === 1) return routedEntries[0].flowId;

  const sender = resolveWhatsAppSender(config, requestedPhoneNumberId);
  return normalize(sender?.flowId) || normalize(config?.flowId) || null;
};

export const getWhatsAppMissingConfigurationFields = (config = {}) => {
  const whatsapp = config?.whatsapp || config || {};
  if (!whatsapp?.enabled) return [];

  const missing = [];
  if (!whatsapp.accessToken) missing.push('accessToken');
  if (!whatsapp.phoneNumberId && !(Array.isArray(whatsapp.senderNumbers) && whatsapp.senderNumbers.length > 0)) {
    missing.push('phoneNumberId');
  }

  const effectiveFlowId = resolveWhatsAppFlowId({
    ...whatsapp,
    routingEntries: Array.isArray(config?.entries) ? config.entries : whatsapp.routingEntries
  }, whatsapp.phoneNumberId);
  if (!effectiveFlowId) missing.push('flowId');
  if (!whatsapp.webhookVerifyToken) missing.push('webhookVerifyToken');

  return missing;
};

export const getChannelConfig = async (tenantId) => {
  if (!tenantId) return null;
  const cached = cacheByTenant.get(tenantId);
  if (cached && isFresh(cached.at)) return cached.value || null;

  const all = await adapter.findMany('channelConfigs', {
    query: { tenantId },
    sort: { updatedAt: -1, createdAt: -1 },
    limit: 5
  });
  const raw = dedupeChannelConfigs(all).find((c) => c.tenantId === tenantId) || null;
  const config = normalizeChannelConfigRecord(raw);
  setCacheEntry(tenantId, config);
  return config;
};

export const getTelegramConfig = async (tenantId) => {
  const config = await getChannelConfig(tenantId);
  if (!config || !config.telegram) return null;
  return config.telegram;
};

export const getWhatsAppConfig = async (tenantId) => {
  const config = await getChannelConfig(tenantId);
  if (!config || !config.whatsapp) return null;
  return {
    ...config.whatsapp,
    routingEntries: normalizeWhatsAppRoutingEntries(config.entries)
  };
};

const buildAllChannelsCache = async () => {
  const all = dedupeChannelConfigs(await adapter.getCollection('channelConfigs'));
  const telegram = [];
  const whatsapp = [];

  all.forEach((config) => {
    const telegramConfig = config.telegram ? normalizeTelegramPayload(config.telegram) : null;
    const whatsappConfig = config.whatsapp ? normalizeWhatsAppPayload(config.whatsapp) : null;

    if (telegramConfig?.botToken && telegramConfig.enabled) {
      telegram.push({
        tenantId: config.tenantId,
        telegram: telegramConfig
      });
    }

    if (whatsappConfig?.enabled && hasValidWhatsAppSender(whatsappConfig)) {
      whatsapp.push({
        tenantId: config.tenantId,
        whatsapp: {
          ...whatsappConfig,
          routingEntries: normalizeWhatsAppRoutingEntries(config.entries)
        }
      });
    }
  });

  cacheAll = { telegram, whatsapp };
  cacheAllAt = Date.now();
  return cacheAll;
};

export const getAllTelegramConfigs = async () => {
  if (cacheAll && isFresh(cacheAllAt)) {
    return cacheAll.telegram;
  }
  const all = await buildAllChannelsCache();
  return all.telegram;
};

export const getAllWhatsAppConfigs = async () => {
  if (cacheAll && isFresh(cacheAllAt)) {
    return cacheAll.whatsapp;
  }
  const all = await buildAllChannelsCache();
  return all.whatsapp;
};

export const findWhatsAppConfigByPhoneNumberId = async (phoneNumberId) => {
  const normalizedId = normalize(phoneNumberId);
  if (!normalizedId) return null;

  const configs = await getAllWhatsAppConfigs();
  for (const entry of configs) {
    const sender = resolveWhatsAppSender(entry.whatsapp, normalizedId);
    if (sender) {
      return {
        tenantId: entry.tenantId,
        whatsapp: entry.whatsapp,
        sender
      };
    }
  }
  return null;
};

// Todos os tenants que tem este numero no canal, inclusive com canal desligado
// ou sem token. getAllWhatsAppConfigs ignora esses, mas aqui eles contam: um
// numero parado em outro tenant volta a disputar o webhook quando for religado.
export const findWhatsAppPhoneNumberOwners = async (phoneNumberId) => {
  const normalizedId = normalize(phoneNumberId);
  if (!normalizedId) return [];

  const all = dedupeChannelConfigs(await adapter.getCollection('channelConfigs'));
  return all
    .filter((config) => config.whatsapp && normalizeSenderNumbers(config.whatsapp)
      .some((sender) => sender.phoneNumberId === normalizedId))
    .map((config) => config.tenantId);
};

// Tenants com canal WhatsApp ativo nesta WABA. Eventos de conta (qualidade,
// templates, restricoes) chegam sem phone_number_id, so com o id da WABA.
export const findWhatsAppConfigsByWabaId = async (wabaId) => {
  const normalizedId = normalize(wabaId);
  if (!normalizedId) return [];
  const configs = await getAllWhatsAppConfigs();
  return configs.filter((entry) => normalize(entry.whatsapp?.wabaId) === normalizedId);
};

export const saveTelegramConfig = async (tenantId, telegramConfig) => {
  const all = await adapter.getCollection('channelConfigs');
  const now = new Date().toISOString();
  const index = all.findIndex((config) => config.tenantId === tenantId);
  const existingTelegram = index >= 0 ? (all[index].telegram || {}) : {};
  const payload = {
    enabled: Boolean(telegramConfig.enabled),
    botToken: resolveSecretValue(telegramConfig.botToken, existingTelegram.botToken),
    flowId: normalize(telegramConfig.flowId),
    webhookUrl: normalize(telegramConfig.webhookUrl),
    webhookSecret: resolveSecretValue(telegramConfig.webhookSecret, existingTelegram.webhookSecret),
    usePolling: telegramConfig.usePolling !== false,
    updatedAt: now
  };
  encryptForStorage(payload, TELEGRAM_SECRET_FIELDS);

  if (index === -1) {
    all.push({
      id: `channels_${tenantId}`,
      tenantId,
      telegram: payload,
      createdAt: now,
      updatedAt: now
    });
  } else {
    all[index] = {
      ...all[index],
      tenantId,
      telegram: {
        ...all[index].telegram,
        ...payload
      },
      updatedAt: now
    };
  }

  await adapter.saveCollection('channelConfigs', all);
  setCacheEntry(tenantId, normalizeChannelConfigRecord(all.find((config) => config.tenantId === tenantId) || null));
  invalidateRuntimeFlowCache(tenantId);
  return payload;
};

// Desconecta o WhatsApp do tenant: tira numero, token, PIN e WABA e guarda so
// um historico sem segredo. Apaga em vez de desligar porque a trava do
// Embedded Signup tambem olha canal desligado, e o numero precisa ficar livre
// para outro tenant. Devolve o que havia para avisar a Meta depois.
export const clearWhatsAppConfig = async (tenantId, { actorId = null } = {}) => {
  if (!tenantId) throw Object.assign(new Error('tenantId obrigatorio'), { status: 400 });
  const all = await adapter.getCollection('channelConfigs');
  const now = new Date().toISOString();
  const records = all.filter((config) => config.tenantId === tenantId && config.whatsapp);

  const previous = records.map((config) => normalizeWhatsAppPayload(config.whatsapp));
  const phoneNumberIds = [...new Set(previous.flatMap((wa) => wa.senderNumbers.map((sender) => sender.phoneNumberId)))];
  const connection = previous.find((wa) => wa.accessToken && wa.wabaId) || previous.find((wa) => wa.wabaId) || previous[0] || null;
  if (!connection || (!connection.accessToken && !connection.wabaId && !phoneNumberIds.length)) {
    throw Object.assign(new Error('O WhatsApp nao esta conectado neste tenant.'), { status: 404 });
  }

  for (const config of records) {
    config.whatsapp = {
      enabled: false,
      disconnectedAt: now,
      disconnectedBy: actorId,
      lastConnection: {
        wabaId: connection.wabaId || null,
        phoneNumberIds,
        businessId: connection.businessId || null,
        onboardedVia: connection.onboardedVia || null,
        onboardedAt: connection.onboardedAt || null
      },
      updatedAt: now
    };
    config.updatedAt = now;
  }

  await adapter.saveCollection('channelConfigs', all);
  setCacheEntry(tenantId, normalizeChannelConfigRecord(dedupeChannelConfigs(all).find((config) => config.tenantId === tenantId) || null));
  invalidateRuntimeFlowCache(tenantId);
  return { accessToken: connection.accessToken || null, wabaId: connection.wabaId || null, phoneNumberIds };
};

export const saveWhatsAppConfig = async (tenantId, whatsappConfig) => {
  const all = await adapter.getCollection('channelConfigs');
  const now = new Date().toISOString();
  const index = all.findIndex((config) => config.tenantId === tenantId);
  const existingWhatsapp = index >= 0 ? (all[index].whatsapp || {}) : {};
  const normalizedIncoming = normalizeWhatsAppPayload(whatsappConfig);
  const existingSenders = normalizeSenderNumbers(existingWhatsapp);
  const findExistingSender = (sender) => existingSenders.find((item) => (
    (sender.id && item.id === sender.id) || (sender.phoneNumberId && item.phoneNumberId === sender.phoneNumberId)
  ));
  const senderNumbers = normalizedIncoming.senderNumbers.map((sender) => {
    const existingSender = findExistingSender(sender);
    return {
      ...sender,
      flowId: normalize(sender.flowId) || normalize(existingSender?.flowId)
    };
  });
  const payload = {
    enabled: Boolean(whatsappConfig.enabled),
    accessToken: resolveSecretValue(whatsappConfig.accessToken, existingWhatsapp.accessToken),
    phoneNumberId: normalizedIncoming.phoneNumberId,
    senderNumbers,
    wabaId: normalize(whatsappConfig.wabaId),
    flowId: normalize(whatsappConfig.flowId),
    webhookVerifyToken: resolveSecretValue(whatsappConfig.webhookVerifyToken, existingWhatsapp.webhookVerifyToken),
    appSecret: resolveSecretValue(whatsappConfig.appSecret, existingWhatsapp.appSecret),
    // Campos do Embedded Signup. Preservam o valor existente quando a chamada
    // vem do formulario manual, que nao os envia.
    registrationPin: resolveSecretValue(whatsappConfig.registrationPin, existingWhatsapp.registrationPin),
    onboardedVia: normalize(whatsappConfig.onboardedVia) || normalize(existingWhatsapp.onboardedVia),
    onboardedAt: normalize(whatsappConfig.onboardedAt) || normalize(existingWhatsapp.onboardedAt),
    businessId: normalize(whatsappConfig.businessId) || normalize(existingWhatsapp.businessId),
    updatedAt: now
  };
  encryptForStorage(payload, WHATSAPP_SECRET_FIELDS);

  if (index === -1) {
    all.push({
      id: `channels_${tenantId}`,
      tenantId,
      telegram: null,
      whatsapp: payload,
      createdAt: now,
      updatedAt: now
    });
  } else {
    all[index] = {
      ...all[index],
      tenantId,
      whatsapp: {
        ...all[index].whatsapp,
        ...payload
      },
      updatedAt: now
    };
  }

  await adapter.saveCollection('channelConfigs', all);
  setCacheEntry(tenantId, normalizeChannelConfigRecord(all.find((config) => config.tenantId === tenantId) || null));
  invalidateRuntimeFlowCache(tenantId);
  return payload;
};

export const updateChannelFlowRoute = async (tenantId, route = {}, actor = null) => {
  const channel = normalize(route.channel);
  const flowId = normalize(route.flowId);
  const senderId = normalize(route.senderId);
  const senderPhoneNumberId = normalize(route.senderPhoneNumberId || route.phoneNumberId);
  const entryId = normalize(route.entryId);

  if (!tenantId) {
    throw new Error('tenantId obrigatorio');
  }
  if (!['telegram', 'whatsapp', 'web'].includes(channel)) {
    const error = new Error('Canal invalido');
    error.status = 400;
    throw error;
  }

  const all = await adapter.getCollection('channelConfigs');
  const now = new Date().toISOString();
  const routeUpdatedBy = actor ? {
    id: normalize(actor.id),
    name: normalize(actor.name || actor.fullName || actor.displayName || actor.username || actor.email) || normalize(actor.id) || 'Usuario',
    role: normalize(actor.role)
  } : { id: 'system', name: 'Sistema', role: 'SYSTEM' };
  let index = all.findIndex((config) => config.tenantId === tenantId);
  if (index === -1) {
    all.push({
      id: `channels_${tenantId}`,
      tenantId,
      telegram: null,
      whatsapp: null,
      createdAt: now,
      updatedAt: now
    });
    index = all.length - 1;
  }

  const current = all[index];
  if (entryId) {
    const entries = Array.isArray(current.entries) ? current.entries : [];
    const entryIndex = entries.findIndex((entry) => entry.id === entryId);
    if (entryIndex === -1) {
      const error = new Error('Canal nao encontrado');
      error.status = 404;
      throw error;
    }
    const entry = entries[entryIndex];
    if (entry.modificationPasswordHash) {
      const passwordMatches = await bcrypt.compare(String(route.modificationPassword || ''), entry.modificationPasswordHash);
      if (!passwordMatches) {
        const error = new Error('Senha de modificacao invalida');
        error.status = 403;
        throw error;
      }
    }
    entries[entryIndex] = {
      ...entry,
      flowId,
      routeUpdatedAt: now,
      routeUpdatedBy,
      updatedAt: now,
      updatedBy: routeUpdatedBy,
      activity: [
        ...(Array.isArray(entry.activity) ? entry.activity : []),
        { id: `event_${Date.now()}`, type: 'routing', label: flowId ? 'Roteamento atualizado' : 'Roteamento padrao aplicado', at: now, actor: routeUpdatedBy }
      ].slice(-100)
    };
    current.entries = entries;
  } else if (channel === 'telegram') {
    current.telegram = {
      ...(current.telegram || {}),
      flowId,
      routeUpdatedAt: now,
      routeUpdatedBy,
      updatedAt: now
    };
  } else {
    const currentWhatsapp = current.whatsapp || {};
    const senderNumbers = normalizeSenderNumbers(currentWhatsapp);

    if (senderId || senderPhoneNumberId) {
      const nextSenders = senderNumbers.map((sender) => {
        const matches = (senderId && sender.id === senderId)
          || (senderPhoneNumberId && sender.phoneNumberId === senderPhoneNumberId);
        return matches ? { ...sender, flowId, routeUpdatedAt: now, routeUpdatedBy } : sender;
      });

      if (!nextSenders.some((sender) => (
        (senderId && sender.id === senderId) || (senderPhoneNumberId && sender.phoneNumberId === senderPhoneNumberId)
      ))) {
        const error = new Error('Numero remetente nao encontrado');
        error.status = 404;
        throw error;
      }

      current.whatsapp = {
        ...currentWhatsapp,
        senderNumbers: nextSenders,
        updatedAt: now
      };
    } else {
      current.whatsapp = {
        ...currentWhatsapp,
        flowId,
        routeUpdatedAt: now,
        routeUpdatedBy,
        updatedAt: now
      };
    }
  }

  current.updatedAt = now;
  all[index] = current;

  await adapter.saveCollection('channelConfigs', all);
  const normalized = normalizeChannelConfigRecord(current);
  setCacheEntry(tenantId, normalized);
  invalidateRuntimeFlowCache(tenantId);
  return normalized;
};

const sanitizeChannelEntry = (entry = {}) => {
  const { tokenHash, modificationPasswordHash, ...safe } = entry;
  return {
    ...safe,
    tokenConfigured: Boolean(tokenHash),
    modificationPasswordConfigured: Boolean(modificationPasswordHash)
  };
};

export const createChannelEntry = async (tenantId, input = {}, actor = null) => {
  const name = normalize(input.name);
  const platform = normalize(input.platform)?.toLowerCase();
  const seed = normalize(input.seed);
  const modificationPassword = normalize(input.modificationPassword);

  if (!tenantId) throw new Error('tenantId obrigatorio');
  if (!name || name.length < 3) {
    const error = new Error('Nome do canal deve ter ao menos 3 caracteres');
    error.status = 400;
    throw error;
  }
  if (!['web', 'whatsapp', 'telegram'].includes(platform)) {
    const error = new Error('Plataforma invalida');
    error.status = 400;
    throw error;
  }
  if (!seed || seed.length < 8) {
    const error = new Error('Seed deve ter ao menos 8 caracteres');
    error.status = 400;
    throw error;
  }

  const all = await adapter.getCollection('channelConfigs');
  const now = new Date().toISOString();
  let index = all.findIndex((config) => config.tenantId === tenantId);
  if (index === -1) {
    all.push({ id: `channels_${tenantId}`, tenantId, telegram: null, whatsapp: null, entries: [], createdAt: now, updatedAt: now });
    index = all.length - 1;
  }

  const current = all[index];
  const entries = Array.isArray(current.entries) ? current.entries : [];
  if (entries.some((entry) => String(entry.name || '').trim().toLowerCase() === name.toLowerCase())) {
    const error = new Error('Ja existe um canal com este nome');
    error.status = 409;
    throw error;
  }

  const entropy = crypto.randomBytes(32).toString('base64url');
  const signature = crypto.createHash('sha256').update(`${tenantId}:${seed}:${entropy}`).digest('base64url').slice(0, 18);
  const token = `ocf_${entropy}.${signature}`;
  const actorInfo = {
    id: normalize(actor?.id) || 'system',
    name: normalize(actor?.name || actor?.fullName || actor?.displayName || actor?.username || actor?.email) || 'Sistema',
    role: normalize(actor?.role) || 'SYSTEM'
  };
  const entry = {
    id: `channel_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    tenantId,
    name,
    platform,
    status: 'draft',
    enabled: false,
    flowId: normalize(input.flowId),
    tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    tokenHint: `${token.slice(0, 10)}...${token.slice(-6)}`,
    modificationPasswordHash: modificationPassword ? await bcrypt.hash(modificationPassword, 12) : null,
    createdAt: now,
    updatedAt: now,
    createdBy: actorInfo,
    updatedBy: actorInfo,
    activity: [{ id: `event_${Date.now()}`, type: 'created', label: 'Canal criado', at: now, actor: actorInfo }]
  };

  current.entries = [...entries, entry];
  current.updatedAt = now;
  all[index] = current;
  await adapter.saveCollection('channelConfigs', all);
  const normalized = normalizeChannelConfigRecord(current);
  setCacheEntry(tenantId, normalized);
  cacheAll = null;
  cacheAllAt = 0;
  return { channel: sanitizeChannelEntry(entry), token };
};

export const listChannelEntries = async (tenantId) => {
  const config = await getChannelConfig(tenantId);
  return (Array.isArray(config?.entries) ? config.entries : []).map(sanitizeChannelEntry);
};

export const markChannelEntryConfigured = async (tenantId, channelId, platform, actor = null, technicalConfig = {}) => {
  const normalizedId = normalize(channelId);
  const normalizedPlatform = normalize(platform)?.toLowerCase();
  if (!tenantId || !normalizedId) return getChannelConfig(tenantId);

  const all = await adapter.getCollection('channelConfigs');
  const index = all.findIndex((config) => config.tenantId === tenantId);
  if (index === -1) {
    const error = new Error('Canal nao encontrado');
    error.status = 404;
    throw error;
  }

  const current = all[index];
  const entries = Array.isArray(current.entries) ? current.entries : [];
  const entryIndex = entries.findIndex((entry) => entry.id === normalizedId);
  if (entryIndex === -1 || entries[entryIndex].platform !== normalizedPlatform) {
    const error = new Error('Canal nao encontrado para esta plataforma');
    error.status = 404;
    throw error;
  }

  const now = new Date().toISOString();
  const updatedBy = {
    id: normalize(actor?.id) || 'system',
    name: normalize(actor?.name || actor?.fullName || actor?.displayName || actor?.username || actor?.email) || 'Sistema',
    role: normalize(actor?.role) || 'SYSTEM'
  };
  const entry = entries[entryIndex];
  const whatsappPhoneNumberIds = normalizedPlatform === 'whatsapp'
    ? [...new Set([
      normalize(technicalConfig?.phoneNumberId),
      ...(Array.isArray(technicalConfig?.senderNumbers)
        ? technicalConfig.senderNumbers.map((sender) => normalize(sender?.phoneNumberId))
        : [])
    ].filter(Boolean))]
    : [];
  entries[entryIndex] = {
    ...entry,
    status: 'active',
    enabled: true,
    ...(normalizedPlatform === 'whatsapp' && whatsappPhoneNumberIds.length ? {
      phoneNumberId: whatsappPhoneNumberIds[0],
      senderPhoneNumberIds: whatsappPhoneNumberIds
    } : {}),
    updatedAt: now,
    updatedBy,
    activity: [
      ...(Array.isArray(entry.activity) ? entry.activity : []),
      { id: `event_${Date.now()}`, type: 'configured', label: 'Configuracao tecnica concluida', at: now, actor: updatedBy }
    ].slice(-100)
  };

  current.entries = entries;
  current.updatedAt = now;
  all[index] = current;
  await adapter.saveCollection('channelConfigs', all);
  const normalized = normalizeChannelConfigRecord(current);
  setCacheEntry(tenantId, normalized);
  cacheAll = null;
  cacheAllAt = 0;
  invalidateRuntimeFlowCache(tenantId);
  return normalized;
};

export const deleteChannelEntry = async (tenantId, channelId, options = {}) => {
  const normalizedId = normalize(channelId);
  if (!tenantId) throw new Error('tenantId obrigatorio');
  if (!normalizedId) {
    const error = new Error('Canal obrigatorio');
    error.status = 400;
    throw error;
  }

  const all = await adapter.getCollection('channelConfigs');
  const index = all.findIndex((config) => config.tenantId === tenantId);
  if (index === -1) {
    const error = new Error('Canal nao encontrado');
    error.status = 404;
    throw error;
  }

  const current = all[index];
  const entries = Array.isArray(current.entries) ? current.entries : [];
  const entryIndex = entries.findIndex((entry) => entry.id === normalizedId);

  if (entryIndex >= 0) {
    const entry = entries[entryIndex];
    if (entry.modificationPasswordHash) {
      const passwordMatches = await bcrypt.compare(String(options.modificationPassword || ''), entry.modificationPasswordHash);
      if (!passwordMatches) {
        const error = new Error('Senha de modificacao invalida');
        error.status = 403;
        throw error;
      }
    }
    current.entries = entries.filter((entry) => entry.id !== normalizedId);
  } else if (normalizedId === 'whatsapp' || normalizedId === 'telegram') {
    if (!current[normalizedId]) {
      const error = new Error('Canal nao encontrado');
      error.status = 404;
      throw error;
    }
    current[normalizedId] = null;
  } else {
    const error = new Error('Canal nao encontrado');
    error.status = 404;
    throw error;
  }

  current.updatedAt = new Date().toISOString();
  all[index] = current;
  await adapter.saveCollection('channelConfigs', all);
  const normalized = normalizeChannelConfigRecord(current);
  setCacheEntry(tenantId, normalized);
  cacheAll = null;
  cacheAllAt = 0;
  invalidateRuntimeFlowCache(tenantId);
  return normalized;
};
