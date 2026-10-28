import adapter from '../../db/DatabaseAdapter.js';
import { CHAT_EVENT_TYPES } from './chatEvents.js';

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();

const cacheKey = (scope, params) => `${scope}|${JSON.stringify(params)}`;

const fromCache = (key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

const putCache = (key, value) => {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
};

export const clearAnalyticsCache = () => cache.clear();

const isoOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const normalizeRange = ({ from, to }) => {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromIso = isoOrNull(from) || defaultFrom.toISOString();
  const toIso = isoOrNull(to) || now.toISOString();
  return { from: fromIso, to: toIso };
};

const buildChatQuery = ({ tenantId, from, to, channel = null, queue = null }) => {
  const query = {
    tenantId,
    createdAt: { $gte: from, $lte: to }
  };
  if (channel) query.channel = channel;
  if (queue) query.queue = queue;
  return query;
};

const loadChatsAndEvents = async ({ tenantId, from, to, channel, queue }) => {
  const [chats, events] = await Promise.all([
    adapter.findMany('activeChats', {
      query: buildChatQuery({ tenantId, from, to, channel, queue }),
      limit: 0
    }),
    adapter.findMany('chatEvents', {
      query: { tenantId, timestamp: { $gte: from, $lte: to } },
      sort: { timestamp: 1 },
      limit: 0
    })
  ]);

  const eventsByChat = new Map();
  for (const event of events) {
    if (!eventsByChat.has(event.chatId)) eventsByChat.set(event.chatId, []);
    eventsByChat.get(event.chatId).push(event);
  }

  return { chats, eventsByChat };
};

const summarizeChat = (chat, chatEvents) => {
  const events = chatEvents || [];
  const findEvent = (type) => events.find((event) => event.type === type) || null;

  const opened = findEvent(CHAT_EVENT_TYPES.CHAT_OPENED) || { timestamp: chat.createdAt };
  const queueEntered = findEvent(CHAT_EVENT_TYPES.QUEUE_ENTERED);
  const agentAssumed = findEvent(CHAT_EVENT_TYPES.AGENT_ASSUMED);
  const agentClosed = findEvent(CHAT_EVENT_TYPES.AGENT_CLOSED);
  const closedByInactivity = findEvent(CHAT_EVENT_TYPES.CLOSED_BY_INACTIVITY)
    || (chat.closedByInactivity || chat.inactivityClosed
        ? { type: CHAT_EVENT_TYPES.CLOSED_BY_INACTIVITY, timestamp: chat.closedAt }
        : null);

  const reachedQueue = Boolean(queueEntered) || Boolean(chat.waitingSince) || Boolean(chat.queue && chat.status === 'waiting');
  const reachedAgent = Boolean(agentAssumed) || Boolean(chat.agentId);
  const isClosed = chat.status === 'closed';
  const lostInQueue = reachedQueue && !reachedAgent && isClosed;

  let waitMinutes = null;
  if (queueEntered && agentAssumed) {
    const start = new Date(queueEntered.timestamp).getTime();
    const end = new Date(agentAssumed.timestamp).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      waitMinutes = (end - start) / 60000;
    }
  } else if (chat.waitingSince && agentAssumed) {
    const start = new Date(chat.waitingSince).getTime();
    const end = new Date(agentAssumed.timestamp).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      waitMinutes = (end - start) / 60000;
    }
  }

  return {
    chatId: chat.id,
    channel: chat.channel || null,
    queue: chat.queue || queueEntered?.context?.queue || null,
    openedAt: opened.timestamp || chat.createdAt,
    closedAt: chat.closedAt || agentClosed?.timestamp || closedByInactivity?.timestamp || null,
    reachedQueue,
    reachedAgent,
    isClosed,
    closedByAgent: Boolean(agentClosed),
    closedByInactivity: Boolean(closedByInactivity),
    lostInQueue,
    waitMinutes,
    resolvedByBotOnly: !reachedAgent && !reachedQueue && isClosed
  };
};

const average = (numbers) => {
  const valid = numbers.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
};

