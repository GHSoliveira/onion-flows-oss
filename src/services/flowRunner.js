import adapter from '../../db/DatabaseAdapter.js';
import { createLog, getIo } from './logs.js';
import { getPublishedSubflowGraph } from './subflows.js';
import { normalizeWhatsappWaId } from './activeOutreach.js';
import { withChatLock } from './chatLocks.js';
import { scheduleDelayResume } from './delayResumeScheduler.js';
import { getWhatsAppConfig, resolveFlowNodeWhatsAppSender, resolveWhatsAppSender } from './channelConfig.js';
import { sanitizeChatState } from './chatStateGuard.js';
import { getTenantSettings } from './tenantSettings.js';
import { sendWhatsAppInteractive, sendWhatsAppTemplate } from './whatsappApi.js';
import { tryDecrypt as tryDecryptSecret } from '../utils/crypto.js';
import { validateScript } from '../utils/scriptValidator.js';
import { validateInputValue } from '../utils/inputValidation.js';
import vm from 'node:vm';
import {
  buildWhatsAppTemplateComponents,
  buildWhatsAppTemplatePreview,
  describeWhatsAppTemplateInputs
} from './whatsappTemplateCatalog.js';

import { generateId } from '../utils/helpers.js';
import { CHAT_EVENT_TYPES, emitChatEvent, shouldEmitForNodeType } from './chatEvents.js';
import { recordRating } from './ratings.js';
import {
  appendChatMessage,
  updateChatMessageDeliveryStatusByProvider
} from './chatMessages.js';
import { applyCartOperation } from './cartRuntime.js';
import { validateExternalUrl } from '../utils/externalUrl.js';
import { prepareIntegrationRequest, recordIntegrationResult } from './restIntegrations.js';
import {
  buildMenuInteractive,
  buildNumberedText,
  chooseMenuFormat,
  isDynamicMenu,
  matchMenuOption,
  resolveDisplayMode,
  resolveMenuOptions
} from './menuOptions.js';

const DAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const DEFAULT_TENANT_TIMEZONE = String(
  process.env.DEFAULT_TIMEZONE || process.env.TZ || 'America/Sao_Paulo'
).trim() || 'America/Sao_Paulo';
const WEEKDAY_PART_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

const parseText = (text, vars) => {
  if (!text) return '';
  return text.replace(/\{([\w\.[\]]+)\}/g, (match, path) => {
    try {
      const keys = path.split(/[.[\]]/).filter(Boolean);
      let value = vars;
      for (const key of keys) {
        if (value === undefined || value === null) return match;
        value = value[key];
      }
      return value !== undefined ? String(value) : match;
    } catch (err) {
      return match;
    }
  });
};

const resolveInterpolatedValue = (value, vars) => {
  if (typeof value === 'string') {
    return parseText(value, vars);
  }
  return value;
};

const normalizeCommand = (value) => {
  const text = String(value || '').trim().toLowerCase();
  return text || null;
};

const parseHolderExitKeywords = (value) => String(value || '')
  .split(/[\n,;|]+/)
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

const isExplicitCommandText = (value) => {
  const text = String(value || '').trim();
  return /^[#\/!]/.test(text);
};

const COMMAND_PROTECTED_NODE_TYPES = new Set([
  'menuNode',
  'catalogNode',
  'templateNode',
  'whatsappTemplateNode',
  'ratingNode'
]);

const findCommandNodeByInput = (flowData, text) => {
  const normalizedInput = normalizeCommand(text);
  if (!normalizedInput) return null;
  return flowData.nodes.find(
    (node) => node.type === 'commandNode' && normalizeCommand(node.data?.command) === normalizedInput
  ) || null;
};

const resolveCatalogPrice = (priceValue) => {
  if (priceValue === undefined || priceValue === null || priceValue === '') return null;
  const num = Number(priceValue);
  return Number.isFinite(num) ? num : null;
};

const formatCatalogPrice = (priceValue) => {
  const value = resolveCatalogPrice(priceValue);
  if (value === null) return '';
  try {
    return `R$ ${value.toFixed(2).replace('.', ',')}`;
  } catch {
    return String(value);
  }
};

const normalizeForMatch = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase();

const normalizeCatalogItem = (item, vars) => ({
  id: String(item?.id || generateId('manual')),
  name: parseText(String(item?.name || ''), vars).trim(),
  description: parseText(String(item?.description || ''), vars).trim(),
  category: parseText(String(item?.category || ''), vars).trim(),
  sku: parseText(String(item?.sku || ''), vars).trim(),
  mediaUrl: parseText(String(item?.mediaUrl || ''), vars).trim(),
  price: resolveCatalogPrice(item?.price)
});

const buildCatalogPrompt = (nodeData, options, vars) => {
  const baseTitle = parseText(nodeData?.title || nodeData?.message || 'Selecione um item:', vars).trim();
  const lines = options.map((item, index) => {
    const priceLabel = formatCatalogPrice(item.price);
    const suffix = priceLabel ? ` - ${priceLabel}` : '';
    return `${index + 1}. ${item.name}${suffix}`;
  });
  return [baseTitle, ...lines].filter(Boolean).join('\n');
};

const resolveCatalogOptions = async (node, chat, vars) => {
  const sourceType = String(node.data?.sourceType || 'catalog').toLowerCase();
  const limit = Math.min(Math.max(parseInt(node.data?.limit || '5', 10) || 5, 1), 20);
  const selectedIds = Array.isArray(node.data?.itemIds)
    ? node.data.itemIds.map((id) => String(id))
    : [];
  let options = [];

  if (sourceType === 'manual') {
    options = (Array.isArray(node.data?.items) ? node.data.items : [])
      .map((item, index) => ({
        id: String(item?.id || `manual_${node.id}_${index + 1}`),
        name: item?.name || '',
        description: item?.description || '',
        price: item?.price ?? null,
        category: item?.category || '',
        sku: item?.sku || '',
        mediaUrl: item?.mediaUrl || ''
      }));
  } else {
    const tenantId = chat?.tenantId || null;
    const categoryFilter = parseText(String(node.data?.category || ''), vars).trim().toLowerCase();
    const includeInactive = node.data?.includeInactive === true;
    const catalog = await adapter.getCollection('catalogItems', tenantId);
    options = (Array.isArray(catalog) ? catalog : []).filter((item) => {
      if (!includeInactive && item.active === false) return false;
      if (categoryFilter && String(item.category || '').toLowerCase() !== categoryFilter) return false;
      if (selectedIds.length && !selectedIds.includes(String(item.id))) return false;
      return true;
    });
  }

  return options
    .map((item) => normalizeCatalogItem(item, vars))
    .filter((item) => item.name)
    .slice(0, limit);
};

const resolveVariables = (varMap, globalVars) => {
  const localContext = { ...globalVars };
  if (varMap && Array.isArray(varMap)) {
    varMap.forEach((mapping) => {
      if (mapping.global && mapping.local) {
        localContext[mapping.local] = globalVars[mapping.global];
      }
    });
  }
  return localContext;
};

const buildSystemVars = (chat) => {
  const channel = chat?.channel || null;
  const channelUserId = chat?.channelUserId || null;
  const channelChatId = chat?.channelChatId || null;
  const waId = channel === 'whatsapp' ? channelUserId : null;
  const tgId = channel === 'telegram' ? channelUserId : null;
  return {
    CHANNEL: channel,
    CHAT_ID: chat?.id || null,
    TENANT_ID: chat?.tenantId || null,
    CHANNEL_USER_ID: channelUserId,
    CHANNEL_CHAT_ID: channelChatId,
    WA_ID: waId,
    TG_ID: tgId,
    CUSTOMER_CPF: chat?.customerCpf || null
  };
};

export const getChatById = async (chatId) => {
  if (!chatId) return null;
  return adapter.findOne(
    'activeChats',
    { id: chatId },
    { projection: { _id: 0 } }
  );
};

const getDb = async () => {
  if (!adapter.db) {
    await adapter.init();
  }
  return adapter.db;
};

const getWhatsAppTemplateById = async (tenantId, templateId) => {
  if (!tenantId || !templateId) return null;
  const db = await getDb();
  return db.collection('whatsappTemplates').findOne({
    tenantId,
    id: String(templateId)
  });
};

const getWhatsAppInteractiveTemplateById = async (tenantId, templateId) => {
  if (!tenantId || !templateId) return null;
  const db = await getDb();
  return db.collection('whatsappInteractiveTemplates').findOne({
    tenantId,
    id: String(templateId)
  });
};

const normalizeTemplateMapping = (mapping) => ({
  mode: mapping?.mode === 'variable' ? 'variable' : 'fixed',
  value: String(mapping?.value || '')
});

const resolveTemplateMappingValue = (mapping, vars) => {
  const normalized = normalizeTemplateMapping(mapping);
  if (!normalized.value) return '';
  if (normalized.mode === 'variable') {
    const value = vars?.[normalized.value];
    return value === undefined || value === null ? '' : String(value);
  }
  return parseText(normalized.value, vars);
};

const resolveTemplateMappingList = (mappings, vars) => (
  Array.isArray(mappings)
    ? mappings.map((mapping) => resolveTemplateMappingValue(mapping, vars))
    : []
);

const resolveTemplateButtonMappings = (buttonMappings, vars) => {
  if (!buttonMappings || typeof buttonMappings !== 'object') return {};
  return Object.fromEntries(
    Object.entries(buttonMappings).map(([buttonIndex, mappings]) => [
      buttonIndex,
      resolveTemplateMappingList(mappings, vars)
    ])
  );
};

const resolveWhatsAppTemplateValues = (nodeData, vars) => ({
  header: resolveTemplateMappingList(nodeData?.headerMappings, vars),
  body: resolveTemplateMappingList(nodeData?.bodyMappings, vars),
  buttons: resolveTemplateButtonMappings(nodeData?.buttonMappings, vars),
  headerMediaUrl: resolveTemplateMappingValue(nodeData?.headerMediaMapping, vars)
});

const buildWhatsAppInteractivePayload = (template, vars) => {
  if (!template || typeof template !== 'object') return null;

  const headerText = parseText(String(template.headerText || ''), vars).trim();
  const bodyText = parseText(String(template.bodyText || ''), vars).trim();
  const footerText = parseText(String(template.footerText || ''), vars).trim();
  const kind = String(template.kind || 'list').toLowerCase();
  const payload = {
    type: kind === 'button'
      ? 'button'
      : kind === 'product'
        ? 'product'
        : kind === 'product_list'
          ? 'product_list'
          : 'list',
    body: { text: bodyText || '...' }
  };

  if (headerText && payload.type !== 'product') {
    payload.header = { type: 'text', text: headerText };
  }

  if (footerText) {
    payload.footer = { text: footerText };
  }

  if (payload.type === 'product') {
    payload.action = {
      catalog_id: parseText(String(template.catalogId || ''), vars).trim(),
      product_retailer_id: parseText(String(template.productRetailerId || ''), vars).trim()
    };
  } else if (payload.type === 'product_list') {
    payload.action = {
      catalog_id: parseText(String(template.catalogId || ''), vars).trim(),
      sections: (Array.isArray(template.productSections) ? template.productSections : []).map((section) => ({
        ...(parseText(String(section?.title || ''), vars).trim()
          ? { title: parseText(String(section?.title || ''), vars).trim() }
          : {}),
        product_items: (Array.isArray(section?.productItems) ? section.productItems : []).map((item) => ({
          product_retailer_id: parseText(String(item?.productRetailerId || ''), vars).trim()
        })).filter((item) => item.product_retailer_id)
      })).filter((section) => Array.isArray(section.product_items) && section.product_items.length > 0)
    };
  } else if (payload.type === 'list') {
    payload.action = {
      button: parseText(String(template.actionTitle || 'Ver opcoes'), vars).trim() || 'Ver opcoes',
      sections: (Array.isArray(template.sections) ? template.sections : []).map((section) => ({
        ...(parseText(String(section?.title || ''), vars).trim()
          ? { title: parseText(String(section?.title || ''), vars).trim() }
          : {}),
        rows: (Array.isArray(section?.rows) ? section.rows : []).map((row) => ({
          id: parseText(String(row?.id || ''), vars).trim(),
          title: parseText(String(row?.title || ''), vars).trim(),
          ...(parseText(String(row?.description || ''), vars).trim()
            ? { description: parseText(String(row?.description || ''), vars).trim() }
            : {})
        })).filter((row) => row.id && row.title)
      })).filter((section) => Array.isArray(section.rows) && section.rows.length > 0)
    };
  } else {
    payload.action = {
      buttons: (Array.isArray(template.buttons) ? template.buttons : []).slice(0, 3).map((button) => ({
        type: 'reply',
        reply: {
          id: parseText(String(button?.id || ''), vars).trim(),
          title: parseText(String(button?.title || ''), vars).trim()
        }
      })).filter((button) => button.reply.id && button.reply.title)
    };
  }

  return payload;
};

const buildWhatsAppInteractivePreview = (template, vars) => {
  if (!template || typeof template !== 'object') return '';
  const parts = [];
  const headerText = parseText(String(template.headerText || ''), vars).trim();
  const bodyText = parseText(String(template.bodyText || ''), vars).trim();
  const footerText = parseText(String(template.footerText || ''), vars).trim();

  if (headerText && template.kind !== 'product') parts.push(headerText);
  if (bodyText) parts.push(bodyText);
  if (footerText) parts.push(footerText);

  if (template.kind === 'product') {
    const catalogId = parseText(String(template.catalogId || ''), vars).trim();
    const productRetailerId = parseText(String(template.productRetailerId || ''), vars).trim();
    parts.push('[Produto]');
    if (catalogId) parts.push(`catalog_id: ${catalogId}`);
    if (productRetailerId) parts.push(`product_retailer_id: ${productRetailerId}`);
  } else if (template.kind === 'product_list') {
    const catalogId = parseText(String(template.catalogId || ''), vars).trim();
    parts.push('[Catalogo]');
    if (catalogId) parts.push(`catalog_id: ${catalogId}`);
    (Array.isArray(template.productSections) ? template.productSections : []).forEach((section) => {
      const sectionTitle = parseText(String(section?.title || ''), vars).trim();
      if (sectionTitle) parts.push(sectionTitle);
      (Array.isArray(section?.productItems) ? section.productItems : []).forEach((item) => {
        const retailerId = parseText(String(item?.productRetailerId || ''), vars).trim();
        if (retailerId) parts.push(`- product_retailer_id: ${retailerId}`);
      });
    });
  } else if (template.kind === 'list') {
    const actionTitle = parseText(String(template.actionTitle || 'Ver opcoes'), vars).trim();
    if (actionTitle) parts.push(`[${actionTitle}]`);
    (Array.isArray(template.sections) ? template.sections : []).forEach((section) => {
      const sectionTitle = parseText(String(section?.title || ''), vars).trim();
      if (sectionTitle) parts.push(sectionTitle);
      (Array.isArray(section?.rows) ? section.rows : []).forEach((row) => {
        const rowTitle = parseText(String(row?.title || ''), vars).trim();
        const rowId = parseText(String(row?.id || ''), vars).trim();
        if (rowTitle || rowId) {
          parts.push(`- ${rowTitle || rowId} (${rowId || 'sem_id'})`);
        }
      });
    });
  } else {
    const buttons = (Array.isArray(template.buttons) ? template.buttons : []).map((button) => {
      const title = parseText(String(button?.title || ''), vars).trim();
      const id = parseText(String(button?.id || ''), vars).trim();
      if (!title && !id) return null;
      return `[${title || id}]`;
    }).filter(Boolean);
    if (buttons.length) {
      parts.push(buttons.join(' '));
    }
  }

  return parts.filter(Boolean).join('\n');
};

const buildLatestResponseVars = (currentVars, {
  text = '',
  buttonText = '',
  responsePayload = ''
} = {}) => ({
  ...currentVars,
  ULTIMA_RESPOSTA_CLIENTE: text || '',
  WTN_BOTAO_TEXTO: buttonText || '',
  WTN_BOTAO_PAYLOAD: responsePayload || ''
});

const normalizeSequentialMenuOptions = (options) => (
  Array.isArray(options)
    ? options.map((option, index) => {
      const fallbackId = String(index + 1);
      const id = String(option?.id || fallbackId).trim() || fallbackId;
      const label = String(option?.label || option?.value || id).trim() || id;
      return {
        id,
        label,
        value: option?.value ?? label
      };
    }).filter((option) => option.id)
    : []
);

const normalizeSequentialStep = (step, index = 0) => {
  const stepType = String(step?.type || 'message').trim().toLowerCase();
  const type = ['message', 'input', 'menu'].includes(stepType) ? stepType : 'message';
  const fallbackText = type === 'input'
    ? 'Digite uma informacao:'
    : (type === 'menu' ? 'Selecione uma opcao:' : '...');

  return {
    id: String(step?.id || `seq_step_${index + 1}`),
    type,
    text: String(step?.text || fallbackText),
    variableName: String(step?.variableName || '').trim(),
    setVarEnabled: Boolean(step?.setVarEnabled),
    invalidSelectionMessage: String(step?.invalidSelectionMessage || 'Selecione uma opcao valida.').trim() || 'Selecione uma opcao valida.',
    options: type === 'menu'
      ? normalizeSequentialMenuOptions(step?.options)
      : []
  };
};

const getSequentialSteps = (nodeData) => (
  (Array.isArray(nodeData?.steps) ? nodeData.steps : [])
    .map((step, index) => normalizeSequentialStep(step, index))
    .filter((step) => step.type)
);

const findSequentialMenuSelection = ({ options, text, buttonId }) => {
  const safeOptions = Array.isArray(options) ? options : [];
  const normalizedText = String(text || '').trim().toLowerCase();
  if (buttonId) {
    const selectedByButton = safeOptions.find((option) => String(option.id) === String(buttonId));
    if (selectedByButton) return selectedByButton;
  }

  if (/^\d+$/.test(normalizedText)) {
    const index = Number(normalizedText) - 1;
    if (safeOptions[index]) return safeOptions[index];
  }

  if (normalizedText) {
    const byId = safeOptions.find((option) => String(option.id || '').toLowerCase() === normalizedText);
    if (byId) return byId;
    const byLabel = safeOptions.find((option) => String(option.label || '').toLowerCase() === normalizedText);
    if (byLabel) return byLabel;
  }

  return null;
};

const toMinutes = (timeStr) => {
  if (!timeStr) return null;
  const [hours, minutes] = timeStr.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

const isWithinRange = (nowMinutes, startMinutes, endMinutes) => {
  if (startMinutes === null || endMinutes === null) return false;
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
};

const getScheduleReferenceParts = (reference = new Date(), timeZone = DEFAULT_TENANT_TIMEZONE) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(reference);
    const mapped = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekdayIndex = WEEKDAY_PART_INDEX[mapped.weekday];
    const hour = Number(mapped.hour);
    const minute = Number(mapped.minute);
    if (
      weekdayIndex === undefined
      || !Number.isFinite(hour)
      || !Number.isFinite(minute)
    ) {
      throw new Error('invalid_schedule_parts');
    }
    return {
      dayLabel: DAY_LABELS[weekdayIndex],
      currentMinutes: hour * 60 + minute
    };
  } catch {
    return {
      dayLabel: DAY_LABELS[reference.getDay()],
      currentMinutes: reference.getHours() * 60 + reference.getMinutes()
    };
  }
};

