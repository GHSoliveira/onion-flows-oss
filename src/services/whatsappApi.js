import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { notifyWhatsAppProblem } from './whatsappAlerts.js';

const getGraphVersion = () => process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';

const buildUrl = (phoneNumberId, endpoint) => {
  const version = getGraphVersion();
  return `https://graph.facebook.com/${version}/${phoneNumberId}/${endpoint}`;
};

const buildResourceUrl = (resourceId) => {
  const version = getGraphVersion();
  return `https://graph.facebook.com/${version}/${resourceId}`;
};

const normalizeMessageText = (value) => String(value || '').trim();
const isFakeWhatsAppSendEnabled = () => ['1', 'true', 'yes', 'on'].includes(
  String(process.env.WHATSAPP_FAKE_SEND || '').trim().toLowerCase()
);

const fakeWhatsAppSend = ({ to, type, extra = {} }) => {
  const id = `wamid.sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.log('[WHATSAPP][SANDBOX] Fake send ok', { to, type, messageId: id, ...extra });
  return {
    messaging_product: 'whatsapp',
    contacts: [{ input: to, wa_id: to }],
    messages: [{ id }]
  };
};

const getFakeMediaDir = () => path.resolve(process.env.WHATSAPP_FAKE_MEDIA_DIR || './sandbox/fake-whatsapp-media');

const readFakeMediaManifest = (mediaId) => {
  const safeId = String(mediaId || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safeId) return null;
  const manifestPath = path.join(getFakeMediaDir(), `${safeId}.json`);
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
};

const buildWhatsAppApiErrorMessage = (data, fallback) => {
  const message = data?.error?.message || fallback;
  const details = data?.error?.error_data?.details || null;
  return details ? `${message} | ${details}` : message;
};

const requestWhatsAppBlockUsers = async ({ accessToken, phoneNumberId, method, users }) => {
  const normalizedUsers = [...new Set(
    (Array.isArray(users) ? users : [users])
      .map((value) => String(value || '').replace(/\D/g, ''))
      .filter(Boolean)
  )];
  if (!accessToken || !phoneNumberId || !normalizedUsers.length) {
    throw new Error('Parametros invalidos para moderacao de usuarios WhatsApp');
  }

  const response = await fetch(buildUrl(phoneNumberId, 'block_users'), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      block_users: normalizedUsers.map((user) => ({ user }))
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(buildWhatsAppApiErrorMessage(data, `Falha ao moderar usuario WhatsApp (${response.status})`));
    error.status = response.status >= 500 ? 502 : 400;
    error.code = data?.error?.code || 'whatsapp_block_users_failed';
    throw error;
  }
  return data;
};

export const blockWhatsAppUsers = async ({ accessToken, phoneNumberId, users }) => (
  requestWhatsAppBlockUsers({ accessToken, phoneNumberId, method: 'POST', users })
);

export const unblockWhatsAppUsers = async ({ accessToken, phoneNumberId, users }) => (
  requestWhatsAppBlockUsers({ accessToken, phoneNumberId, method: 'DELETE', users })
);

export const listWhatsAppBlockedUsers = async ({
  accessToken,
  phoneNumberId,
  limit = 100,
  after = null
}) => {
  if (!accessToken || !phoneNumberId) {
    throw new Error('Parametros invalidos para consultar bloqueios WhatsApp');
  }
  const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, Number(limit) || 100))) });
  if (after) params.set('after', String(after));
  const response = await fetch(`${buildUrl(phoneNumberId, 'block_users')}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(buildWhatsAppApiErrorMessage(data, `Falha ao consultar bloqueios WhatsApp (${response.status})`));
    error.status = response.status >= 500 ? 502 : 400;
    error.code = data?.error?.code || 'whatsapp_block_users_list_failed';
    throw error;
  }
  return {
    users: (Array.isArray(data?.data) ? data.data : [])
      .map((item) => String(item?.wa_id || '').replace(/\D/g, ''))
      .filter(Boolean),
    after: data?.paging?.next ? (data?.paging?.cursors?.after || null) : null
  };
};

