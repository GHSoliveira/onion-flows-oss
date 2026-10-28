import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import PostgresAdapter, { matchesQuery } from '../db/PostgresAdapter.js';

// O filtro que vai para o SQL so pode ESTREITAR: toda linha que o filtro em
// memoria (matchesQuery) aceita precisa voltar do banco. Aqui roda num
// Postgres de verdade (PGlite) contra documentos com tipos misturados, que e
// onde a traducao costuma errar: numero salvo como texto, lista no lugar de
// valor, campo ausente, null, acento, caminho com ponto.

const docs = [
  { id: 'a1', tenantId: 't1', status: 'bot', n: 5, when: '2026-09-10T10:00:00.000Z', tags: ['vip', 'novo'], meta: { origin: 'voice_call', score: 3 } },
  { id: 'a2', tenantId: 't1', status: 'open', n: '7', when: '2026-09-12T10:00:00.000Z', tags: [], meta: { origin: 'whatsapp' } },
  { id: 'a3', tenantId: 't1', status: 'closed', n: 12, when: '2026-09-15T08:00:00.000Z', meta: null },
  { id: 'a4', tenantId: 't2', status: null, n: null, when: 'ontem', tags: ['vip'] },
  { id: 'a5', tenantId: 't2', n: 0, name: 'Joaquim Ávila', meta: { origin: 'whatsapp', score: '9' } },
  { id: 'a6', tenantId: 't2', status: 'bot', n: -1.5, when: '2026-09-15T08:00:00.000Z', name: 'ana', meta: { list: [{ origin: 'x' }] } },
  { id: 'a7', status: 'open', agentId: 'u1', n: 3 },
  { id: 'a8', tenantId: 't1', status: ['bot'], flag: true, n: 1e3 },
  { id: 'a9', tenantId: 't1', status: 'open', flag: false, name: '\u{1F600} emoji', when: '' }
];

const consultas = [
  {},
  { status: 'bot' },
  { status: null },
  { flag: true },
  { flag: false },
  { 'meta.origin': 'whatsapp' },
  { 'meta.score': 3 },
  { 'meta.list.origin': 'x' },
  { status: { $in: ['bot', 'open'] } },
  { status: { $in: [null] } },
  { status: { $in: [] } },
  { status: { $in: ['bot'], $ne: 'bot' } },
  { status: { $ne: 'closed' } },
  { status: { $ne: null } },
  { n: { $gt: 4 } },
  { n: { $gte: 5, $lt: 13 } },
  { n: { $lte: 0 } },
  { n: { $gt: '6' } },
  { when: { $gte: '2026-09-12' } },
  { when: { $lt: '2026-09-15T08:00:00.000Z' } },
  { when: { $gt: 'o' } },
  { name: { $gt: 'a' } },
  { name: { $lt: 'Z' } },
  { agentId: { $exists: true } },
  { agentId: { $exists: false } },
  { meta: { $exists: true } },
  { 'meta.origin': { $exists: true } },
  { name: /ana/i },
  { name: { $regex: '^jo', $options: 'i' } },
  { tags: 'vip' },
  { tags: { $elemMatch: { $in: ['novo'] } } },
  { $or: [{ status: 'bot' }, { agentId: 'u1' }] },
  { $or: [{ status: 'bot' }, { name: /ana/ }] },
  { $or: [] },
  { $and: [{ tenantId: 't1' }, { n: { $gt: 1 } }] },
  { tenantId: 't1', $or: [{ status: { $in: ['open', 'closed'] } }, { flag: true }] },
  { tenantId: { $in: ['t2'] }, status: { $ne: 'bot' } },
  { id: 'a3' },
  { id: { $in: ['a1', 'a9'] } },
  { meta: { origin: 'whatsapp' } },
  { status: { $eq: 'bot' } }
];

let db;
const adapter = Object.create(PostgresAdapter.prototype);
adapter.tableName = 'app_documents';

before(async () => {
  db = new PGlite();
  await db.exec(`create table app_documents (collection text not null, id text not null, tenant_id text, doc jsonb not null,
    updated_at timestamptz default now(), primary key (collection, id))`);
  for (const doc of docs) {
    await db.query('insert into app_documents (collection, id, tenant_id, doc) values ($1, $2, $3, $4::jsonb)',
      ['c', doc.id, doc.tenantId ?? null, JSON.stringify(doc)]);
  }
});

after(async () => { await db?.close(); });

// Mesmo matchesQuery que o adaptador aplica depois do SQL.
const filtroEmMemoria = (query) => docs.filter((doc) => matchesQuery(doc, query)).map((doc) => doc.id).sort();

const doSql = async (query) => {
  const { text, values } = adapter.buildCandidateQuery('c', query);
  const resultado = await db.query(text, values);
  return { ids: resultado.rows.map((row) => row.doc.id).sort(), text };
};

for (const query of consultas) {
  test(`SQL nunca perde linha: ${JSON.stringify(query, (k, v) => (v instanceof RegExp ? String(v) : v))}`, async () => {
    const esperado = filtroEmMemoria(query);
    const { ids, text } = await doSql(query);
    for (const id of esperado) assert.ok(ids.includes(id), `${id} sumiu no SQL\n${text}`);
  });
}

test('o SQL de fato estreita os filtros comuns', async () => {
  const casos = [
    [{ status: { $in: ['bot', 'open'] } }, ['a1', 'a2', 'a6', 'a7', 'a9']],
    // a2 tem n como texto e a4 como null: o JS converte os dois, entao o SQL
    // devolve e o filtro em memoria decide.
    [{ n: { $gt: 4 } }, ['a1', 'a2', 'a3', 'a4', 'a8']],
    [{ when: { $gte: '2026-09-12' } }, ['a2', 'a3', 'a4', 'a6', 'a9']],
    [{ status: { $ne: 'closed' } }, ['a1', 'a2', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']],
    [{ agentId: { $exists: true } }, ['a7']],
    [{ $or: [{ status: 'bot' }, { agentId: 'u1' }] }, ['a1', 'a6', 'a7', 'a8']],
    [{ 'meta.origin': 'whatsapp' }, ['a2', 'a5']],
    [{ status: { $in: [] } }, []]
  ];
  for (const [query, esperado] of casos) {
    assert.deepEqual((await doSql(query)).ids, esperado, JSON.stringify(query));
  }
});

test('regex e $or com ramo sem traducao ficam para o filtro em memoria', async () => {
  assert.equal((await doSql({ name: /ana/i })).ids.length, docs.length);
  assert.equal((await doSql({ $or: [{ status: 'bot' }, { name: /ana/ }] })).ids.length, docs.length);
});
