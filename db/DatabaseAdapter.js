import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import PostgresAdapter from './PostgresAdapter.js';

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const slowQueryEnabled = () => truthy(process.env.SLOW_QUERY_LOG_ENABLED);
const slowQueryMs = () => {
  const parsed = Number.parseInt(process.env.SLOW_QUERY_MS || '500', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
};
const extractTenantId = (query = {}) => {
  if (typeof query?.tenantId === 'string') return query.tenantId;
  if (query?.tenantId && typeof query.tenantId === 'object' && typeof query.tenantId.$eq === 'string') return query.tenantId.$eq;
  return null;
};
const logSlowQuery = ({ collection, operation, startedAt, query = {}, resultSize = null }) => {
  const durationMs = Date.now() - startedAt;
  if (!slowQueryEnabled() || durationMs < slowQueryMs()) return;
  console.warn('[DB_SLOW_QUERY]', {
    collection,
    operation,
    durationMs,
    tenantId: extractTenantId(query),
    resultSize
  });
};
const getByPath = (object, keyPath) => {
  if (!keyPath) return undefined;
  return String(keyPath).split('.').reduce((current, key) => current?.[key], object);
};

const setByPath = (object, keyPath, value) => {
  const keys = String(keyPath).split('.');
  let current = object;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    if (key === '$') return;
    if (!current[key] || typeof current[key] !== 'object') current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
};

const unsetByPath = (object, keyPath) => {
  const keys = String(keyPath).split('.');
  let current = object;
  for (let index = 0; index < keys.length - 1; index += 1) {
    current = current?.[keys[index]];
    if (!current || typeof current !== 'object') return;
  }
  delete current[keys[keys.length - 1]];
};

const compare = (left, right) => {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return left > right ? 1 : -1;
};

const escapeInValue = (value) => `"${String(value).replace(/"/g, '\\"')}"`;

const matchesValue = (actual, expected) => {
  // Expressao regular direta, como no MongoDB: { campo: /texto/i }. Sem isto o
  // valor caia na comparacao por igualdade e a busca nunca achava nada.
  if (expected instanceof RegExp) {
    const valores = Array.isArray(actual) ? actual : [actual];
    return valores.some((item) => {
      if (item === undefined || item === null) return false;
      expected.lastIndex = 0;
      return expected.test(String(item));
    });
  }
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$in' in expected) return (expected.$in || []).includes(actual);
    if ('$ne' in expected && actual === expected.$ne) return false;
    if ('$gt' in expected && !(actual > expected.$gt)) return false;
    if ('$gte' in expected && !(actual >= expected.$gte)) return false;
    if ('$lt' in expected && !(actual < expected.$lt)) return false;
    if ('$lte' in expected && !(actual <= expected.$lte)) return false;
    if ('$exists' in expected && (expected.$exists ? actual === undefined : actual !== undefined)) return false;
    if ('$regex' in expected) {
      const flags = expected.$options || '';
      return new RegExp(expected.$regex, flags).test(String(actual || ''));
    }
    if (['$ne', '$gt', '$gte', '$lt', '$lte', '$exists'].some((operator) => operator in expected)) return true;
  }
  if (Array.isArray(actual)) return actual.includes(expected);
  return actual === expected;
};

const matchesQuery = (doc, query = {}) => {
  if (!query || Object.keys(query).length === 0) return true;
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return (expected || []).some((item) => matchesQuery(doc, item));
    if (key === '$and') return (expected || []).every((item) => matchesQuery(doc, item));
    return matchesValue(getByPath(doc, key), expected);
  });
};

const evalExpression = (doc, expression) => {
  if (typeof expression === 'string') {
    return expression.startsWith('$') ? getByPath(doc, expression.slice(1)) : expression;
  }
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return expression;
  if ('$ifNull' in expression) {
    const [valueExpression, fallback] = expression.$ifNull || [];
    const value = evalExpression(doc, valueExpression);
    return value === undefined || value === null ? fallback : value;
  }
  if ('$size' in expression) {
    const value = evalExpression(doc, expression.$size);
    return Array.isArray(value) ? value.length : 0;
  }
  if ('$gt' in expression) {
    const [left, right] = expression.$gt || [];
    return evalExpression(doc, left) > evalExpression(doc, right);
  }
  if ('$cond' in expression) {
    const [condition, whenTrue, whenFalse] = expression.$cond || [];
    return evalExpression(doc, condition) ? evalExpression(doc, whenTrue) : evalExpression(doc, whenFalse);
  }
  return Object.fromEntries(Object.entries(expression).map(([key, value]) => [key, evalExpression(doc, value)]));
};

const applyProjection = (doc, projection) => {
  if (!projection) return clone(doc);
  const entries = Object.entries(projection);
  const includes = entries.some(([, value]) => value === 1 || typeof value === 'object');
  if (includes) {
    const projected = {};
    for (const [key, value] of entries) {
      if (key === '_id' && value === 0) continue;
      if (value === 1) {
        const fieldValue = getByPath(doc, key);
        if (fieldValue !== undefined) setByPath(projected, key, clone(fieldValue));
      } else if (value && typeof value === 'object' && '$slice' in value) {
        const fieldValue = getByPath(doc, key);
        if (Array.isArray(fieldValue)) setByPath(projected, key, clone(fieldValue.slice(value.$slice)));
      } else if (value && typeof value === 'object') {
        setByPath(projected, key, clone(evalExpression(doc, value)));
      }
    }
    return projected;
  }
  const projected = clone(doc);
  for (const [key, value] of entries) {
    if (value === 0) unsetByPath(projected, key);
  }
  return projected;
};