export const isWhatsAppUserBlocked = async ({ accessToken, phoneNumberId, user, maxPages = 20 }) => {
  const normalized = String(user || '').replace(/\D/g, '');
  if (!normalized) throw new Error('Usuario WhatsApp invalido');

  // A Meta pode canonicalizar numeros brasileiros removendo o nono digito.
  const variants = new Set([normalized]);
  if (normalized.startsWith('55') && normalized.length === 13 && normalized[4] === '9') {
    variants.add(`${normalized.slice(0, 4)}${normalized.slice(5)}`);
  }

  let after = null;
  let page = 0;
  do {
    const result = await listWhatsAppBlockedUsers({ accessToken, phoneNumberId, limit: 100, after });
    if (result.users.some((waId) => variants.has(waId))) {
      return { blocked: true, waId: result.users.find((waId) => variants.has(waId)) || normalized, complete: true };
    }
    after = result.after;
    page += 1;
  } while (after && page < Math.max(1, Number(maxPages) || 20));

  return { blocked: false, waId: normalized, complete: !after };
};

const asArrayLength = (value) => (Array.isArray(value) ? value.length : 0);

const summarizeTemplateDebugContext = (debugContext = {}, components = []) => {
  const inputDef = debugContext?.inputDef && typeof debugContext.inputDef === 'object'
    ? debugContext.inputDef
    : {};
  const values = debugContext?.values && typeof debugContext.values === 'object'
    ? debugContext.values
    : {};

  const expectedButtonsByIndex = {};
  (Array.isArray(inputDef?.buttons) ? inputDef.buttons : []).forEach((button) => {
    expectedButtonsByIndex[String(button?.index ?? '')] = Number(button?.placeholderCount || 0);
  });

  const providedButtonsByIndex = {};
  const rawButtonValues = values?.buttons && typeof values.buttons === 'object' ? values.buttons : {};
  Object.entries(rawButtonValues).forEach(([index, buttonParams]) => {
    providedButtonsByIndex[String(index)] = asArrayLength(buttonParams);
  });

  const sentButtonsByIndex = {};
  const sent = {
    header: 0,
    body: 0,
    buttonsByIndex: sentButtonsByIndex,
    totalParameters: 0
  };

  (Array.isArray(components) ? components : []).forEach((component) => {
    const type = String(component?.type || '').toLowerCase();
    const parameterCount = asArrayLength(component?.parameters);
    sent.totalParameters += parameterCount;

    if (type === 'header') {
      sent.header = parameterCount;
      return;
    }
    if (type === 'body') {
      sent.body = parameterCount;
      return;
    }
    if (type === 'button') {
      sentButtonsByIndex[String(component?.index ?? '')] = parameterCount;
    }
  });

  return {
    expected: {
      header: Number(inputDef?.header?.placeholderCount || 0),
      body: Number(inputDef?.body?.placeholderCount || 0),
      buttonsByIndex: expectedButtonsByIndex
    },
    provided: {
      header: asArrayLength(values?.header),
      body: asArrayLength(values?.body),
      buttonsByIndex: providedButtonsByIndex
    },
    sent
  };
};

const assertMaxLength = (label, value, max) => {
  const normalized = normalizeMessageText(value);
  if (normalized.length > max) {
    throw new Error(`${label} excede o limite do WhatsApp (${normalized.length}/${max})`);
  }
};

const assertRequiredText = (label, value) => {
  const normalized = normalizeMessageText(value);
  if (!normalized) {
    throw new Error(`${label} é obrigatório(a) no interactive WhatsApp`);
  }
  return normalized;
};

