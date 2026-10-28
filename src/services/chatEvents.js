import adapter from '../../db/DatabaseAdapter.js';
import { generateId } from '../utils/helpers.js';
import { getIo } from './logs.js';

export const CHAT_EVENT_TYPES = Object.freeze({
  CHAT_OPENED: 'CHAT_OPENED',
  FLOW_STARTED: 'FLOW_STARTED',
  FLOW_NODE_ENTERED: 'FLOW_NODE_ENTERED',
  FLOW_TIMEOUT: 'FLOW_TIMEOUT',
  QUEUE_ENTERED: 'QUEUE_ENTERED',
  QUEUE_TRANSFERRED: 'QUEUE_TRANSFERRED',
  AGENT_ASSUMED: 'AGENT_ASSUMED',
  AGENT_RELEASED: 'AGENT_RELEASED',
  AGENT_CLOSED: 'AGENT_CLOSED',
  CLOSED_BY_INACTIVITY: 'CLOSED_BY_INACTIVITY',
  CUSTOMER_DISENGAGED: 'CUSTOMER_DISENGAGED',
  RESUME_TO_FLOW: 'RESUME_TO_FLOW',
  VOICE_CALL_RECEIVED: 'VOICE_CALL_RECEIVED',
  VOICE_CALL_ANSWERED: 'VOICE_CALL_ANSWERED',
  VOICE_CALL_ENDED: 'VOICE_CALL_ENDED',
  VOICE_CALL_MISSED: 'VOICE_CALL_MISSED',
  RATING_SUBMITTED: 'RATING_SUBMITTED',
  ERROR: 'ERROR'
});

const FLOW_NODE_WHITELIST = new Set([
  'inputNode',
  'menuNode',
  'ratingNode',
  'holderNode',
  'whatsappTemplateNode',
  'queueNode',
  'endNode',
  'finalNode'
]);

export const shouldEmitForNodeType = (nodeType) => FLOW_NODE_WHITELIST.has(String(nodeType || ''));

let hasInitializedIndex = false;

const ensureIndexes = async (collection) => {
  if (hasInitializedIndex) return;
  hasInitializedIndex = true;
  collection.createIndex({ tenantId: 1, chatId: 1, timestamp: 1 }, { name: 'tenantId_chatId_timestamp_1' }).catch(() => {});
  collection.createIndex({ tenantId: 1, type: 1, timestamp: 1 }, { name: 'tenantId_type_timestamp_1' }).catch(() => {});
  collection.createIndex({ tenantId: 1, timestamp: -1 }, { name: 'tenantId_timestamp_-1' }).catch(() => {});
  collection.createIndex({ id: 1 }, { unique: true, name: 'id_1' }).catch(() => {});
};

export const emitChatEvent = async ({
  tenantId,
  chatId,
  type,
  actor = null,
  context = null,
  timestamp = null,
  id = null
}) => {
  if (!type || !chatId || !tenantId) return null;

  const event = {
    id: id || generateId('evt'),
    tenantId: String(tenantId),
    chatId: String(chatId),
    type: String(type),
    timestamp: timestamp || new Date().toISOString(),
    actor: actor || null,
    context: context || null
  };

  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('chatEvents');
    await ensureIndexes(collection);
    await collection.insertOne(event);

    const io = getIo();
    if (io) {
      io.to(`tenant:${event.tenantId}`).emit('chat_event', event);
    }
    return event;
  } catch (error) {
    console.error('[CHAT_EVENT] Falha ao registrar evento', error?.message || error);
    return null;
  }
};

export const queryChatEvents = async ({ tenantId, chatId, types = null, from = null, to = null, limit = 500 }) => {
  if (!tenantId || !chatId) return [];
  const query = { tenantId: String(tenantId), chatId: String(chatId) };
  if (Array.isArray(types) && types.length) query.type = { $in: types };
  if (from || to) {
    query.timestamp = {};
    if (from) query.timestamp.$gte = new Date(from).toISOString();
    if (to) query.timestamp.$lte = new Date(to).toISOString();
  }
  return adapter.findMany('chatEvents', {
    query,
    sort: { timestamp: 1 },
    limit: Math.min(Math.max(limit, 1), 2000)
  });
};
