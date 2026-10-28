import adapter from '../../db/DatabaseAdapter.js';
import { CHAT_EVENT_TYPES, emitChatEvent, queryChatEvents } from './chatEvents.js';

// Nota dada pelo cliente no no de nota. Vira um evento com data, valor e o
// atendente avaliado, e e desse evento que saem media e contagem.
//
// Antes a nota so ficava em vars.nota e dois contadores tentavam atribui-la ao
// atendente: um ao encerrar/devolver (antes de o cliente responder a nota) e
// outro no no final (quando a conversa ja nao tinha atendente). No fluxo
// normal fila -> atendente -> nota -> fim a nota nunca chegava a ninguem.

export const RATING_MIN = 1;
export const RATING_MAX = 5;

export const isValidRating = (value) => Number.isInteger(value) && value >= RATING_MIN && value <= RATING_MAX;

// Quem o cliente esta avaliando: o atendente atual ou, se a conversa ja voltou
// para o fluxo, o ultimo que assumiu depois do inicio do fluxo desta rodada.
export const resolveRatedAgent = async (chat) => {
  if (!chat?.id || !chat?.tenantId) return null;
  if (chat.agentId) {
    let name = chat.agentName || null;
    if (!name) name = (await adapter.findOne('users', { id: chat.agentId }, { projection: { _id: 0, name: 1, username: 1 } }))?.name || null;
    return { id: String(chat.agentId), name: name || 'Atendente' };
  }
  const eventos = await queryChatEvents({
    tenantId: chat.tenantId,
    chatId: chat.id,
    types: [CHAT_EVENT_TYPES.FLOW_STARTED, CHAT_EVENT_TYPES.AGENT_ASSUMED],
    limit: 2000
  });
  let ultimo = null;
  for (const evento of eventos) {
    // Eventos vem em ordem de data. Um fluxo novo zera: atendente de rodada anterior nao conta.
    if (evento.type === CHAT_EVENT_TYPES.FLOW_STARTED) ultimo = null;
    else if (evento.type === CHAT_EVENT_TYPES.AGENT_ASSUMED && evento.actor?.id) {
      ultimo = { id: String(evento.actor.id), name: evento.actor.name || 'Atendente' };
    }
  }
  return ultimo;
};

// Atualiza media e contagem guardadas no cadastro do atendente, que varias telas
// ja leem. Uma vez por nota, no momento em que ela e dada.
const somarNoAtendente = async (agentId, value) => {
  const user = await adapter.getDocument('users', { id: agentId });
  if (!user) return;
  const ratingCount = Number(user.ratingCount || 0) + 1;
  const ratingSum = Number(user.ratingSum || 0) + value;
  await adapter.updateOne('users', { id: agentId }, {
    $set: { ratingCount, ratingSum, ratingAvg: ratingSum / ratingCount, lastRatingAt: new Date().toISOString() }
  });
};

export const recordRating = async ({ chat, value, variableName = 'nota', nodeId = null }) => {
  if (!chat?.id || !chat?.tenantId || !isValidRating(value)) return null;
  // Simulador do editor nao entra em relatorio nem na media de ninguem.
  if (chat.isFlowTest) return null;
  const agente = await resolveRatedAgent(chat);
  const evento = await emitChatEvent({
    tenantId: chat.tenantId,
    chatId: chat.id,
    type: CHAT_EVENT_TYPES.RATING_SUBMITTED,
    actor: { kind: 'customer', id: chat.channelUserId || chat.customerCpf || null },
    context: {
      value,
      variableName,
      nodeId,
      agentId: agente?.id || null,
      agentName: agente?.name || null,
      queue: chat.queue || null
    }
  });
  if (agente?.id) await somarNoAtendente(agente.id, value).catch((error) => {
    console.warn('[RATING] Falha ao atualizar media do atendente', { agentId: agente.id, error: error?.message });
  });
  return evento;
};

// Nota antiga (sem evento): so a variavel da conversa, nos nomes que os
// relatorios sempre usaram.
export const legacyChatRating = (chat) => {
  const vars = chat?.vars || {};
  const value = Number(vars.nota ?? vars.rating ?? vars.avaliacao);
  return Number.isFinite(value) && value >= RATING_MIN && value <= RATING_MAX ? value : null;
};