const applyUpdate = (doc, update = {}) => {
  const hasOperators = Object.keys(update).some((key) => key.startsWith('$'));
  if (!hasOperators) {
    Object.keys(doc).forEach((key) => delete doc[key]);
    Object.assign(doc, clone(update));
    return;
  }
  for (const [key, value] of Object.entries(update.$set || {})) {
    if (key.includes('.$')) {
      const [arrayKey] = key.split('.$');
      const array = getByPath(doc, arrayKey);
      if (Array.isArray(array)) {
        const replacement = value;
        const index = array.findIndex((item) => item !== replacement);
        if (index >= 0) array[index] = replacement;
      }
    } else {
      setByPath(doc, key, clone(value));
    }
  }
  for (const [key, value] of Object.entries(update.$unset || {})) unsetByPath(doc, key);
  for (const [key, value] of Object.entries(update.$inc || {})) {
    setByPath(doc, key, Number(getByPath(doc, key) || 0) + Number(value || 0));
  }
  for (const [key, value] of Object.entries(update.$push || {})) {
    const list = getByPath(doc, key);
    const next = Array.isArray(list) ? list : [];
    if (value && typeof value === 'object' && '$each' in value) next.push(...clone(value.$each));
    else next.push(clone(value));
    setByPath(doc, key, next);
  }
  for (const [key, value] of Object.entries(update.$pull || {})) {
    const list = getByPath(doc, key);
    if (Array.isArray(list)) setByPath(doc, key, list.filter((item) => item !== value));
  }
};

class JsonCursor {
  constructor(items) {
    this.items = items || [];
  }

  sort(sortSpec = {}) {
    const entries = Object.entries(sortSpec);
    this.items = [...this.items].sort((a, b) => {
      for (const [key, direction] of entries) {
        const result = compare(getByPath(a, key), getByPath(b, key));
        if (result !== 0) return result * (direction === -1 ? -1 : 1);
      }
      return 0;
    });
    return this;
  }

  skip(count = 0) {
    this.items = this.items.slice(count);
    return this;
  }

  limit(count = 0) {
    if (count > 0) this.items = this.items.slice(0, count);
    return this;
  }

  async toArray() {
    return clone(this.items);
  }
}

class JsonCollection {
  constructor(adapter, name) {
    this.adapter = adapter;
    this.name = name;
  }

  get docs() {
    if (!Array.isArray(this.adapter.data[this.name])) this.adapter.data[this.name] = [];
    return this.adapter.data[this.name];
  }

  async createIndex() {
    return null;
  }

  find(query = {}, options = {}) {
    const projection = options?.projection;
    const items = this.docs.filter((doc) => matchesQuery(doc, query)).map((doc) => applyProjection(doc, projection));
    return new JsonCursor(items);
  }

  async findOne(query = {}, options = {}) {
    const doc = this.docs.find((item) => matchesQuery(item, query));
    return doc ? applyProjection(doc, options?.projection) : null;
  }

  async countDocuments(query = {}) {
    return this.docs.filter((doc) => matchesQuery(doc, query)).length;
  }

  async insertOne(doc) {
    this.docs.push(clone(doc));
    await this.adapter.flush();
    return { acknowledged: true, insertedId: doc?.id || null };
  }

  async updateOne(filter, update, options = {}) {
    let doc = this.docs.find((item) => matchesQuery(item, filter));
    const matched = Boolean(doc);
    if (!doc && options.upsert) {
      doc = clone(filter || {});
      this.docs.push(doc);
    }
    if (!doc) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    applyUpdate(doc, update);
    await this.adapter.flush();
    return { acknowledged: true, matchedCount: matched ? 1 : 0, modifiedCount: 1, upsertedCount: matched ? 0 : 1 };
  }

  async updateMany(filter, update) {
    let modifiedCount = 0;
    for (const doc of this.docs) {
      if (matchesQuery(doc, filter)) {
        applyUpdate(doc, update);
        modifiedCount += 1;
      }
    }
    if (modifiedCount) await this.adapter.flush();
    return { acknowledged: true, matchedCount: modifiedCount, modifiedCount };
  }

  async deleteOne(filter) {
    const index = this.docs.findIndex((doc) => matchesQuery(doc, filter));
    if (index === -1) return { acknowledged: true, deletedCount: 0 };
    this.docs.splice(index, 1);
    await this.adapter.flush();
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter = {}) {
    const before = this.docs.length;
    this.adapter.data[this.name] = this.docs.filter((doc) => !matchesQuery(doc, filter));
    const deletedCount = before - this.adapter.data[this.name].length;
    if (deletedCount) await this.adapter.flush();
    return { acknowledged: true, deletedCount };
  }

  aggregate(pipeline = []) {
    let items = this.docs.map((item) => clone(item));
    for (const stage of pipeline) {
      if (stage.$match) items = items.filter((doc) => matchesQuery(doc, stage.$match));
      if (stage.$sort) items = new JsonCursor(items).sort(stage.$sort).items;
      if (stage.$skip) items = items.slice(stage.$skip);
      if (stage.$limit) items = items.slice(0, stage.$limit);
      if (stage.$project) {
        items = items.map((doc) => {
          const projected = {};
          for (const [key, value] of Object.entries(stage.$project)) {
            if (key === '_id' && value === 0) continue;
            if (value === 1) {
              const fieldValue = getByPath(doc, key);
              if (fieldValue !== undefined) setByPath(projected, key, clone(fieldValue));
            } else if (value !== 0) {
              setByPath(projected, key, clone(evalExpression(doc, value)));
            }
          }
          return projected;
        });
      }
    }
    return new JsonCursor(items);
  }

  async bulkWrite(operations = []) {
    for (const operation of operations) {
      if (operation.updateOne) {
        await this.updateOne(
          operation.updateOne.filter,
          operation.updateOne.update,
          { upsert: operation.updateOne.upsert }
        );
      }
    }
    return { acknowledged: true };
  }
}

class JsonDb {
  constructor(adapter) {
    this.adapter = adapter;
  }

  collection(name) {
    return new JsonCollection(this.adapter, name);
  }
}

class JsonAdapter {
  constructor() {
    this.db = null;
    this.data = {};
    this.filePath = null;
  }