const validateWhatsAppInteractivePayload = (interactive) => {
  if (!interactive || typeof interactive !== 'object') {
    throw new Error('Payload interactive inválido');
  }

  const type = String(interactive.type || '').toLowerCase();
  if (!['list', 'button', 'product', 'product_list'].includes(type)) {
    throw new Error(`Tipo de interactive inválido: ${interactive.type || 'vazio'}`);
  }

  const bodyText = assertRequiredText('Body', interactive.body?.text);
  assertMaxLength('Body', bodyText, 1024);

  if (interactive.header?.type && String(interactive.header.type).toLowerCase() !== 'text') {
    throw new Error('Header de interactive deve ser do tipo text');
  }

  if (interactive.header?.text) {
    assertMaxLength('Header', interactive.header.text, 60);
  }

  if (interactive.footer?.text) {
    assertMaxLength('Footer', interactive.footer.text, 60);
  }

  if (type === 'product') {
    if (interactive.header?.text) {
      throw new Error('Single product nao aceita header');
    }
    const catalogId = assertRequiredText('Catalog ID do produto', interactive.action?.catalog_id);
    const productRetailerId = assertRequiredText('Retailer ID do produto', interactive.action?.product_retailer_id);
    assertMaxLength('Catalog ID do produto', catalogId, 256);
    assertMaxLength('Retailer ID do produto', productRetailerId, 256);
    return;
  }

  if (type === 'product_list') {
    const headerText = assertRequiredText('Header do multi product', interactive.header?.text);
    assertMaxLength('Header do multi product', headerText, 60);
    const catalogId = assertRequiredText('Catalog ID do multi product', interactive.action?.catalog_id);
    assertMaxLength('Catalog ID do multi product', catalogId, 256);

    const sections = Array.isArray(interactive.action?.sections) ? interactive.action.sections : [];
    if (!sections.length) {
      throw new Error('Interactive multi product precisa de pelo menos uma seção');
    }
    if (sections.length > 10) {
      throw new Error('Interactive multi product aceita no máximo 10 seções');
    }

    let totalProducts = 0;
    sections.forEach((section, sectionIndex) => {
      if (section?.title) {
        assertMaxLength(`Título da seção ${sectionIndex + 1}`, section.title, 24);
      }

      const productItems = Array.isArray(section?.product_items) ? section.product_items : [];
      if (!productItems.length) {
        throw new Error(`Seção ${sectionIndex + 1} precisa de pelo menos um produto`);
      }

      totalProducts += productItems.length;
      productItems.forEach((item, itemIndex) => {
        const retailerId = assertRequiredText(`Produto ${sectionIndex + 1}.${itemIndex + 1}`, item?.product_retailer_id);
        assertMaxLength(`Produto ${sectionIndex + 1}.${itemIndex + 1}`, retailerId, 256);
      });
    });

    if (totalProducts > 30) {
      throw new Error(`Interactive multi product aceita no máximo 30 produtos no total; recebido: ${totalProducts}`);
    }
    return;
  }

  if (type === 'list') {
    const actionButton = assertRequiredText('Texto do botão da lista', interactive.action?.button);
    assertMaxLength('Texto do botão da lista', actionButton, 20);

    const sections = Array.isArray(interactive.action?.sections) ? interactive.action.sections : [];
    if (!sections.length) {
      throw new Error('Interactive list precisa de pelo menos uma seção');
    }
    if (sections.length > 10) {
      throw new Error('Interactive list aceita no máximo 10 seções');
    }

    const rowIds = new Set();
    let totalRows = 0;
    sections.forEach((section, sectionIndex) => {
      if (section?.title) {
        assertMaxLength(`Título da seção ${sectionIndex + 1}`, section.title, 24);
      }

      const rows = Array.isArray(section?.rows) ? section.rows : [];
      if (!rows.length) {
        throw new Error(`Seção ${sectionIndex + 1} precisa de pelo menos uma linha`);
      }
      totalRows += rows.length;

      rows.forEach((row, rowIndex) => {
        const rowId = assertRequiredText(`ID da linha ${sectionIndex + 1}.${rowIndex + 1}`, row?.id);
        const rowTitle = assertRequiredText(`Título da linha ${sectionIndex + 1}.${rowIndex + 1}`, row?.title);
        assertMaxLength(`ID da linha ${sectionIndex + 1}.${rowIndex + 1}`, rowId, 200);
        assertMaxLength(`Título da linha ${sectionIndex + 1}.${rowIndex + 1}`, rowTitle, 24);
        if (row?.description) {
          assertMaxLength(`Descrição da linha ${sectionIndex + 1}.${rowIndex + 1}`, row.description, 72);
        }
        if (rowIds.has(rowId)) {
          throw new Error(`ID duplicado na interactive list: ${rowId}`);
        }
        rowIds.add(rowId);
      });
    });

    if (totalRows > 10) {
      throw new Error(`Interactive list aceita no máximo 10 linhas no total; recebido: ${totalRows}`);
    }
    return;
  }

  const buttons = Array.isArray(interactive.action?.buttons) ? interactive.action.buttons : [];
  if (!buttons.length) {
    throw new Error('Interactive de botões precisa de pelo menos um botão');
  }
  if (buttons.length > 3) {
    throw new Error('Interactive de botões aceita no máximo 3 botões');
  }

  const replyIds = new Set();
  buttons.forEach((button, index) => {
    if (String(button?.type || '').toLowerCase() !== 'reply') {
      throw new Error(`Botão ${index + 1} precisa ser do tipo reply`);
    }
    const replyId = assertRequiredText(`ID do botão ${index + 1}`, button?.reply?.id);
    const replyTitle = assertRequiredText(`Título do botão ${index + 1}`, button?.reply?.title);
    assertMaxLength(`ID do botão ${index + 1}`, replyId, 256);
    assertMaxLength(`Título do botão ${index + 1}`, replyTitle, 20);
    if (replyIds.has(replyId)) {
      throw new Error(`ID duplicado no interactive button: ${replyId}`);
    }
    replyIds.add(replyId);
  });
};