const isScheduleOpen = (schedule, { reference = new Date(), timeZone = DEFAULT_TENANT_TIMEZONE } = {}) => {
  if (!schedule || !schedule.rules) return false;
  const { dayLabel, currentMinutes } = getScheduleReferenceParts(reference, timeZone);
  const rule = schedule.rules[dayLabel];
  if (!rule || !rule.active) return false;
  const startMinutes = toMinutes(rule.start);
  const endMinutes = toMinutes(rule.end);
  return isWithinRange(currentMinutes, startMinutes, endMinutes);
};

const updateChatById = async (chatId, updater) => {
  const currentChat = await adapter.findOne(
    'activeChats',
    { id: chatId },
    { projection: { _id: 0 } }
  );
  if (!currentChat) {
    throw new Error('Chat nao encontrado');
  }
  updater(currentChat);
  const sanitized = sanitizeChatState(currentChat);
  sanitized.chat.updatedAt = new Date().toISOString();
  await adapter.updateOne(
    'activeChats',
    { id: chatId },
    { $set: sanitized.chat }
  );
  return sanitized.chat;
};

const addChatMessage = async (chatId, message) => {
  const { chat } = await appendChatMessage(chatId, message);
  const io = getIo();
  if (io && chat?.tenantId && !chat.isFlowTest) {
    io.to(`tenant:${chat.tenantId}`).emit('new_message', { chatId, message });
  }
  return chat;
};

const normalizeVarKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/\s+/g, '_');

const buildSecureVarKeySet = (secureVars, secureVarNames = []) => new Set(
  [
    ...Object.keys(secureVars || {}),
    ...(Array.isArray(secureVarNames) ? secureVarNames : [])
  ]
    .map((key) => normalizeVarKey(key))
    .filter(Boolean)
);

const stripSecureVars = (vars, secureVarKeys) => {
  if (!vars || typeof vars !== 'object') return {};
  if (!secureVarKeys?.size) return vars;
  return Object.fromEntries(
    Object.entries(vars).filter(([key]) => !secureVarKeys.has(normalizeVarKey(key)))
  );
};

const setChatVars = async (chatId, vars) => {
  return updateChatById(chatId, (chat) => {
    const secureVarKeys = buildSecureVarKeySet(chat?.secureVars, chat?.secureVarNames);
    chat.vars = stripSecureVars(vars, secureVarKeys);
  });
};

const updateInputAttempt = async (chatId, nodeId, mode = 'increment') => {
  let attemptCount = 0;
  await updateChatById(chatId, (chat) => {
    const attempts = chat.inputAttempts && typeof chat.inputAttempts === 'object'
      ? { ...chat.inputAttempts }
      : {};
    if (mode === 'clear') {
      delete attempts[nodeId];
    } else {
      attemptCount = Math.max(0, Number(attempts[nodeId]) || 0) + 1;
      attempts[nodeId] = attemptCount;
    }
    chat.inputAttempts = attempts;
  });
  return attemptCount;
};

const setChatSecureVars = async (chatId, secureVars) => {
  return updateChatById(chatId, (chat) => {
    const nextSecureVars = (secureVars && typeof secureVars === 'object') ? secureVars : {};
    const secureVarKeys = buildSecureVarKeySet(nextSecureVars);
    chat.secureVars = nextSecureVars;
    chat.secureVarNames = Object.keys(nextSecureVars);
    chat.vars = stripSecureVars(chat.vars, secureVarKeys);
    if (chat.variables && typeof chat.variables === 'object') {
      chat.variables = stripSecureVars(chat.variables, secureVarKeys);
    }
  });
};

const setCurrentNodeId = async (chatId, nodeId) => {
  return updateChatById(chatId, (chat) => {
    if (!nodeId || chat.currentNodeId !== nodeId) {
      chat.holderContext = null;
    }
    chat.currentNodeId = nodeId;
    chat.currentNodeEnteredAt = nodeId ? new Date().toISOString() : null;
  });
};

const setInputWaitState = async (chatId, nodeId) => {
  return updateChatById(chatId, (chat) => {
    const attempts = chat.inputAttempts && typeof chat.inputAttempts === 'object'
      ? { ...chat.inputAttempts }
      : {};
    delete attempts[nodeId];
    chat.inputAttempts = attempts;
    chat.holderContext = null;
    chat.currentNodeId = nodeId;
    chat.currentNodeEnteredAt = new Date().toISOString();
  });
};

const setSequentialWaitState = async (chatId, nodeId, stepIndex) => (
  updateChatById(chatId, (chat) => {
    chat.currentNodeId = nodeId;
    chat.currentNodeEnteredAt = nodeId ? new Date().toISOString() : null;
    chat.sequentialContext = nodeId
      ? {
          nodeId,
          stepIndex
        }
      : null;
  })
);

const clearSequentialWaitState = async (chatId) => (
  updateChatById(chatId, (chat) => {
    chat.currentNodeId = null;
    chat.currentNodeEnteredAt = null;
    chat.sequentialContext = null;
  })
);

const setChatDelayState = async (chatId, nodeId, nextNodeId, delayMs) => {
  const now = Date.now();
  return updateChatById(chatId, (chat) => {
    chat.currentNodeId = nodeId || null;
    chat.currentNodeEnteredAt = nodeId ? new Date(now).toISOString() : null;
    chat.delayNodeId = nodeId || null;
    chat.delayNextNodeId = nextNodeId || null;
    chat.delayUntil = nextNodeId ? new Date(now + delayMs).toISOString() : null;
  });
};

