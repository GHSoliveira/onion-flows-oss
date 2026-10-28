import adapter from '../../db/DatabaseAdapter.js';
import { createLog, getIo } from './logs.js';
import { findWhatsAppConfigByPhoneNumberId, getWhatsAppConfig } from './channelConfig.js';
import { getOnlineUserIds } from './userStatus.js';
import { CHAT_EVENT_TYPES, emitChatEvent } from './chatEvents.js';
import { appendChatMessage } from './chatMessages.js';
import { sendWhatsAppText } from './whatsappApi.js';
import { normalizeWhatsappWaId } from './activeOutreach.js';
import { generateId } from '../utils/helpers.js';

// Chamadas de voz recebidas pelo WhatsApp (Calling API da Meta).
//
// O cliente liga, a Meta manda um webhook "connect" com a oferta SDP e segura a
// ligacao por cerca de 60 s para a empresa atender. O Onion toca para um atendente online da
// fila configurada de cada vez, em rodizio fixo; quem atende negocia o audio
// no proprio navegador (WebRTC) e o servidor so repassa a resposta SDP para a
// Meta. O audio nunca passa por aqui.

export const VOICE_CALLS = 'voiceCalls';
export const VOICE_SETTINGS = 'voiceCallSettings';
export const VOICE_ROTATION = 'voiceCallRotation';

// A Calling API e recente; versao fixa, como nos insights da conta.
const GRAPH_VERSION = 'v24.0';

export const VOICE_DEFAULTS = Object.freeze({
  enabled: false,
  queueName: null,
  ringSeconds: 10,
  // A Meta segura a ligacao por cerca de 60 s antes de encerrar como "nao
  // atendida" (medido em 2026-09-18); para um pouco antes, com folga.
  maxRingSeconds: 55,
  missedMessage: {
    enabled: false,
    text: 'Oi! Vimos sua ligação, mas não conseguimos atender agora. Pode falar com a gente por aqui que já te respondemos.'
  }
});

const nowIso = () => new Date().toISOString();
const texto = (value) => {
  const clean = String(value ?? '').trim();
  return clean || null;
};
const limitar = (value, min, max, fallback) => {
  const numero = Number(value);
  if (!Number.isFinite(numero)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numero)));
};

/* ------------------------------ configuracao ----------------------------- */

const settingsId = (tenantId) => `voice_settings_${tenantId}`;

export const normalizeVoiceSettings = (raw = {}) => ({
  enabled: raw.enabled === true,
  queueName: texto(raw.queueName),
  ringSeconds: limitar(raw.ringSeconds, 5, 25, VOICE_DEFAULTS.ringSeconds),
  maxRingSeconds: limitar(raw.maxRingSeconds, 10, 58, VOICE_DEFAULTS.maxRingSeconds),
  missedMessage: {
    enabled: raw.missedMessage?.enabled === true,
    text: String(raw.missedMessage?.text ?? VOICE_DEFAULTS.missedMessage.text).trim().slice(0, 1000)
      || VOICE_DEFAULTS.missedMessage.text
  }
});

export const getVoiceSettings = async (tenantId) => {
  if (!tenantId) return normalizeVoiceSettings();
  const stored = await adapter.findOne(VOICE_SETTINGS, { id: settingsId(tenantId) }, { projection: { _id: 0 } });
  return { tenantId, ...normalizeVoiceSettings(stored || {}), updatedAt: stored?.updatedAt || null };
};

export const saveVoiceSettings = async (tenantId, patch = {}, actor = null) => {
  const atual = await getVoiceSettings(tenantId);
  const proximo = normalizeVoiceSettings({
    ...atual,
    ...patch,
    missedMessage: { ...atual.missedMessage, ...(patch.missedMessage || {}) }
  });
  if (proximo.enabled && !proximo.queueName) {
    const error = new Error('Escolha a fila que recebe as ligações antes de ativar.');
    error.status = 400;
    error.code = 'voice_queue_required';
    throw error;
  }
  if (proximo.queueName) {
    const fila = await adapter.findOne('queues', { tenantId, name: proximo.queueName });
    if (!fila) {
      const error = new Error('Fila não encontrada neste tenant.');
      error.status = 400;
      error.code = 'voice_queue_not_found';
      throw error;
    }
  }
  const doc = { id: settingsId(tenantId), tenantId, ...proximo, updatedAt: nowIso(), updatedBy: actor?.id || null };
  await adapter.saveDocument(VOICE_SETTINGS, doc);
  // Desligou as ligacoes no Onion: esconde o botao no WhatsApp, senao o cliente
  // continuaria ligando e toda ligacao seria recusada.
  if (atual.enabled && !proximo.enabled) {
    await setMetaCallButton(tenantId, false, actor).catch((error) => {
      console.warn('[VOICE] Falha ao esconder o botao de ligar', { tenantId, error: error?.message });
    });
  }
  await createLog('VOICE_SETTINGS_UPDATE', { tenantId, enabled: doc.enabled, queueName: doc.queueName, ringSeconds: doc.ringSeconds, missedMessage: doc.missedMessage.enabled }, actor?.id || 'system').catch(() => {});
  return { tenantId, ...proximo, updatedAt: doc.updatedAt };
};