export const verifyWhatsAppSignature = (rawBody, signatureHeader, appSecret) => {
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const signature = signatureHeader.replace('sha256=', '');
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
};

export const sendWhatsAppText = async ({ accessToken, phoneNumberId, to, text, contextMessageId = null, debugContext = null }) => {
  if (!accessToken || !phoneNumberId || !to || !text) {
    throw new Error('Parâmetros inválidos para envio WhatsApp');
  }
  const url = buildUrl(phoneNumberId, 'messages');
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  };
  // Quote nativo: faz a mensagem aparecer "respondendo" a contextMessageId no
  // app do cliente. Se o ID for inválido, a Meta ignora o context e envia
  // normal — não quebra o envio.
  if (contextMessageId) {
    payload.context = { message_id: String(contextMessageId) };
  }

  if (isFakeWhatsAppSendEnabled()) {
    return fakeWhatsAppSend({ to, type: 'text' });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Falha ao enviar WhatsApp (${res.status})`;
    console.error('[WHATSAPP] Send error', { status: res.status, data });
    await notifyWhatsAppProblem({
      operation: 'send_text',
      tenantId: debugContext?.tenantId || null,
      status: res.status,
      data,
      context: { ...(debugContext || {}), to, phoneNumberId }
    });
    throw new Error(message);
  }
  console.log('[WHATSAPP] Send ok', { to, messageId: data?.messages?.[0]?.id || null });
  return data;
};

const whatsappMediaTypes = new Set(['image', 'video', 'audio', 'document']);

export const sendWhatsAppMedia = async ({
  accessToken,
  phoneNumberId,
  to,
  mediaType,
  mediaUrl,
  caption = null,
  filename = null,
  contextMessageId = null,
  voice = false,
  debugContext = null
}) => {
  const normalizedType = String(mediaType || '').toLowerCase();
  // WhatsApp does not support image/gif — GIFs must be sent as video type
  const isGif = /\.gif(\?.*)?$/i.test(mediaUrl || '');
  const resolvedType = (normalizedType === 'image' && isGif) ? 'video' : normalizedType;
  const type = whatsappMediaTypes.has(resolvedType) ? resolvedType : 'document';

  if (!accessToken || !phoneNumberId || !to || !mediaUrl) {
    throw new Error('Parâmetros inválidos para envio de mídia no WhatsApp');
  }

  const url = buildUrl(phoneNumberId, 'messages');
  const mediaPayload = { link: mediaUrl };

  if (caption && type !== 'audio') {
    mediaPayload.caption = caption;
  }

  if (type === 'document' && filename) {
    mediaPayload.filename = filename;
  }

  // Mensagem de voz (microfone e onda no WhatsApp): so OGG/OPUS mono.
  if (type === 'audio' && voice === true) {
    mediaPayload.voice = true;
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type,
    [type]: mediaPayload
  };
  if (contextMessageId) {
    payload.context = { message_id: String(contextMessageId) };
  }

  if (isFakeWhatsAppSendEnabled()) {
    return fakeWhatsAppSend({ to, type, extra: { mediaUrl } });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Falha ao enviar mídia WhatsApp (${res.status})`;
    console.error('[WHATSAPP] Media send error', { status: res.status, data });
    await notifyWhatsAppProblem({
      operation: 'send_media',
      tenantId: debugContext?.tenantId || null,
      status: res.status,
      data,
      context: { ...(debugContext || {}), to, phoneNumberId }
    });
    throw new Error(message);
  }

  console.log('[WHATSAPP] Media send ok', { to, mediaType: type, messageId: data?.messages?.[0]?.id || null });
  return data;
};

