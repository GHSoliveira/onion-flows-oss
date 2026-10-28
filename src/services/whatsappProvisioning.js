import { getWhatsAppConfig } from './channelConfig.js';

// Consultas de provisionamento na Graph API: descobrir numeros de uma WABA e
// diagnosticar o canal (token, assinatura de webhook, qualidade e limite de envio).
// Sao chamadas de leitura/configuracao, separadas do envio de mensagens que vive
// em whatsappApi.js.

const getGraphVersion = () => process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const buildGraphUrl = (resource) => `https://graph.facebook.com/${getGraphVersion()}/${resource}`;

const REQUEST_TIMEOUT_MS = Number(process.env.WHATSAPP_GRAPH_TIMEOUT_MS || 10000);

const graphRequest = async (resource, { accessToken, method = 'GET', params = null, body = null }) => {
  const url = new URL(buildGraphUrl(resource));
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data?.error?.message || `Graph API respondeu ${res.status}`);
      // Repassa o status so quando for um codigo HTTP valido: res.status() do
      // Express lanca com valores fora da faixa.
      error.status = res.status >= 400 && res.status <= 599 ? res.status : 502;
      error.graphCode = data?.error?.code ?? null;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeout = new Error('A Graph API nao respondeu a tempo.');
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const normalizePhoneNumber = (item = {}) => ({
  phoneNumberId: item.id || null,
  displayPhoneNumber: item.display_phone_number || null,
  verifiedName: item.verified_name || null,
  qualityRating: item.quality_rating || null,
  codeVerificationStatus: item.code_verification_status || null,
  platformType: item.platform_type || null
});

// Lista os numeros da WABA para o editor oferecer um select em vez de exigir que
// o admin cole o phoneNumberId na mao.
export const listWabaPhoneNumbers = async ({ accessToken, wabaId }) => {
  if (!accessToken) throw Object.assign(new Error('Token de acesso obrigatorio.'), { status: 400 });
  if (!wabaId) throw Object.assign(new Error('wabaId obrigatorio.'), { status: 400 });

  const data = await graphRequest(`${wabaId}/phone_numbers`, {
    accessToken,
    params: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type', limit: 50 }
  });
  return (Array.isArray(data?.data) ? data.data : []).map(normalizePhoneNumber);
};

// Estado de saude do numero: e daqui que sai o tier de envio, util antes de
// disparar campanha.
export const getPhoneNumberHealth = async ({ accessToken, phoneNumberId }) => {
  const data = await graphRequest(phoneNumberId, {
    accessToken,
    params: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status,platform_type' }
  });
  return {
    ...normalizePhoneNumber({ ...data, id: phoneNumberId }),
    messagingLimitTier: data?.messaging_limit_tier || null
  };
};

// Apps assinados no webhook da WABA. Sem isso o Onion nao recebe mensagem.
export const getWebhookSubscriptions = async ({ accessToken, wabaId }) => {
  const data = await graphRequest(`${wabaId}/subscribed_apps`, { accessToken });
  return (Array.isArray(data?.data) ? data.data : []).map((item) => ({
    appId: item?.whatsapp_business_api_data?.id || null,
    appName: item?.whatsapp_business_api_data?.name || null
  }));
};

// Tira o app do webhook da WABA. Usado ao desconectar o numero do tenant.
export const unsubscribeWebhook = async ({ accessToken, wabaId }) => {
  const data = await graphRequest(`${wabaId}/subscribed_apps`, { accessToken, method: 'DELETE' });
  return Boolean(data?.success);
};

// Assina o app no webhook da WABA, substituindo o passo manual no painel da Meta.
export const subscribeWebhook = async ({ accessToken, wabaId }) => {
  const data = await graphRequest(`${wabaId}/subscribed_apps`, { accessToken, method: 'POST' });
  return Boolean(data?.success);
};

// Registra o numero na Cloud API. O PIN e o de verificacao em duas etapas do
// numero; sem esse passo o numero nao envia mensagem.
export const registerPhoneNumber = async ({ accessToken, phoneNumberId, pin }) => {
  const cleanPin = String(pin || '').trim();
  if (!/^\d{6}$/.test(cleanPin)) {
    throw Object.assign(new Error('O PIN precisa ter exatamente 6 digitos.'), { status: 400 });
  }
  const data = await graphRequest(`${phoneNumberId}/register`, {
    accessToken,
    method: 'POST',
    body: { messaging_product: 'whatsapp', pin: cleanPin }
  });
  return Boolean(data?.success);
};