/* ----------------------------- Graph: chamadas ---------------------------- */

const isFakeSend = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.WHATSAPP_FAKE_SEND || '').trim().toLowerCase());

// Registro das acoes em modo sandbox, para os testes conferirem o que iria para a Meta.
export const fakeCallActions = [];

export const sendCallAction = async ({ accessToken, phoneNumberId, callId, action, sdp = null, callbackData = null }) => {
  const body = { messaging_product: 'whatsapp', call_id: callId, action };
  if (sdp) body.session = { sdp_type: 'answer', sdp };
  if (callbackData) body.biz_opaque_callback_data = String(callbackData).slice(0, 512);

  if (isFakeSend()) {
    fakeCallActions.push({ phoneNumberId, ...body });
    return { messaging_product: 'whatsapp', success: true };
  }

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/calls`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    const error = new Error(data?.error?.message || `Falha na ação ${action} da chamada (${res.status})`);
    error.status = res.status;
    error.code = data?.error?.code || 'call_action_failed';
    throw error;
  }
  return data;
};

/* ------------------------ configuracao do numero na Meta ------------------- */

const graphSettingsUrl = (phoneNumberId) => `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/settings`;

// Estado do recurso no numero: ligado, botao visivel, retorno automatico.
export const getMetaCallingSettings = async (tenantId) => {
  const config = await getWhatsAppConfig(tenantId);
  if (!config?.accessToken || !config?.phoneNumberId) return { connected: false };
  if (isFakeSend()) return { connected: true, status: 'ENABLED', callIconVisibility: 'DISABLE_ALL', callbackPermissionStatus: 'DISABLED' };
  const res = await fetch(graphSettingsUrl(config.phoneNumberId), { headers: { Authorization: `Bearer ${config.accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { connected: true, error: data?.error?.message || `Falha ao ler a configuração (${res.status})` };
  }
  return {
    connected: true,
    status: data?.calling?.status || 'NOT_SET',
    callIconVisibility: data?.calling?.call_icon_visibility || 'NOT_SET',
    callbackPermissionStatus: data?.calling?.callback_permission_status || 'NOT_SET'
  };
};