export const sendWhatsAppTemplate = async ({
  accessToken,
  phoneNumberId,
  to,
  templateName,
  languageCode,
  components = [],
  debugContext = null
}) => {
  if (!accessToken || !phoneNumberId || !to || !templateName || !languageCode) {
    throw new Error('Parametros invalidos para envio de template WhatsApp');
  }

  const url = buildUrl(phoneNumberId, 'messages');
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode }
    }
  };

  if (Array.isArray(components) && components.length > 0) {
    payload.template.components = components;
  }

  if (isFakeWhatsAppSendEnabled()) {
    return fakeWhatsAppSend({ to, type: 'template', extra: { templateName } });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = buildWhatsAppApiErrorMessage(data, `Falha ao enviar template WhatsApp (${res.status})`);
    const componentSummary = (Array.isArray(components) ? components : []).map((component) => ({
      type: String(component?.type || ''),
      index: component?.index ?? null,
      parameterCount: asArrayLength(component?.parameters)
    }));
    const parameterSummary = summarizeTemplateDebugContext(debugContext, components);

    console.error('[WHATSAPP] Template send error', {
      status: res.status,
      code: data?.error?.code || null,
      message: data?.error?.message || null,
      details: data?.error?.error_data?.details || null,
      fbtraceId: data?.error?.fbtrace_id || null,
      templateName,
      languageCode,
      templateId: debugContext?.templateId || null,
      tenantId: debugContext?.tenantId || null,
      flowId: debugContext?.flowId || null,
      nodeId: debugContext?.nodeId || null,
      to,
      parameterSummary,
      componentSummary
    });
    await notifyWhatsAppProblem({
      operation: 'send_template',
      tenantId: debugContext?.tenantId || null,
      status: res.status,
      data,
      context: {
        ...(debugContext || {}),
        to,
        phoneNumberId,
        templateName,
        parameterSummary,
        componentSummary
      }
    });
    throw new Error(message);
  }

  console.log('[WHATSAPP] Template send ok', { to, templateName, messageId: data?.messages?.[0]?.id || null });
  return data;
};

