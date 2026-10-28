import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const { Pool } = pg;

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

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
    // $elemMatch: pelo menos um item do array precisa satisfazer o subquery.
    // Sem isso a condicao caia no `actual.includes(expected)` abaixo, que
    // compara o objeto do operador por identidade e nunca casa: a busca
    // devolvia vazio e o chamador criava um registro duplicado.
    if ('$elemMatch' in expected) {
      return Array.isArray(actual) && actual.some((item) => matchesQuery(item, expected.$elemMatch));
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
        const replacement = clone(value);
        const index = array.findIndex((item) => item !== replacement);
        if (index >= 0) array[index] = replacement;
      }
    } else {
      setByPath(doc, key, clone(value));
    }
  }
  for (const key of Object.keys(update.$unset || {})) unsetByPath(doc, key);
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

const extractEqualityFields = (query = {}) => {
  const result = {};
  for (const [key, value] of Object.entries(query || {})) {
    if (key.startsWith('$') || value === undefined) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$eq' in value) setByPath(result, key, clone(value.$eq));
      continue;
    }
    setByPath(result, key, clone(value));
  }
  return result;
};

const findHint = (query, key) => {
  if (!query || typeof query !== 'object') return null;
  const direct = query[key];
  if (typeof direct === 'string' || typeof direct === 'number') return direct;
  if (direct && typeof direct === 'object' && !Array.isArray(direct) && '$eq' in direct) return direct.$eq;
  for (const item of query.$and || []) {
    const nested = findHint(item, key);
    if (nested !== null && nested !== undefined) return nested;
  }
  return null;
};

// Filtro no SQL: so estreita. Cada clausula devolve um SUPERCONJUNTO do que o
// matchesQuery aceita, e o matchesQuery continua rodando depois em cada linha.
// Na duvida (regex, $elemMatch, objeto literal), nao gera clausula e a linha
// vem para o filtro em memoria, como antes. Errar para mais custa trafego;
// errar para menos some com dado, entao cada caso abaixo espelha o
// matchesValue, inclusive nas esquisitices dele.
const isPrimitive = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const isAscii = (value) => /^[\x00-\x7f]*$/.test(value);
const RANGE_SQL = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' };

const nestUnder = (keys, value) => keys.reduceRight((inner, key) => ({ [key]: inner }), value);

// Parametro enviado sem aparecer no texto derruba a consulta inteira no
// Postgres ("bind message supplies N parameters"), entao clausula descartada
// devolve os parametros que empilhou.
const fieldClause = (key, expected, values) => {
  const mark = values.length;
  const clause = buildFieldClause(key, expected, values);
  if (!clause || clause === 'false') values.length = mark;
  return clause;
};

