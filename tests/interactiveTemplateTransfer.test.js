import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Exportar e importar interactives entre tenants: selecao, conflito de nome,
// id novo no destino e correcao das referencias nos fluxos.

const dbPath = path.join(os.tmpdir(), `onion-interactive-transfer-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'interactive-transfer-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const transfer = await import('../src/services/interactiveTemplateTransfer.js');

const C = transfer.INTERACTIVE_COLLECTION;

const lista = (id, tenantId, name, extra = {}) => ({
  id, tenantId, channel: 'whatsapp', type: 'interactive', name, kind: 'list',
  headerText: '', bodyText: `Corpo de ${name}`, footerText: '', actionTitle: 'Ver opções',
  sections: [{ title: 'Opções', rows: [{ id: 'r1', title: 'Pizza', description: 'Grande', sku: '', unitPrice: 42 }] }],
  buttons: [], catalogId: '', productRetailerId: '', productSections: [],
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra
});

const botoes = (id, tenantId, name) => ({
  id, tenantId, channel: 'whatsapp', type: 'interactive', name, kind: 'button',
  bodyText: 'Confirma?', buttons: [{ id: 'sim', title: 'Sim' }, { id: 'nao', title: 'Não' }],
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
});

const produtos = (id, tenantId, name, catalogId) => ({
  id, tenantId, channel: 'whatsapp', type: 'interactive', name, kind: 'product_list',
  headerText: 'Cardápio', bodyText: 'Escolha', catalogId,
  productSections: [{ title: 'Lanches', productItems: [{ productRetailerId: 'x-burguer' }] }],
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z'
});

const fluxo = (id, tenantId, ref) => {
  const nodes = [{ id: 'n1', type: 'messageNode', data: { contentKind: 'interactive', interactiveTemplateId: ref } }];
  return { id, tenantId, name: `Fluxo ${id}`, nodes, draft: { nodes, edges: [] }, published: { nodes, edges: [], version: 1 } };
};

// O adapter JSON guarda tudo em memoria depois do init: limpar o arquivo nao zera.
const reset = async () => {
  for (const name of [C, 'catalogIntegrations', 'flows']) await adapter.deleteMany(name, {});
  await adapter.insertOne(C, lista('src_menu', 'tenant_origem', 'Menu principal'));
  await adapter.insertOne(C, botoes('src_confirma', 'tenant_origem', 'Confirmação'));
  await adapter.insertOne(C, produtos('src_cardapio', 'tenant_origem', 'Cardápio', 'cat_origem'));
  await adapter.insertOne(C, lista('dst_menu', 'tenant_destino', 'MENU  principal', { bodyText: 'Menu antigo do destino', footerText: 'rodapé antigo' }));
  await adapter.insertOne('catalogIntegrations', { id: 'cat_int_destino', tenantId: 'tenant_destino', provider: 'meta', catalogId: 'cat_destino' });
};

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
});
beforeEach(reset);
after(() => { try { fs.unlinkSync(dbPath); } catch {} });

const exportar = (ids = null) => transfer.buildInteractiveExport({ tenantId: 'tenant_origem', ids, tenantName: 'Origem' });
const doDestino = async () => (await adapter.findDocuments(C, { tenantId: 'tenant_destino' })).sort((a, b) => a.name.localeCompare(b.name));

test('exportar: so os escolhidos, sem tenantId nem datas do banco', async () => {
  const bundle = await exportar(['src_menu', 'src_confirma', 'id_de_outro_tenant']);
  assert.equal(bundle.format, 'onion-interactives');
  assert.equal(bundle.source.tenantId, 'tenant_origem');
  assert.deepEqual(bundle.items.map((item) => item.id).sort(), ['src_confirma', 'src_menu']);
  for (const item of bundle.items) {
    assert.equal(item.tenantId, undefined);
    assert.equal(item.createdAt, undefined);
  }
});

test('previa (dryRun) nao grava e aponta conflito de nome, erro e catalogo diferente', async () => {
  const bundle = await exportar();
  bundle.items.push({ id: 'quebrado', name: 'Sem corpo', kind: 'list', sections: [] });

  const r = await transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal((await doDestino()).length, 1, 'nada gravado');

  const porId = Object.fromEntries(r.items.map((item) => [item.sourceId, item]));
  assert.equal(porId.src_menu.conflictWith.id, 'dst_menu', 'nome igual ignorando maiuscula e espaco');
  assert.equal(porId.src_menu.targetName, 'Menu principal (importado)');
  assert.equal(porId.src_confirma.status, 'created');
  assert.equal(porId.src_confirma.conflictWith, null);
  assert.equal(porId.quebrado.status, 'invalid');
  assert.ok(porId.quebrado.errors.length > 0);
  assert.match(porId.src_cardapio.warnings[0], /cat_origem.*cat_destino/);
  assert.equal(r.targetCatalogId, 'cat_destino');
});

test('criar copia: id novo, nome com "(importado)" e origem registrada', async () => {
  const r = await transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle: await exportar(), onConflict: 'copy' });
  assert.deepEqual(r.summary, { created: 3, replaced: 0, skipped: 0, invalid: 0 });

  const destino = await doDestino();
  assert.equal(destino.length, 4);
  const antigo = destino.find((item) => item.id === 'dst_menu');
  assert.equal(antigo.bodyText, 'Menu antigo do destino', 'existente intacto');

  const copia = destino.find((item) => item.name === 'Menu principal (importado)');
  assert.ok(copia);
  assert.notEqual(copia.id, 'src_menu');
  assert.equal(copia.tenantId, 'tenant_destino');
  assert.deepEqual({ tenantId: copia.importedFrom.tenantId, id: copia.importedFrom.id }, { tenantId: 'tenant_origem', id: 'src_menu' });
  assert.equal(copia.sections[0].rows[0].unitPrice, 42);

  const origem = await adapter.findDocuments(C, { tenantId: 'tenant_origem' });
  assert.equal(origem.length, 3, 'origem nao muda');
});

test('substituir: mantem o id do destino e limpa campo que sobrou do conteudo antigo', async () => {
  const bundle = await exportar(['src_menu']);
  delete bundle.items[0].footerText; // arquivo sem o campo nao pode deixar o rodape antigo
  const r = await transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle, onConflict: 'replace' });
  assert.equal(r.summary.replaced, 1);

  const destino = await doDestino();
  assert.equal(destino.length, 1);
  assert.equal(destino[0].id, 'dst_menu');
  assert.equal(destino[0].bodyText, 'Corpo de Menu principal');
  assert.equal(destino[0].footerText, '', 'rodape antigo nao sobra');
});

test('pular: nao grava o conflito e so cria os novos', async () => {
  const r = await transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle: await exportar(['src_menu', 'src_confirma']), onConflict: 'skip' });
  assert.deepEqual(r.summary, { created: 1, replaced: 0, skipped: 1, invalid: 0 });
  const destino = await doDestino();
  assert.equal(destino.length, 2);
  assert.equal(destino.find((item) => item.id === 'dst_menu').bodyText, 'Menu antigo do destino');
});

test('selecao: importa so os ids marcados', async () => {
  const r = await transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle: await exportar(), selectedIds: ['src_confirma'] });
  assert.equal(r.items.length, 1);
  assert.equal((await doDestino()).length, 2);
});

test('fluxos: referencia ao id de origem vira o id novo; referencia valida e outro tenant ficam', async () => {
  await adapter.insertOne('flows', fluxo('f_quebrado', 'tenant_destino', 'src_confirma'));
  await adapter.insertOne('flows', fluxo('f_ok', 'tenant_destino', 'dst_menu'));
  await adapter.insertOne('flows', fluxo('f_origem', 'tenant_origem', 'src_confirma'));

  const r = await transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle: await exportar(['src_confirma']) });
  const novoId = r.items[0].targetId;
  assert.deepEqual(r.flows.map((flow) => flow.id), ['f_quebrado']);

  const [quebrado] = await adapter.findDocuments('flows', { id: 'f_quebrado' });
  assert.equal(quebrado.nodes[0].data.interactiveTemplateId, novoId);
  assert.equal(quebrado.draft.nodes[0].data.interactiveTemplateId, novoId);
  assert.equal(quebrado.published.nodes[0].data.interactiveTemplateId, novoId);
  assert.equal(quebrado.published.version, 1);

  const [ok] = await adapter.findDocuments('flows', { id: 'f_ok' });
  assert.equal(ok.nodes[0].data.interactiveTemplateId, 'dst_menu');
  const [origem] = await adapter.findDocuments('flows', { id: 'f_origem' });
  assert.equal(origem.nodes[0].data.interactiveTemplateId, 'src_confirma');
});

test('importar no proprio tenant: fluxo que usa o item original continua nele', async () => {
  await adapter.insertOne('flows', fluxo('f_proprio', 'tenant_origem', 'src_confirma'));
  const r = await transfer.importInteractiveTemplates({ tenantId: 'tenant_origem', bundle: await exportar(['src_confirma']), onConflict: 'copy' });
  assert.equal(r.items[0].targetName, 'Confirmação (importado)');
  assert.deepEqual(r.flows, []);
  const [flow] = await adapter.findDocuments('flows', { id: 'f_proprio' });
  assert.equal(flow.nodes[0].data.interactiveTemplateId, 'src_confirma');
});

test('pular com nome igual: fluxo passa a usar o item que ja existe', async () => {
  await adapter.insertOne('flows', fluxo('f_menu', 'tenant_destino', 'src_menu'));
  await transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle: await exportar(['src_menu']), onConflict: 'skip' });
  const [flow] = await adapter.findDocuments('flows', { id: 'f_menu' });
  assert.equal(flow.nodes[0].data.interactiveTemplateId, 'dst_menu');
});

test('arquivo invalido e recusado antes de tocar no banco', async () => {
  await assert.rejects(transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle: { items: [] } }), (erro) => erro.status === 400);
  const grande = await exportar();
  grande.items = Array.from({ length: transfer.MAX_IMPORT_ITEMS + 1 }, (_, i) => ({ ...grande.items[0], id: `x${i}` }));
  await assert.rejects(transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle: grande }), /no máximo/);
  await assert.rejects(transfer.importInteractiveTemplates({ tenantId: 'tenant_destino', bundle: await exportar(), onConflict: 'apagar' }), /inválido/);
  assert.equal((await doDestino()).length, 1);
});