export const getOverview = async ({ tenantId, from, to, channel = null, queue = null }) => {
  if (!tenantId) return null;
  const range = normalizeRange({ from, to });
  const key = cacheKey('overview', { tenantId, ...range, channel, queue });
  const cached = fromCache(key);
  if (cached) return cached;

  const { chats, eventsByChat } = await loadChatsAndEvents({ tenantId, ...range, channel, queue });
  const summaries = chats.map((chat) => summarizeChat(chat, eventsByChat.get(chat.id)));

  const entradas = summaries.length;
  const resolvidosBot = summaries.filter((s) => s.resolvedByBotOnly).length;
  const atendidosHumano = summaries.filter((s) => s.reachedAgent).length;
  const fechadosPorAgente = summaries.filter((s) => s.closedByAgent).length;
  const fechadosPorInatividade = summaries.filter((s) => s.closedByInactivity).length;
  const perdidosNaFila = summaries.filter((s) => s.lostInQueue).length;
  const emFila = summaries.filter((s) => s.reachedQueue && !s.reachedAgent && !s.isClosed).length;
  const emAtendimento = summaries.filter((s) => s.reachedAgent && !s.isClosed).length;

  const tempoMedioEsperaMin = average(summaries.map((s) => s.waitMinutes));

  const result = {
    range,
    filters: { channel, queue },
    entradas,
    resolvidosBot,
    atendidosHumano,
    fechadosPorAgente,
    fechadosPorInatividade,
    perdidosNaFila,
    emFila,
    emAtendimento,
    tempoMedioEsperaMin: tempoMedioEsperaMin !== null ? Number(tempoMedioEsperaMin.toFixed(2)) : null
  };

  return putCache(key, result);
};

const bucketStart = (isoDate, bucket) => {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return null;
  if (bucket === 'day') {
    date.setUTCHours(0, 0, 0, 0);
  } else {
    date.setUTCMinutes(0, 0, 0);
  }
  return date.toISOString();
};

const enumerateBuckets = (fromIso, toIso, bucket) => {
  const buckets = [];
  const start = new Date(bucketStart(fromIso, bucket));
  const end = new Date(toIso);
  let cursor = new Date(start);
  const stepMs = bucket === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  while (cursor.getTime() <= end.getTime()) {
    buckets.push(cursor.toISOString());
    cursor = new Date(cursor.getTime() + stepMs);
  }
  return buckets;
};

export const getTimeseries = async ({ tenantId, from, to, bucket = 'hour', channel = null, queue = null }) => {
  if (!tenantId) return null;
  const range = normalizeRange({ from, to });
  const normalizedBucket = bucket === 'day' ? 'day' : 'hour';
  const key = cacheKey('timeseries', { tenantId, ...range, bucket: normalizedBucket, channel, queue });
  const cached = fromCache(key);
  if (cached) return cached;

  const { chats, eventsByChat } = await loadChatsAndEvents({ tenantId, ...range, channel, queue });
  const summaries = chats.map((chat) => summarizeChat(chat, eventsByChat.get(chat.id)));

  const buckets = enumerateBuckets(range.from, range.to, normalizedBucket);
  const map = new Map();
  for (const ts of buckets) {
    map.set(ts, { ts, entradas: 0, fechamentos: 0, fila: 0 });
  }

  const bump = (isoTimestamp, field) => {
    const key = bucketStart(isoTimestamp, normalizedBucket);
    if (!key) return;
    const entry = map.get(key);
    if (entry) entry[field] += 1;
  };

  for (const summary of summaries) {
    if (summary.openedAt) bump(summary.openedAt, 'entradas');
    if (summary.closedAt) bump(summary.closedAt, 'fechamentos');
    if (summary.reachedQueue) {
      const queueEnteredEvent = (eventsByChat.get(summary.chatId) || [])
        .find((event) => event.type === CHAT_EVENT_TYPES.QUEUE_ENTERED);
      const queueTs = queueEnteredEvent?.timestamp || summary.openedAt;
      if (queueTs) bump(queueTs, 'fila');
    }
  }

  const result = {
    range,
    bucket: normalizedBucket,
    filters: { channel, queue },
    points: Array.from(map.values())
  };

  return putCache(key, result);
};

const percentile = (sortedValues, p) => {
  if (!sortedValues.length) return null;
  const rank = (sortedValues.length - 1) * p;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
};