const buildFieldClause = (key, expected, values) => {
  if (key.includes('$')) return null;
  const keys = key.split('.');
  const param = (value) => { values.push(value); return `$${values.length}`; };
  const pathParam = () => `${param(keys)}::text[]`;

  if (isPrimitive(expected)) {
    // Igual ao matchesValue: valor direto ou item de uma lista.
    if (keys.length === 1) {
      const objectParam = `${param(JSON.stringify({ [key]: expected }))}::jsonb`;
      const arrayParam = `${param(JSON.stringify([expected]))}::jsonb`;
      const keyParam = param(key);
      return `(doc @> ${objectParam} or (jsonb_typeof(doc -> ${keyParam}) = 'array' and (doc -> ${keyParam}) @> ${arrayParam}))`;
    }
    const objectParam = `${param(JSON.stringify(nestUnder(keys, expected)))}::jsonb`;
    const arrayParam = `${param(JSON.stringify(nestUnder(keys, [expected])))}::jsonb`;
    return `(doc @> ${objectParam} or doc @> ${arrayParam})`;
  }
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || expected instanceof RegExp) return null;

  const field = `(doc #> ${pathParam()})`;
  // No matchesValue o $in responde sozinho e ignora os outros operadores.
  if ('$in' in expected) {
    const list = expected.$in || [];
    if (!Array.isArray(list) || !list.every(isPrimitive)) return null;
    if (!list.length) return 'false';
    return `(${param(JSON.stringify(list))}::jsonb @> jsonb_build_array(${field}))`;
  }

  const parts = [];
  if ('$ne' in expected && isPrimitive(expected.$ne)) {
    parts.push(`not coalesce(${field} = ${param(JSON.stringify(expected.$ne))}::jsonb, false)`);
  }
  for (const [operator, sql] of Object.entries(RANGE_SQL)) {
    if (!(operator in expected)) continue;
    const bound = expected[operator];
    // Comparacao do JS entre tipos diferentes converte; aqui so estreita
    // quando o valor salvo e do mesmo tipo e deixa o resto para o JS. Campo
    // ausente e undefined no JS, que perde toda comparacao. CASE e
    // nao OR porque o Postgres nao garante a ordem do OR, e o cast de texto
    // para numeric quebraria a consulta.
    if (typeof bound === 'number' && Number.isFinite(bound)) {
      parts.push(`(case when jsonb_typeof(${field}) = 'number' then (${field})::numeric ${sql} ${param(bound)}::numeric when ${field} is null then false else true end)`);
    } else if (typeof bound === 'string' && isAscii(bound)) {
      // collate "C" compara byte a byte, que para um lado ASCII da a mesma
      // ordem do < do JavaScript.
      parts.push(`(case when jsonb_typeof(${field}) = 'string' then (doc #>> ${pathParam()}) collate "C" ${sql} ${param(bound)} when ${field} is null then false else true end)`);
    }
  }
  if ('$exists' in expected) parts.push(expected.$exists ? `${field} is not null` : `${field} is null`);
  return parts.length ? `(${parts.join(' and ')})` : null;
};

const queryClause = (query, values, skip = new Set()) => {
  if (!query || typeof query !== 'object') return null;
  const parts = [];
  for (const [key, expected] of Object.entries(query)) {
    if (expected === undefined || skip.has(key)) continue;
    if (key === '$and') {
      for (const item of expected || []) {
        const clause = queryClause(item, values);
        if (clause) parts.push(clause);
      }
    } else if (key === '$or') {
      const list = expected || [];
      if (!list.length) continue;
      // Um ramo sem clausula aceita qualquer linha: o $or inteiro nao estreita.
      const mark = values.length;
      const branches = list.map((item) => queryClause(item, values));
      if (branches.every(Boolean)) parts.push(`(${branches.join(' or ')})`);
      else values.length = mark;
    } else {
      const clause = fieldClause(key, expected, values);
      if (clause) parts.push(clause);
    }
  }
  return parts.length ? parts.join(' and ') : null;
};

const slowQueryEnabled = () => truthy(process.env.SLOW_QUERY_LOG_ENABLED);
const OPTIMISTIC_UPDATE_ATTEMPTS = 5;
const slowQueryMs = () => Math.max(1, Number.parseInt(process.env.SLOW_QUERY_MS || '500', 10) || 500);

class PostgresCursor {
  constructor(itemsPromise) {
    this.itemsPromise = Promise.resolve(itemsPromise || []);
  }

  sort(sortSpec = {}) {
    this.itemsPromise = this.itemsPromise.then((items) => {
      const entries = Object.entries(sortSpec);
      return [...items].sort((a, b) => {
        for (const [key, direction] of entries) {
          const result = compare(getByPath(a, key), getByPath(b, key));
          if (result !== 0) return result * (direction === -1 ? -1 : 1);
        }
        return 0;
      });
    });
    return this;
  }

  skip(count = 0) {
    this.itemsPromise = this.itemsPromise.then((items) => items.slice(count));
    return this;
  }

  limit(count = 0) {
    if (count > 0) this.itemsPromise = this.itemsPromise.then((items) => items.slice(0, count));
    return this;
  }

  async toArray() {
    return clone(await this.itemsPromise);
  }
}

class PostgresCollection {
  constructor(adapter, name) {
    this.adapter = adapter;
    this.name = name;
  }

  async createIndex() {
    return null;
  }