/* ===================== SUBFLUXO =====================
 * O subfluxo roda no mesmo motor do fluxo pai. Em vez de trocar o grafo em
 * execucao, mesclamos os dois num so, prefixando os ids do subfluxo. Assim o
 * `flowData.nodes.find(...)` continua funcionando sem encanamento novo, e o
 * retorno ao pai e so mais um id dentro do mesmo grafo.
 *
 * Estado no chat (molde do sequentialContext):
 *   chat.subflowContext = { subflowId, returnNodeId, resumedNodeId, errorNodeId }
 * Nulo quando nao esta dentro de subfluxo. Sem aninhamento por decisao de projeto.
 */
const SUBFLOW_PREFIX = 'sf::';

export const isSubflowNodeId = (nodeId) => String(nodeId || '').startsWith(SUBFLOW_PREFIX);

const prefixSubflowGraph = (subflow) => ({
  nodes: (subflow.nodes || []).map((node) => ({ ...node, id: `${SUBFLOW_PREFIX}${node.id}` })),
  edges: (subflow.edges || []).map((edge, index) => ({
    ...edge,
    id: `${SUBFLOW_PREFIX}${edge.id || `e${index}`}`,
    source: `${SUBFLOW_PREFIX}${edge.source}`,
    target: `${SUBFLOW_PREFIX}${edge.target}`
  }))
});

const mergeSubflowIntoGraph = (flowData, prefixed) => ({
  ...flowData,
  nodes: [...(flowData.nodes || []), ...prefixed.nodes],
  edges: [...(flowData.edges || []), ...prefixed.edges]
});

// Usado pelo applyUserInput: se o chat parou dentro de um subfluxo, o grafo
// precisa conter tambem os nodes daquele subfluxo, senao o node atual nao e
// encontrado e a conversa e resetada.
export const resolveExecutionGraph = async (chat, flowData) => {
  const context = chat?.subflowContext;
  if (!context?.subflowId || !flowData) return flowData;
  try {
    const subflow = await getPublishedSubflowGraph(chat.tenantId, context.subflowId);
    if (!subflow) return flowData;
    return mergeSubflowIntoGraph(flowData, prefixSubflowGraph(subflow));
  } catch (error) {
    console.warn('[SUBFLOW] Falha ao carregar subfluxo em execucao:', error?.message || error);
    return flowData;
  }
};

const findSubflowOutlet = (flowData, nodeId, handle) => {
  const edge = (flowData.edges || []).find(
    (candidate) => candidate.source === nodeId && String(candidate.sourceHandle) === handle
  );
  return edge ? edge.target : null;
};

export const applyFlowRuntimeReset = (chat) => {
  if (!chat || typeof chat !== 'object') return chat;
  chat.currentNodeId = null;
  chat.currentNodeEnteredAt = null;
  chat.flowStarted = false;
  chat.resumeNodeId = null;
  chat.resumePending = false;
  chat.continueFlowAfterQueue = false;
  chat.catalogContext = null;
  chat.sequentialContext = null;
  chat.subflowContext = null;
  chat.holderContext = null;
  chat.delayNodeId = null;
  chat.delayNextNodeId = null;
  chat.delayUntil = null;
  chat.inputAttempts = {};
  chat.secureVars = {};
  chat.secureVarNames = [];
  return chat;
};

export const tryHandleGlobalCommand = async ({
  chat,
  flowData,
  text,
  templates,
  schedules,
  sendMessage,
  sendMedia
}) => {
  if (!text || !flowData?.nodes || !chat?.id) return false;
  const commandNode = findCommandNodeByInput(flowData, text);
  if (!commandNode) return false;

  console.log(`[FLOW] Command matched (${text}) -> ${commandNode.id}`);
  const currentNode = flowData.nodes.find((node) => node.id === chat.currentNodeId);
  if (currentNode?.type === 'inputNode') {
    await updateInputAttempt(chat.id, chat.currentNodeId, 'clear');
  }
  await setCurrentNodeId(chat.id, null);
  await runFlow({
    nodeId: commandNode.id,
    flowData,
    currentVars: chat?.vars || {},
    chatId: chat.id,
    templates,
    schedules,
    sendMessage,
    sendMedia
  });
  return true;
};

export const canApplyGlobalCommand = (nodeType = null, text = '') => (
  !COMMAND_PROTECTED_NODE_TYPES.has(String(nodeType || '')) || isExplicitCommandText(text)
);

const normalizeDeliveryStatus = (value) => {
  const status = String(value || '').trim().toLowerCase();
  if (!status) return null;
  if (status === 'accepted' || status === 'warning') return 'sent';
  if (['sent', 'delivered', 'read', 'failed'].includes(status)) return status;
  return status;
};

const normalizeDeliveryTimestamp = (value) => {
  if (!value) return new Date().toISOString();
  const raw = String(value).trim();
  if (!raw) return new Date().toISOString();
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    const ms = raw.length <= 10 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
};

const applyDeliveryMetadata = (message, meta = null) => {
  const providerMessageId = meta?.providerMessageId || message?.providerMessageId || null;
  const deliveryStatus = normalizeDeliveryStatus(meta?.deliveryStatus || message?.deliveryStatus || null);
  const deliveryStatusAt = meta?.deliveryStatusAt || message?.deliveryStatusAt || null;

  return {
    ...message,
    providerMessageId,
    deliveryStatus,
    deliveryStatusAt,
    meta: meta ? {
      ...meta,
      providerMessageId,
      deliveryStatus,
      deliveryStatusAt
    } : message?.meta || null
  };
};

const createMessage = (sender, text, buttons = null, meta = null) => applyDeliveryMetadata({
  id: generateId('msg'),
  sender,
  text,
  buttons: buttons || null,
  meta: meta || null,
  timestamp: new Date().toISOString()
}, meta);

const createMediaMessage = (sender, mediaType, mediaUrl, caption, fileName = null, extra = null) => {
  const safeType = String(mediaType || 'document').toLowerCase();
  const normalizedType = ['image', 'video', 'audio', 'document'].includes(safeType) ? safeType : 'document';
  const normalizedCaption = caption || '';
  return {
    id: generateId('msg'),
    sender,
    text: normalizedCaption || `[${normalizedType}] ${mediaUrl || ''}`.trim(),
    media: {
      type: normalizedType,
      url: mediaUrl || '',
      caption: normalizedCaption || '',
      fileName: fileName || null,
      ...(extra && typeof extra === 'object' ? extra : {})
    },
    buttons: null,
    timestamp: new Date().toISOString()
  };
};

export const addBotMessage = async (chatId, text, buttons, sendMessage, meta = null) => {
  if (!chatId || !text) return null;
  let nextMeta = meta ? { ...meta } : null;
  if (sendMessage) {
    const sendResult = await sendMessage(text, buttons);
    const providerMessageId = sendResult?.messages?.[0]?.id || null;
    if (providerMessageId) {
      nextMeta = {
        ...(nextMeta || {}),
        providerMessageId,
        deliveryStatus: normalizeDeliveryStatus(nextMeta?.deliveryStatus || 'sent'),
        deliveryStatusAt: new Date().toISOString()
      };
    }
  }
  const message = createMessage('bot', text, buttons, nextMeta);
  await addChatMessage(chatId, message);
  return message;
};

// Mescla variaveis no chat sem apagar as que ja existem. Mesma regra do
// setChatVars para variaveis seguras: elas nunca sao gravadas em `vars`.
export const mergeChatVars = async (chatId, patch = {}) => {
  if (!chatId || !patch || typeof patch !== 'object') return null;
  return updateChatById(chatId, (chat) => {
    const secureVarKeys = buildSecureVarKeySet(chat?.secureVars, chat?.secureVarNames);
    chat.vars = stripSecureVars({ ...(chat?.vars || {}), ...patch }, secureVarKeys);
  });
};

export const addUserMessage = async (chatId, text, options = {}) => {
  if (!chatId || !text) return null;
  // providerMessageId é o ID da mensagem no canal (WhatsApp/Telegram). Guardar
  // permite que o agente responda essa mensagem com quote nativo depois.
  const providerMessageId = options?.providerMessageId || null;
  // options.meta leva dados estruturados junto da mensagem, como os itens de um
  // pedido do catalogo. providerMessageId continua prevalecendo sobre ele.
  const extraMeta = options?.meta && typeof options.meta === 'object' ? options.meta : null;
  const meta = (extraMeta || providerMessageId)
    ? { ...(extraMeta || {}), ...(providerMessageId ? { providerMessageId } : {}) }
    : null;
  const message = createMessage('user', text, null, meta);
  if (providerMessageId && !message.providerMessageId) {
    message.providerMessageId = providerMessageId;
  }
  // replyTo: quando o cliente cita uma mensagem nossa (reply nativo do canal).
  if (options?.replyTo) {
    message.replyTo = options.replyTo;
  }
  await addChatMessage(chatId, message);
  return message;
};

export const addUserMedia = async (chatId, mediaPayload) => {
  if (!chatId || !mediaPayload?.mediaUrl) return null;
  const message = createMediaMessage(
    'user',
    mediaPayload.mediaType,
    mediaPayload.mediaUrl,
    mediaPayload.caption,
    mediaPayload.fileName,
    {
      mimeType: mediaPayload.mimeType || null,
      providerMediaId: mediaPayload.providerMediaId || null,
      sha256: mediaPayload.sha256 || null
    }
  );
  if (mediaPayload.providerMessageId) {
    message.providerMessageId = mediaPayload.providerMessageId;
    message.meta = { ...(message.meta || {}), providerMessageId: mediaPayload.providerMessageId };
  }
  if (mediaPayload.replyTo) {
    message.replyTo = mediaPayload.replyTo;
  }
  await addChatMessage(chatId, message);
  return message;
};

export const addBotMedia = async (chatId, mediaPayload, sendMedia) => {
  if (!chatId || !mediaPayload?.mediaUrl) return null;
  let message = createMediaMessage(
    'bot',
    mediaPayload.mediaType,
    mediaPayload.mediaUrl,
    mediaPayload.caption,
    mediaPayload.fileName
  );
  if (sendMedia) {
    const sendResult = await sendMedia({
      mediaType: message.media.type,
      mediaUrl: message.media.url,
      caption: message.media.caption,
      fileName: message.media.fileName
    });
    const providerMessageId = sendResult?.messages?.[0]?.id || null;
    if (providerMessageId) {
      message = applyDeliveryMetadata(message, {
        ...(message.meta || {}),
        providerMessageId,
        deliveryStatus: 'sent',
        deliveryStatusAt: new Date().toISOString()
      });
    }
  }
  await addChatMessage(chatId, message);
  return message;
};

export const updateChatMessageDeliveryStatusByProviderMessageId = async ({
  providerMessageId,
  status,
  timestamp = null,
  errors = null
}) => {
  if (!providerMessageId) return null;

  const normalizedStatus = normalizeDeliveryStatus(status);
  if (!normalizedStatus) return null;

  const nextTimestamp = normalizeDeliveryTimestamp(timestamp);

  const storedMessageUpdate = await updateChatMessageDeliveryStatusByProvider({
    providerMessageId,
    status: normalizedStatus,
    deliveryStatusAt: nextTimestamp,
    errors
  });
  if (storedMessageUpdate) {
    return storedMessageUpdate;
  }

  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection('activeChats');
  const chat = await collection.findOne(
    {
      $or: [
        { 'messages.providerMessageId': String(providerMessageId) },
        { 'messages.meta.providerMessageId': String(providerMessageId) }
      ]
    },
    { projection: { _id: 0, id: 1, messages: 1 } }
  );

  if (!chat?.id) return null;

  return withChatLock(chat.id, async () => {
    const liveChat = await getChatById(chat.id);
    if (!liveChat) return null;

    const liveMessageIndex = Array.isArray(liveChat?.messages)
      ? liveChat.messages.findIndex((message) => (
        String(message?.providerMessageId || message?.meta?.providerMessageId || '') === String(providerMessageId)
      ))
      : -1;
    if (liveMessageIndex === -1) return null;

    const currentMessage = liveChat.messages[liveMessageIndex];
    liveChat.messages[liveMessageIndex] = applyDeliveryMetadata(currentMessage, {
      ...(currentMessage?.meta || {}),
      providerMessageId,
      deliveryStatus: normalizedStatus,
      deliveryStatusAt: nextTimestamp,
      deliveryErrors: normalizedStatus === 'failed' ? (errors || null) : null
    });
    liveChat.updatedAt = new Date().toISOString();
    await adapter.updateOne(
      'activeChats',
      { id: liveChat.id },
      { $set: liveChat }
    );
    return {
      chatId: liveChat.id,
      message: liveChat.messages[liveMessageIndex]
    };
  });
};