  async init() {
    if (this.db) return;
    this.filePath = path.resolve(process.env.JSON_DB_PATH || './sandbox/data/db.json');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '{}\n', 'utf8');
    this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8') || '{}');
    this.db = new JsonDb(this);
    console.log(`[DB] JSON adapter ativo em ${this.filePath}`);
  }

  async flush() {
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
  }

  async collection(name) {
    if (!this.db) await this.init();
    return this.db.collection(name);
  }

  async findOne(name, query = {}, options = {}) {
    return this.db.collection(name).findOne(query, options);
  }

  async findMany(name, options = {}) {
    const collection = this.db.collection(name);
    const { query = {}, projection, sort, skip = 0, limit = 0 } = options;
    let cursor = collection.find(query, projection ? { projection } : undefined);
    if (sort) cursor = cursor.sort(sort);
    if (skip > 0) cursor = cursor.skip(skip);
    if (limit > 0) cursor = cursor.limit(limit);
    return cursor.toArray();
  }

  async countDocuments(name, query = {}) {
    return this.db.collection(name).countDocuments(query);
  }

  async insertOne(name, doc, options = {}) {
    return this.db.collection(name).insertOne(doc, options);
  }

  async updateOne(name, filter, update, options = {}) {
    return this.db.collection(name).updateOne(filter, update, options);
  }

  async deleteMany(name, filter, options = {}) {
    return this.db.collection(name).deleteMany(filter, options);
  }

  async getDocument(name, filter) {
    return this.findOne(name, filter || {});
  }

  async saveDocument(name, doc) {
    return this.updateOne(name, { id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findDocuments(name, filter, options = {}) {
    return this.findMany(name, { query: filter || {}, ...options });
  }

  async getCollection(name, tenantId = null) {
    const query = {};
    if (tenantId && tenantId !== 'super_admin' && tenantId !== null) query.tenantId = tenantId;
    return this.findMany(name, { query });
  }

  async saveCollection(name, data) {
    this.data[name] = clone(data || []);
    await this.flush();
    return true;
  }

  async getUsers(tenantId = null) {
    return this.getCollection('users', tenantId);
  }

  async saveUsers(users) {
    return this.saveCollection('users', users);
  }

  async getFlows(tenantId = null) {
    return this.getCollection('flows', tenantId);
  }

  async saveFlows(flows) {
    return this.saveCollection('flows', flows);
  }

  async getVariables(tenantId = null) {
    return this.getCollection('variables', tenantId);
  }

  async saveVariables(variables) {
    return this.saveCollection('variables', variables);
  }

  async getActiveChats(tenantId = null) {
    return this.getCollection('activeChats', tenantId);
  }

  async saveActiveChats(chats) {
    return this.saveCollection('activeChats', chats);
  }

  async close() {
    this.db = null;
  }
}

class MongoAdapter {
  constructor() {
    this.client = null;
    this.db = null;
  }

  async connect(uri, dbName) {
    try {
      this.client = new MongoClient(uri);
      await this.client.connect();
      this.db = this.client.db(dbName);
      console.log('Conectado ao MongoDB');
      return true;
    } catch (error) {
      console.error('Erro ao conectar ao MongoDB:', error.message);
      throw error;
    }
  }

  async init() {
    if (this.db) return;

    const uri = process.env.MONGODB_URI;
    const dbName = process.env.MONGODB_DB_NAME || 'onionflow';

    if (!uri) throw new Error('MONGODB_URI nao definido nas variaveis de ambiente');

    await this.connect(uri, dbName);

    const autoIndexRaw = process.env.DB_AUTO_INDEX;
    const autoIndex = autoIndexRaw === undefined ? true : truthy(autoIndexRaw);

    if (autoIndex) await this.ensureIndexes();
    else console.log('[DB_INDEX] Auto index desabilitado por configuracao');
  }

  async ensureIndexes() {
    if (!this.db) await this.init();

    const indexMap = {
      tenants: [{ key: { id: 1 }, name: 'id_1' }],
      users: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { username: 1 }, name: 'username_1' }],
      flows: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { tenantId: 1, id: 1 }, name: 'tenantId_id_1' }, { key: { tenantId: 1, updatedAt: -1 }, name: 'tenantId_updatedAt_-1' }],
      flowSnippets: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, updatedAt: -1 }, name: 'tenantId_updatedAt_-1' }
      ],
      flowTestSessions: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, flowId: 1, expiresAt: 1 }, name: 'tenantId_flowId_expiresAt_1' },
        { key: { expiresAt: 1 }, name: 'expiresAt_1' }
      ],
      variables: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }],
      activeChats: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1 }, name: 'tenantId_1' },
        { key: { tenantId: 1, status: 1 }, name: 'tenantId_status_1' },
        { key: { tenantId: 1, status: 1, updatedAt: -1 }, name: 'tenantId_status_updatedAt_-1' },
        { key: { tenantId: 1, updatedAt: -1 }, name: 'tenantId_updatedAt_-1' },
        { key: { customerCpf: 1 }, name: 'customerCpf_1' },
        { key: { tenantId: 1, customerCpf: 1, updatedAt: -1 }, name: 'tenantId_customerCpf_updatedAt_-1' },
        { key: { tenantId: 1, closedAt: -1 }, name: 'tenantId_closedAt_-1' },
        { key: { tenantId: 1, agentId: 1, status: 1, updatedAt: -1 }, name: 'tenantId_agentId_status_updatedAt_-1' },
        { key: { tenantId: 1, queue: 1, status: 1, updatedAt: -1 }, name: 'tenantId_queue_status_updatedAt_-1' },
        { key: { tenantId: 1, channel: 1, channelUserId: 1 }, name: 'tenantId_channel_channelUserId_1' },
        { key: { tenantId: 1, channel: 1, channelUserId: 1, status: 1 }, name: 'tenantId_channel_channelUserId_status_1' },
        { key: { tenantId: 1, whatsappPhoneNumberId: 1 }, name: 'tenantId_whatsappPhoneNumberId_1' },
        { key: { tenantId: 1, turizmoLeadId: 1, status: 1 }, name: 'tenantId_turizmoLeadId_status_1' }
      ],
      templates: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { tenantId: 1, channel: 1 }, name: 'tenantId_channel_1' }, { key: { tenantId: 1, updatedAt: -1, name: 1 }, name: 'tenantId_updatedAt_-1_name_1' }],
      messageTemplates: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { tenantId: 1, channel: 1 }, name: 'tenantId_channel_1' }, { key: { tenantId: 1, updatedAt: -1, name: 1 }, name: 'tenantId_updatedAt_-1_name_1' }],
      whatsappTemplates: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { tenantId: 1, id: 1 }, name: 'tenantId_id_1' }, { key: { tenantId: 1, status: 1 }, name: 'tenantId_status_1' }, { key: { tenantId: 1, updatedAt: -1, name: 1 }, name: 'tenantId_updatedAt_-1_name_1' }],
      schedules: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }],
      queues: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }],
      tags: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }],
      webhooks: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }],
      cannedResponses: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }],
      channelConfigs: [{ key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { 'whatsapp.phoneNumberId': 1 }, name: 'whatsapp_phoneNumberId_1' }, { key: { 'whatsapp.senderNumbers.phoneNumberId': 1 }, name: 'whatsapp_senderNumbers_phoneNumberId_1' }, { key: { tenantId: 1, 'entries.id': 1 }, name: 'tenantId_entries_id_1' }],
      systemLogs: [{ key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { tenantId: 1, timestamp: -1 }, name: 'tenantId_timestamp_-1' }, { key: { timestamp: -1 }, name: 'timestamp_-1' }],
      tenantModuleSettings: [{ key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { tenantId: 1, updatedAt: -1 }, name: 'tenantId_updatedAt_-1' }],
      tenantIncidents: [
        { key: { tenantId: 1, status: 1, lastSeenAt: -1 }, name: 'tenantId_status_lastSeenAt_-1' },
        { key: { tenantId: 1, fingerprint: 1, status: 1 }, name: 'tenantId_fingerprint_status_1' }
      ],
      tenantAuditEvents: [
        { key: { tenantId: 1, timestamp: -1 }, name: 'tenantId_timestamp_-1' },
        { key: { tenantId: 1, type: 1, timestamp: -1 }, name: 'tenantId_type_timestamp_-1' }
      ],
      automationLibraryItems: [
        { key: { tenantId: 1, updatedAt: -1 }, name: 'tenantId_updatedAt_-1' },
        { key: { tenantId: 1, type: 1, updatedAt: -1 }, name: 'tenantId_type_updatedAt_-1' },
        { key: { tenantId: 1, id: 1 }, name: 'tenantId_id_1' }
      ],
      chatEvents: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, chatId: 1, timestamp: 1 }, name: 'tenantId_chatId_timestamp_1' },
        { key: { tenantId: 1, type: 1, timestamp: 1 }, name: 'tenantId_type_timestamp_1' },
        { key: { tenantId: 1, timestamp: -1 }, name: 'tenantId_timestamp_-1' }
      ],
      chatMessages: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, chatId: 1, timestamp: 1 }, name: 'tenantId_chatId_timestamp_1' },
        { key: { tenantId: 1, chatId: 1, messageId: 1 }, name: 'tenantId_chatId_messageId_1' },
        { key: { tenantId: 1, providerMessageId: 1 }, name: 'tenantId_providerMessageId_1' }
      ],
      webVitals: [{ key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { timestamp: -1 }, name: 'timestamp_-1' }],
      outreachCampaigns: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, updatedAt: -1 }, name: 'tenantId_updatedAt_-1' },
        { key: { tenantId: 1, status: 1, createdAt: 1 }, name: 'tenantId_status_createdAt_1' },
        { key: { status: 1, createdAt: 1 }, name: 'status_createdAt_1' },
        { key: { tenantId: 1, turizmoCampaignId: 1 }, name: 'tenantId_turizmoCampaignId_unique', options: { unique: true, partialFilterExpression: { turizmoCampaignId: { $type: 'string' } } } }
      ],
      outreachCampaignItems: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, campaignId: 1, status: 1, sortIndex: 1 }, name: 'tenantId_campaignId_status_sortIndex_1' },
        { key: { tenantId: 1, campaignId: 1 }, name: 'tenantId_campaignId_1' },
        { key: { tenantId: 1, status: 1, createdAt: 1 }, name: 'tenantId_status_createdAt_1' },
        { key: { tenantId: 1, providerMessageId: 1 }, name: 'tenantId_providerMessageId_unique', options: { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } } }
      ],
      contactOutreachHistory: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, providerMessageId: 1 }, name: 'tenantId_providerMessageId_1' },
        { key: { tenantId: 1, contactId: 1, createdAt: -1 }, name: 'tenantId_contactId_createdAt_-1' },
        { key: { tenantId: 1, chatId: 1, createdAt: -1 }, name: 'tenantId_chatId_createdAt_-1' }
      ],
      messageClassifications: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, reviewStatus: 1, createdAt: -1 }, name: 'tenantId_reviewStatus_createdAt_-1' },
        { key: { tenantId: 1, messageId: 1, promptVersion: 1 }, name: 'tenantId_messageId_promptVersion_unique', options: { unique: true } }
      ],
      cadences: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, status: 1, updatedAt: -1 }, name: 'tenantId_status_updatedAt_-1' }
      ],
      cadenceExecutions: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, status: 1, nextExecutionAt: 1 }, name: 'tenantId_status_nextExecutionAt_1' },
        { key: { tenantId: 1, contactId: 1, status: 1 }, name: 'tenantId_contactId_status_1' }
      ],
      contactSuppression: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, channel: 1, normalizedIdentifier: 1 }, name: 'tenantId_channel_identifier_unique', options: { unique: true } }
      ],
      integrationOutbox: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { destination: 1, status: 1, nextAttemptAt: 1 }, name: 'destination_status_nextAttemptAt_1' },
        { key: { eventId: 1 }, name: 'eventId_unique', options: { unique: true } },
        { key: { tenantId: 1, destination: 1, idempotencyKey: 1 }, name: 'tenantId_destination_idempotencyKey_unique', options: { unique: true } }
      ],
      integrationInboundRequests: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, destination: 1, idempotencyKey: 1 }, name: 'tenantId_destination_idempotencyKey_unique', options: { unique: true } },
        { key: { tenantId: 1, destination: 1, operationKey: 1 }, name: 'tenantId_destination_operationKey_unique', options: { unique: true } },
        { key: { tenantId: 1, createdAt: -1 }, name: 'tenantId_createdAt_-1' }
      ],
      outreachMetricEvents: [
        { key: { dedupeKey: 1 }, name: 'dedupeKey_unique', options: { unique: true } },
        { key: { tenantId: 1, campaignId: 1, occurredAt: -1 }, name: 'tenantId_campaignId_occurredAt_-1' }
      ],
      aiPromptVersions: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, active: 1, updatedAt: -1 }, name: 'tenantId_active_updatedAt_-1' }
      ],
      commercialTasks: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, status: 1, dueAt: 1 }, name: 'tenantId_status_dueAt_1' },
        { key: { tenantId: 1, assignedTo: 1, status: 1 }, name: 'tenantId_assignedTo_status_1' },
        { key: { tenantId: 1, classificationId: 1 }, name: 'tenantId_classificationId_1' },
        { key: { tenantId: 1, commandId: 1 }, name: 'tenantId_commandId_1' }
      ],
      turizmoAutomationCommands: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, commandId: 1 }, name: 'tenantId_commandId_unique', options: { unique: true } },
        { key: { tenantId: 1, decisionId: 1, type: 1 }, name: 'tenantId_decisionId_type_1' },
        { key: { tenantId: 1, turizmoLeadId: 1, createdAt: -1 }, name: 'tenantId_turizmoLeadId_createdAt_-1' }
      ],
      turizmoAutomationStates: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, turizmoLeadId: 1 }, name: 'tenantId_turizmoLeadId_unique', options: { unique: true } }
      ],
      attendanceRoutingProfiles: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, trigger: 1, active: 1, updatedAt: -1 }, name: 'tenantId_trigger_active_updatedAt_-1' },
        { key: { tenantId: 1, id: 1 }, name: 'tenantId_id_1' }
      ],
      attendanceRoutingDecisions: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { routingKey: 1 }, name: 'routingKey_unique', options: { unique: true } },
        { key: { tenantId: 1, chatId: 1, createdAt: -1 }, name: 'tenantId_chatId_createdAt_-1' },
        { key: { tenantId: 1, status: 1, updatedAt: -1 }, name: 'tenantId_status_updatedAt_-1' }
      ],
      mediaAssets: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { tenantId: 1, type: 1 }, name: 'tenantId_type_1' }],
      catalogItems: [{ key: { id: 1 }, name: 'id_1' }, { key: { tenantId: 1 }, name: 'tenantId_1' }, { key: { tenantId: 1, active: 1 }, name: 'tenantId_active_1' }, { key: { tenantId: 1, metaSyncStatus: 1 }, name: 'tenantId_metaSyncStatus_1' }],
      catalogIntegrations: [{ key: { tenantId: 1, provider: 1 }, name: 'tenantId_provider_1' }],
      contacts: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { tenantId: 1, id: 1 }, name: 'tenantId_id_1' },
        { key: { tenantId: 1 }, name: 'tenantId_1' },
        { key: { tenantId: 1, name: 1 }, name: 'tenantId_name_1' },
        { key: { tenantId: 1, phone: 1 }, name: 'tenantId_phone_1' },
        { key: { tenantId: 1, 'phones.number': 1 }, name: 'tenantId_phones_number_1' },
        { key: { tenantId: 1, 'channelIdentities.channel': 1, 'channelIdentities.normalizedIdentifier': 1 }, name: 'tenantId_identities_channel_normalized_1' },
        { key: { tenantId: 1, tags: 1 }, name: 'tenantId_tags_1' },
        { key: { tenantId: 1, normalizedPrimaryPhone: 1 }, name: 'tenantId_normalizedPrimaryPhone_1' },
        { key: { tenantId: 1, turizmoLeadId: 1 }, name: 'tenantId_turizmoLeadId_unique', options: { unique: true, partialFilterExpression: { turizmoLeadId: { $type: 'string' } } } }
      ],
      tenantSettings: [{ key: { tenantId: 1 }, name: 'tenantId_1' }],
      telegramSessions: [{ key: { userId: 1 }, name: 'userId_1' }],
      adminIpAllowlist: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { ip: 1 }, name: 'ip_1' },
        { key: { expiresAt: 1 }, name: 'expiresAt_1' }
      ],
      adminAccessAudit: [
        { key: { timestamp: -1 }, name: 'timestamp_-1' },
        { key: { userId: 1, timestamp: -1 }, name: 'userId_timestamp_-1' },
        { key: { outcome: 1, timestamp: -1 }, name: 'outcome_timestamp_-1' }
      ],
      mfaSessions: [
        { key: { id: 1 }, name: 'id_1' },
        { key: { userId: 1, ip: 1 }, name: 'userId_ip_1' },
        { key: { expiresAt: 1 }, name: 'expiresAt_1' }
      ],
      loginAttempts: [
        { key: { username: 1 }, name: 'username_1' },
        { key: { lastFailedAt: 1 }, name: 'lastFailedAt_1' }
      ],
      userLoginIps: [
        { key: { userId: 1 }, name: 'userId_1' }
      ]
    };

    await Promise.all(Object.entries(indexMap).map(async ([collectionName, indexes]) => {
      const collection = this.db.collection(collectionName);
      for (const index of indexes) {
        try {
          await collection.createIndex(index.key, { name: index.name, ...(index.options || {}) });
        } catch (error) {
          console.warn(`[DB_INDEX] Falha ao criar indice ${collectionName}.${index.name}: ${error.message}`);
        }
      }
    }));
  }

  async collection(name) {
    if (!this.db) await this.init();
    return this.db.collection(name);
  }

  async findOne(name, query = {}, options = {}) {
    const startedAt = Date.now();
    const collection = await this.collection(name);
    const result = await collection.findOne(query, options);
    logSlowQuery({ collection: name, operation: 'findOne', startedAt, query, resultSize: result ? 1 : 0 });
    return result;
  }

  async findMany(name, options = {}) {
    const startedAt = Date.now();
    const collection = await this.collection(name);
    const { query = {}, projection, sort, skip = 0, limit = 0 } = options;
    let cursor = collection.find(query, projection ? { projection } : undefined);
    if (sort) cursor = cursor.sort(sort);
    if (skip > 0) cursor = cursor.skip(skip);
    if (limit > 0) cursor = cursor.limit(limit);
    const result = await cursor.toArray();
    logSlowQuery({ collection: name, operation: 'findMany', startedAt, query, resultSize: Array.isArray(result) ? result.length : null });
    return result;
  }

  async countDocuments(name, query = {}) {
    const startedAt = Date.now();
    const collection = await this.collection(name);
    const result = await collection.countDocuments(query);
    logSlowQuery({ collection: name, operation: 'countDocuments', startedAt, query, resultSize: result });
    return result;
  }

  async insertOne(name, doc, options = {}) {
    const startedAt = Date.now();
    const collection = await this.collection(name);
    const result = await collection.insertOne(doc, options);
    logSlowQuery({ collection: name, operation: 'insertOne', startedAt, query: doc, resultSize: 1 });
    return result;
  }

  async updateOne(name, filter, update, options = {}) {
    const startedAt = Date.now();
    const collection = await this.collection(name);
    const result = await collection.updateOne(filter, update, options);
    logSlowQuery({ collection: name, operation: 'updateOne', startedAt, query: filter, resultSize: result?.modifiedCount ?? null });
    return result;
  }

  async deleteMany(name, filter, options = {}) {
    const startedAt = Date.now();
    const collection = await this.collection(name);
    const result = await collection.deleteMany(filter, options);
    logSlowQuery({ collection: name, operation: 'deleteMany', startedAt, query: filter, resultSize: result?.deletedCount ?? null });
    return result;
  }

  async getDocument(name, filter) {
    return this.findOne(name, filter || {});
  }

  async saveDocument(name, doc) {
    return this.updateOne(name, { id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findDocuments(name, filter, options = {}) {
    return this.findMany(name, { query: filter || {}, ...options });
  }

  async getCollection(name, tenantId = null) {
    const query = {};
    if (tenantId && tenantId !== 'super_admin' && tenantId !== null) query.tenantId = tenantId;
    return this.findMany(name, { query });
  }

  async saveCollection(name, data) {
    if (!this.db) await this.init();
    const collection = this.db.collection(name);
    if (!data || data.length === 0) return true;
    const operations = data.map((doc) => ({
      updateOne: { filter: { id: doc.id }, update: { $set: doc }, upsert: true }
    }));
    await collection.bulkWrite(operations);
    return true;
  }

  async getUsers(tenantId = null) {
    return this.getCollection('users', tenantId);
  }

  async saveUsers(users) {
    return this.saveCollection('users', users);
  }

  async getFlows(tenantId = null) {
    return this.getCollection('flows', tenantId);
  }

  async saveFlows(flows) {
    return this.saveCollection('flows', flows);
  }

  async getVariables(tenantId = null) {
    return this.getCollection('variables', tenantId);
  }

  async saveVariables(variables) {
    return this.saveCollection('variables', variables);
  }

  async getActiveChats(tenantId = null) {
    return this.getCollection('activeChats', tenantId);
  }

  async saveActiveChats(chats) {
    return this.saveCollection('activeChats', chats);
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }
}

class SupabaseCursor {
  constructor(items) {
    this.items = items || [];
  }

  sort(sortSpec = {}) {
    const entries = Object.entries(sortSpec);
    this.items = [...this.items].sort((a, b) => {
      for (const [key, direction] of entries) {
        const result = compare(getByPath(a, key), getByPath(b, key));
        if (result !== 0) return result * (direction === -1 ? -1 : 1);
      }
      return 0;
    });
    return this;
  }

  skip(count = 0) {
    this.items = this.items.slice(count);
    return this;
  }

  limit(count = 0) {
    if (count > 0) this.items = this.items.slice(0, count);
    return this;
  }

  async toArray() {
    return clone(this.items);
  }
}

class SupabaseAsyncCursor {
  constructor(promise) {
    this.promise = promise;
  }

  sort(sortSpec = {}) {
    this.promise = this.promise.then((items) => new SupabaseCursor(items).sort(sortSpec).items);
    return this;
  }

  skip(count = 0) {
    this.promise = this.promise.then((items) => items.slice(count));
    return this;
  }

  limit(count = 0) {
    if (count > 0) {
      this.promise = this.promise.then((items) => items.slice(0, count));
    }
    return this;
  }

  async toArray() {
    return clone(await this.promise);
  }
}

class SupabaseCollection {
  constructor(adapter, name) {
    this.adapter = adapter;
    this.name = name;
  }

  async createIndex() {
    return null;
  }

  async _loadDocs(query = {}) {
    return this.adapter.loadDocuments(this.name, query);
  }

  find(query = {}, options = {}) {
    const projection = options?.projection;
    const pending = this._loadDocs(query).then((docs) => (
      docs
        .filter((doc) => matchesQuery(doc, query))
        .map((doc) => applyProjection(doc, projection))
    ));
    return new SupabaseAsyncCursor(pending);
  }

  async findOne(query = {}, options = {}) {
    const docs = await this._loadDocs(query);
    const doc = docs.find((item) => matchesQuery(item, query));
    return doc ? applyProjection(doc, options?.projection) : null;
  }

  async countDocuments(query = {}) {
    const docs = await this._loadDocs(query);
    return docs.filter((doc) => matchesQuery(doc, query)).length;
  }

  async insertOne(doc) {
    const nextDoc = clone(doc || {});
    if (!nextDoc.id) nextDoc.id = randomUUID();
    await this.adapter.upsertDocument(this.name, nextDoc);
    return { acknowledged: true, insertedId: nextDoc.id };
  }

  async updateOne(filter, update, options = {}) {
    const docs = await this._loadDocs(filter);
    let doc = docs.find((item) => matchesQuery(item, filter));
    const matched = Boolean(doc);
    if (!doc && options.upsert) {
      doc = clone(filter || {});
      if (!doc.id) doc.id = randomUUID();
    }
    if (!doc) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    applyUpdate(doc, update);
    if (!doc.id) doc.id = randomUUID();
    await this.adapter.upsertDocument(this.name, doc);
    return { acknowledged: true, matchedCount: matched ? 1 : 0, modifiedCount: 1, upsertedCount: matched ? 0 : 1 };
  }

  async updateMany(filter, update) {
    const docs = await this._loadDocs(filter);
    const matches = docs.filter((doc) => matchesQuery(doc, filter));
    for (const doc of matches) {
      applyUpdate(doc, update);
      if (!doc.id) doc.id = randomUUID();
      await this.adapter.upsertDocument(this.name, doc);
    }
    return { acknowledged: true, matchedCount: matches.length, modifiedCount: matches.length };
  }

  async deleteOne(filter) {
    const docs = await this._loadDocs(filter);
    const doc = docs.find((item) => matchesQuery(item, filter));
    if (!doc?.id) return { acknowledged: true, deletedCount: 0 };
    await this.adapter.deleteDocumentsByIds(this.name, [doc.id]);
    return { acknowledged: true, deletedCount: 1 };
  }

  async deleteMany(filter = {}) {
    const docs = await this._loadDocs(filter);
    const matches = docs.filter((doc) => matchesQuery(doc, filter));
    const ids = matches.map((doc) => doc.id).filter(Boolean);
    if (!ids.length) return { acknowledged: true, deletedCount: 0 };
    await this.adapter.deleteDocumentsByIds(this.name, ids);
    return { acknowledged: true, deletedCount: ids.length };
  }

  aggregate(pipeline = []) {
    const pending = this._loadDocs({}).then((loadedDocs) => {
      let items = loadedDocs.map((item) => clone(item));
      for (const stage of pipeline) {
        if (stage.$match) items = items.filter((doc) => matchesQuery(doc, stage.$match));
        if (stage.$sort) items = new SupabaseCursor(items).sort(stage.$sort).items;
        if (stage.$skip) items = items.slice(stage.$skip);
        if (stage.$limit) items = items.slice(0, stage.$limit);
        if (stage.$project) {
          items = items.map((doc) => {
            const projected = {};
            for (const [key, value] of Object.entries(stage.$project)) {
              if (key === '_id' && value === 0) continue;
              if (value === 1) {
                const fieldValue = getByPath(doc, key);
                if (fieldValue !== undefined) setByPath(projected, key, clone(fieldValue));
              } else if (value !== 0) {
                setByPath(projected, key, clone(evalExpression(doc, value)));
              }
            }
            return projected;
          });
        }
      }
      return items;
    });
    return {
      async toArray() {
        return pending;
      }
    };
  }

  async bulkWrite(operations = []) {
    for (const operation of operations) {
      if (operation.updateOne) {
        await this.updateOne(
          operation.updateOne.filter,
          operation.updateOne.update,
          { upsert: operation.updateOne.upsert }
        );
      }
    }
    return { acknowledged: true };
  }
}

class SupabaseDb {
  constructor(adapter) {
    this.adapter = adapter;
  }

  collection(name) {
    return new SupabaseCollection(this.adapter, name);
  }
}

class SupabaseAdapter {
  constructor() {
    this.db = null;
    this.baseUrl = null;
    this.apiKey = null;
    this.tableName = process.env.SUPABASE_DOCUMENTS_TABLE || 'app_documents';
  }

  async init() {
    if (this.db) return;

    this.baseUrl = String(
      process.env.SUPABASE_URL
      || process.env.VITE_SUPABASE_URL
      || ''
    ).replace(/\/+$/, '');
    this.apiKey = process.env.SUPABASE_SECRET_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_ANON_KEY
      || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
      || '';

    if (!this.baseUrl) throw new Error('SUPABASE_URL nao definido');
    if (!this.apiKey) throw new Error('SUPABASE_SECRET_KEY nao definido');

    this.db = new SupabaseDb(this);

    const probe = await this.request('GET', `/rest/v1/${this.tableName}`, {
      query: {
        select: 'id',
        limit: '1'
      }
    });

    if (!probe.ok) {
      const body = await this.safeParse(probe);
      const reason = body?.message || body?.error || probe.statusText || 'Falha ao acessar tabela';
      throw new Error(`Supabase nao esta pronto: ${reason}. Execute o SQL de bootstrap antes de subir o server.`);
    }

    if (process.env.SUPABASE_SERVICE_ROLE_KEY
      ? false
      : (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY)) {
      console.warn('[DB] Supabase usando chave publica/anon. Para backend, use SUPABASE_SERVICE_ROLE_KEY.');
    }

    console.log(`[DB] Supabase adapter ativo em ${this.tableName}`);
  }

  async safeParse(response) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  buildHeaders(extra = {}) {
    return {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      ...extra
    };
  }

  buildUrl(pathname, query = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  }

  async request(method, pathname, options = {}) {
    await this.init();
    const headers = this.buildHeaders(options.headers || {});
    const init = {
      method,
      headers
    };
    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      init.headers['Content-Type'] = 'application/json';
    }
    return fetch(this.buildUrl(pathname, options.query), init);
  }

  async loadRows(name, hint = {}) {
    const query = {
      select: 'id,tenant_id,doc,updated_at,created_at',
      collection: `eq.${name}`,
      limit: String(Number.parseInt(process.env.SUPABASE_COLLECTION_FETCH_LIMIT || '10000', 10) || 10000)
    };

    if (typeof hint?.id === 'string' && hint.id) {
      query.id = `eq.${hint.id}`;
    }
    if (typeof hint?.tenantId === 'string' && hint.tenantId) {
      query.tenant_id = `eq.${hint.tenantId}`;
    }

    const response = await this.request('GET', `/rest/v1/${this.tableName}`, { query });
    if (!response.ok) {
      const body = await this.safeParse(response);
      throw new Error(body?.message || body?.error || `Falha ao buscar ${name} no Supabase`);
    }
    const rows = await response.json();
    return Array.isArray(rows) ? rows : [];
  }

  async loadDocuments(name, query = {}) {
    const hint = {
      id: typeof query?.id === 'string' ? query.id : null,
      tenantId: typeof query?.tenantId === 'string' ? query.tenantId : null
    };
    const rows = await this.loadRows(name, hint);
    return rows.map((row) => clone(row.doc)).filter(Boolean);
  }

  async upsertDocument(name, doc) {
    const nextDoc = clone(doc || {});
    if (!nextDoc.id) nextDoc.id = randomUUID();
    const tenantId = nextDoc.tenantId ?? null;
    const now = new Date().toISOString();
    const payload = [{
      collection: name,
      id: nextDoc.id,
      tenant_id: tenantId,
      doc: nextDoc,
      updated_at: now
    }];
    const response = await this.request('POST', `/rest/v1/${this.tableName}`, {
      query: {
        on_conflict: 'collection,id'
      },
      headers: {
        Prefer: 'resolution=merge-duplicates'
      },
      body: payload
    });
    if (!response.ok) {
      const body = await this.safeParse(response);
      throw new Error(body?.message || body?.error || `Falha ao salvar ${name}`);
    }
    return nextDoc;
  }

  async deleteDocumentsByIds(name, ids = []) {
    const cleanIds = ids.filter(Boolean);
    if (!cleanIds.length) return { acknowledged: true, deletedCount: 0 };
    const response = await this.request('DELETE', `/rest/v1/${this.tableName}`, {
      query: {
        collection: `eq.${name}`,
        id: `in.(${cleanIds.map(escapeInValue).join(',')})`
      }
    });
    if (!response.ok) {
      const body = await this.safeParse(response);
      throw new Error(body?.message || body?.error || `Falha ao remover documentos de ${name}`);
    }
    return { acknowledged: true, deletedCount: cleanIds.length };
  }

  async collection(name) {
    if (!this.db) await this.init();
    return this.db.collection(name);
  }

  async findOne(name, query = {}, options = {}) {
    return this.db.collection(name).findOne(query, options);
  }

  async findMany(name, options = {}) {
    const collection = this.db.collection(name);
    const { query = {}, projection, sort, skip = 0, limit = 0 } = options;
    let cursor = collection.find(query, projection ? { projection } : undefined);
    if (sort) cursor = cursor.sort(sort);
    if (skip > 0) cursor = cursor.skip(skip);
    if (limit > 0) cursor = cursor.limit(limit);
    return cursor.toArray();
  }

  async countDocuments(name, query = {}) {
    return this.db.collection(name).countDocuments(query);
  }

  async insertOne(name, doc, options = {}) {
    return this.db.collection(name).insertOne(doc, options);
  }

  async updateOne(name, filter, update, options = {}) {
    return this.db.collection(name).updateOne(filter, update, options);
  }

  async deleteMany(name, filter, options = {}) {
    return this.db.collection(name).deleteMany(filter, options);
  }

  async getDocument(name, filter) {
    return this.findOne(name, filter || {});
  }

  async saveDocument(name, doc) {
    return this.updateOne(name, { id: doc.id }, { $set: doc }, { upsert: true });
  }

  async findDocuments(name, filter, options = {}) {
    return this.findMany(name, { query: filter || {}, ...options });
  }

  async getCollection(name, tenantId = null) {
    const query = {};
    if (tenantId && tenantId !== 'super_admin' && tenantId !== null) query.tenantId = tenantId;
    return this.findMany(name, { query });
  }

  async saveCollection(name, data) {
    const items = Array.isArray(data) ? data : [];
    for (const doc of items) {
      await this.upsertDocument(name, doc);
    }
    return true;
  }

  async getUsers(tenantId = null) {
    return this.getCollection('users', tenantId);
  }

  async saveUsers(users) {
    return this.saveCollection('users', users);
  }

  async getFlows(tenantId = null) {
    return this.getCollection('flows', tenantId);
  }

  async saveFlows(flows) {
    return this.saveCollection('flows', flows);
  }

  async getVariables(tenantId = null) {
    return this.getCollection('variables', tenantId);
  }

  async saveVariables(variables) {
    return this.saveCollection('variables', variables);
  }

  async getActiveChats(tenantId = null) {
    return this.getCollection('activeChats', tenantId);
  }

  async saveActiveChats(chats) {
    return this.saveCollection('activeChats', chats);
  }

  async close() {
    this.db = null;
  }
}

const selectedAdapter = String(process.env.DB_ADAPTER || '').trim().toLowerCase();

// O .env da maquina de desenvolvimento aponta para o Supabase de producao.
// Fora do servidor (NODE_ENV diferente de production), banco remoto so com
// pedido explicito: um script rodado no lugar errado nao grava em dado de
// cliente. O servidor define NODE_ENV=production na unit do systemd.
const REMOTE_ADAPTERS = ['postgres', 'postgresql', 'supabase-postgres', 'supabase'];
const usesJson = truthy(process.env.USE_JSON_DB) || selectedAdapter === 'json';
if (!usesJson && REMOTE_ADAPTERS.includes(selectedAdapter)
  && String(process.env.NODE_ENV || '').trim() !== 'production'
  && !truthy(process.env.ALLOW_PRODUCTION_DB)) {
  throw new Error(
    `[DB] DB_ADAPTER=${selectedAdapter} com NODE_ENV=${process.env.NODE_ENV || '(vazio)'}: `
    + 'banco remoto bloqueado fora do servidor. Use DB_ADAPTER=json (ou o sandbox) '
    + 'ou, se for de proposito, ALLOW_PRODUCTION_DB=true.'
  );
}

const adapter =truthy(process.env.USE_JSON_DB) || selectedAdapter === 'json'
  ? new JsonAdapter()
  : ['postgres', 'postgresql', 'supabase-postgres'].includes(selectedAdapter)
    ? new PostgresAdapter()
  : selectedAdapter === 'supabase'
    ? new SupabaseAdapter()
    : new MongoAdapter();

export default adapter;
