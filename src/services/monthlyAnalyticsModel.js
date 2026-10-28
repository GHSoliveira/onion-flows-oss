const DAY = 86400000;
const OFFSET = 3 * 3600000;
const time = (value) => value ? new Date(value).getTime() : NaN;
const mean = (values) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
const dayKey = (ms) => new Date(ms - OFFSET).toISOString().slice(0, 10);
const boundary = (year, month) => Date.UTC(year, month, 1, 3);

export function monthlyRanges(month, now = new Date()) {
  const current = dayKey(now.getTime()).slice(0, 7);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) || month < '2020-01' || month > current) {
    throw Object.assign(new Error('Selecione um mes entre janeiro de 2020 e o mes atual.'), { status: 400 });
  }
  const [year, number] = month.split('-').map(Number);
  const start = boundary(year, number - 1);
  const monthEnd = boundary(year, number);
  const end = Math.min(monthEnd, now.getTime());
  const previousStart = boundary(year, number - 2);
  // Compare elapsed calendar days, not an entire previous month against a partial month.
  const previousEnd = end === monthEnd ? start : Math.min(start, previousStart + end - start);
  return { start, end, previousStart, previousEnd, partial: end < monthEnd, month, timezone: 'America/Sao_Paulo' };
}

export const MONTHLY_EVENT_TYPES = [
  'CHAT_OPENED', 'FLOW_STARTED', 'QUEUE_ENTERED', 'QUEUE_TRANSFERRED',
  'AGENT_ASSUMED', 'AGENT_CLOSED', 'CLOSED_BY_INACTIVITY', 'ERROR', 'FLOW_TIMEOUT', 'RATING_SUBMITTED'
];
const CLOSE = new Set(['AGENT_CLOSED', 'CLOSED_BY_INACTIVITY', 'LEGACY_CLOSED']);