// Mostra ou esconde o botao de ligar para os clientes. So chamada receptiva:
// o retorno automatico (permissao para a empresa ligar) fica sempre desligado.
export const setMetaCallButton = async (tenantId, visible, actor = null) => {
  if (visible) {
    const settings = await getVoiceSettings(tenantId);
    if (!settings.enabled || !settings.queueName) {
      throw erro('Ative as ligações e escolha a fila antes de mostrar o botão: senão toda ligação seria recusada.', 400, 'voice_not_ready');
    }
  }
  const config = await getWhatsAppConfig(tenantId);
  if (!config?.accessToken || !config?.phoneNumberId) throw erro('WhatsApp não conectado.', 400, 'whatsapp_not_connected');
  const calling = { status: 'ENABLED', call_icon_visibility: visible ? 'DEFAULT' : 'DISABLE_ALL', callback_permission_status: 'DISABLED' };
  if (!isFakeSend()) {
    const res = await fetch(graphSettingsUrl(config.phoneNumberId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.accessToken}` },
      body: JSON.stringify({ calling })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw erro(data?.error?.error_user_msg || data?.error?.message || `A Meta recusou a configuração (${res.status})`, 502, 'meta_calling_settings_failed');
  }
  await createLog('VOICE_META_CALL_BUTTON', { tenantId, visible: Boolean(visible) }, actor?.id || 'system').catch(() => {});
  return getMetaCallingSettings(tenantId);
};

/* --------------------------------- webhook -------------------------------- */

const primeiro = (value) => (Array.isArray(value) ? value[0] : value);

export const parseCallEvents = (payload) => {
  const eventos = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'calls') continue;
      const value = change.value || {};
      const phoneNumberId = texto(value.metadata?.phone_number_id);
      const nomes = new Map((Array.isArray(value.contacts) ? value.contacts : [])
        .map((contato) => [String(contato?.wa_id || '').replace(/\D/g, ''), texto(contato?.profile?.name)]));
      for (const call of Array.isArray(value.calls) ? value.calls : []) {
        const from = String(call?.from || '').replace(/\D/g, '') || null;
        eventos.push({
          phoneNumberId,
          callId: texto(call?.id),
          event: String(call?.event || '').toLowerCase(),
          direction: String(call?.direction || '').toUpperCase(),
          from,
          to: texto(call?.to),
          contactName: (from && nomes.get(from)) || null,
          sdpType: texto(call?.session?.sdp_type),
          sdp: typeof call?.session?.sdp === 'string' ? call.session.sdp : null,
          status: texto(primeiro(call?.status)),
          duration: Number.isFinite(Number(call?.duration)) ? Number(call.duration) : null,
          startTime: call?.start_time ? new Date(Number(call.start_time) * 1000).toISOString() : null,
          endTime: call?.end_time ? new Date(Number(call.end_time) * 1000).toISOString() : null,
          timestamp: call?.timestamp ? new Date(Number(call.timestamp) * 1000).toISOString() : nowIso()
        });
      }
    }
  }
  return eventos.filter((evento) => evento.callId && evento.event);
};

/* ------------------------------ estado em memoria ------------------------- */

// Um processo so (systemd). Se reiniciar no meio de um toque, a Meta encerra a
// chamada por falta de resposta e o webhook "terminate" fecha o registro.
const timers = new Map();
const aceitando = new Set();

const limparTimers = (callId) => {
  const atual = timers.get(callId);
  if (atual) {
    clearTimeout(atual.ring);
    clearTimeout(atual.deadline);
  }
  timers.delete(callId);
};

const emitirParaUsuario = (userId, evento, dados) => {
  if (!userId) return;
  try {
    getIo()?.to(`user:${userId}`).emit(evento, dados);
  } catch (_) {}
};

const docId = (callId) => `voice_${callId}`;

const buscarChamada = (callId) => adapter.findOne(VOICE_CALLS, { id: docId(callId) }, { projection: { _id: 0 } });

const salvarChamada = async (call) => {
  const doc = { ...call, updatedAt: nowIso() };
  await adapter.saveDocument(VOICE_CALLS, doc);
  return doc;
};

/* --------------------------------- rodizio -------------------------------- */

const rotationId = (tenantId, queueName) => `voice_rotation_${tenantId}_${String(queueName || '').toLowerCase()}`;

// Pode receber o toque quem esta com o painel aberto agora (socket conectado):
// e o que precisa para o aviso chegar na tela. A lista de "online" do login
// vive em memoria e zera quando o servidor reinicia; o socket reconecta sozinho.
const usuariosComPainelAberto = () => {
  const sockets = getIo()?.sockets?.sockets;
  if (!sockets || typeof sockets.values !== 'function') return getOnlineUserIds();
  const ids = new Set();
  for (const socket of sockets.values()) {
    if (socket?.userId && !socket.isGenesysExtension) ids.add(socket.userId);
  }
  return ids;
};

const ordemFixa = (a, b) => {
  const nome = String(a.name || a.username || '').localeCompare(String(b.name || b.username || ''), 'pt-BR', { sensitivity: 'base' });
  return nome || String(a.id).localeCompare(String(b.id));
};

const refAgente = (agente) => ({ id: agente.id, name: agente.name || agente.username || 'Atendente' });

// Situacao da fila agora: a ordem fixa completa e quem pode receber o toque ja
// (painel aberto, fora de outra ligacao e sem estar tocando para outro cliente).
// Recalculada a cada passo: quem abre o painel no meio da ligacao entra no
// rodizio, quem fecha sai.
const situacaoDaFila = async ({ tenantId, queueName, callId = null }) => {
  const agentes = await adapter.findMany('users', { query: { tenantId, role: 'AGENT' }, limit: 1000 });
  const online = usuariosComPainelAberto();
  const recentes = await adapter.findMany(VOICE_CALLS, { query: { tenantId }, sort: { createdAt: -1 }, limit: 200 });
  const ocupados = new Set(recentes
    .filter((call) => call.callId !== callId)
    .map((call) => {
      if (['active', 'connecting'].includes(call.status)) return call.answeredBy?.id;
      if (call.status === 'ringing') return call.currentAgentId;
      return null;
    })
    .filter(Boolean));

  const elegiveis = agentes
    .filter((agente) => Array.isArray(agente.queues) && agente.queues.includes(queueName))
    .filter((agente) => agente.active !== false && agente.status !== 'inactive')
    .sort(ordemFixa);
  const disponiveis = elegiveis.filter((agente) => online.has(agente.id) && !ocupados.has(agente.id));
  return { elegiveis, disponiveis };
};

// Proximo candidato depois de `referenciaId` na ordem fixa (volta ao comeco).
const proximoDepois = (elegiveis, candidatos, referenciaId) => {
  if (!candidatos.length) return null;
  const posicao = referenciaId ? elegiveis.findIndex((agente) => agente.id === referenciaId) : -1;
  if (posicao < 0) return candidatos[0];
  return candidatos.find((agente) => elegiveis.indexOf(agente) > posicao) || candidatos[0];
};

const lerPonteiro = (tenantId, queueName) => adapter.findOne(VOICE_ROTATION, { id: rotationId(tenantId, queueName) });

// Quem tocaria agora, na ordem do rodizio, comecando pelo proximo depois de
// quem recebeu a primeira tentativa da ligacao anterior.
export const buildRingOrder = async ({ tenantId, queueName, callId = null }) => {
  const { elegiveis, disponiveis } = await situacaoDaFila({ tenantId, queueName, callId });
  if (!disponiveis.length) return [];
  const primeiro = proximoDepois(elegiveis, disponiveis, (await lerPonteiro(tenantId, queueName))?.lastAgentId);
  const inicio = disponiveis.indexOf(primeiro);
  return [...disponiveis.slice(inicio), ...disponiveis.slice(0, inicio)].map(refAgente);
};

const avancarPonteiro = (tenantId, queueName, agentId) => adapter.saveDocument(VOICE_ROTATION, {
  id: rotationId(tenantId, queueName),
  tenantId,
  queueName,
  lastAgentId: agentId,
  updatedAt: nowIso()
});

const ringPayload = (call) => ({
  callId: call.callId,
  from: call.from,
  contactName: call.contactName,
  chatId: call.chatId,
  sdp: call.offerSdp,
  queueName: call.queueName,
  expiresAt: call.deadlineAt
});

// Sem ninguem para tocar, confere de novo a cada 2 s ate o prazo.
const ESPERA_MS = 2000;

const agendarPasso = (callId, ms) => {
  const atual = timers.get(callId) || {};
  clearTimeout(atual.ring);
  timers.set(callId, { ...atual, ring: setTimeout(() => { tocarProximo(callId).catch(() => {}); }, ms) });
};

const tocarProximo = async (callId) => {
  const call = await buscarChamada(callId);
  if (!call || call.status !== 'ringing') return;
  const restante = new Date(call.deadlineAt).getTime() - Date.now();
  if (restante <= 1000) return;

  const anterior = call.currentAgentId;
  const { elegiveis, disponiveis } = await situacaoDaFila({ tenantId: call.tenantId, queueName: call.queueName, callId });
  // Quem recusou nao toca de novo nesta ligacao.
  const recusaram = new Set(call.declinedBy || []);
  const candidatos = disponiveis.filter((agente) => !recusaram.has(agente.id));

  if (!candidatos.length) {
    if (disponiveis.length) {
      // Todo mundo que podia atender recusou: encerra ja, em vez de deixar o cliente chamando.
      limparTimers(callId);
      if (anterior) emitirParaUsuario(anterior, 'voice_call_ringing_stop', { callId, reason: 'declined' });
      await salvarChamada({ ...call, status: 'unanswered', currentAgentId: null, endReason: 'all_declined' });
      const config = await getWhatsAppConfig(call.tenantId);
      await sendCallAction({ accessToken: config?.accessToken, phoneNumberId: call.phoneNumberId, callId, action: 'reject' }).catch(() => null);
      return;
    }
    // Ninguem com o painel aberto agora: a ligacao continua chamando para o
    // cliente e o Onion confere de novo, para quem entrar no meio ainda atender.
    if (anterior) emitirParaUsuario(anterior, 'voice_call_ringing_stop', { callId, reason: 'agent_left' });
    if (anterior || !call.waitingSince) {
      await salvarChamada({ ...call, currentAgentId: null, waitingSince: call.waitingSince || nowIso() });
    }
    agendarPasso(callId, Math.min(ESPERA_MS, restante));
    return;
  }

  const primeiroToque = !(call.offeredTo || []).length;
  const referencia = primeiroToque
    ? (await lerPonteiro(call.tenantId, call.queueName))?.lastAgentId
    : (anterior || call.lastRungAgentId || null);
  const agente = refAgente(proximoDepois(elegiveis, candidatos, referencia));
  const ordem = call.ringOrder || [];
  const atualizado = await salvarChamada({
    ...call,
    currentAgentId: agente.id,
    lastRungAgentId: agente.id,
    waitingSince: null,
    offeredTo: [...new Set([...(call.offeredTo || []), agente.id])],
    ringOrder: ordem.some((item) => item.id === agente.id) ? ordem : [...ordem, agente]
  });
  if (primeiroToque) await avancarPonteiro(call.tenantId, call.queueName, agente.id);

  if (anterior && anterior !== agente.id) emitirParaUsuario(anterior, 'voice_call_ringing_stop', { callId, reason: 'next_agent' });
  emitirParaUsuario(agente.id, 'voice_call_ringing', ringPayload(atualizado));

  const settings = await getVoiceSettings(call.tenantId);
  agendarPasso(callId, Math.min(settings.ringSeconds * 1000, restante));
};

const expirarToque = async (callId) => {
  const call = await buscarChamada(callId);
  limparTimers(callId);
  if (!call || call.status !== 'ringing') return;
  emitirParaUsuario(call.currentAgentId, 'voice_call_ringing_stop', { callId, reason: 'expired' });
  // Nao recusa: deixa a Meta encerrar como "nao atendida", que e o que o cliente
  // entende. O webhook terminate registra a perdida.
  await salvarChamada({ ...call, status: 'unanswered', currentAgentId: null });
};

/* ----------------------------- ciclo da chamada ---------------------------- */

const resolverTenant = async (evento, tenantId) => {
  if (tenantId) return tenantId;
  if (!evento.phoneNumberId) return null;
  return (await findWhatsAppConfigByPhoneNumberId(evento.phoneNumberId))?.tenantId || null;
};

// Conversa do cliente para a linha do tempo. Usa a mais recente em aberto.
// Sem conversa aberta, cria um registro ja encerrado so para a ligacao: uma
// conversa nova em modo robo faria o fluxo rodar e ela ficaria no monitoramento
// como "na automacao". Se o cliente escrever depois, nasce uma conversa normal.
const conversaDoCliente = async ({ tenantId, from, phoneNumberId, contactName = null, queueName = null }) => {
  const channelUserId = normalizeWhatsappWaId(from);
  if (!channelUserId) return null;
  const abertas = await adapter.findDocuments('activeChats', { tenantId, channel: 'whatsapp', channelUserId, status: { $ne: 'closed' } });
  const recente = (Array.isArray(abertas) ? abertas : [])
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0];
  if (recente) return recente;

  const agora = nowIso();
  const registro = {
    id: generateId('chat'),
    tenantId,
    customerCpf: `wa_${channelUserId}`,
    customerName: contactName || null,
    status: 'closed',
    origin: 'voice_call',
    closeReason: 'voice_call_only',
    queue: queueName || null,
    messages: [],
    lastMessage: null,
    lastMessageAt: null,
    messageCount: 0,
    unreadByAgentCount: 0,
    vars: {},
    channel: 'whatsapp',
    channelUserId,
    channelChatId: channelUserId,
    whatsappPhoneNumberId: phoneNumberId || null,
    currentNodeId: null,
    processedMessageIds: [],
    createdAt: agora,
    updatedAt: agora,
    closedAt: agora
  };
  await adapter.saveDocument('activeChats', registro);
  return registro;
};

const registrarNaConversa = async (call, type, context = {}) => {
  if (!call.chatId) return;
  await emitChatEvent({
    tenantId: call.tenantId,
    chatId: call.chatId,
    type,
    actor: context.actor || { kind: 'customer', id: call.from },
    context: { callId: call.callId, queueName: call.queueName, ...context.data }
  }).catch(() => null);
};

const onIncomingCall = async (evento, tenantId) => {
  if (evento.direction && evento.direction !== 'USER_INITIATED') return { skipped: 'not_user_initiated' };
  const existente = await buscarChamada(evento.callId);
  if (existente) return { skipped: 'duplicate' };

  const config = await getWhatsAppConfig(tenantId);
  const settings = await getVoiceSettings(tenantId);
  const chat = await conversaDoCliente({ tenantId, from: evento.from, phoneNumberId: evento.phoneNumberId, contactName: evento.contactName, queueName: settings.queueName }).catch(() => null);

  const base = {
    id: docId(evento.callId),
    tenantId,
    callId: evento.callId,
    direction: 'inbound',
    from: evento.from,
    contactName: evento.contactName,
    phoneNumberId: evento.phoneNumberId,
    chatId: chat?.id || null,
    contactId: chat?.contactId || null,
    queueName: settings.queueName,
    offerSdp: evento.sdp,
    receivedAt: evento.timestamp,
    createdAt: nowIso(),
    ringOrder: [],
    offeredTo: [],
    currentAgentId: null,
    answeredBy: null
  };

  if (!settings.enabled || !settings.queueName || !evento.sdp) {
    const call = await salvarChamada({ ...base, status: 'rejected', endReason: settings.enabled ? 'invalid_offer' : 'voice_disabled' });
    await sendCallAction({ accessToken: config?.accessToken, phoneNumberId: evento.phoneNumberId, callId: evento.callId, action: 'reject' }).catch(() => null);
    return { rejected: call.endReason };
  }

  await registrarNaConversa(base, CHAT_EVENT_TYPES.VOICE_CALL_RECEIVED, { data: { from: evento.from } });

  // Retrato de quem tocaria agora; o rodizio de verdade se recalcula a cada passo.
  const ordem = await buildRingOrder({ tenantId, queueName: settings.queueName, callId: evento.callId });
  const deadlineAt = new Date(Date.now() + settings.maxRingSeconds * 1000).toISOString();
  await salvarChamada({ ...base, status: 'ringing', ringOrder: ordem, deadlineAt });

  timers.set(evento.callId, {
    deadline: setTimeout(() => { expirarToque(evento.callId).catch(() => {}); }, settings.maxRingSeconds * 1000)
  });
  await tocarProximo(evento.callId);
  return { ringing: ordem.map((agente) => agente.id) };
};

const mensagemDePerdida = async (call) => {
  const settings = await getVoiceSettings(call.tenantId);
  if (!settings.missedMessage.enabled || !call.from) return false;
  const config = await getWhatsAppConfig(call.tenantId);
  if (!config?.accessToken) return false;
  const phoneNumberId = call.phoneNumberId || config.phoneNumberId;
  const to = normalizeWhatsappWaId(call.from);
  // A ligacao do cliente abre a janela de 24 h: texto livre, sem template.
  const resultado = await sendWhatsAppText({
    accessToken: config.accessToken,
    phoneNumberId,
    to,
    text: settings.missedMessage.text,
    debugContext: { tenantId: call.tenantId, operation: 'voice_missed_message', callId: call.callId }
  });
  if (call.chatId) {
    await appendChatMessage(call.chatId, {
      sender: 'bot',
      text: settings.missedMessage.text,
      providerMessageId: resultado?.messages?.[0]?.id || null,
      meta: { kind: 'voice_missed_message', callId: call.callId }
    }, { incrementUnread: false }).catch(() => null);
  }
  return true;
};

const onCallTerminated = async (evento, tenantId) => {
  const call = await buscarChamada(evento.callId);
  limparTimers(evento.callId);
  if (!call) return { skipped: 'unknown_call' };
  if (['completed', 'missed', 'failed', 'rejected'].includes(call.status)) return { skipped: 'already_closed' };

  const atendida = Boolean(call.answeredBy) && ['active', 'connecting'].includes(call.status);
  const status = atendida ? 'completed' : (evento.status === 'Failed' && call.status === 'connecting' ? 'failed' : 'missed');
  const fechado = await salvarChamada({
    ...call,
    status,
    currentAgentId: null,
    startedAt: evento.startTime || call.answeredAt || null,
    endedAt: evento.endTime || evento.timestamp,
    duration: atendida ? (evento.duration ?? null) : 0,
    endReason: call.endReason || (atendida
      ? (call.hungUpBy ? 'agent_hangup' : 'ended')
      : ((call.offeredTo || []).length ? 'not_answered' : 'no_agents'))
  });

  if (call.currentAgentId) emitirParaUsuario(call.currentAgentId, 'voice_call_ringing_stop', { callId: call.callId, reason: 'ended' });
  if (call.answeredBy?.id) emitirParaUsuario(call.answeredBy.id, 'voice_call_ended', { callId: call.callId, duration: fechado.duration });

  if (status === 'completed') {
    await registrarNaConversa(fechado, CHAT_EVENT_TYPES.VOICE_CALL_ENDED, {
      actor: { kind: 'agent', id: call.answeredBy.id, name: call.answeredBy.name },
      data: { duration: fechado.duration, answeredBy: call.answeredBy.name }
    });
  } else {
    const tentativas = (call.ringOrder || []).filter((agente) => (call.offeredTo || []).includes(agente.id)).map((agente) => agente.name);
    await registrarNaConversa(fechado, CHAT_EVENT_TYPES.VOICE_CALL_MISSED, { data: { ringedAgents: tentativas } });
    const enviada = await mensagemDePerdida(fechado).catch((error) => {
      console.warn('[VOICE] Falha ao enviar mensagem de ligacao perdida', { callId: call.callId, error: error?.message });
      return false;
    });
    if (enviada) await salvarChamada({ ...fechado, missedMessageSentAt: nowIso() });
  }
  await createLog('VOICE_CALL_END', { tenantId: call.tenantId, callId: call.callId, status, duration: fechado.duration }, 'system').catch(() => {});
  return { status };
};

export const handleVoiceCallWebhook = async ({ payload, tenantId = null }) => {
  const eventos = parseCallEvents(payload);
  const resultados = [];
  for (const evento of eventos) {
    const tenant = await resolverTenant(evento, tenantId);
    if (!tenant) {
      console.warn('[VOICE] Chamada de numero sem tenant', { phoneNumberId: evento.phoneNumberId });
      continue;
    }
    if (evento.event === 'connect') resultados.push(await onIncomingCall(evento, tenant));
    else if (evento.event === 'terminate') resultados.push(await onCallTerminated(evento, tenant));
  }
  return resultados;
};

/* --------------------------- acoes do atendente --------------------------- */

const erro = (message, status, code) => Object.assign(new Error(message), { status, code });

export const acceptVoiceCall = async ({ tenantId, callId, user, sdp }) => {
  if (!sdp || typeof sdp !== 'string') throw erro('Resposta de áudio ausente.', 400, 'voice_sdp_required');
  if (aceitando.has(callId)) throw erro('Outra pessoa já está atendendo esta ligação.', 409, 'voice_call_taken');
  aceitando.add(callId);
  try {
    const call = await buscarChamada(callId);
    if (!call || call.tenantId !== tenantId) throw erro('Ligação não encontrada.', 404, 'voice_call_not_found');
    if (call.status !== 'ringing') throw erro('Esta ligação não está mais tocando.', 409, 'voice_call_not_ringing');
    // So quem esta sendo chamado agora (ou acabou de ser, na virada do rodizio) atende.
    if (!(call.offeredTo || []).includes(user.id)) throw erro('Esta ligação não foi direcionada a você.', 403, 'voice_call_not_offered');
    if ((call.declinedBy || []).includes(user.id)) throw erro('Você recusou esta ligação.', 409, 'voice_call_declined');

    limparTimers(callId);
    const nome = user.name || user.username || 'Atendente';
    await salvarChamada({ ...call, status: 'connecting', currentAgentId: user.id, answeredBy: { id: user.id, name: nome } });
    for (const outro of call.offeredTo || []) {
      if (outro !== user.id) emitirParaUsuario(outro, 'voice_call_ringing_stop', { callId, reason: 'taken' });
    }

    const config = await getWhatsAppConfig(tenantId);
    try {
      await sendCallAction({ accessToken: config?.accessToken, phoneNumberId: call.phoneNumberId, callId, action: 'pre_accept', sdp });
      await sendCallAction({ accessToken: config?.accessToken, phoneNumberId: call.phoneNumberId, callId, action: 'accept', sdp, callbackData: call.id });
    } catch (error) {
      await salvarChamada({ ...call, status: 'failed', endReason: 'accept_failed', answeredBy: { id: user.id, name: nome }, failure: String(error.message).slice(0, 300) });
      throw erro(`A Meta não aceitou o atendimento: ${error.message}`, 502, 'voice_accept_failed');
    }

    const ativa = await salvarChamada({ ...(await buscarChamada(callId)), status: 'active', answeredAt: nowIso() });
    await registrarNaConversa(ativa, CHAT_EVENT_TYPES.VOICE_CALL_ANSWERED, {
      actor: { kind: 'agent', id: user.id, name: nome },
      data: { answeredBy: nome }
    });
    return { callId, status: 'active', chatId: ativa.chatId };
  } finally {
    aceitando.delete(callId);
  }
};

export const declineVoiceCall = async ({ tenantId, callId, user }) => {
  const call = await buscarChamada(callId);
  if (!call || call.tenantId !== tenantId) throw erro('Ligação não encontrada.', 404, 'voice_call_not_found');
  if (call.status !== 'ringing' || call.currentAgentId !== user.id) return { callId, status: call.status };
  emitirParaUsuario(user.id, 'voice_call_ringing_stop', { callId, reason: 'declined' });
  // Recusar passa para o proximo do rodizio na hora.
  await salvarChamada({ ...call, declinedBy: [...new Set([...(call.declinedBy || []), user.id])] });
  await tocarProximo(callId);
  return { callId, status: 'ringing' };
};

export const hangupVoiceCall = async ({ tenantId, callId, user }) => {
  const call = await buscarChamada(callId);
  if (!call || call.tenantId !== tenantId) throw erro('Ligação não encontrada.', 404, 'voice_call_not_found');
  if (call.answeredBy?.id !== user.id) throw erro('Só quem atendeu pode encerrar esta ligação.', 403, 'voice_call_not_owner');
  if (!['active', 'connecting'].includes(call.status)) return { callId, status: call.status };
  const config = await getWhatsAppConfig(tenantId);
  await salvarChamada({ ...call, hungUpBy: user.id });
  // Encerrar pela API e obrigatorio mesmo com BYE no audio: e o que fecha a cobranca.
  await sendCallAction({ accessToken: config?.accessToken, phoneNumberId: call.phoneNumberId, callId, action: 'terminate' });
  return { callId, status: 'ending' };
};

// Para o painel recuperar a ligacao depois de recarregar a pagina.
export const getCurrentCallForUser = async ({ tenantId, user }) => {
  const chamadas = await adapter.findMany(VOICE_CALLS, { query: { tenantId }, sort: { createdAt: -1 }, limit: 20 });
  const tocando = chamadas.find((call) => call.status === 'ringing' && call.currentAgentId === user.id);
  if (tocando) return { state: 'ringing', call: ringPayload(tocando) };
  const ativa = chamadas.find((call) => ['active', 'connecting'].includes(call.status) && call.answeredBy?.id === user.id);
  if (ativa) return { state: 'active', call: { callId: ativa.callId, from: ativa.from, contactName: ativa.contactName, chatId: ativa.chatId, answeredAt: ativa.answeredAt } };
  return { state: 'idle' };
};

export const listVoiceCalls = async ({ tenantId, limit = 50, page = 1 }) => {
  const porPagina = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const pagina = Math.max(Number.parseInt(page, 10) || 1, 1);
  const [chamadas, total] = await Promise.all([
    adapter.findMany(VOICE_CALLS, {
      query: { tenantId },
      sort: { createdAt: -1 },
      skip: (pagina - 1) * porPagina,
      limit: porPagina
    }),
    adapter.countDocuments(VOICE_CALLS, { tenantId })
  ]);
  // SDP nao sai daqui: e grande e so interessa na hora de atender.
  return {
    items: chamadas.map(({ offerSdp, ...resto }) => resto),
    pagination: { page: pagina, limit: porPagina, total, pages: Math.max(1, Math.ceil(total / porPagina)) }
  };
};

// So para testes: zera o estado em memoria.
export const resetVoiceCallRuntime = () => {
  for (const callId of [...timers.keys()]) limparTimers(callId);
  aceitando.clear();
  fakeCallActions.length = 0;
};