  find(query = {}, options = {}) {
    const pending = this.adapter.loadDocuments(this.name, query).then((docs) => (
      docs.filter((doc) => matchesQuery(doc, query)).map((doc) => applyProjection(doc, options?.projection))
    ));
    return new PostgresCursor(pending);
  }

  async findOne(query = {}, options = {}) {
    const docs = await this.adapter.loadDocuments(this.name, query);
    const doc = docs.find((item) => matchesQuery(item, query));
    return doc ? applyProjection(doc, options?.projection) : null;
  }

  async countDocuments(query = {}) {
    const docs = await this.adapter.loadDocuments(this.name, query);
    return docs.filter((doc) => matchesQuery(doc, query)).length;
  }

  async insertOne(doc) {
    const nextDoc = clone(doc || {});
    if (!nextDoc.id) nextDoc.id = randomUUID();
    await this.adapter.insertDocument(this.name, nextDoc);
    return { acknowledged: true, insertedId: nextDoc.id };
  }

  // Atualizacao otimista: le o documento com a versao da linha (xmin) e grava so
  // se ninguem gravou no meio. Sao 2 idas ao banco em vez das 4 da transacao
  // (BEGIN, SELECT FOR UPDATE, upsert, COMMIT); com ~6 ms por ida ate a Supabase,
  // isso pesava em toda mensagem. Conflito relê e tenta de novo; esgotou, cai na
  // transacao travada de antes, que tem a mesma garantia.
  async updateOne(filter, update, options = {}) {
    for (let attempt = 0; attempt < OPTIMISTIC_UPDATE_ATTEMPTS; attempt += 1) {
      const rows = await this.adapter.loadDocumentsWithVersion(this.name, filter);
      const row = rows.find((item) => matchesQuery(item.doc, filter));
      if (!row) {
        if (!options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
        const doc = extractEqualityFields(filter);
        applyUpdate(doc, update);
        if (!doc.id) doc.id = randomUUID();
        if (await this.adapter.insertDocumentIfAbsent(this.name, doc)) {
          return { acknowledged: true, matchedCount: 0, modifiedCount: 1, upsertedCount: 1 };
        }
        continue; // outro processo criou ao mesmo tempo: na volta vira update
      }
      const doc = row.doc;
      const originalId = doc.id;
      applyUpdate(doc, update);
      if (!doc.id) doc.id = randomUUID();
      // Trocar o id muda a chave da linha: so a transacao trata isso como antes.
      if (originalId === undefined || String(doc.id) !== String(originalId)) break;
      if (await this.adapter.updateDocumentIfVersion(this.name, doc, row.version)) {
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
    }
    return this.updateOneLocked(filter, update, options);
  }

  async updateOneLocked(filter, update, options = {}) {
    return this.adapter.withTransaction(async (client) => {
      const docs = await this.adapter.loadDocuments(this.name, filter, { client, forUpdate: true });
      let doc = docs.find((item) => matchesQuery(item, filter));
      const matched = Boolean(doc);
      if (!doc && options.upsert) doc = extractEqualityFields(filter);
      if (!doc) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      applyUpdate(doc, update);
      if (!doc.id) doc.id = randomUUID();
      await this.adapter.upsertDocument(this.name, doc, client);
      return { acknowledged: true, matchedCount: matched ? 1 : 0, modifiedCount: 1, upsertedCount: matched ? 0 : 1 };
    });
  }

  async updateMany(filter, update) {
    return this.adapter.withTransaction(async (client) => {
      const docs = await this.adapter.loadDocuments(this.name, filter, { client, forUpdate: true });
      const matching = docs.filter((doc) => matchesQuery(doc, filter));
      for (const doc of matching) {
        applyUpdate(doc, update);
        if (!doc.id) doc.id = randomUUID();
        await this.adapter.upsertDocument(this.name, doc, client);
      }
      return { acknowledged: true, matchedCount: matching.length, modifiedCount: matching.length };
    });
  }

  async deleteOne(filter) {
    return this.adapter.withTransaction(async (client) => {
      const docs = await this.adapter.loadDocuments(this.name, filter, { client, forUpdate: true });
      const doc = docs.find((item) => matchesQuery(item, filter));
      if (!doc?.id) return { acknowledged: true, deletedCount: 0 };
      await this.adapter.deleteDocumentsByIds(this.name, [doc.id], client);
      return { acknowledged: true, deletedCount: 1 };
    });
  }

  async deleteMany(filter = {}) {
    return this.adapter.withTransaction(async (client) => {
      const docs = await this.adapter.loadDocuments(this.name, filter, { client, forUpdate: true });
      const ids = docs.filter((doc) => matchesQuery(doc, filter)).map((doc) => doc.id).filter(Boolean);
      if (!ids.length) return { acknowledged: true, deletedCount: 0 };
      await this.adapter.deleteDocumentsByIds(this.name, ids, client);
      return { acknowledged: true, deletedCount: ids.length };
    });
  }

  aggregate(pipeline = []) {
    // O primeiro $match estreita no SQL; os estagios continuam rodando em memoria.
    const firstMatch = pipeline[0]?.$match || {};
    const pending = this.adapter.loadDocuments(this.name, firstMatch).then((loadedDocs) => {
      let items = loadedDocs.map((item) => clone(item));
      for (const stage of pipeline) {
        if (stage.$match) items = items.filter((doc) => matchesQuery(doc, stage.$match));
        if (stage.$sort) {
          const entries = Object.entries(stage.$sort);
          items = [...items].sort((a, b) => {
            for (const [key, direction] of entries) {
              const result = compare(getByPath(a, key), getByPath(b, key));
              if (result !== 0) return result * (direction === -1 ? -1 : 1);
            }
            return 0;
          });
        }
        if (stage.$skip) items = items.slice(stage.$skip);
        if (stage.$limit) items = items.slice(0, stage.$limit);
        if (stage.$project) items = items.map((doc) => applyProjection(doc, stage.$project));
      }
      return items;
    });
    return { async toArray() { return clone(await pending); } };
  }

  async bulkWrite(operations = []) {
    for (const operation of operations) {
      if (operation.updateOne) {
        await this.updateOne(operation.updateOne.filter, operation.updateOne.update, {
          upsert: operation.updateOne.upsert
        });
      }
    }
    return { acknowledged: true };
  }
}

class PostgresDb {
  constructor(adapter) {
    this.adapter = adapter;
  }

  collection(name) {
    return new PostgresCollection(this.adapter, name);
  }
}

class PostgresAdapter {
  constructor() {
    this.pool = null;
    this.db = null;
    this.tableName = process.env.POSTGRES_DOCUMENTS_TABLE || 'app_documents';
  }

  async init() {
    if (this.pool) return;
    if (!/^[a-z_][a-z0-9_]*$/i.test(this.tableName)) throw new Error('POSTGRES_DOCUMENTS_TABLE invalido');

    const max = Math.max(1, Math.min(20, Number.parseInt(process.env.PGPOOL_MAX || '5', 10) || 5));
    const sslMode = String(process.env.PGSSLMODE || 'require').trim().toLowerCase();
    const rejectUnauthorized = !['0', 'false', 'no', 'off'].includes(
      String(process.env.PGSSL_REJECT_UNAUTHORIZED ?? 'true').trim().toLowerCase()
    );
    const caPath = String(process.env.PGSSL_CA_PATH || '').trim();
    const ssl = sslMode === 'disable' ? null : {
      rejectUnauthorized,
      ...(caPath ? { ca: fs.readFileSync(caPath, 'utf8') } : {})
    };
    const config = {
      max,
      idleTimeoutMillis: Math.max(1000, Number.parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10) || 30000),
      connectionTimeoutMillis: Math.max(1000, Number.parseInt(process.env.PG_CONNECT_TIMEOUT_MS || '10000', 10) || 10000),
      application_name: process.env.PGAPPNAME || 'onion-web-flows',
      ...(ssl ? { ssl } : {})
    };

    if (process.env.DATABASE_URL) config.connectionString = process.env.DATABASE_URL;
    else {
      Object.assign(config, {
        host: process.env.PGHOST,
        port: Number.parseInt(process.env.PGPORT || '5432', 10),
        database: process.env.PGDATABASE || 'postgres',
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD
      });
    }

    if (!config.connectionString && (!config.host || !config.user || !config.password)) {
      throw new Error('Credenciais PostgreSQL incompletas');
    }

    this.pool = new Pool(config);
    this.pool.on('error', (error) => console.error('[DB_POSTGRES_POOL]', { message: error.message }));

    try {
      const probe = await this.pool.query(`select to_regclass('public.${this.tableName}') as table_name`);
      if (!probe.rows[0]?.table_name) {
        throw new Error(`Tabela ${this.tableName} nao encontrada. Execute scripts/supabase-bootstrap.sql.`);
      }
      this.db = new PostgresDb(this);
      console.log(`[DB] PostgreSQL adapter ativo em ${this.tableName} (pool max=${max})`);
    } catch (error) {
      await this.pool.end().catch(() => {});
      this.pool = null;
      throw error;
    }
  }

  async withTransaction(callback) {
    if (!this.pool) await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  buildCandidateQuery(name, query = {}, options = {}) {
    const values = [name];
    const clauses = ['collection = $1'];
    const id = findHint(query, 'id');
    const tenantId = findHint(query, 'tenantId');
    if (id !== null && id !== undefined) {
      values.push(String(id));
      clauses.push(`id = $${values.length}`);
    }
    if (tenantId !== null && tenantId !== undefined) {
      values.push(String(tenantId));
      clauses.push(`tenant_id = $${values.length}`);
    }

    const skip = new Set();
    if (id !== null && id !== undefined) skip.add('id');
    if (tenantId !== null && tenantId !== undefined) skip.add('tenantId');
    const narrowing = queryClause(query, values, skip);
    if (narrowing) clauses.push(narrowing);

    const limit = Math.max(0, Number.parseInt(options.limit || '0', 10) || 0);
    return {
      text: `select doc from ${this.tableName} where ${clauses.join(' and ')}${limit ? ` limit ${limit}` : ''}${options.forUpdate ? ' for update' : ''}`,
      values
    };
  }

  async loadDocuments(name, query = {}, options = {}) {
    if (!this.pool) await this.init();
    const startedAt = Date.now();
    const executor = options.client || this.pool;
    const statement = this.buildCandidateQuery(name, query, options);
    const result = await executor.query(statement);
    const documents = result.rows.map((row) => clone(row.doc)).filter(Boolean);
    const durationMs = Date.now() - startedAt;
    if (slowQueryEnabled() && durationMs >= slowQueryMs()) {
      console.warn('[DB_SLOW_QUERY]', {
        collection: name,
        operation: 'loadDocuments',
        durationMs,
        tenantId: findHint(query, 'tenantId'),
        resultSize: documents.length
      });
    }
    return documents;
  }

  async insertDocument(name, doc, client = null) {
    if (!this.pool) await this.init();
    const executor = client || this.pool;
    await executor.query(
      `insert into ${this.tableName} (collection, id, tenant_id, doc) values ($1, $2, $3, $4::jsonb)`,
      [name, String(doc.id), doc.tenantId == null ? null : String(doc.tenantId), JSON.stringify(doc)]
    );
    return doc;
  }

  async loadDocumentsWithVersion(name, query = {}) {
    if (!this.pool) await this.init();
    const statement = this.buildCandidateQuery(name, query);
    statement.text = statement.text.replace(/^select doc from /, 'select doc, xmin::text as version from ');
    const result = await this.pool.query(statement);
    return result.rows
      .filter((row) => row.doc)
      .map((row) => ({ doc: clone(row.doc), version: row.version }));
  }

  // Grava so se a linha ainda estiver na versao lida (ninguem gravou no meio).
  async updateDocumentIfVersion(name, doc, version) {
    if (!this.pool) await this.init();
    const result = await this.pool.query(
      `update ${this.tableName}
       set tenant_id = $3, doc = $4::jsonb, updated_at = now()
       where collection = $1 and id = $2 and xmin = $5::xid`,
      [name, String(doc.id), doc.tenantId == null ? null : String(doc.tenantId), JSON.stringify(doc), String(version)]
    );
    return result.rowCount === 1;
  }

  async insertDocumentIfAbsent(name, doc) {
    if (!this.pool) await this.init();
    const result = await this.pool.query(
      `insert into ${this.tableName} (collection, id, tenant_id, doc)
       values ($1, $2, $3, $4::jsonb)
       on conflict (collection, id) do nothing`,
      [name, String(doc.id), doc.tenantId == null ? null : String(doc.tenantId), JSON.stringify(doc)]
    );
    return result.rowCount === 1;
  }

  async upsertDocument(name, doc, client = null) {
    if (!this.pool) await this.init();
    const executor = client || this.pool;
    await executor.query(
      `insert into ${this.tableName} (collection, id, tenant_id, doc)
       values ($1, $2, $3, $4::jsonb)
       on conflict (collection, id) do update
       set tenant_id = excluded.tenant_id, doc = excluded.doc, updated_at = now()`,
      [name, String(doc.id), doc.tenantId == null ? null : String(doc.tenantId), JSON.stringify(doc)]
    );
    return doc;
  }

  async deleteDocumentsByIds(name, ids = [], client = null) {
    if (!ids.length) return { acknowledged: true, deletedCount: 0 };
    if (!this.pool) await this.init();
    const executor = client || this.pool;
    const result = await executor.query(
      `delete from ${this.tableName} where collection = $1 and id = any($2::text[])`,
      [name, ids.map(String)]
    );
    return { acknowledged: true, deletedCount: result.rowCount };
  }

  async collection(name) {
    if (!this.db) await this.init();
    return this.db.collection(name);
  }

  async findOne(name, query = {}, options = {}) {
    return (await this.collection(name)).findOne(query, options);
  }

  async findMany(name, options = {}) {
    const collection = await this.collection(name);
    const { query = {}, projection, sort, skip = 0, limit = 0 } = options;
    let cursor = collection.find(query, projection ? { projection } : undefined);
    if (sort) cursor = cursor.sort(sort);
    if (skip > 0) cursor = cursor.skip(skip);
    if (limit > 0) cursor = cursor.limit(limit);
    return cursor.toArray();
  }

  async countDocuments(name, query = {}) {
    return (await this.collection(name)).countDocuments(query);
  }

  async insertOne(name, doc, options = {}) {
    return (await this.collection(name)).insertOne(doc, options);
  }

  async updateOne(name, filter, update, options = {}) {
    return (await this.collection(name)).updateOne(filter, update, options);
  }

  async deleteMany(name, filter, options = {}) {
    return (await this.collection(name)).deleteMany(filter, options);
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
    if (tenantId && tenantId !== 'super_admin') query.tenantId = tenantId;
    return this.findMany(name, { query });
  }

  async saveCollection(name, data) {
    const items = Array.isArray(data) ? data : [];
    if (!items.length) return true;
    await this.withTransaction(async (client) => {
      for (const original of items) {
        const doc = clone(original || {});
        if (!doc.id) doc.id = randomUUID();
        await this.upsertDocument(name, doc, client);
      }
    });
    return true;
  }

  async getUsers(tenantId = null) { return this.getCollection('users', tenantId); }
  async saveUsers(users) { return this.saveCollection('users', users); }
  async getFlows(tenantId = null) { return this.getCollection('flows', tenantId); }
  async saveFlows(flows) { return this.saveCollection('flows', flows); }
  async getVariables(tenantId = null) { return this.getCollection('variables', tenantId); }
  async saveVariables(variables) { return this.saveCollection('variables', variables); }
  async getActiveChats(tenantId = null) { return this.getCollection('activeChats', tenantId); }
  async saveActiveChats(chats) { return this.saveCollection('activeChats', chats); }

  async close() {
    if (this.pool) await this.pool.end();
    this.pool = null;
    this.db = null;
  }
}

export { matchesQuery, PostgresCollection };
export default PostgresAdapter;