export const sendWhatsAppInteractive = async ({
  accessToken,
  phoneNumberId,
  to,
  interactive,
  debugContext = null
}) => {
  if (!accessToken || !phoneNumberId || !to || !interactive || typeof interactive !== 'object') {
    throw new Error('Parametros invalidos para envio de interactive WhatsApp');
  }

  validateWhatsAppInteractivePayload(interactive);

  const url = buildUrl(phoneNumberId, 'messages');
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive
  };

  if (isFakeWhatsAppSendEnabled()) {
    return fakeWhatsAppSend({ to, type: 'interactive', extra: { interactiveType: interactive?.type || null } });
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = buildWhatsAppApiErrorMessage(data, `Falha ao enviar interactive WhatsApp (${res.status})`);
    console.error('[WHATSAPP] Interactive send error', {
      status: res.status,
      data,
      details: data?.error?.error_data?.details || null,
      interactiveType: interactive?.type || null
    });
    await notifyWhatsAppProblem({
      operation: 'send_interactive',
      tenantId: debugContext?.tenantId || null,
      status: res.status,
      data,
      context: {
        ...(debugContext || {}),
        to,
        phoneNumberId,
        interactiveType: interactive?.type || null
      }
    });
    throw new Error(message);
  }

  console.log('[WHATSAPP] Interactive send ok', { to, messageId: data?.messages?.[0]?.id || null });
  return data;
};

export const getWhatsAppMediaMetadata = async ({ accessToken, mediaId }) => {
  if (!accessToken || !mediaId) {
    throw new Error('Parametros invalidos para obter metadados de midia WhatsApp');
  }

  if (isFakeWhatsAppSendEnabled()) {
    const manifest = readFakeMediaManifest(mediaId);
    if (!manifest?.filePath) {
      throw new Error(`Midia sandbox nao encontrada: ${mediaId}`);
    }
    return {
      id: mediaId,
      url: `sandbox-media://${mediaId}`,
      mime_type: manifest.mimeType || 'application/octet-stream',
      file_size: manifest.size || null,
      sha256: manifest.sha256 || null
    };
  }

  const res = await fetch(buildResourceUrl(mediaId), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `Falha ao obter metadata da midia WhatsApp (${res.status})`;
    console.error('[WHATSAPP] Media metadata error', { status: res.status, data, mediaId });
    await notifyWhatsAppProblem({
      operation: 'media_metadata',
      status: res.status,
      data,
      context: { mediaId }
    });
    throw new Error(message);
  }

  return data;
};

export const downloadWhatsAppMedia = async ({ accessToken, mediaUrl }) => {
  if (!accessToken || !mediaUrl) {
    throw new Error('Parametros invalidos para baixar midia WhatsApp');
  }

  if (isFakeWhatsAppSendEnabled() && String(mediaUrl || '').startsWith('sandbox-media://')) {
    const mediaId = String(mediaUrl).replace('sandbox-media://', '');
    const manifest = readFakeMediaManifest(mediaId);
    if (!manifest?.filePath) {
      throw new Error(`Arquivo sandbox nao encontrado: ${mediaId}`);
    }
    const filePath = path.resolve(manifest.filePath);
    const buffer = fs.readFileSync(filePath);
    const filename = String(manifest.fileName || path.basename(filePath)).replace(/"/g, '');
    return {
      buffer,
      mimeType: manifest.mimeType || 'application/octet-stream',
      contentDisposition: `attachment; filename="${filename}"`
    };
  }

  const res = await fetch(mediaUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    const message = data?.error?.message || `Falha ao baixar midia WhatsApp (${res.status})`;
    console.error('[WHATSAPP] Media download error', { status: res.status, data, mediaUrl });
    await notifyWhatsAppProblem({
      operation: 'media_download',
      status: res.status,
      data,
      context: { mediaUrl }
    });
    throw new Error(message);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: res.headers.get('content-type') || null,
    contentDisposition: res.headers.get('content-disposition') || null
  };
};