const round = (value, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const NODE_WAIT_TYPES = new Set(['inputNode', 'menuNode', 'holderNode', 'whatsappTemplateNode', 'ratingNode']);

export const getBottlenecks = async ({ tenantId, from, to, channel = null, queue = null }) => {
  if (!tenantId) return null;
  const range = normalizeRange({ from, to });
  const key = cacheKey('bottlenecks', { tenantId, ...range, channel, queue });
  const cached = fromCache(key);
  if (cached) return cached;

  const { chats, eventsByChat } = await loadChatsAndEvents({ tenantId, ...range, channel, queue });

  // === FILAS ===
  const queueStats = new Map();
  for (const chat of chats) {
    const summary = summarizeChat(chat, eventsByChat.get(chat.id));
    const queueName = summary.queue;
    if (!queueName && !summary.reachedQueue) continue;
    const targetQueue = queueName || '(sem fila)';
    if (!queueStats.has(targetQueue)) {
      queueStats.set(targetQueue, { entradas: 0, abandonos: 0, atendidos: 0, esperas: [] });
    }
    const stats = queueStats.get(targetQueue);
    stats.entradas += 1;
    if (summary.lostInQueue) stats.abandonos += 1;
    if (summary.reachedAgent) stats.atendidos += 1;
    if (Number.isFinite(summary.waitMinutes)) stats.esperas.push(summary.waitMinutes);
  }
  const filas = Array.from(queueStats.entries())
    .map(([name, stats]) => {
      const sorted = [...stats.esperas].sort((a, b) => a - b);
      const taxaPerda = stats.entradas > 0 ? stats.abandonos / stats.entradas : 0;
      return {
        queue: name,
        entradas: stats.entradas,
        atendidos: stats.atendidos,
        abandonos: stats.abandonos,
        taxaPerda: round(taxaPerda, 4),
        esperaP50Min: round(percentile(sorted, 0.5), 2),
        esperaP95Min: round(percentile(sorted, 0.95), 2)
      };
    })
    .sort((a, b) => (b.esperaP95Min || 0) - (a.esperaP95Min || 0))
    .slice(0, 10);

  // === NÓS DO FLUXO ===
  const nodeStats = new Map();
  for (const [chatId, events] of eventsByChat) {
    let lastWaitNode = null;
    for (const event of events) {
      if (event.type === CHAT_EVENT_TYPES.FLOW_NODE_ENTERED) {
        const nodeType = event.context?.nodeType;
        if (!NODE_WAIT_TYPES.has(nodeType)) continue;
        const nodeKey = event.context?.nodeId || nodeType;
        const label = event.context?.nodeLabel || nodeType;
        if (!nodeStats.has(nodeKey)) {
          nodeStats.set(nodeKey, { nodeId: nodeKey, nodeType, label, entradas: 0, timeouts: 0, transferidos: 0 });
        }
        const stats = nodeStats.get(nodeKey);
        stats.entradas += 1;
        lastWaitNode = nodeKey;
      } else if (event.type === CHAT_EVENT_TYPES.FLOW_TIMEOUT && lastWaitNode) {
        const stats = nodeStats.get(lastWaitNode);
        if (stats) stats.timeouts += 1;
        lastWaitNode = null;
      } else if (event.type === CHAT_EVENT_TYPES.QUEUE_ENTERED && lastWaitNode) {
        const stats = nodeStats.get(lastWaitNode);
        if (stats) stats.transferidos += 1;
        lastWaitNode = null;
      }
    }
  }
  const nodos = Array.from(nodeStats.values())
    .map((stats) => ({
      ...stats,
      taxaTimeout: stats.entradas > 0 ? round(stats.timeouts / stats.entradas, 4) : 0
    }))
    .sort((a, b) => b.timeouts - a.timeouts || b.entradas - a.entradas)
    .slice(0, 10);

  // === CANAIS ===
  const channelStats = new Map();
  for (const chat of chats) {
    const summary = summarizeChat(chat, eventsByChat.get(chat.id));
    const channelName = summary.channel || '(desconhecido)';
    if (!channelStats.has(channelName)) {
      channelStats.set(channelName, { entradas: 0, perdidos: 0, atendidos: 0, fechadosInatividade: 0 });
    }
    const stats = channelStats.get(channelName);
    stats.entradas += 1;
    if (summary.lostInQueue) stats.perdidos += 1;
    if (summary.reachedAgent) stats.atendidos += 1;
    if (summary.closedByInactivity) stats.fechadosInatividade += 1;
  }
  const canais = Array.from(channelStats.entries())
    .map(([name, stats]) => ({
      channel: name,
      entradas: stats.entradas,
      atendidos: stats.atendidos,
      perdidos: stats.perdidos,
      fechadosInatividade: stats.fechadosInatividade,
      taxaPerda: stats.entradas > 0 ? round(stats.perdidos / stats.entradas, 4) : 0,
      taxaInatividade: stats.entradas > 0 ? round(stats.fechadosInatividade / stats.entradas, 4) : 0
    }))
    .sort((a, b) => b.entradas - a.entradas);

  // === AGENTES ===
  const agentStats = new Map();
  const recordAgent = (agentId, name) => {
    if (!agentStats.has(agentId)) {
      agentStats.set(agentId, { agentId, name: name || agentId, atendidos: 0, duracoes: [] });
    } else if (name && !agentStats.get(agentId).name) {
      agentStats.get(agentId).name = name;
    }
    return agentStats.get(agentId);
  };

  for (const events of eventsByChat.values()) {
    let lastAssume = null;
    for (const event of events) {
      if (event.type === CHAT_EVENT_TYPES.AGENT_ASSUMED) {
        lastAssume = event;
        const stats = recordAgent(event.actor?.id || 'desconhecido', event.actor?.name);
        stats.atendidos += 1;
      } else if (
        (event.type === CHAT_EVENT_TYPES.AGENT_CLOSED || event.type === CHAT_EVENT_TYPES.RESUME_TO_FLOW)
        && lastAssume
      ) {
        const start = new Date(lastAssume.timestamp).getTime();
        const end = new Date(event.timestamp).getTime();
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          const stats = recordAgent(lastAssume.actor?.id || 'desconhecido', lastAssume.actor?.name);
          stats.duracoes.push((end - start) / 60000);
        }
        lastAssume = null;
      }
    }
  }

  const openChats = await adapter.findMany('activeChats', {
    query: { tenantId, status: 'open' },
    projection: { id: 1, agentId: 1, agentName: 1, updatedAt: 1 },
    limit: 0
  });
  const openByAgent = new Map();
  for (const chat of openChats) {
    if (!chat.agentId) continue;
    if (!openByAgent.has(chat.agentId)) openByAgent.set(chat.agentId, { count: 0, name: chat.agentName || null });
    openByAgent.get(chat.agentId).count += 1;
  }
  for (const [agentId, info] of openByAgent) {
    const stats = recordAgent(agentId, info.name);
    stats.emAtendimento = info.count;
  }

  const agentes = Array.from(agentStats.values())
    .map((stats) => {
      const sorted = [...stats.duracoes].sort((a, b) => a - b);
      return {
        agentId: stats.agentId,
        name: stats.name,
        atendidos: stats.atendidos,
        emAtendimento: stats.emAtendimento || 0,
        duracaoMediaMin: stats.duracoes.length ? round(stats.duracoes.reduce((a, b) => a + b, 0) / stats.duracoes.length, 2) : null,
        duracaoP95Min: round(percentile(sorted, 0.95), 2)
      };
    })
    .filter((stats) => stats.atendidos > 0 || stats.emAtendimento > 0)
    .sort((a, b) => (b.emAtendimento || 0) - (a.emAtendimento || 0) || b.atendidos - a.atendidos)
    .slice(0, 10);

  const result = {
    range,
    filters: { channel, queue },
    filas,
    nodos,
    canais,
    agentes
  };

  return putCache(key, result);
};

export const getFunnel = async ({ tenantId, from, to, channel = null, queue = null }) => {
  if (!tenantId) return null;
  const range = normalizeRange({ from, to });
  const key = cacheKey('funnel', { tenantId, ...range, channel, queue });
  const cached = fromCache(key);
  if (cached) return cached;

  const { chats, eventsByChat } = await loadChatsAndEvents({ tenantId, ...range, channel, queue });
  const summaries = chats.map((chat) => summarizeChat(chat, eventsByChat.get(chat.id)));

  const abriu = summaries.length;
  const entrouFila = summaries.filter((s) => s.reachedQueue).length;
  const agenteAssumiu = summaries.filter((s) => s.reachedAgent).length;
  const resolvido = summaries.filter((s) => s.closedByAgent).length;

  const result = {
    range,
    filters: { channel, queue },
    stages: [
      { stage: 'abriu', label: 'Atendimento aberto', count: abriu },
      { stage: 'entrou_fila', label: 'Entrou em fila', count: entrouFila },
      { stage: 'agente_assumiu', label: 'Agente assumiu', count: agenteAssumiu },
      { stage: 'resolvido', label: 'Resolvido por agente', count: resolvido }
    ]
  };

  return putCache(key, result);
};
