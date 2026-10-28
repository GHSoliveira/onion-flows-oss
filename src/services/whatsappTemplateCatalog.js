import crypto from 'node:crypto';
import adapter from '../../db/DatabaseAdapter.js';

const getGraphVersion = () => process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';

const buildGraphUrl = (resourceId, endpoint) => {
  const version = getGraphVersion();
  return `https://graph.facebook.com/${version}/${resourceId}/${endpoint}`;
};

const TEMPLATE_FIELDS = [
  'id',
  'name',
  'status',
  'category',
  'language',
  'components',
  'quality_score',
  'rejected_reason',
  'previous_category',
  'sub_category'
].join(',');

const TEMPLATE_TOKEN_REGEX = /\{\{\s*[^{}]+\s*\}\}/g;
const NUMERIC_TOKEN_REGEX = /^\d+$/;

const countPlaceholders = (value) => {
  const text = String(value || '');
  return (text.match(TEMPLATE_TOKEN_REGEX) || []).length;
};

const extractPlaceholderTokens = (value) => {
  const text = String(value || '');
  return (text.match(TEMPLATE_TOKEN_REGEX) || [])
    .map((token) => {
      const normalized = String(token || '').trim();
      const match = normalized.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
      const name = String(match?.[1] || '').trim();
      if (!name) return null;
      return {
        raw: normalized,
        name,
        isNumeric: NUMERIC_TOKEN_REGEX.test(name)
      };
    })
    .filter(Boolean);
};

const normalizeQualityScore = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.score || value.quality_rating || value.status || JSON.stringify(value);
  }
  return String(value);
};

const sanitizeSlug = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

const normalizeButtons = (components) => {
  const buttonsComponent = (Array.isArray(components) ? components : [])
    .find((component) => String(component?.type || '').toUpperCase() === 'BUTTONS');

  const buttons = Array.isArray(buttonsComponent?.buttons) ? buttonsComponent.buttons : [];
  return buttons.map((button, index) => ({
    index,
    type: String(button?.type || 'UNKNOWN').toUpperCase(),
    text: String(button?.text || '').trim(),
    url: button?.url || null,
    phoneNumber: button?.phoneNumber || button?.phone_number || null,
    example: button?.example || null
  }));
};

const normalizeComponents = (components) => {
  if (!Array.isArray(components)) return [];
  return components.map((component) => {
    const type = String(component?.type || '').toUpperCase();
    if (type === 'BUTTONS') {
      return {
        ...component,
        type,
        buttons: normalizeButtons([component])
      };
    }
    return {
      ...component,
      type
    };
  });
};

const buildTemplateDocument = ({
  tenantId,
  wabaId,
  phoneNumberId,
  template,
  existingByMetaId
}) => {
  const metaTemplateId = String(template?.id || `${template?.name || 'template'}:${template?.language || 'unknown'}`);
  const now = new Date().toISOString();
  const previous = existingByMetaId.get(metaTemplateId);
  const components = normalizeComponents(template?.components);
  const header = components.find((component) => component.type === 'HEADER') || null;
  const body = components.find((component) => component.type === 'BODY') || null;
  const footer = components.find((component) => component.type === 'FOOTER') || null;
  const buttons = normalizeButtons(components);

  return {
    id: previous?.id || `wa_tpl_${tenantId}_${sanitizeSlug(metaTemplateId) || crypto.randomUUID().slice(0, 8)}`,
    tenantId,
    provider: 'meta',
    channel: 'whatsapp',
    metaTemplateId,
    wabaId,
    phoneNumberId: phoneNumberId || null,
    name: String(template?.name || '').trim(),
    language: String(template?.language || '').trim(),
    category: String(template?.category || '').trim(),
    status: String(template?.status || '').trim(),
    qualityScore: normalizeQualityScore(template?.quality_score),
    rejectedReason: template?.rejected_reason || null,
    previousCategory: template?.previous_category || null,
    subCategory: template?.sub_category || null,
    headerFormat: String(header?.format || '').trim() || null,
    headerText: header?.text || null,
    bodyText: body?.text || null,
    footerText: footer?.text || null,
    buttons,
    buttonCount: buttons.length,
    placeholderCount: countPlaceholders(body?.text) + countPlaceholders(header?.text) + countPlaceholders(footer?.text),
    components,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    lastSyncedAt: now
  };
};