const PROFILE_FIELDS = ['about', 'address', 'description', 'email', 'vertical', 'websites', 'profile_picture_url'];

export const getBusinessProfile = async ({ accessToken, phoneNumberId }) => {
  const data = await graphRequest(`${phoneNumberId}/whatsapp_business_profile`, {
    accessToken,
    params: { fields: PROFILE_FIELDS.join(',') }
  });
  const profile = Array.isArray(data?.data) ? data.data[0] || {} : data || {};
  return {
    about: profile.about || '',
    address: profile.address || '',
    description: profile.description || '',
    email: profile.email || '',
    vertical: profile.vertical || '',
    websites: Array.isArray(profile.websites) ? profile.websites : [],
    profilePictureUrl: profile.profile_picture_url || null
  };
};

export const updateBusinessProfile = async ({ accessToken, phoneNumberId, profile = {} }) => {
  const body = { messaging_product: 'whatsapp' };
  ['about', 'address', 'description', 'email', 'vertical'].forEach((key) => {
    if (profile[key] !== undefined) body[key] = String(profile[key] || '');
  });
  if (profile.websites !== undefined) {
    body.websites = (Array.isArray(profile.websites) ? profile.websites : [])
      .map((site) => String(site || '').trim())
      .filter(Boolean)
      .slice(0, 2); // a Meta aceita no maximo 2 sites
  }
  const data = await graphRequest(`${phoneNumberId}/whatsapp_business_profile`, {
    accessToken, method: 'POST', body
  });
  return Boolean(data?.success);
};

const countPlaceholders = (text) => {
  const found = new Set(String(text || '').match(/\{\{\s*\d+\s*\}\}/g) || []);
  return found.size;
};

// Monta o payload de components no formato da Meta. Campos com {{n}} exigem
// "example" preenchido, senao a submissao volta rejeitada.
const buildTemplateComponents = ({ headerText, body, footer, buttons, headerExample, bodyExample }) => {
  const components = [];

  if (headerText) {
    const header = { type: 'HEADER', format: 'TEXT', text: headerText };
    if (countPlaceholders(headerText) > 0) {
      const sample = (Array.isArray(headerExample) ? headerExample : []).map((v) => String(v || ''));
      if (sample.length !== countPlaceholders(headerText)) {
        throw Object.assign(new Error('Informe um exemplo para cada variavel do cabecalho.'), { status: 400 });
      }
      header.example = { header_text: sample };
    }
    components.push(header);
  }

  const bodyComponent = { type: 'BODY', text: body };
  const bodyVars = countPlaceholders(body);
  if (bodyVars > 0) {
    const sample = (Array.isArray(bodyExample) ? bodyExample : []).map((v) => String(v || ''));
    if (sample.length !== bodyVars) {
      throw Object.assign(new Error('Informe um exemplo para cada variavel do corpo.'), { status: 400 });
    }
    bodyComponent.example = { body_text: [sample] };
  }
  components.push(bodyComponent);

  if (footer) components.push({ type: 'FOOTER', text: footer });

  const quickReplies = (Array.isArray(buttons) ? buttons : [])
    .map((b) => String(b?.text || b || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  if (quickReplies.length) {
    components.push({ type: 'BUTTONS', buttons: quickReplies.map((text) => ({ type: 'QUICK_REPLY', text })) });
  }

  return components;
};

const TEMPLATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION'];

// A Meta so aceita [a-z0-9_] no nome. Tira o acento em vez de trocar por
// underscore ("horário" vira "horario", nao "hor_rio"), colapsa repeticoes e
// apara as pontas.
export const normalizeTemplateName = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 512);

// Cria o template na WABA. A Meta ainda revisa: o retorno traz status PENDING.
export const createMessageTemplate = async ({ accessToken, wabaId, template = {} }) => {
  const name = normalizeTemplateName(template.name);
  if (!name) throw Object.assign(new Error('Nome do template obrigatorio.'), { status: 400 });
  const body = String(template.body || '').trim();
  if (!body) throw Object.assign(new Error('O corpo do template e obrigatorio.'), { status: 400 });

  const category = String(template.category || 'UTILITY').toUpperCase();
  if (!TEMPLATE_CATEGORIES.includes(category)) {
    throw Object.assign(new Error(`Categoria invalida. Use ${TEMPLATE_CATEGORIES.join(', ')}.`), { status: 400 });
  }

  const payload = {
    name,
    language: String(template.language || 'pt_BR').trim(),
    category,
    components: buildTemplateComponents({
      headerText: String(template.headerText || '').trim(),
      body,
      footer: String(template.footer || '').trim(),
      buttons: template.buttons,
      headerExample: template.headerExample,
      bodyExample: template.bodyExample
    })
  };

  const data = await graphRequest(`${wabaId}/message_templates`, { accessToken, method: 'POST', body: payload });
  return { id: data?.id || null, status: data?.status || 'PENDING', name, category: data?.category || category };
};

const settle = async (label, fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error.message || `Falha em ${label}`, status: error.status || null };
  }
};

