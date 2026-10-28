import adapter from '../../db/DatabaseAdapter.js';
import { findWhatsAppConfigsByWabaId } from './channelConfig.js';
import { registerPhoneNumber } from './whatsappProvisioning.js';
import { generateId } from '../utils/helpers.js';

/**
 * Nome de exibicao e foto de perfil do numero WhatsApp.
 *
 * Nome: a Meta analisa cada pedido (`new_display_name`). Depois de aprovado, o
 * numero precisa ser registrado de novo em ate 14 dias, senao o nome volta para
 * analise. Quando a Onion tem o PIN do numero (onboarding pelo Embedded Signup),
 * esse registro e automatico, disparado pelo webhook de decisao do nome.
 *
 * Foto: sobe pela Resumable Upload API do app dono do token e vira um
 * `profile_picture_handle` no perfil. Nao passa por analise.
 */

const GRAPH_VERSION = process.env.WHATSAPP_INSIGHTS_GRAPH_VERSION || 'v24.0';
const REQUEST_TIMEOUT_MS = 30000;

export const DISPLAY_NAME_REQUESTS_COLLECTION = 'whatsappDisplayNameRequests';
export const DISPLAY_NAME_CHANGE_LIMIT = 10;
const DISPLAY_NAME_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const PROFILE_PICTURE_TYPES = ['image/jpeg', 'image/png'];
export const PROFILE_PICTURE_MAX_BYTES = 5 * 1024 * 1024;

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

