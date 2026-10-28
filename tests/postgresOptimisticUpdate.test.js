import test from 'node:test';
import assert from 'node:assert/strict';

// updateOne otimista (ler com a versao da linha e gravar so se nao mudou): 2 idas
// ao banco em vez de 4. Aqui um banco falso em memoria com versao por linha
// prova que gravacao concorrente nao se perde e que o caminho travado continua
// como reserva.

process.env.NODE_ENV = 'test';
const { PostgresCollection } = await import('../db/PostgresAdapter.js');

const bancoFalso = () => {
  const linhas = new Map(); // id -> { doc, version }
  let versao = 1;
  const stats = { leituras: 0, gravacoes: 0, conflitos: 0, travadas: 0 };
  const adapter = {
    stats,
    linhas,
    antesDeGravar: null,
    async loadDocumentsWithVersion(_name, filter) {
      stats.leituras += 1;
      const ids = filter?.id ? [filter.id] : [...linhas.keys()];
      return ids.filter((id) => linhas.has(id)).map((id) => ({ doc: structuredClone(linhas.get(id).doc), version: String(linhas.get(id).version) }));
    },
    async updateDocumentIfVersion(_name, doc, version) {
      if (this.antesDeGravar) { const f = this.antesDeGravar; this.antesDeGravar = null; await f(); }
      const atual = linhas.get(doc.id);
      if (!atual || String(atual.version) !== String(version)) { stats.conflitos += 1; return false; }
      stats.gravacoes += 1;
      linhas.set(doc.id, { doc: structuredClone(doc), version: ++versao });
      return true;
    },
    async insertDocumentIfAbsent(_name, doc) {
      if (linhas.has(doc.id)) return false;
      stats.gravacoes += 1;
      linhas.set(doc.id, { doc: structuredClone(doc), version: ++versao });
      return true;
    },
    // Caminho travado de reserva (o real faz BEGIN / SELECT FOR UPDATE / upsert / COMMIT).
    async withTransaction(fn) { stats.travadas += 1; return fn(null); },
    async loadDocuments(_name, filter) {
      const ids = filter?.id ? [filter.id] : [...linhas.keys()];
      return ids.filter((id) => linhas.has(id)).map((id) => structuredClone(linhas.get(id).doc));
    },
    async upsertDocument(_name, doc) { linhas.set(doc.id, { doc: structuredClone(doc), version: ++versao }); return doc; }
  };
  return adapter;
};

test('atualizacao sem disputa: 1 leitura e 1 gravacao, sem transacao', async () => {
  const banco = bancoFalso();
  banco.linhas.set('c1', { doc: { id: 'c1', n: 0 }, version: 1 });
  const col = new PostgresCollection(banco, 'activeChats');
  const r = await col.updateOne({ id: 'c1' }, { $set: { n: 1 } });
  assert.equal(r.matchedCount, 1);
  assert.equal(banco.linhas.get('c1').doc.n, 1);
  assert.deepEqual({ leituras: banco.stats.leituras, gravacoes: banco.stats.gravacoes, travadas: banco.stats.travadas }, { leituras: 1, gravacoes: 1, travadas: 0 });
});

test('gravacao de outro processo no meio: rele e aplica por cima, sem perder nenhuma', async () => {
  const banco = bancoFalso();
  banco.linhas.set('c1', { doc: { id: 'c1', a: 0, b: 0 }, version: 1 });
  const col = new PostgresCollection(banco, 'activeChats');
  // Entre a leitura e a gravacao de "a", outro processo grava "b".
  banco.antesDeGravar = async () => {
    const atual = banco.linhas.get('c1');
    banco.linhas.set('c1', { doc: { ...atual.doc, b: 7 }, version: atual.version + 1000 });
  };
  await col.updateOne({ id: 'c1' }, { $set: { a: 5 } });
  assert.deepEqual(banco.linhas.get('c1').doc, { id: 'c1', a: 5, b: 7 });
  assert.equal(banco.stats.conflitos, 1);
  assert.equal(banco.stats.travadas, 0);
});

test('muitos incrementos concorrentes no mesmo documento: nenhum se perde', async () => {
  const banco = bancoFalso();
  banco.linhas.set('c1', { doc: { id: 'c1', n: 0 }, version: 1 });
  // Atrasa as gravacoes para as 20 leituras acontecerem antes de qualquer gravacao.
  const original = banco.updateDocumentIfVersion.bind(banco);
  banco.updateDocumentIfVersion = async (...args) => { await new Promise((r) => setTimeout(r, Math.random() * 3)); return original(...args); };
  const col = new PostgresCollection(banco, 'activeChats');
  await Promise.all(Array.from({ length: 20 }, () => col.updateOne({ id: 'c1' }, { $inc: { n: 1 } })));
  assert.equal(banco.linhas.get('c1').doc.n, 20);
});

test('upsert de documento novo grava uma vez; se alguem criou junto, vira update', async () => {
  const banco = bancoFalso();
  const col = new PostgresCollection(banco, 'activeChats');
  const r = await col.updateOne({ id: 'novo' }, { $set: { id: 'novo', x: 1 } }, { upsert: true });
  assert.equal(r.upsertedCount, 1);
  const original = banco.insertDocumentIfAbsent.bind(banco);
  banco.insertDocumentIfAbsent = async (name, doc) => {
    banco.linhas.set(doc.id, { doc: { id: doc.id, y: 2 }, version: 999 });
    return original(name, doc);
  };
  await col.updateOne({ id: 'outro' }, { $set: { id: 'outro', x: 3 } }, { upsert: true });
  assert.deepEqual(banco.linhas.get('outro').doc, { id: 'outro', y: 2, x: 3 });
});

test('trocar o id do documento usa o caminho travado de antes', async () => {
  const banco = bancoFalso();
  banco.linhas.set('c1', { doc: { id: 'c1', n: 0 }, version: 1 });
  const col = new PostgresCollection(banco, 'activeChats');
  await col.updateOne({ id: 'c1' }, { $set: { id: 'c2' } });
  assert.equal(banco.stats.travadas, 1);
});