export function buildMonthlyPeriod(chats, events, start, end) {
  const inPeriod = (ms) => ms >= start && ms < end;
  const summary = { incoming: 0, contacts: 0, waitMinutes: null, waitSamples: 0, rating: null, ratingSamples: 0, attended: 0 };
  const movement = { opening: 0, incoming: 0, reopened: 0, closed: 0, ending: 0 };
  const quality = { legacyClosures: 0, missingDates: 0, unmatchedPickups: 0, uncertainState: 0 };
  const incidents = { errors: 0, timeouts: 0, closedWaiting: 0, inactivity: 0 };
  const days = new Map();
  for (let ts = start; ts < end; ts += DAY) days.set(dayKey(ts), { day: dayKey(ts), incoming: 0, closed: 0, waits: [] });
  const daily = (ts) => days.get(dayKey(ts));
  const byChat = new Map();
  const seen = new Set();
  for (const event of events) {
    if (event.id && seen.has(event.id)) continue;
    if (event.id) seen.add(event.id);
    const ts = time(event.timestamp);
    if (!Number.isFinite(ts) || ts >= end) continue;
    if (!byChat.has(event.chatId)) byChat.set(event.chatId, []);
    byChat.get(event.chatId).push({ ...event, ts });
  }
  const queues = new Map();
  const agents = new Map();
  const group = (map, id, name) => {
    if (!map.has(id)) map.set(id, { id, name, chats: new Set(), pickups: 0, waits: [], ratings: [], closed: 0 });
    return map.get(id);
  };
  const contacts = new Set();
  const waits = [];
  const ratings = [];
  const attended = new Set();
  for (const chat of chats) {
    const created = time(chat.createdAt);
    if (!Number.isFinite(created)) { quality.missingDates++; continue; }
    if (created >= end) continue;
    const history = [...(byChat.get(chat.id) || [])];
    const closedAt = time(chat.closedAt);
    if (Number.isFinite(closedAt) && closedAt < end && !history.some((e) => CLOSE.has(e.type) && Math.abs(e.ts - closedAt) < 60000)) {
      history.push({ ts: closedAt, type: 'LEGACY_CLOSED' });
      if (inPeriod(closedAt)) quality.legacyClosures++;
    }
    history.sort((a, b) => a.ts - b.ts || String(a.id || '').localeCompare(String(b.id || '')));
    let open = true;
    let openAtStart = created < start;
    let waiting = null;
    let assignedAgent = null;
    let lastQueue = null;
    let lastClosed = null;
    if (inPeriod(created)) {
      summary.incoming++;
      movement.incoming++;
      daily(created).incoming++;
      const identity = chat.channelUserId || chat.customerCpf;
      if (identity) contacts.add(`${chat.channel || 'web'}:${identity}`);
    }
    for (const event of history) {
      const active = inPeriod(event.ts);
      if (event.type === 'CHAT_OPENED' || event.type === 'FLOW_STARTED') {
        if (!open) { open = true; if (active) movement.reopened++; }
      } else if (CLOSE.has(event.type)) {
        if (open) {
          open = false;
          lastClosed = event.ts;
          if (active) {
            movement.closed++;
            daily(event.ts).closed++;
            if (waiting) incidents.closedWaiting++;
            if (event.type === 'CLOSED_BY_INACTIVITY') incidents.inactivity++;
            if (lastQueue) group(queues, lastQueue, lastQueue).closed++;
            if (assignedAgent) group(agents, assignedAgent.id, assignedAgent.name).closed++;
          }
          waiting = null;
          assignedAgent = null;
        }
      } else if (event.type === 'QUEUE_ENTERED' || event.type === 'QUEUE_TRANSFERRED') {
        const queue = String(event.context?.queue || event.context?.toQueue || 'Sem fila identificada');
        // A transfer starts the destination queue's waiting interval; duplicate entry does not reset it.
        if (!waiting || waiting.queue !== queue || event.type === 'QUEUE_TRANSFERRED') waiting = { ts: event.ts, queue };
        lastQueue = queue;
        assignedAgent = null;
        if (active) group(queues, queue, queue).chats.add(chat.id);
      } else if (event.type === 'AGENT_ASSUMED') {
        const id = String(event.actor?.id || 'unknown');
        const name = String(event.actor?.name || 'Agente nao identificado');
        assignedAgent = { id, name };
        if (active) {
          attended.add(chat.id);
          const agent = group(agents, id, name);
          agent.chats.add(chat.id);
          agent.pickups++;
          if (waiting && event.ts >= waiting.ts) {
            const value = (event.ts - waiting.ts) / 60000;
            waits.push(value);
            daily(event.ts).waits.push(value);
            agent.waits.push(value);
            const queue = group(queues, waiting.queue, waiting.queue);
            queue.chats.add(chat.id);
            queue.pickups++;
            queue.waits.push(value);
          } else quality.unmatchedPickups++;
        }
        waiting = null;
      } else if (event.type === 'RATING_SUBMITTED') {
        // Nota registrada quando o cliente respondeu: conta na data dela, para o
        // atendente avaliado e a fila da conversa, mesmo que o fluxo tenha
        // terminado sozinho no no final (que nao gera evento de encerramento).
        const value = Number(event.context?.value);
        if (active && value >= 1 && value <= 5) {
          ratings.push(value);
          if (event.context?.agentId) group(agents, String(event.context.agentId), String(event.context.agentName || 'Agente nao identificado')).ratings.push(value);
          const queue = event.context?.queue || lastQueue;
          if (queue) group(queues, String(queue), String(queue)).ratings.push(value);
        }
      } else if (active && event.type === 'ERROR') incidents.errors++;
      else if (active && event.type === 'FLOW_TIMEOUT') incidents.timeouts++;
      if (event.ts < start) openAtStart = open;
    }
    if (openAtStart) movement.opening++;
    if (open) movement.ending++;
    if ((chat.status === 'closed' && !Number.isFinite(closedAt) && open)
      || (chat.status !== 'closed' && !open && time(chat.updatedAt) < end)) quality.uncertainState++;
    // Legacy ratings have no timestamp: associate only with the last known closure, not each reopening.
    // Conversa com nota registrada como evento ja contou acima.
    const hasRatingEvent = history.some((event) => event.type === 'RATING_SUBMITTED');
    const value = Number(chat.vars?.nota ?? chat.vars?.rating ?? chat.vars?.avaliacao);
    if (!hasRatingEvent && lastClosed !== null && inPeriod(lastClosed) && Math.abs(lastClosed - closedAt) < 60000 && value >= 1 && value <= 5) {
      ratings.push(value);
      if (chat.agentId) group(agents, String(chat.agentId), String(chat.agentName || 'Agente nao identificado')).ratings.push(value);
      if (chat.queue) group(queues, String(chat.queue), String(chat.queue)).ratings.push(value);
    }
  }
  summary.contacts = contacts.size;
  summary.waitMinutes = mean(waits);
  summary.waitSamples = waits.length;
  summary.rating = mean(ratings);
  summary.ratingSamples = ratings.length;
  summary.attended = attended.size;
  const rows = (map) => [...map.values()].map((row) => ({
    id: row.id, name: row.name, conversations: row.chats.size, pickups: row.pickups,
    waitMinutes: mean(row.waits), waitSamples: row.waits.length, closed: row.closed,
    rating: mean(row.ratings), ratingSamples: row.ratings.length
  })).sort((a, b) => b.conversations - a.conversations || a.name.localeCompare(b.name));
  return {
    summary, movement, incidents, quality, queues: rows(queues), agents: rows(agents),
    days: [...days.values()].map(({ waits: samples, ...day }) => ({ ...day, waitMinutes: mean(samples), waitSamples: samples.length }))
  };
}