const falha = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const graphCall = async (resource, { accessToken = null, method = 'GET', query = null, json = null, body = null, headers = {}, auth = 'bearer' } = {}) => {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${resource}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        ...(accessToken ? { Authorization: auth === 'oauth' ? `OAuth ${accessToken}` : `Bearer ${accessToken}` } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: json ? JSON.stringify(json) : body
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 422 e nao 502: a Cloudflare troca 502 pela pagina dela e a mensagem da Meta some.
      throw falha(data?.error?.error_user_msg || data?.error?.message || `A Meta respondeu ${res.status}`, 422, { graphCode: data?.error?.code ?? null });
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw falha('A Meta nao respondeu a tempo.', 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/* ------------------------------ leitura ------------------------------ */

const countRecentNameRequests = async (tenantId, phoneNumberId, now = new Date()) => {
  const requests = await adapter.findDocuments(DISPLAY_NAME_REQUESTS_COLLECTION, { tenantId, phoneNumberId });
  return requests.filter((item) => now.getTime() - Date.parse(item.createdAt) < DISPLAY_NAME_WINDOW_MS).length;
};

export const getProfileIdentity = async ({ tenantId, accessToken, phoneNumberId, pinStored = false, now = new Date() }) => {
  const [phone, profile, used] = await Promise.all([
    graphCall(phoneNumberId, { accessToken, query: { fields: 'display_phone_number,verified_name,name_status,new_display_name,new_name_status' } }),
    graphCall(`${phoneNumberId}/whatsapp_business_profile`, { accessToken, query: { fields: 'profile_picture_url' } }),
    countRecentNameRequests(tenantId, phoneNumberId, now)
  ]);
  const perfil = Array.isArray(profile?.data) ? profile.data[0] || {} : profile || {};
  return {
    phoneNumberId,
    displayPhoneNumber: phone.display_phone_number || null,
    verifiedName: phone.verified_name || null,
    nameStatus: String(phone.name_status || '').toUpperCase() || null,
    newDisplayName: phone.new_display_name || null,
    newNameStatus: String(phone.new_name_status || '').toUpperCase() || null,
    profilePictureUrl: perfil.profile_picture_url || null,
    pinStored: Boolean(pinStored),
    nameChanges: { used, limit: DISPLAY_NAME_CHANGE_LIMIT, windowDays: 30 }
  };
};

/* -------------------------------- nome -------------------------------- */

export const validateDisplayName = (value) => {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 3) throw falha('O nome precisa ter pelo menos 3 caracteres.');
  if (name.length > 128) throw falha('O nome pode ter no maximo 128 caracteres.');
  if (/https?:\/\/|www\./i.test(name)) throw falha('O nome nao pode conter link.');
  return name;
};

export const requestDisplayNameChange = async ({ tenantId, accessToken, phoneNumberId, name, pinStored = false, actorId = null, now = new Date() }) => {
  const clean = validateDisplayName(name);
  const used = await countRecentNameRequests(tenantId, phoneNumberId, now);
  if (used >= DISPLAY_NAME_CHANGE_LIMIT) {
    throw falha(`A Meta permite ${DISPLAY_NAME_CHANGE_LIMIT} pedidos de nome a cada 30 dias, e esse limite ja foi usado.`, 429);
  }

  await graphCall(phoneNumberId, { accessToken, method: 'POST', json: { new_display_name: clean } });
  await adapter.insertOne(DISPLAY_NAME_REQUESTS_COLLECTION, {
    id: generateId('wa_name_request'),
    tenantId,
    phoneNumberId,
    name: clean,
    actorId,
    createdAt: now.toISOString()
  });

  return getProfileIdentity({ tenantId, accessToken, phoneNumberId, pinStored, now });
};

// Chamado pelo webhook de decisao do nome. Acha o numero pelo display_phone_number
// entre os canais da WABA e registra de novo com o PIN guardado.
export const reRegisterAfterNameApproval = async ({ wabaId, displayPhoneNumber }) => {
  const alvo = digitsOf(displayPhoneNumber);
  if (!wabaId || !alvo) return [];
  const results = [];
  for (const entry of await findWhatsAppConfigsByWabaId(wabaId)) {
    const wa = entry.whatsapp || {};
    const ids = [...new Set([wa.phoneNumberId, ...(Array.isArray(wa.senderNumbers) ? wa.senderNumbers : []).map((sender) => sender?.phoneNumberId)].filter(Boolean))];
    for (const phoneNumberId of ids) {
      let display = null;
      try {
        display = (await graphCall(phoneNumberId, { accessToken: wa.accessToken, query: { fields: 'display_phone_number' } })).display_phone_number;
      } catch (_) {
        continue;
      }
      if (digitsOf(display) !== alvo) continue;
      if (!wa.registrationPin) {
        results.push({ tenantId: entry.tenantId, phoneNumberId, registered: false, reason: 'missing_pin' });
        continue;
      }
      try {
        const registered = await registerPhoneNumber({ accessToken: wa.accessToken, phoneNumberId, pin: wa.registrationPin });
        results.push(registered
          ? { tenantId: entry.tenantId, phoneNumberId, registered: true }
          : { tenantId: entry.tenantId, phoneNumberId, registered: false, reason: 'register_failed', error: 'a Meta nao confirmou o registro' });
      } catch (error) {
        results.push({ tenantId: entry.tenantId, phoneNumberId, registered: false, reason: 'register_failed', error: String(error?.message || error).slice(0, 200) });
      }
    }
  }
  return results;
};

/* -------------------------------- foto -------------------------------- */

export const decodeImageDataUrl = (dataUrl) => {
  const match = /^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw falha('Imagem invalida.');
  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
  if (!PROFILE_PICTURE_TYPES.includes(mimeType)) throw falha('Use uma imagem JPG ou PNG.');
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw falha('Imagem vazia.');
  if (buffer.length > PROFILE_PICTURE_MAX_BYTES) throw falha('A imagem precisa ter ate 5 MB.');
  return { mimeType, buffer };
};

// A sessao de upload precisa ser aberta no app dono do token. Token do Embedded
// Signup e token manual podem ser de apps diferentes, entao pergunta a Meta.
const resolveTokenAppId = async (accessToken) => {
  const appId = process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appId && appSecret) {
    try {
      const data = await graphCall('debug_token', { query: { input_token: accessToken, access_token: `${appId}|${appSecret}` } });
      if (data?.data?.app_id) return String(data.data.app_id);
    } catch (_) {
      // cai no app configurado
    }
  }
  if (!appId) throw falha('WHATSAPP_APP_ID nao configurado para enviar a foto.', 503);
  return appId;
};

export const updateProfilePicture = async ({ accessToken, phoneNumberId, dataUrl, fileName = 'perfil' }) => {
  const { mimeType, buffer } = decodeImageDataUrl(dataUrl);
  const appId = await resolveTokenAppId(accessToken);
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const safeName = `${String(fileName || 'perfil').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60) || 'perfil'}.${extension}`;

  const session = await graphCall(`${appId}/uploads`, {
    method: 'POST',
    query: { file_name: safeName, file_length: buffer.length, file_type: mimeType, access_token: accessToken }
  });
  if (!session?.id) throw falha('A Meta nao abriu a sessao de upload.', 422);

  const uploaded = await graphCall(session.id, {
    accessToken,
    auth: 'oauth',
    method: 'POST',
    headers: { file_offset: '0' },
    body: buffer
  });
  if (!uploaded?.h) throw falha('A Meta nao devolveu a referencia da imagem.', 422);

  await graphCall(`${phoneNumberId}/whatsapp_business_profile`, {
    accessToken,
    method: 'POST',
    json: { messaging_product: 'whatsapp', profile_picture_handle: uploaded.h }
  });

  const profile = await graphCall(`${phoneNumberId}/whatsapp_business_profile`, { accessToken, query: { fields: 'profile_picture_url' } });
  const perfil = Array.isArray(profile?.data) ? profile.data[0] || {} : profile || {};
  return { profilePictureUrl: perfil.profile_picture_url || null };
};