const fetchTemplatesPage = async ({ accessToken, wabaId, after = null }) => {
  const params = new URLSearchParams({
    limit: '100',
    fields: TEMPLATE_FIELDS
  });

  if (after) {
    params.set('after', after);
  }

  const url = `${buildGraphUrl(wabaId, 'message_templates')}?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const providerMessage = data?.error?.message || '';
    const invalidWabaId = Number(data?.error?.code) === 100
      && providerMessage.includes('nonexisting field (message_templates)');
    const error = new Error(invalidWabaId
      ? 'WABA ID invalido. Informe o ID da conta do WhatsApp Business, nao o App ID ou Phone Number ID.'
      : (providerMessage || `Falha ao sincronizar templates WhatsApp (${response.status})`));
    error.status = invalidWabaId ? 400 : response.status;
    error.code = invalidWabaId ? 'invalid_waba_id' : (data?.error?.code || 'whatsapp_template_sync_failed');
    throw error;
  }

  return data;
};

export const syncWhatsAppTemplateCatalog = async ({ tenantId, accessToken, wabaId, phoneNumberId }) => {
  if (!tenantId) {
    throw new Error('tenantId obrigatorio');
  }
  if (!accessToken) {
    throw new Error('Access token do WhatsApp nao configurado');
  }
  if (!wabaId) {
    throw new Error('WABA ID nao configurado');
  }

  if (!adapter.db) {
    await adapter.init();
  }

  const collection = adapter.db.collection('whatsappTemplates');
  const existing = await collection.find({ tenantId }).toArray();
  const existingByMetaId = new Map(existing.map((item) => [String(item.metaTemplateId || ''), item]));

  const allTemplates = [];
  let after = null;
  let safety = 0;

  do {
    const payload = await fetchTemplatesPage({ accessToken, wabaId, after });
    const pageItems = Array.isArray(payload?.data) ? payload.data : [];
    allTemplates.push(...pageItems);
    after = payload?.paging?.cursors?.after || null;
    safety += 1;
  } while (after && safety < 20);

  const nextDocuments = allTemplates.map((template) => buildTemplateDocument({
    tenantId,
    wabaId,
    phoneNumberId,
    template,
    existingByMetaId
  }));

  await collection.deleteMany({ tenantId });
  for (const document of nextDocuments) {
    await collection.insertOne(document);
  }

  return {
    items: nextDocuments,
    total: nextDocuments.length,
    syncedAt: new Date().toISOString()
  };
};

export const listWhatsAppTemplateCatalog = async (tenantId) => {
  if (!tenantId) {
    return [];
  }

  if (!adapter.db) {
    await adapter.init();
  }

  const collection = adapter.db.collection('whatsappTemplates');
  return collection
    .find({ tenantId })
    .sort({ name: 1, language: 1 })
    .toArray();
};

export const describeWhatsAppTemplateInputs = (template) => {
  const components = Array.isArray(template?.components) ? template.components : [];
  const header = components.find((component) => component.type === 'HEADER') || null;
  const body = components.find((component) => component.type === 'BODY') || null;
  const buttons = Array.isArray(template?.buttons) ? template.buttons : normalizeButtons(components);

  const headerFormat = String(header?.format || '').toUpperCase();
  const headerText = String(header?.text || '');
  const bodyText = String(body?.text || '');
  const headerTokens = extractPlaceholderTokens(headerText);
  const bodyTokens = extractPlaceholderTokens(bodyText);

  return {
    header: {
      format: headerFormat || null,
      text: headerText,
      placeholderCount: headerTokens.length,
      placeholderTokens: headerTokens.map((token) => token.name),
      requiresMedia: ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat)
    },
    body: {
      text: bodyText,
      placeholderCount: bodyTokens.length,
      placeholderTokens: bodyTokens.map((token) => token.name)
    },
    buttons: buttons
      .map((button) => ({
        index: String(button.index),
        type: String(button.type || 'UNKNOWN').toUpperCase(),
        text: String(button.text || ''),
        placeholderCount: extractPlaceholderTokens(button.url || button.text || '').length,
        placeholderTokens: extractPlaceholderTokens(button.url || button.text || '').map((token) => token.name)
      }))
      .filter((button) => button.placeholderCount > 0)
  };
};

const replaceTemplateTokens = (value, inputs = []) => {
  let cursor = 0;
  return String(value || '').replace(TEMPLATE_TOKEN_REGEX, () => {
    const nextValue = inputs[cursor];
    cursor += 1;
    return nextValue !== undefined && nextValue !== null && String(nextValue).length > 0
      ? String(nextValue)
      : '{{?}}';
  });
};

const requireNonEmptyTemplateParam = (value, label) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${label} vazio.`);
  }
  return normalized;
};