export const getDisabledNodeNextId = (node, edges = []) => {
  if (!node?.data?.disabled || node.type === 'startNode') return null;
  const outgoing = (Array.isArray(edges) ? edges : []).filter((edge) => edge.source === node.id);
  return outgoing.length === 1 ? outgoing[0].target : null;
};

// Botoes/lista do node de menu. Devolve false quando nao deu (canal sem
// WhatsApp configurado, Meta recusou): quem chama manda as opcoes em texto.
const sendMenuInteractive = async ({ chat, chatId, flowData, node, interactive, previewText }) => {
  try {
    const config = await getWhatsAppConfig(chat?.tenantId || null);
    const { sender } = resolveFlowNodeWhatsAppSender(config, null, chat?.whatsappPhoneNumberId || null);
    const to = normalizeWhatsappWaId(chat?.channelUserId || '');
    if (!config?.enabled || !config?.accessToken || !sender?.phoneNumberId || !to) return false;
    const result = await sendWhatsAppInteractive({
      accessToken: config.accessToken,
      phoneNumberId: sender.phoneNumberId,
      to,
      interactive,
      debugContext: { tenantId: chat?.tenantId || null, flowId: flowData?.id || null, nodeId: node?.id || null, source: 'menuNode' }
    });
    await addBotMessage(chatId, previewText, null, null, {
      type: 'whatsapp_interactive',
      source: 'menuNode',
      interactiveKind: interactive.type,
      senderPhoneNumberId: sender.phoneNumberId,
      providerMessageId: result?.messages?.[0]?.id || null,
      deliveryStatus: 'sent',
      deliveryStatusAt: new Date().toISOString()
    });
    return true;
  } catch (error) {
    console.warn('[FLOW] Menu interativo nao foi; vai como texto', {
      tenantId: chat?.tenantId || null,
      nodeId: node?.id || null,
      error: error?.message || String(error)
    });
    return false;
  }
};

// Proximo node depois de uma saida (caseNode) do node, pelo handle.
const nextAfterBranch = (flowData, nodeId, handle) => {
  const ateSaida = flowData.edges.find((e) => e.source === nodeId && String(e.sourceHandle) === handle);
  if (!ateSaida) return null;
  return flowData.edges.find((e) => e.source === ateSaida.target)?.target || null;
};