// Diagnostico consolidado do canal. Cada verificacao e independente: uma falha
// nao derruba as outras, para o admin ver exatamente qual etapa esta quebrada.
export const diagnoseWhatsAppChannel = async (tenantId) => {
  const config = await getWhatsAppConfig(tenantId);
  const accessToken = config?.accessToken || null;
  const wabaId = config?.wabaId || null;
  const phoneNumberId = config?.phoneNumberId || null;

  if (!accessToken) {
    return {
      configured: false,
      checks: [{ key: 'token', label: 'Token de acesso', status: 'missing', detail: 'Nenhum token salvo neste canal.' }]
    };
  }

  const checks = [];

  const identity = await settle('token', () => graphRequest('me', { accessToken, params: { fields: 'id,name' } }));
  checks.push(identity.ok
    ? { key: 'token', label: 'Token de acesso', status: 'ok', detail: identity.value?.name || identity.value?.id || 'valido' }
    : { key: 'token', label: 'Token de acesso', status: 'error', detail: identity.error });

  if (!wabaId) {
    checks.push({ key: 'waba', label: 'Conta WhatsApp Business', status: 'missing', detail: 'wabaId nao configurado.' });
  } else {
    const subs = await settle('webhook', () => getWebhookSubscriptions({ accessToken, wabaId }));
    if (!subs.ok) {
      checks.push({ key: 'webhook', label: 'Webhook assinado', status: 'error', detail: subs.error });
    } else if (subs.value.length) {
      checks.push({
        key: 'webhook',
        label: 'Webhook assinado',
        status: 'ok',
        detail: subs.value.map((a) => a.appName || a.appId).filter(Boolean).join(', ') || 'app assinado'
      });
    } else {
      checks.push({
        key: 'webhook',
        label: 'Webhook assinado',
        status: 'warn',
        detail: 'Nenhum app assinado nesta WABA. O Onion nao vai receber mensagens.',
        action: 'subscribe'
      });
    }
  }

  if (!phoneNumberId) {
    checks.push({ key: 'number', label: 'Numero remetente', status: 'missing', detail: 'phoneNumberId nao configurado.' });
  } else {
    const health = await settle('numero', () => getPhoneNumberHealth({ accessToken, phoneNumberId }));
    if (!health.ok) {
      checks.push({ key: 'number', label: 'Numero remetente', status: 'error', detail: health.error });
    } else {
      const value = health.value;
      const parts = [value.displayPhoneNumber, value.verifiedName].filter(Boolean).join(' - ');
      checks.push({ key: 'number', label: 'Numero remetente', status: 'ok', detail: parts || phoneNumberId });
      checks.push({
        key: 'quality',
        label: 'Qualidade do numero',
        status: value.qualityRating === 'RED' ? 'warn' : 'ok',
        detail: value.qualityRating || 'sem classificacao'
      });
      checks.push({
        key: 'limit',
        label: 'Limite de envio',
        status: 'ok',
        detail: value.messagingLimitTier || 'nao informado'
      });
    }
  }

  return { configured: true, checks };
};