export const buildWhatsAppTemplatePreview = (template, values = {}) => {
  const inputDef = describeWhatsAppTemplateInputs(template);
  const headerValues = Array.isArray(values?.header) ? values.header : [];
  const bodyValues = Array.isArray(values?.body) ? values.body : [];

  const parts = [
    `Template: ${template?.name || 'sem_nome'}`
  ];

  if (inputDef.header.text) {
    parts.push(replaceTemplateTokens(inputDef.header.text, headerValues));
  }
  if (inputDef.body.text) {
    parts.push(replaceTemplateTokens(inputDef.body.text, bodyValues));
  }

  return parts.filter(Boolean).join('\n');
};

export const buildWhatsAppTemplateComponents = (template, values = {}) => {
  const inputDef = describeWhatsAppTemplateInputs(template);
  const components = [];
  const headerValues = Array.isArray(values?.header) ? values.header : [];
  const bodyValues = Array.isArray(values?.body) ? values.body : [];
  const buttonValues = values?.buttons && typeof values.buttons === 'object' ? values.buttons : {};
  const headerMediaUrl = String(values?.headerMediaUrl || '').trim();

  if (inputDef.header.requiresMedia) {
    if (!headerMediaUrl) {
      throw new Error('Este template exige uma URL publica de midia no header.');
    }
    const mediaType = String(inputDef.header.format || '').toLowerCase();
    components.push({
      type: 'header',
      parameters: [
        {
          type: mediaType,
          [mediaType]: { link: headerMediaUrl }
        }
      ]
    });
  } else if (inputDef.header.placeholderCount > 0) {
    if (headerValues.length < inputDef.header.placeholderCount) {
      throw new Error('Preencha todos os parametros do header.');
    }
    components.push({
      type: 'header',
      parameters: headerValues.slice(0, inputDef.header.placeholderCount).map((text, index) => {
        const normalizedText = requireNonEmptyTemplateParam(text, `Parametro ${index + 1} do header`);
        const tokenName = String(inputDef?.header?.placeholderTokens?.[index] || '').trim();
        const param = {
          type: 'text',
          text: normalizedText
        };
        if (tokenName && !NUMERIC_TOKEN_REGEX.test(tokenName)) {
          param.parameter_name = tokenName;
        }
        return param;
      })
    });
  }

  if (inputDef.body.placeholderCount > 0) {
    if (bodyValues.length < inputDef.body.placeholderCount) {
      throw new Error('Preencha todos os parametros do corpo da mensagem.');
    }
    components.push({
      type: 'body',
      parameters: bodyValues.slice(0, inputDef.body.placeholderCount).map((text, index) => {
        const normalizedText = requireNonEmptyTemplateParam(text, `Parametro ${index + 1} do corpo`);
        const tokenName = String(inputDef?.body?.placeholderTokens?.[index] || '').trim();
        const param = {
          type: 'text',
          text: normalizedText
        };
        if (tokenName && !NUMERIC_TOKEN_REGEX.test(tokenName)) {
          param.parameter_name = tokenName;
        }
        return param;
      })
    });
  }

  inputDef.buttons.forEach((button) => {
    const valuesForButton = Array.isArray(buttonValues?.[button.index]) ? buttonValues[button.index] : [];
    if (valuesForButton.length < button.placeholderCount) {
      throw new Error(`Preencha todos os parametros do botao ${button.text || Number(button.index) + 1}.`);
    }

    const subType = button.type === 'URL' ? 'url' : (button.type === 'QUICK_REPLY' ? 'quick_reply' : 'url');
    const paramType = subType === 'quick_reply' ? 'payload' : 'text';
    components.push({
      type: 'button',
      sub_type: subType,
      index: button.index,
      parameters: valuesForButton.slice(0, button.placeholderCount).map((value, valueIndex) => {
        const normalizedValue = requireNonEmptyTemplateParam(
          value,
          `Parametro ${valueIndex + 1} do botao ${button.text || Number(button.index) + 1}`
        );
        const tokenName = String(button?.placeholderTokens?.[valueIndex] || '').trim();
        const param = subType === 'quick_reply'
          ? { type: paramType, payload: normalizedValue }
          : { type: paramType, text: normalizedValue };
        if (tokenName && !NUMERIC_TOKEN_REGEX.test(tokenName)) {
          param.parameter_name = tokenName;
        }
        return param;
      })
    });
  });

  return components;
};
