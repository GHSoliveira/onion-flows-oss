import adapter from '../../db/DatabaseAdapter.js';
import { buildMonthlyPeriod, monthlyRanges, MONTHLY_EVENT_TYPES } from './monthlyAnalyticsModel.js';

const cache = new Map();
const pending = new Map();
const TTL = 30000;
const CHAT_PROJECTION = { _id: 0, id: 1, tenantId: 1, createdAt: 1, updatedAt: 1, closedAt: 1, status: 1, channel: 1,
  channelUserId: 1, customerCpf: 1, queue: 1, agentId: 1, agentName: 1, 'vars.nota': 1, 'vars.rating': 1, 'vars.avaliacao': 1 };
const EVENT_PROJECTION = { _id: 0, id: 1, chatId: 1, type: 1, timestamp: 1, 'actor.id': 1, 'actor.name': 1, 'context.queue': 1, 'context.toQueue': 1,
  'context.value': 1, 'context.agentId': 1, 'context.agentName': 1 };

// The compatibility adapter filters/projections in JS. This report must not download
// entire message arrays or secrets before projecting when backed by PostgreSQL.
export function monthlyPostgresPage(tableName, collection, query, lastId, projection) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableName)) throw new Error('Invalid analytics table');
  const fields = {};
  for (const [path, include] of Object.entries(projection)) {
    if (!include) continue;
    const [parent, child] = path.split('.');
    if (!/^[a-z_][a-z0-9_]*$/i.test(parent) || (child && !/^[a-z_][a-z0-9_]*$/i.test(child))) throw new Error('Invalid projection');
    if (child) (fields[parent] ||= []).push(`'${child}', doc #> '{${parent},${child}}'`);
    else fields[parent] = `doc -> '${parent}'`;
  }
  const select = Object.entries(fields).map(([key, value]) => `'${key}', ${Array.isArray(value) ? `jsonb_build_object(${value.join(',')})` : value}`).join(',');
  const timestampField = collection === 'activeChats' ? 'createdAt' : 'timestamp';
  const values = [collection, query.tenantId, query[timestampField].$lt];
  const clauses = ['collection = $1', 'tenant_id = $2', `doc ->> '${timestampField}' < $3`];
  if (lastId) { values.push(lastId); clauses.push(`id > $${values.length}`); }
  if (query.channel) { values.push(query.channel); clauses.push(`doc ->> 'channel' = $${values.length}`); }
  if (query.type) { values.push(query.type.$in); clauses.push(`doc ->> 'type' = any($${values.length}::text[])`); }
  return { text: `select jsonb_build_object(${select}) as doc from ${tableName} where ${clauses.join(' and ')} order by id limit 1000`, values };
}

async function readPages(collection, query, projection, maximum) {
  const result = [];
  let lastId;
  while (true) {
    const batch = adapter.pool && adapter.tableName
      ? (await adapter.pool.query(monthlyPostgresPage(adapter.tableName, collection, query, lastId, projection))).rows.map((row) => row.doc)
      : await adapter.findMany(collection, {
      query: { ...query, ...(lastId ? { id: { $gt: lastId } } : {}) }, projection, sort: { id: 1 }, limit: 1000
    });
    result.push(...batch);
    if (result.length > maximum) throw Object.assign(new Error('Periodo excede o limite do relatorio online. Solicite uma exportacao assistida.'), { status: 422 });
    if (batch.length < 1000) return result;
    const next = batch.at(-1)?.id;
    if (!next || next === lastId) throw new Error('Invalid analytics cursor');
    lastId = next;
  }
}

export async function getMonthlyAnalytics({ tenantId, month, channel = null }) {
  if (!tenantId) throw Object.assign(new Error('Tenant obrigatorio.'), { status: 400 });
  if (channel && !['web', 'whatsapp', 'telegram', 'simulator'].includes(channel)) throw Object.assign(new Error('Canal invalido.'), { status: 400 });
  const range = monthlyRanges(month);
  const key = JSON.stringify([tenantId, month, channel]);
  const cached = cache.get(key);
  if (cached?.expires > Date.now()) return cached.value;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= 2) throw Object.assign(new Error('Relatorios em processamento. Tente novamente em instantes.'), { status: 503 });
  const task = (async () => {
    if (!adapter.db) await adapter.init();
    const chats = await readPages('activeChats', {
      tenantId, createdAt: { $lt: new Date(range.end).toISOString() }, ...(channel ? { channel } : {})
    }, CHAT_PROJECTION, 20000);
    const events = await readPages('chatEvents', {
      tenantId, timestamp: { $lt: new Date(range.end).toISOString() }, type: { $in: MONTHLY_EVENT_TYPES }
    }, EVENT_PROJECTION, 100000);
    const current = buildMonthlyPeriod(chats, events, range.start, range.end);
    const previous = buildMonthlyPeriod(chats, events, range.previousStart, range.previousEnd);
    const value = {
      ...current, previous: previous.summary,
      range: { ...range, from: new Date(range.start).toISOString(), to: new Date(range.end).toISOString() },
      generatedAt: new Date().toISOString(),
      methodology: [
        'Horarios de Brasilia. TME em tempo corrido, da entrada na fila ate a tomada pelo agente; transferencias iniciam uma nova espera na fila de destino.',
        'Contatos unicos entre as novas conversas do periodo, por canal e identificador. Tomadas de atendimento podem incluir a mesma conversa mais de uma vez.',
        'Movimentacao reconstruida com eventos disponiveis e closedAt. Encerramento nao significa resolucao. Reaberturas sem evento e dados excluidos por retencao nao podem ser recuperados.',
        'Notas de 1 a 5 contadas na data em que o cliente respondeu o no de nota, para o atendente que atendeu a conversa. Conversas anteriores a esse registro usam as variaveis nota, rating ou avaliacao, associadas ao ultimo encerramento conhecido.',
        'Filas e agentes sao atribuidos pelos eventos da operacao; notas legadas usam a ultima fila e agente salvos. Detalhes mostram agregados, nunca o conteudo das conversas.',
        range.partial ? 'Comparacao com o mesmo intervalo decorrido do mes anterior, limitado ao fim daquele mes.' : 'Comparacao com o mes anterior completo.'
      ]
    };
    if (cache.size >= 30) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: Date.now() + TTL });
    return value;
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