export const runFlow = async ({
  nodeId,
  flowData,
  currentVars,
  chatId,
  templates,
  schedules,
  sendMessage,
  sendMedia,
  sequentialStepIndex = 0
}) => {
  const node = flowData.nodes.find((n) => n.id === nodeId);
  if (!node) {
    console.warn(`[FLOW] Node not found for chat ${chatId}: ${nodeId}`);
    await updateChatById(chatId, (currentChat) => {
      if (currentChat.currentNodeId === nodeId || currentChat.resumeNodeId === nodeId) {
        applyFlowRuntimeReset(currentChat);
      } else {
        currentChat.catalogContext = null;
        currentChat.sequentialContext = null;
      }
      if (currentChat.status === 'bot') {
        currentChat.flowStarted = false;
      }
    });
    return;
  }
  console.log(`[FLOW] Node ${node.type} (${node.id}) at ${new Date().toISOString()}`);
  const effectiveSendMedia = sendMedia || sendMessage?.__sendMedia || null;

  if (node.data?.disabled === true && node.type !== 'startNode') {
    const nextNodeId = getDisabledNodeNextId(node, flowData.edges);
    if (!nextNodeId) {
      console.warn(`[FLOW] Disabled node requires exactly one output: ${node.id}`);
      return;
    }
    await setCurrentNodeId(chatId, null);
    await runFlow({
      nodeId: nextNodeId,
      flowData,
      currentVars,
      chatId,
      templates,
      schedules,
      sendMessage,
      sendMedia: effectiveSendMedia
    });
    return;
  }

  const chat = await getChatById(chatId);
  if (chat && !chat.isFlowTest && shouldEmitForNodeType(node.type)) {
    emitChatEvent({
      tenantId: chat.tenantId,
      chatId: chat.id,
      type: CHAT_EVENT_TYPES.FLOW_NODE_ENTERED,
      actor: { kind: 'flow' },
      context: {
        nodeId: node.id,
        nodeType: node.type,
        nodeLabel: node.data?.label || null
      }
    }).catch(() => {});
  }
  const systemVars = buildSystemVars(chat);
  const contextWithAlias = resolveVariables(node.data?.varMap, { ...systemVars, ...currentVars });
  const secureVars = (chat?.secureVars && typeof chat.secureVars === 'object') ? chat.secureVars : {};
  const privateContextWithAlias = resolveVariables(node.data?.varMap, { ...systemVars, ...currentVars, ...secureVars });

  if (chat?.isFlowTest && node.type === 'queueNode') {
    const edge = flowData.edges.find((item) => item.source === node.id);
    if (edge) {
      await runFlow({ nodeId: edge.target, flowData, currentVars, chatId, templates, schedules, sendMessage, sendMedia: effectiveSendMedia });
    }
    return;
  }

  if (node.type === 'startNode') {
    const startEdge = flowData.edges.find((e) => e.source === nodeId);
    if (startEdge) {
      await runFlow({
        nodeId: startEdge.target,
        flowData,
        currentVars,
        chatId,
        templates,
        schedules,
        sendMessage
      });
    }
    return;
  }

  if (node.type === 'messageNode') {
    if (node.data?.text) {
      const text = parseText(node.data.text, contextWithAlias);
      await addBotMessage(chatId, text, null, sendMessage);
    }
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars,
        chatId,
        templates,
        schedules,
        sendMessage
      });
    }
    return;
  }

  if (node.type === 'sequentialNode') {
    const steps = getSequentialSteps(node.data);
    const totalSteps = steps.length;
    let stepIndex = Number.parseInt(sequentialStepIndex, 10);
    if (!Number.isFinite(stepIndex) || stepIndex < 0) {
      stepIndex = 0;
    }
    let varsCursor = { ...currentVars };

    if (!totalSteps) {
      await clearSequentialWaitState(chatId);
      const edge = flowData.edges.find((e) => e.source === nodeId);
      if (edge) {
        await runFlow({
          nodeId: edge.target,
          flowData,
          currentVars: varsCursor,
          chatId,
          templates,
          schedules,
          sendMessage,
          sendMedia: effectiveSendMedia
        });
      }
      return;
    }

    while (stepIndex < totalSteps) {
      const step = steps[stepIndex];
      const stepContext = resolveVariables(node.data?.varMap, { ...systemVars, ...varsCursor });

      if (step.type === 'message') {
        const text = parseText(step.text || '...', stepContext).trim();
        if (text) {
          await addBotMessage(chatId, text, null, sendMessage);
        }
        stepIndex += 1;
        continue;
      }

      if (step.type === 'input') {
        const prompt = parseText(step.text || 'Digite uma informacao:', stepContext);
        await addBotMessage(chatId, prompt, null, sendMessage);
        await setSequentialWaitState(chatId, node.id, stepIndex);
        return;
      }

      if (step.type === 'menu') {
        const prompt = parseText(step.text || 'Selecione uma opcao:', stepContext);
        await addBotMessage(chatId, prompt, null, sendMessage);
        await setSequentialWaitState(chatId, node.id, stepIndex);
        return;
      }

      stepIndex += 1;
    }

    await clearSequentialWaitState(chatId);
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars: varsCursor,
        chatId,
        templates,
        schedules,
        sendMessage,
        sendMedia: effectiveSendMedia
      });
    }
    return;
  }

  if (node.type === 'inputNode') {
    const questionText = parseText(node.data?.text || 'Digite uma informacao:', contextWithAlias);
    await addBotMessage(chatId, questionText, null, sendMessage);
    await setInputWaitState(chatId, node.id);
    return;
  }

  if (node.type === 'menuNode') {
    const menuText = parseText(node.data?.text || 'Selecione uma opção:', contextWithAlias);
    const display = resolveDisplayMode(node.data);
    // Menu antigo ("so o texto"): segue igual a antes, as opcoes ficam a cargo do texto.
    if (display === 'text') {
      await addBotMessage(chatId, menuText, null, sendMessage);
      await setCurrentNodeId(chatId, node.id);
      return;
    }

    const options = resolveMenuOptions(node.data, contextWithAlias, (texto) => parseText(texto, contextWithAlias));
    if (isDynamicMenu(node.data) && !options.length) {
      // Lista vazia (API nao devolveu nada): segue pela saida "Lista vazia".
      const vazio = nextAfterBranch(flowData, node.id, 'empty');
      if (!vazio) {
        console.warn('[FLOW] Menu dinamico sem opcoes e sem saida "Lista vazia"', { nodeId: node.id, variable: node.data?.optionsVariable || null });
        return;
      }
      await runFlow({ nodeId: vazio, flowData, currentVars, chatId, templates, schedules, sendMessage, sendMedia: effectiveSendMedia });
      return;
    }

    // As opcoes ficam guardadas na conversa: a resposta e comparada com o que
    // o cliente viu, mesmo que a variavel mude depois.
    await updateChatById(chatId, (current) => {
      current.menuContext = { nodeId: node.id, options: options.map(({ id, label, value }) => ({ id, label, value })) };
    });
    const format = chooseMenuFormat({ display, options, channel: chat?.channel });
    const numbered = buildNumberedText(menuText, options);
    let enviado = false;
    if (format === 'buttons' || format === 'list') {
      enviado = await sendMenuInteractive({
        chat,
        chatId,
        flowData,
        node,
        interactive: buildMenuInteractive({ bodyText: menuText, options, format, listButtonText: parseText(node.data?.listButtonText || '', contextWithAlias) }),
        previewText: numbered
      });
    }
    if (!enviado) await addBotMessage(chatId, numbered, null, sendMessage);
    await setCurrentNodeId(chatId, node.id);
    return;
  }

  if (node.type === 'holderNode') {
    const holderText = parseText(node.data?.text || '', contextWithAlias);
    if (holderText) {
      await addBotMessage(chatId, holderText, null, sendMessage);
    }
    await setCurrentNodeId(chatId, node.id);
    await updateChatById(chatId, (chat) => {
      chat.holderContext = {
        nodeId: node.id,
        messages: [],
        fallbackSent: false,
        startedAt: new Date().toISOString()
      };
    });
    return;
  }

  if (node.type === 'ratingNode') {
    const questionText = parseText(node.data?.text || 'Avalie este atendimento de 1 a 5.', contextWithAlias);
    await addBotMessage(chatId, questionText, null, sendMessage);
    await setCurrentNodeId(chatId, node.id);
    return;
  }

  if (node.type === 'templateNode') {
    const templateId = node.data?.templateId;
    let template = templates.find((t) => String(t.id) === String(templateId));
    if (template) {
      const text = parseText(template.text, contextWithAlias);
      await addBotMessage(chatId, text, template.buttons, sendMessage);
      await setCurrentNodeId(chatId, node.id);
    } else {
      if (templateId && adapter?.db) {
        try {
          template = await adapter.db.collection('templates').findOne({ id: String(templateId) });
          if (!template) {
            template = await adapter.db.collection('messageTemplates').findOne({ id: String(templateId) });
          }
        } catch (err) {
          console.warn('[FLOW] Falha ao buscar template direto no Mongo:', err.message);
        }
      }

      if (template) {
        const text = parseText(template.text, contextWithAlias);
        await addBotMessage(chatId, text, template.buttons, sendMessage);
        await setCurrentNodeId(chatId, node.id);
      } else {
        console.warn('[FLOW] Template nao encontrado:', templateId, 'templates carregados:', templates.length);
        await addBotMessage(chatId, 'Template nao encontrado.', null, sendMessage);
      }
    }
    return;
  }

  if (node.type === 'whatsappTemplateNode') {
    const nextEdge = flowData.edges.find((e) => e.source === nodeId);
    const contentKind = node.data?.contentKind === 'interactive' ? 'interactive' : 'template';

    if (chat?.channel !== 'whatsapp') {
      if (node.data?.nonWhatsappAction === 'sendFallback') {
        const fallbackText = parseText(node.data?.fallbackText || '', contextWithAlias).trim();
        if (fallbackText) {
          await addBotMessage(chatId, fallbackText, null, sendMessage);
        }
      }

      if (nextEdge) {
        await runFlow({
          nodeId: nextEdge.target,
          flowData,
          currentVars,
          chatId,
          templates,
          schedules,
          sendMessage,
          sendMedia: effectiveSendMedia
        });
      }
      return;
    }

    const config = await getWhatsAppConfig(chat?.tenantId || null);
    const { sender, ignoredSenderId } = resolveFlowNodeWhatsAppSender(
      config,
      node.data?.senderPhoneNumberId || null,
      chat?.whatsappPhoneNumberId || null
    );
    const senderLogContext = { tenantId: chat?.tenantId || null, flowId: flowData?.id || null, nodeId: node?.id || null };
    if (ignoredSenderId) {
      console.warn('[FLOW] Remetente fixado no no nao pertence ao tenant; usando o remetente da conversa', senderLogContext);
    }
    if (!config?.enabled || !config?.accessToken || !sender?.phoneNumberId) {
      console.warn('[FLOW] WhatsApp sem canal ou remetente para enviar o no', senderLogContext);
      await addBotMessage(chatId, 'Canal WhatsApp nao configurado para envio.', null, null, {
        type: contentKind === 'interactive' ? 'whatsapp_interactive_error' : 'whatsapp_template_error',
        templateId: contentKind === 'interactive' ? node.data?.interactiveTemplateId || null : node.data?.whatsappTemplateId || null
      });
      return;
    }

    const to = normalizeWhatsappWaId(chat?.channelUserId || '');
    if (!to) {
      await addBotMessage(chatId, 'Numero de destino invalido para envio WhatsApp.', null, null, {
        type: contentKind === 'interactive' ? 'whatsapp_interactive_error' : 'whatsapp_template_error',
        templateId: contentKind === 'interactive' ? node.data?.interactiveTemplateId || null : node.data?.whatsappTemplateId || null
      });
      return;
    }

    try {
      let previewText = '';
      let result = null;
      let meta = null;

      if (contentKind === 'interactive') {
        const interactiveTemplate = await getWhatsAppInteractiveTemplateById(chat?.tenantId || null, node.data?.interactiveTemplateId);
        if (!interactiveTemplate) {
          await addBotMessage(chatId, 'Interactive WhatsApp nao encontrada.', null, null, {
            type: 'whatsapp_interactive_error',
            templateId: node.data?.interactiveTemplateId || null
          });
          return;
        }

        const interactivePayload = buildWhatsAppInteractivePayload(interactiveTemplate, contextWithAlias);
        if (!interactivePayload?.action) {
          await addBotMessage(chatId, 'Interactive WhatsApp invalida.', null, null, {
            type: 'whatsapp_interactive_error',
            templateId: interactiveTemplate.id,
            templateName: interactiveTemplate.name
          });
          return;
        }

        previewText = buildWhatsAppInteractivePreview(interactiveTemplate, contextWithAlias);
        result = await sendWhatsAppInteractive({
          accessToken: config.accessToken,
          phoneNumberId: sender.phoneNumberId,
          to,
          interactive: interactivePayload,
          debugContext: {
            tenantId: chat?.tenantId || null,
            flowId: flowData?.id || null,
            nodeId: node?.id || null,
            templateId: interactiveTemplate.id,
            templateName: interactiveTemplate.name
          }
        });
        meta = {
          type: 'whatsapp_interactive',
          templateId: interactiveTemplate.id,
          templateName: interactiveTemplate.name,
          interactiveKind: interactiveTemplate.kind,
          senderPhoneNumberId: sender.phoneNumberId,
          providerMessageId: result?.messages?.[0]?.id || null,
          deliveryStatus: 'sent',
          deliveryStatusAt: new Date().toISOString(),
          waitForReply: node.data?.waitForReply !== false
        };
      } else {
        const whatsappTemplate = await getWhatsAppTemplateById(chat?.tenantId || null, node.data?.whatsappTemplateId);
        if (!whatsappTemplate) {
          await addBotMessage(chatId, 'Template WhatsApp nao encontrado.', null, null, {
            type: 'whatsapp_template_error',
            templateId: node.data?.whatsappTemplateId || null
          });
          return;
        }

        const values = resolveWhatsAppTemplateValues(node.data || {}, contextWithAlias);
        const inputDef = describeWhatsAppTemplateInputs(whatsappTemplate);
        const components = buildWhatsAppTemplateComponents(whatsappTemplate, values);
        previewText = buildWhatsAppTemplatePreview(whatsappTemplate, values);
        result = await sendWhatsAppTemplate({
          accessToken: config.accessToken,
          phoneNumberId: sender.phoneNumberId,
          to,
          templateName: whatsappTemplate.name,
          languageCode: whatsappTemplate.language,
          components,
          debugContext: {
            tenantId: chat?.tenantId || null,
            flowId: flowData?.id || null,
            nodeId: node?.id || null,
            templateId: whatsappTemplate.id,
            inputDef,
            values
          }
        });
        meta = {
          type: 'whatsapp_template',
          templateId: whatsappTemplate.id,
          templateName: whatsappTemplate.name,
          languageCode: whatsappTemplate.language,
          senderPhoneNumberId: sender.phoneNumberId,
          providerMessageId: result?.messages?.[0]?.id || null,
          deliveryStatus: 'sent',
          deliveryStatusAt: new Date().toISOString(),
          waitForReply: node.data?.waitForReply !== false
        };
      }

      await updateChatById(chatId, (currentChat) => {
        currentChat.whatsappPhoneNumberId = sender.phoneNumberId;
        currentChat.whatsappSenderLabel = sender.label || sender.displayNumber || currentChat.whatsappSenderLabel || null;
      });

      await addBotMessage(
        chatId,
        previewText || (contentKind === 'interactive' ? 'Interactive WhatsApp enviada.' : 'Template WhatsApp enviado.'),
        null,
        null,
        meta
      );

      if (node.data?.waitForReply !== false) {
        await setCurrentNodeId(chatId, node.id);
        return;
      }

      if (nextEdge) {
        await runFlow({
          nodeId: nextEdge.target,
          flowData,
          currentVars,
          chatId,
          templates,
          schedules,
          sendMessage,
          sendMedia: effectiveSendMedia
        });
      }
    } catch (error) {
      await addBotMessage(
        chatId,
        `Erro ao enviar WhatsApp: ${error.message || 'erro desconhecido'}`,
        null,
        null,
        {
          type: contentKind === 'interactive' ? 'whatsapp_interactive_error' : 'whatsapp_template_error',
          templateId: contentKind === 'interactive' ? node.data?.interactiveTemplateId || null : node.data?.whatsappTemplateId || null
        }
      );
    }
    return;
  }

  if (node.type === 'mediaNode') {
    const rawMediaType = String(node.data?.mediaType || 'document').toLowerCase();
    const mediaUrl = parseText(node.data?.mediaUrl || '', contextWithAlias).trim();
    // GIFs must be sent as video on WhatsApp
    const isGif = /\.gif(\?.*)?$/i.test(mediaUrl);
    const mediaType = (rawMediaType === 'image' && isGif) ? 'video' : rawMediaType;
    const caption = parseText(node.data?.caption || '', contextWithAlias);
    const fileName = parseText(node.data?.fileName || '', contextWithAlias);

    if (!mediaUrl) {
      await addBotMessage(chatId, 'Erro: media sem URL configurada.', null, sendMessage);
    } else {
      await addBotMedia(chatId, { mediaType, mediaUrl, caption, fileName }, effectiveSendMedia);
    }

    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars,
        chatId,
        templates,
        schedules,
        sendMessage,
        sendMedia: effectiveSendMedia
      });
    }
    return;
  }

  if (node.type === 'catalogNode') {
    const chat = await getChatById(chatId);
    const options = await resolveCatalogOptions(node, chat, contextWithAlias);

    if (!options.length) {
      await addBotMessage(chatId, parseText(node.data?.emptyMessage || 'Nenhum item disponível no momento.', contextWithAlias), null, sendMessage);
      const edge = flowData.edges.find((e) => e.source === nodeId);
      if (edge) {
        await runFlow({
          nodeId: edge.target,
          flowData,
          currentVars,
          chatId,
          templates,
          schedules,
          sendMessage,
          sendMedia: effectiveSendMedia
        });
      }
      return;
    }

    const showButtons = node.data?.showButtons !== false;
    const buttons = showButtons
      ? options.map((item) => ({
        id: item.id,
        label: item.name
      }))
      : null;
    const prompt = buildCatalogPrompt(node.data || {}, options, contextWithAlias);

    await addBotMessage(chatId, prompt, buttons, sendMessage);
    if (!showButtons) {
      await updateChatById(chatId, (currentChat) => {
        currentChat.catalogContext = null;
      });
      const edge = flowData.edges.find((e) => e.source === nodeId);
      if (edge) {
        await runFlow({
          nodeId: edge.target,
          flowData,
          currentVars,
          chatId,
          templates,
          schedules,
          sendMessage,
          sendMedia: effectiveSendMedia
        });
      }
      return;
    }
    await updateChatById(chatId, (currentChat) => {
      currentChat.catalogContext = {
        nodeId: node.id,
        options
      };
    });
    await setCurrentNodeId(chatId, node.id);
    return;
  }

  if (node.type === 'conditionNode') {
    let matchedHandleId = 'else';
    for (const cond of node.data?.conditions || []) {
      const varValue = contextWithAlias[cond.variable] !== undefined ? contextWithAlias[cond.variable] : '';
      const condValue = resolveInterpolatedValue(cond.value, contextWithAlias);
      let isMatch = false;
      const v1 = String(varValue).trim().toLowerCase();
      const v2 = String(condValue).trim().toLowerCase();
      switch (cond.operator) {
        case '==': isMatch = v1 === v2; break;
        case '!=': isMatch = v1 !== v2; break;
        case '>': {
          const left = Number(varValue);
          const right = Number(condValue);
          isMatch = String(varValue).trim() !== '' && String(condValue).trim() !== '' && Number.isFinite(left) && Number.isFinite(right) && left > right;
          break;
        }
        case '<': {
          const left = Number(varValue);
          const right = Number(condValue);
          isMatch = String(varValue).trim() !== '' && String(condValue).trim() !== '' && Number.isFinite(left) && Number.isFinite(right) && left < right;
          break;
        }
        case 'contains': isMatch = v1.includes(v2); break;
        default: isMatch = v1 === v2;
      }
      if (isMatch) {
        matchedHandleId = String(cond.id);
        break;
      }
    }

    const edgesFromNode = flowData.edges.filter((e) => e.source === nodeId);
    const edgeToCase = edgesFromNode.find((e) => String(e.sourceHandle) === String(matchedHandleId));
    if (edgeToCase) {
      const caseNodeId = edgeToCase.target;
      const nextEdge = flowData.edges.find((e) => e.source === caseNodeId);
      if (nextEdge) {
        await runFlow({
          nodeId: nextEdge.target,
          flowData,
          currentVars,
          chatId,
          templates,
          schedules,
          sendMessage
        });
      }
    }
    return;
  }

  if (node.type === 'scriptNode') {
    // Política de runtime: erros NUNCA são enviados ao cliente final. A
    // defesa primária está no save do flow (src/routes/flows.js valida AST
    // antes de gravar). Se algo escapar aqui — script herdado, race
    // condition, timeout do vm — registramos no systemLogs e SEGUIMOS para
    // o próximo node como se o script tivesse passado (com vars inalteradas).
    const script = String(node.data?.script || '');
    const followNextEdge = async (varsToUse) => {
      const edge = flowData.edges.find((e) => e.source === nodeId);
      if (!edge) return;
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars: varsToUse,
        chatId,
        templates,
        schedules,
        sendMessage
      });
    };
    const logScriptFailure = async (reason, kind) => {
      try {
        await createLog('FLOW_SCRIPT_BLOCKED', {
          tenantId: chat?.tenantId || null,
          chatId,
          nodeId,
          kind,
          reason
        }, 'system');
      } catch (_) {
        // never propagate logging failure
      }
    };

    try {
      try {
        validateScript(script);
      } catch (validationError) {
        await logScriptFailure(validationError.message, 'validation');
        await followNextEdge(currentVars);
        return;
      }

      const safeVars = JSON.parse(JSON.stringify(currentVars));
      const safeSecrets = JSON.parse(JSON.stringify(secureVars || {}));
      const sandbox = vm.createContext({ vars: safeVars, secrets: safeSecrets }, {
        name: `flow-script-${chatId}`,
        codeGeneration: { strings: false, wasm: false }
      });
      vm.runInContext(`"use strict"; ${script};`, sandbox, { timeout: 200 });
      const updatedVars = sandbox.vars;
      if (!updatedVars || typeof updatedVars !== 'object') {
        throw new Error('Script deve manter o objeto vars como objeto');
      }
      await setChatVars(chatId, updatedVars);
      await followNextEdge(updatedVars);
    } catch (err) {
      await logScriptFailure(err?.message || String(err), 'execution');
      await followNextEdge(currentVars);
    }
    return;
  }

  if (node.type === 'httpRequestNode') {
    // Com integracao, o node guarda so o caminho: endereco e chave vem do
    // cadastro da integracao, resolvidos aqui no servidor.
    const integrationId = String(node.data?.integrationId || '').trim();
    let url = integrationId ? '' : encodeURI(parseText(node.data?.url, privateContextWithAlias));
    let integrationAuth = {};
    try {
      if (chat?.isFlowTest) throw new Error('Requisicao externa bloqueada no sandbox');
      if (integrationId) {
        const prepared = await prepareIntegrationRequest({
          tenantId: chat?.tenantId,
          integrationId,
          path: node.data?.path,
          vars: privateContextWithAlias
        });
        url = prepared.url;
        integrationAuth = prepared.authHeaders;
      } else {
        await validateExternalUrl(url);
      }
      const method = (node.data?.method || 'GET').toUpperCase();
      const resolveHeaderValues = (inputHeaders) => {
        if (!inputHeaders || typeof inputHeaders !== 'object') return {};
        const resolved = {};
        Object.entries(inputHeaders).forEach(([key, value]) => {
          if (typeof value === 'string') {
            resolved[key] = parseText(value, privateContextWithAlias);
          } else if (value === null || value === undefined) {
            resolved[key] = '';
          } else {
            resolved[key] = String(value);
          }
        });
        return resolved;
      };
      let headers = {};
      if (node.data?.headersJson) {
        try {
          headers = JSON.parse(node.data.headersJson);
        } catch (err) {
          throw new Error('Headers JSON inválido');
        }
      }

      headers = { ...resolveHeaderValues(headers), ...integrationAuth };
      let body = null;
      if (node.data?.body && method !== 'GET') {
        body = parseText(node.data.body, privateContextWithAlias);
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const controller = new AbortController();
      const timeoutMs = Number(node.data?.timeoutMs || 10000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method,
        headers,
        body: body || undefined,
        signal: controller.signal,
        // Redirecionamento poderia levar a chave da integracao para outro servidor.
        ...(integrationId ? { redirect: 'error' } : {})
      });
      clearTimeout(timeoutId);
      if (integrationId) {
        recordIntegrationResult(chat?.tenantId, integrationId, { ok: res.ok, status: res.status });
      }
      const rawText = await res.text();
      let apiData = null;
      try {
        apiData = JSON.parse(rawText);
      } catch (parseError) {
        if ((node.data?.responseType || 'json') === 'json') {
          throw new Error('Resposta não é JSON válido');
        }
        apiData = { ok: res.ok, rawText };
      }
      let newVars = {
        ...currentVars,
        HTTP_STATUS: res.status,
        HTTP_OK: res.ok,
        HTTP_RAW: rawText,
        HTTP_ERROR_MESSAGE: res.ok ? null : (apiData?.message || apiData?.error || rawText || `HTTP ${res.status}`)
      };
      if (apiData && node.data?.mappings) {
        node.data.mappings.forEach((m) => {
          let value = apiData;
          if (m.jsonPath && m.jsonPath !== '.') {
            m.jsonPath.split('.').forEach((key) => { value = value ? value[key] : undefined; });
          }
          if (m.varName) newVars[m.varName] = value;
        });
        await setChatVars(chatId, newVars);
      } else if (apiData === null) {
        await setChatVars(chatId, newVars);
      }
      const status = res.ok ? 'success' : 'error';
      const edge = flowData.edges.find((e) => e.source === nodeId && e.sourceHandle === status);
      if (edge) {
        await runFlow({
          nodeId: edge.target,
          flowData,
          currentVars: newVars,
          chatId,
          templates,
          schedules,
          sendMessage
        });
      } else {
        const fallback = flowData.edges.find((e) => e.source === nodeId);
        console.warn('[FLOW] HTTP sem aresta para status:', status, 'node:', nodeId, 'fallback:', fallback?.target);
        if (fallback) {
          await runFlow({
            nodeId: fallback.target,
            flowData,
            currentVars: newVars,
            chatId,
            templates,
            schedules,
            sendMessage
          });
        }
      }
    } catch (err) {
      console.warn('[FLOW] HTTP request error:', err.message || err, 'url:', url);
      if (integrationId && !chat?.isFlowTest) {
        recordIntegrationResult(chat?.tenantId, integrationId, { ok: false, error: err?.cause?.message || err.message });
      }
      const newVars = {
        ...currentVars,
        HTTP_OK: false,
        HTTP_STATUS: null,
        HTTP_ERROR_MESSAGE: err.message || String(err || 'HTTP error')
      };
      await setChatVars(chatId, newVars);
      const errorEdge = flowData.edges.find((e) => e.source === nodeId && e.sourceHandle === 'error');
      if (errorEdge) {
        await runFlow({
          nodeId: errorEdge.target,
          flowData,
          currentVars: newVars,
          chatId,
          templates,
          schedules,
          sendMessage
        });
      }
    }
    return;
  }

  if (node.type === 'scheduleNode') {
    const schedule = schedules.find((s) => s.id === node.data?.scheduleId);
    const tenantSettings = chat?.tenantId ? await getTenantSettings(chat.tenantId) : null;
    const isOpen = isScheduleOpen(schedule, {
      timeZone: tenantSettings?.timezone || DEFAULT_TENANT_TIMEZONE
    });
    const branch = isOpen ? 'inside' : 'outside';
    const childNode = flowData.nodes.find((n) => n.id.startsWith(`child_${nodeId}_${branch}`));
    if (childNode) {
      const nextEdge = flowData.edges.find((e) => e.source === childNode.id);
      if (nextEdge) {
        await runFlow({
          nodeId: nextEdge.target,
          flowData,
          currentVars,
          chatId,
          templates,
          schedules,
          sendMessage
        });
      }
    } else {
      const fallbackEdge = flowData.edges.find((e) => e.source === nodeId);
      if (fallbackEdge) {
        const nextEdge = flowData.edges.find((e) => e.source === fallbackEdge.target);
        if (nextEdge) {
          await runFlow({
            nodeId: nextEdge.target,
            flowData,
            currentVars,
            chatId,
            templates,
            schedules,
            sendMessage
          });
        }
      }
    }
    return;
  }

  if (node.type === 'setValueNode') {
    const newVars = {
      ...currentVars,
      [node.data?.variableName]: resolveInterpolatedValue(node.data?.value, contextWithAlias)
    };
    await setChatVars(chatId, newVars);
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars: newVars,
        chatId,
        templates,
        schedules,
        sendMessage
      });
    }
    return;
  }

  if (node.type === 'cartNode') {
    const newVars = applyCartOperation(currentVars, node.data || {});
    await setChatVars(chatId, newVars);
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars: newVars,
        chatId,
        templates,
        schedules,
        sendMessage,
        sendMedia: effectiveSendMedia
      });
    }
    return;
  }

  if (node.type === 'secretNode') {
    const variableName = String(node.data?.variableName || '').trim();
    const nextSecureVars = { ...secureVars };
    if (variableName) {
      const rawValue = tryDecryptSecret(node.data?.value);
      nextSecureVars[variableName] = resolveInterpolatedValue(rawValue, privateContextWithAlias);
    }
    await setChatSecureVars(chatId, nextSecureVars);
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars,
        chatId,
        templates,
        schedules,
        sendMessage,
        sendMedia: effectiveSendMedia
      });
    }
    return;
  }

  if (node.type === 'delayNode') {
    const delayMs = (parseInt(node.data?.delay, 10) || 1) * 1000;
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (chat?.isFlowTest) {
      if (edge) {
        await runFlow({
          nodeId: edge.target,
          flowData,
          currentVars,
          chatId,
          templates,
          schedules,
          sendMessage,
          sendMedia: effectiveSendMedia
        });
      }
      return;
    }
    const effectiveDelayMs = Math.max(delayMs, 1000);
    await setChatDelayState(chatId, node.id, edge?.target || null, effectiveDelayMs);
    // Timer para o segundo exato; o watcher de runtime cobre se ele se perder.
    if (edge?.target) scheduleDelayResume(chatId, effectiveDelayMs);
    return;
  }

  if (node.type === 'gotoNode') {
    const targetAnchorName = node.data?.targetAnchor;
    const anchorNode = flowData.nodes.find(
      (n) => n.type === 'anchorNode' && n.data?.anchorName === targetAnchorName
    );
    if (anchorNode) {
      await runFlow({
        nodeId: anchorNode.id,
        flowData,
        currentVars,
        chatId,
        templates,
        schedules,
        sendMessage
      });
    } else {
      // Âncora inexistente: não vaza erro técnico para o cliente. Registra no
      // backend e finaliza o fluxo (o nó é terminal neste caminho).
      try {
        await createLog('FLOW_GOTO_MISSING_ANCHOR', {
          tenantId: chat?.tenantId || null,
          chatId,
          nodeId,
          targetAnchor: targetAnchorName || null
        }, 'system');
      } catch (_) {
        // logging best-effort
      }
    }
    return;
  }

  if (node.type === 'anchorNode') {
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars,
        chatId,
        templates,
        schedules,
        sendMessage
      });
    }
    return;
  }

  if (node.type === 'commandNode') {
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars,
        chatId,
        templates,
        schedules,
        sendMessage
      });
    }
    return;
  }

  if (node.type === 'caseNode') {
    const edge = flowData.edges.find((e) => e.source === nodeId);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars,
        chatId,
        templates,
        schedules,
        sendMessage
      });
    }
    return;
  }

  /* Entra no subfluxo: guarda para onde voltar e passa a executar o grafo
   * mesclado a partir da entrada do subfluxo. */
  if (node.type === 'subflowNode') {
    const subflowId = String(node.data?.subflowId || '').trim();
    const errorTarget = findSubflowOutlet(flowData, nodeId, 'error');

    const failToError = async (reason) => {
      console.warn(`[SUBFLOW] ${reason} (node ${nodeId}, chat ${chatId})`);
      const newVars = { ...currentVars, SUBFLUXO_ERRO: reason };
      await setChatVars(chatId, newVars);
      await updateChatById(chatId, (chat) => { chat.subflowContext = null; });
      if (errorTarget) {
        await runFlow({
          nodeId: errorTarget, flowData, currentVars: newVars, chatId,
          templates, schedules, sendMessage, sendMedia: effectiveSendMedia
        });
      }
    };

    if (!subflowId) return failToError('Subfluxo nao selecionado no node');

    const subflow = await getPublishedSubflowGraph(chat?.tenantId, subflowId);
    if (!subflow) return failToError('Subfluxo nao encontrado ou sem versao publicada');

    const prefixed = prefixSubflowGraph(subflow);
    const entry = prefixed.nodes.find((item) => item.type === 'startNode');
    if (!entry) return failToError('Subfluxo sem ponto de entrada');

    await updateChatById(chatId, (currentChat) => {
      currentChat.subflowContext = {
        subflowId,
        returnNodeId: findSubflowOutlet(flowData, nodeId, 'success'),
        resumedNodeId: findSubflowOutlet(flowData, nodeId, 'resumed'),
        errorNodeId: errorTarget,
        enteredAt: new Date().toISOString()
      };
    });

    await runFlow({
      nodeId: entry.id,
      flowData: mergeSubflowIntoGraph(flowData, prefixed),
      currentVars,
      chatId,
      templates,
      schedules,
      sendMessage,
      sendMedia: effectiveSendMedia
    });
    return;
  }

  /* Saida normal do subfluxo: devolve o controle ao fluxo pai. As variaveis ja
   * estao no chat, entao nao ha nada a "entregar" alem de limpar o contexto. */
  if (node.type === 'subflowReturnNode') {
    const liveChat = await getChatById(chatId);
    const returnNodeId = liveChat?.subflowContext?.returnNodeId || null;
    await updateChatById(chatId, (currentChat) => { currentChat.subflowContext = null; });

    if (!returnNodeId) {
      console.warn(`[SUBFLOW] Retorno sem destino no pai (chat ${chatId})`);
      return;
    }
    await runFlow({
      nodeId: returnNodeId, flowData, currentVars, chatId,
      templates, schedules, sendMessage, sendMedia: effectiveSendMedia
    });
    return;
  }

  if (node.type === 'queueNode') {
    // Mensagem de encaminhamento e opcional. sendQueueMessage === false encaminha
    // em silencio (sem avisar o cliente). Ausencia da flag preserva o comportamento
    // historico: envia a mensagem configurada, ou o texto padrao quando em branco.
    const shouldSendQueueMessage = node.data?.sendQueueMessage !== false;
    if (shouldSendQueueMessage) {
      const rawQueueMessage = node.data?.queueMessage;
      const waitMessage = parseText(
        (typeof rawQueueMessage === 'string' && rawQueueMessage.trim())
          ? rawQueueMessage
          : 'Aguarde, em alguns instantes um especialista deve te atender.',
        contextWithAlias
      );
      await addBotMessage(chatId, waitMessage, null, sendMessage);
    }
    const nextEdge = flowData.edges.find((e) => e.source === nodeId);
    const resumeNodeId = nextEdge ? nextEdge.target : null;
    await updateChatById(chatId, (chat) => {
      chat.status = 'waiting';
      chat.queue = node.data?.queueName || 'default';
      chat.waitingSince = new Date().toISOString();
      chat.continueFlowAfterQueue = node.data?.continueFlowAfterQueue ?? true;
      chat.resumeNodeId = resumeNodeId;
      chat.resumePending = false;
    });
    return;
  }

  if (node.type === 'endNode' || node.type === 'finalNode') {
    const finalMessage = parseText(
      node.data?.text || 'Atendimento finalizado. Obrigado!',
      contextWithAlias
    );
    await addBotMessage(chatId, finalMessage, null, sendMessage);
    await updateChatById(chatId, (chat) => {
      applyFlowRuntimeReset(chat);
      chat.status = 'closed';
      chat.closedAt = new Date().toISOString();
    });
    // A nota ja foi registrada quando o cliente respondeu o no de nota
    // (recordRating). Contar aqui de novo duplicava.
    return;
  }
};

export const applyUserInput = async ({
  chat,
  flowData,
  text,
  buttonId,
  buttonText,
  responsePayload,
  templates,
  schedules,
  sendMessage,
  sendMedia
}) => {
  const currentVars = chat?.vars || {};
  const systemVars = buildSystemVars(chat);
  const contextWithAlias = { ...systemVars, ...currentVars };
  if (!chat?.currentNodeId) {
    if (await tryHandleGlobalCommand({
      chat,
      flowData,
      text,
      templates,
      schedules,
      sendMessage,
      sendMedia
    })) {
      return { handled: true, reason: 'command' };
    }
    return { handled: false, reason: 'no_current_node' };
  }
  // Se o chat parou dentro de um subfluxo, o grafo precisa incluir os nodes
  // daquele subfluxo, senao o node atual nao e encontrado e a conversa reseta.
  if (chat?.subflowContext?.subflowId) {
    flowData = await resolveExecutionGraph(chat, flowData);
  }

  const node = flowData.nodes.find((n) => n.id === chat.currentNodeId);
  if (!node) {
    console.warn(`[FLOW] Current node not found for chat ${chat.id}: ${chat.currentNodeId}`);
    await updateChatById(chat.id, (currentChat) => {
      applyFlowRuntimeReset(currentChat);
      if (currentChat.status === 'bot') {
        currentChat.flowStarted = false;
      }
    });
    return { handled: false, reason: 'missing_current_node' };
  }

  if (canApplyGlobalCommand(node.type, text) && await tryHandleGlobalCommand({
    chat,
    flowData,
    text,
    templates,
    schedules,
    sendMessage,
    sendMedia
  })) {
    return { handled: true, reason: 'command' };
  }

  if (node.data?.disabled === true && node.type !== 'startNode') {
    const nextNodeId = getDisabledNodeNextId(node, flowData.edges);
    if (!nextNodeId) return { handled: true, reason: 'disabled_node_without_single_output' };
    await setCurrentNodeId(chat.id, null);
    await runFlow({
      nodeId: nextNodeId,
      flowData,
      currentVars,
      chatId: chat.id,
      templates,
      schedules,
      sendMessage,
      sendMedia
    });
    return { handled: true, reason: 'disabled_node_skipped' };
  }

  console.log(`[FLOW] User input on ${node.type} (${node.id}) at ${new Date().toISOString()}`);

  if (node.type === 'delayNode') {
    return { handled: true, reason: 'delay_waiting' };
  }

  if (node.type === 'sequentialNode') {
    const liveChat = await getChatById(chat.id);
    const sequentialContext = liveChat?.sequentialContext || chat?.sequentialContext || null;
    const steps = getSequentialSteps(node.data);

    if (!steps.length) {
      await clearSequentialWaitState(chat.id);
      const edge = flowData.edges.find((e) => e.source === node.id);
      if (edge) {
        await runFlow({
          nodeId: edge.target,
          flowData,
          currentVars,
          chatId: chat.id,
          templates,
          schedules,
          sendMessage,
          sendMedia
        });
      }
      return { handled: true, reason: 'sequential_empty' };
    }

    let stepIndex = Number.parseInt(sequentialContext?.stepIndex, 10);
    if (String(sequentialContext?.nodeId || '') !== String(node.id)) {
      stepIndex = 0;
    }
    if (!Number.isFinite(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
      stepIndex = 0;
    }
    const currentStep = steps[stepIndex];
    const stepContext = resolveVariables(node.data?.varMap, { ...systemVars, ...currentVars });

    if (!currentStep) {
      await clearSequentialWaitState(chat.id);
      return { handled: true, reason: 'sequential_invalid_step' };
    }

    if (currentStep.type === 'input') {
      const varName = String(currentStep.variableName || '').trim();
      let newVars = { ...currentVars };

      if (!varName) {
        await addBotMessage(chat.id, 'Erro: passo de entrada sem variavel configurada.', null, sendMessage);
      } else {
        newVars[varName] = text;
        await setChatVars(chat.id, newVars);
      }

      await clearSequentialWaitState(chat.id);
      await runFlow({
        nodeId: node.id,
        flowData,
        currentVars: newVars,
        chatId: chat.id,
        templates,
        schedules,
        sendMessage,
        sendMedia,
        sequentialStepIndex: stepIndex + 1
      });
      return { handled: true, reason: 'sequential_input' };
    }

    if (currentStep.type === 'menu') {
      const selected = findSequentialMenuSelection({
        options: currentStep.options,
        text,
        buttonId
      });

      if (!selected) {
        const invalidMessage = parseText(
          currentStep.invalidSelectionMessage || 'Selecione uma opcao valida.',
          stepContext
        );
        await addBotMessage(chat.id, invalidMessage, null, sendMessage);
        return { handled: true, reason: 'sequential_menu_invalid' };
      }

      let newVars = { ...currentVars };
      if (currentStep.setVarEnabled && currentStep.variableName) {
        newVars[currentStep.variableName] = selected.value ?? selected.label ?? selected.id;
        await setChatVars(chat.id, newVars);
      }

      await clearSequentialWaitState(chat.id);
      await runFlow({
        nodeId: node.id,
        flowData,
        currentVars: newVars,
        chatId: chat.id,
        templates,
        schedules,
        sendMessage,
        sendMedia,
        sequentialStepIndex: stepIndex + 1
      });
      return { handled: true, reason: 'sequential_menu' };
    }

    await clearSequentialWaitState(chat.id);
    await runFlow({
      nodeId: node.id,
      flowData,
      currentVars,
      chatId: chat.id,
      templates,
      schedules,
      sendMessage,
      sendMedia,
      sequentialStepIndex: stepIndex + 1
    });
    return { handled: true, reason: 'sequential_advance' };
  }

  if (node.type === 'holderNode') {
    const inboundText = String(text ?? buttonText ?? responsePayload ?? buttonId ?? '').trim();
    const exitKeywords = parseHolderExitKeywords(node.data?.exitKeywords);
    const normalizedInbound = inboundText.toLowerCase();
    const shouldExit = Boolean(normalizedInbound && exitKeywords.includes(normalizedInbound));
    const exitEdge = shouldExit ? flowData.edges.find((e) => e.source === node.id) : null;

    if (shouldExit && exitEdge) {
      await setCurrentNodeId(chat.id, null);
      await updateChatById(chat.id, (currentChat) => {
        currentChat.holderContext = null;
      });
      await runFlow({
        nodeId: exitEdge.target,
        flowData,
        currentVars,
        chatId: chat.id,
        templates,
        schedules,
        sendMessage,
        sendMedia
      });
      return { handled: true, reason: 'holder_exit_keyword' };
    }

    let nextVars = { ...currentVars };
    let shouldSendFallback = false;
    let fallbackText = '';

    await updateChatById(chat.id, (currentChat) => {
      const context = (currentChat.holderContext && currentChat.holderContext.nodeId === node.id)
        ? currentChat.holderContext
        : { nodeId: node.id, messages: [], fallbackSent: false, startedAt: new Date().toISOString() };
      const messages = Array.isArray(context.messages) ? [...context.messages] : [];

      if (inboundText && node.data?.saveMessages !== false) {
        messages.push({
          text: inboundText,
          at: new Date().toISOString()
        });

        const plainMessages = messages.map((item) => String(item?.text || '')).filter(Boolean);
        nextVars = { ...(currentChat.vars || nextVars) };

        if (node.data?.lastMessageVar) {
          nextVars[node.data.lastMessageVar] = inboundText;
        }
        if (node.data?.listVar) {
          nextVars[node.data.listVar] = plainMessages;
        }
        if (node.data?.textVar) {
          nextVars[node.data.textVar] = plainMessages.join('\n');
        }
        if (node.data?.countVar) {
          nextVars[node.data.countVar] = plainMessages.length;
        }

        const secureVarKeys = buildSecureVarKeySet(currentChat?.secureVars, currentChat?.secureVarNames);
        currentChat.vars = stripSecureVars(nextVars, secureVarKeys);
      }

      fallbackText = parseText(node.data?.fallbackText || '', { ...systemVars, ...(currentChat.vars || nextVars) });
      shouldSendFallback = Boolean(fallbackText && (node.data?.fallbackOnce === false || !context.fallbackSent));
      currentChat.holderContext = {
        ...context,
        messages,
        fallbackSent: context.fallbackSent || shouldSendFallback,
        updatedAt: new Date().toISOString()
      };
      currentChat.currentNodeId = node.id;
      currentChat.currentNodeEnteredAt = currentChat.currentNodeEnteredAt || new Date().toISOString();
    });

    if (shouldSendFallback) {
      await addBotMessage(chat.id, fallbackText, null, sendMessage);
    }

    return { handled: true, reason: 'holderNode' };
  }

  if (node.type === 'ratingNode') {
    const answered = (text || '').trim();
    if (!/^[1-5]$/.test(answered)) {
      const errorMessage = node.data?.errorText || 'Digite um numero entre 1 e 5.';
      await addBotMessage(chat.id, errorMessage, null, sendMessage);
      return { handled: true, reason: 'rating_validation_error' };
    }
    const varName = node.data?.variableName || 'nota';
    const ratingValue = Number(answered);
    const newVars = { ...currentVars, [varName]: ratingValue };
    await setChatVars(chat.id, newVars);
    // A nota vale no momento em que e dada, para o atendente que atendeu.
    await recordRating({ chat, value: ratingValue, variableName: varName, nodeId: node.id }).catch((error) => {
      console.warn('[RATING] Falha ao registrar nota', { chatId: chat.id, error: error?.message });
    });
    const edge = flowData.edges.find((e) => e.source === node.id);
    if (edge) {
      await setCurrentNodeId(chat.id, null);
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars: newVars,
        chatId: chat.id,
        templates,
        schedules,
        sendMessage,
        sendMedia
      });
    }
    return { handled: true, reason: 'ratingNode' };
  }

  if (node.type === 'inputNode') {
    const varName = node.data?.variableName;
    if (!varName) {
      await addBotMessage(chat.id, 'Erro: este no de input nao tem variavel configurada.', null, sendMessage);
      return { handled: true, reason: 'input_config_error' };
    }
    const validation = validateInputValue({
      value: text,
      validationType: node.data?.validationType,
      validationPattern: node.data?.validationPattern
    });
    if (!validation.valid) {
      const attemptCount = await updateInputAttempt(chat.id, node.id);
      const maxAttempts = Math.max(0, Math.min(100, Number(node.data?.maxAttempts) || 0));
      const shouldBranch = node.data?.onFailBehavior === 'branch'
        && maxAttempts > 0
        && attemptCount >= maxAttempts;
      const errorMessage = parseText(
        node.data?.errorText || 'Resposta invalida. Tente novamente.',
        contextWithAlias
      );
      await addBotMessage(chat.id, errorMessage, null, sendMessage);

      if (shouldBranch) {
        const invalidEdge = flowData.edges.find(
          (edge) => edge.source === node.id && String(edge.sourceHandle) === 'invalid'
        );
        if (invalidEdge) {
          await updateInputAttempt(chat.id, node.id, 'clear');
          await setCurrentNodeId(chat.id, null);
          await runFlow({
            nodeId: invalidEdge.target,
            flowData,
            currentVars,
            chatId: chat.id,
            templates,
            schedules,
            sendMessage,
            sendMedia
          });
          return { handled: true, reason: 'input_validation_branch' };
        }
        console.warn(`[FLOW] Input invalid branch not connected (${node.id})`);
      }

      const questionText = parseText(node.data?.text || 'Digite uma informacao:', contextWithAlias);
      await addBotMessage(chat.id, questionText, null, sendMessage);
      return { handled: true, reason: 'input_validation_error' };
    }

    const newVars = { ...currentVars, [varName]: validation.value };
    await setChatVars(chat.id, newVars);
    await updateInputAttempt(chat.id, node.id, 'clear');
    const edge = flowData.edges.find(
      (candidate) => candidate.source === node.id && String(candidate.sourceHandle || 'default') === 'default'
    ) || flowData.edges.find(
      (candidate) => candidate.source === node.id && String(candidate.sourceHandle || '') !== 'invalid'
    );
    if (edge) {
      console.log(`[FLOW] Input edge -> ${edge.target}`);
      await setCurrentNodeId(chat.id, null);
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars: newVars,
        chatId: chat.id,
        templates,
        schedules,
        sendMessage,
        sendMedia
      });
    }
    return { handled: true, reason: 'inputNode' };
  }

  if (node.type === 'menuNode') {
    // Compara com as opcoes que o cliente recebeu; sem registro (menu antigo
    // ou conversa de antes desta versao), com as opcoes do node.
    const dinamico = isDynamicMenu(node.data);
    const enviadas = chat.menuContext?.nodeId === node.id && Array.isArray(chat.menuContext.options)
      ? chat.menuContext.options
      : null;
    const options = enviadas || resolveMenuOptions(node.data, contextWithAlias, (texto) => parseText(texto, contextWithAlias));
    const selected = matchMenuOption({ options, text, buttonId });

    if (!selected) {
      const elseEdge = flowData.edges.find(
        (e) => e.source === node.id && String(e.sourceHandle) === 'else'
      );
      if (elseEdge) {
        const nextEdge = flowData.edges.find((e) => e.source === elseEdge.target);
        if (nextEdge) {
          await setCurrentNodeId(chat.id, null);
          await runFlow({
            nodeId: nextEdge.target,
            flowData,
            currentVars,
            chatId: chat.id,
            templates,
            schedules,
            sendMessage,
            sendMedia
          });
          return { handled: true, reason: 'menu_else' };
        }
      }
      await addBotMessage(
        chat.id,
        parseText(node.data?.invalidSelectionMessage || 'Selecione uma opção válida.', contextWithAlias),
        null,
        sendMessage
      );
      return { handled: true, reason: 'menu_invalid' };
    }

    let newVars = { ...currentVars };
    if ((node.data?.setVarEnabled || dinamico) && node.data?.variableName) {
      newVars[node.data.variableName] = selected.value ?? selected.label ?? selected.id;
      await setChatVars(chat.id, newVars);
    }
    if (enviadas) {
      await updateChatById(chat.id, (current) => { current.menuContext = null; });
    }

    // Menu dinamico tem uma saida so para quem escolheu; o fixo, uma por opcao.
    let edgeToCase = flowData.edges.find(
      (e) => e.source === node.id && String(e.sourceHandle) === (dinamico ? 'selected' : String(selected.id))
    );
    if (!edgeToCase) {
      edgeToCase = flowData.edges.find((e) => e.source === node.id);
    }
    if (edgeToCase) {
      const caseNodeId = edgeToCase.target;
      const edgeFromCase = flowData.edges.find((e) => e.source === caseNodeId);
      if (edgeFromCase) {
        await setCurrentNodeId(chat.id, null);
        await runFlow({
          nodeId: edgeFromCase.target,
          flowData,
          currentVars: newVars,
          chatId: chat.id,
          templates,
          schedules,
          sendMessage,
          sendMedia
        });
      }
    }
    return { handled: true, reason: 'menuNode' };
  }

  if (node.type === 'catalogNode') {
    const liveChat = await getChatById(chat.id);
    const context = liveChat?.catalogContext;
    let contextOptions = Array.isArray(context?.options) ? context.options : [];
    if (!contextOptions.length) {
      contextOptions = await resolveCatalogOptions(node, liveChat || chat, currentVars);
    }
    const normalizedText = String(text || '').trim().toLowerCase();
    let selected = null;

    if (buttonId) {
      selected = contextOptions.find((item) => String(item.id) === String(buttonId)) || null;
    }

    if (!selected && normalizedText) {
      if (/^\d+$/.test(normalizedText)) {
        const index = Number(normalizedText) - 1;
        selected = contextOptions[index] || null;
      }
      if (!selected) {
        selected = contextOptions.find((item) => (
          String(item.id).toLowerCase() === normalizedText ||
          String(item.name || '').toLowerCase() === normalizedText
        )) || null;
      }
      if (!selected) {
        const normalizedSearch = normalizeForMatch(normalizedText);
        selected = contextOptions.find((item) => {
          const normalizedName = normalizeForMatch(item.name);
          const normalizedId = normalizeForMatch(item.id);
          return normalizedId === normalizedSearch || normalizedName.includes(normalizedSearch);
        }) || null;
      }
      if (!selected && node.data?.showButtons === false) {
        selected = {
          id: normalizedText,
          name: String(text || '').trim(),
          price: null,
          description: '',
          sku: '',
          category: ''
        };
      }
    }

    if (!selected) {
      await addBotMessage(
        chat.id,
        parseText(node.data?.invalidSelectionMessage || 'Selecione um item válido da lista.', contextWithAlias),
        null,
        sendMessage
      );
      return { handled: true, reason: 'catalog_invalid' };
    }

    const prefixRaw = String(node.data?.varPrefix || 'PRODUTO').trim().toUpperCase();
    const prefix = prefixRaw.length ? prefixRaw.replace(/[^A-Z0-9_]/g, '_') : 'PRODUTO';
    const newVars = {
      ...currentVars,
      [`${prefix}_ID`]: selected.id,
      [`${prefix}_NOME`]: selected.name,
      [`${prefix}_PRECO`]: selected.price,
      [`${prefix}_DESCRICAO`]: selected.description || '',
      [`${prefix}_SKU`]: selected.sku || '',
      [`${prefix}_CATEGORIA`]: selected.category || ''
    };

    await setChatVars(chat.id, newVars);
    await updateChatById(chat.id, (currentChat) => {
      currentChat.catalogContext = null;
    });

    const edge = flowData.edges.find((e) => e.source === node.id);
    if (edge) {
      await setCurrentNodeId(chat.id, null);
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars: newVars,
        chatId: chat.id,
        templates,
        schedules,
        sendMessage,
        sendMedia
      });
    }
    return { handled: true, reason: 'catalogNode' };
  }

  if (node.type === 'whatsappTemplateNode') {
    const replyText = String(text || buttonText || responsePayload || '').trim();
    const payloadValue = String(responsePayload || buttonId || '').trim();
    const buttonTextValue = String(buttonText || '').trim();

    if (node.data?.contentKind === 'interactive' && !payloadValue && !buttonTextValue) {
      const errorMsg = parseText(node.data?.invalidSelectionMessage || 'Por favor, utilize os botões para responder.', contextWithAlias);
      await addBotMessage(chat.id, errorMsg, null, sendMessage);
      return { handled: true, reason: 'template_requires_button' };
    }

    const newVars = buildLatestResponseVars(currentVars, {
      text: replyText,
      buttonText: buttonTextValue,
      responsePayload: payloadValue
    });

    if (node.data?.saveResponseTextVar) {
      newVars[node.data.saveResponseTextVar] = replyText;
    }
    if (node.data?.saveResponsePayloadVar) {
      newVars[node.data.saveResponsePayloadVar] = payloadValue;
    }
    if (node.data?.saveButtonTextVar) {
      newVars[node.data.saveButtonTextVar] = buttonTextValue;
    }

    await setChatVars(chat.id, newVars);
    await setCurrentNodeId(chat.id, null);
    const edge = flowData.edges.find((e) => e.source === node.id);
    if (edge) {
      await runFlow({
        nodeId: edge.target,
        flowData,
        currentVars: newVars,
        chatId: chat.id,
        templates,
        schedules,
        sendMessage,
        sendMedia
      });
    }
    return { handled: true, reason: 'whatsappTemplateNode' };
  }

  if (node.type === 'templateNode') {
    let resolvedButtonId = buttonId;
    if (!resolvedButtonId && text) {
      const tmpl = templates.find((t) => String(t.id) === String(node.data?.templateId));
      const btns = Array.isArray(tmpl?.buttons) ? tmpl.buttons : [];
      const normalizedInput = String(text).trim().toLowerCase();
      const matched = btns.find((btn) => {
        const label = String(btn.label || btn.title || btn.text || '').trim().toLowerCase();
        const id = String(btn.id || '').trim().toLowerCase();
        return label === normalizedInput || id === normalizedInput;
      });
      if (matched) resolvedButtonId = String(matched.id || '');
    }
    if (!resolvedButtonId) {
      await addBotMessage(chat.id, 'Use os botoes para responder.', null, sendMessage);
      return { handled: true, reason: 'template_requires_button' };
    }
    console.log('[FLOW] Template click:', {
      nodeId: node.id,
      buttonId: resolvedButtonId,
      edges: flowData.edges.filter((e) => e.source === node.id).map((e) => ({
        id: e.id,
        sourceHandle: e.sourceHandle,
        target: e.target
      }))
    });
    let edgeToCase = flowData.edges.find(
      (e) => e.source === node.id && String(e.sourceHandle) === String(resolvedButtonId)
    );
    if (!edgeToCase) {
      console.warn('[FLOW] Nao encontrou aresta para botao:', resolvedButtonId, 'node:', node.id);
      edgeToCase = flowData.edges.find((e) => e.source === node.id);
    }
    if (edgeToCase) {
      const caseNodeId = edgeToCase.target;
      const edgeFromCase = flowData.edges.find((e) => e.source === caseNodeId);
      if (edgeFromCase) {
        await setCurrentNodeId(chat.id, null);
        await runFlow({
          nodeId: edgeFromCase.target,
          flowData,
          currentVars,
          chatId: chat.id,
          templates,
          schedules,
          sendMessage,
          sendMedia
        });
      }
    }
  }

  return { handled: true, reason: node.type || 'handled' };
};

export const startChatFlow = async ({ chatId, flowData, templates, schedules, sendMessage, sendMedia }) => {
  try {
    await updateChatById(chatId, (chat) => {
      applyFlowRuntimeReset(chat);
      chat.flowStarted = true;
      chat.status = 'bot';
      chat.closedAt = null;
      if (flowData?.flowId) {
        chat.flowId = flowData.flowId;
        chat.flowName = flowData.flowName || null;
      }
    });
  } catch (err) {
    // ignore
  }
  const startNode = flowData.nodes.find((n) => n.type === 'startNode');
  if (startNode) {
    const chat = await getChatById(chatId);
    if (chat?.tenantId && !chat.isFlowTest) {
      emitChatEvent({
        tenantId: chat.tenantId,
        chatId,
        type: CHAT_EVENT_TYPES.FLOW_STARTED,
        actor: { kind: 'system' },
        context: { startNodeId: startNode.id, channel: chat.channel || null }
      }).catch(() => {});
    }
    await runFlow({
      nodeId: startNode.id,
      flowData,
      currentVars: {},
      chatId,
      templates,
      schedules,
      sendMessage,
      sendMedia
    });
  }
};
