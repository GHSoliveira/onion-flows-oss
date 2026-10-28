import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Contadores da campanha: cada evento atualizava um campo so, entao uma
// resposta "pediu_demo" subia demoRequestedCount e deixava positiveCount e
// qualifiedCount em zero — numeros que vao no evento de encerramento pro Turizmo.

const dbPath = path.join(os.tmpdir(), `outreach-counters-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'outreach-counters-test-only';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { aggregateCampaignItems, calculateCampaignMetrics, recordCampaignMetricOnce, syncCampaignCounters } = await import('../src/services/outreachMetrics.js');

const T = 'tenant_contadores';
const CAMP = 'campaign_contadores';

const item = (id, extra = {}) => ({
  id, tenantId: T, campaignId: CAMP, contactId: `contact_${id}`, templateId: 'tpl_1',
  status: 'sent', sentAt: '2026-09-17T12:00:00.000Z', createdAt: '2026-09-17T12:00:00.000Z', ...extra
});

before(async () => { await adapter.init(); });

beforeEach(async () => {
  for (const collection of ['outreachCampaigns', 'outreachCampaignItems', 'outreachMetricEvents']) {
    await adapter.deleteMany(collection, {});
  }
  await adapter.insertOne('outreachCampaigns', {
    id: CAMP, tenantId: T, name: 'Prospeccao', channel: 'whatsapp', templateId: 'tpl_1', status: 'processing',
    totalContacts: 3, pendingCount: 0, sentCount: 3, deliveredCount: 0, readCount: 0, repliedCount: 0,
    positiveCount: 0, negativeCount: 0, neutralCount: 0, qualifiedCount: 0, demoRequestedCount: 0, optOutCount: 0,
    createdAt: '2026-09-17T12:00:00.000Z'
  });
});

after(async () => { await adapter.close?.(); fs.rmSync(dbPath, { force: true }); });

test('uma resposta pedindo demonstracao conta como positiva, qualificada e demonstracao', async () => {
  await adapter.insertOne('outreachCampaignItems', item('it_1', {
    status: 'qualified', deliveredAt: '2026-09-17T12:01:00.000Z', readAt: '2026-09-17T12:02:00.000Z',
    repliedAt: '2026-09-17T12:03:00.000Z', firstResponseTimeMs: 180000,
    classificationId: 'cls_1', intent: 'pediu_demo', sentiment: 'neutral', confidence: 0.96
  }));

  const gravado = await recordCampaignMetricOnce({ tenantId: T, campaignId: CAMP, campaignItemId: 'it_1', type: 'intent:pediu_demo', sourceId: 'msg_1' });
  assert.equal(gravado, true);

  const campanha = await adapter.findOne('outreachCampaigns', { id: CAMP });
  assert.equal(campanha.positiveCount, 1);
  assert.equal(campanha.qualifiedCount, 1);
  assert.equal(campanha.demoRequestedCount, 1);
  assert.equal(campanha.repliedCount, 1);
  assert.equal(campanha.classifiedCount, 1);
  assert.equal(campanha.readCount, 1);
  assert.equal(campanha.deliveredCount, 1);
  assert.equal(campanha.negativeCount, 0);
  assert.equal(campanha.optOutCount, 0);
  assert.equal(campanha.firstResponseTimeAverageMs, 180000);

  // Evento repetido nao conta duas vezes.
  assert.equal(await recordCampaignMetricOnce({ tenantId: T, campaignId: CAMP, campaignItemId: 'it_1', type: 'intent:pediu_demo', sourceId: 'msg_1' }), false);
  assert.equal((await adapter.findOne('outreachCampaigns', { id: CAMP })).positiveCount, 1);
});

test('descadastro e recusa entram nos contadores certos; status e pendencias nao sao tocados', async () => {
  await adapter.insertOne('outreachCampaignItems', item('it_1', { status: 'opted_out', repliedAt: '2026-09-17T12:03:00.000Z', classificationId: 'cls_1', intent: 'opt_out', optedOutAt: '2026-09-17T12:03:00.000Z' }));
  await adapter.insertOne('outreachCampaignItems', item('it_2', { status: 'classified', repliedAt: '2026-09-17T12:04:00.000Z', classificationId: 'cls_2', intent: 'negativo' }));
  await adapter.insertOne('outreachCampaignItems', item('it_3', { status: 'classified', repliedAt: '2026-09-17T12:05:00.000Z', classificationId: 'cls_3', intent: 'duvida' }));

  const contadores = await syncCampaignCounters({ tenantId: T, campaignId: CAMP });
  assert.equal(contadores.optOutCount, 1);
  assert.equal(contadores.negativeCount, 2, 'descadastro tambem e resposta negativa');
  assert.equal(contadores.neutralCount, 1, 'duvida entra como neutra');
  assert.equal(contadores.positiveCount, 0);
  assert.equal(contadores.qualifiedCount, 0);

  const campanha = await adapter.findOne('outreachCampaigns', { id: CAMP });
  assert.equal(campanha.status, 'processing', 'status continua com o motor de envio');
  assert.equal(campanha.pendingCount, 0);
  assert.equal(campanha.sentCount, 3);
});

test('os numeros da tela e os do documento da campanha nao divergem', async () => {
  await adapter.insertOne('outreachCampaignItems', item('it_1', { status: 'qualified', deliveredAt: 'x', readAt: 'y', repliedAt: 'z', classificationId: 'cls_1', intent: 'pediu_preco', firstResponseTimeMs: 60000 }));
  await adapter.insertOne('outreachCampaignItems', item('it_2', { status: 'delivered', deliveredAt: 'x' }));
  await adapter.insertOne('outreachCampaignItems', item('it_3', { status: 'failed', sentAt: null, failureCode: 'send_failed' }));

  await syncCampaignCounters({ tenantId: T, campaignId: CAMP });
  const campanha = await adapter.findOne('outreachCampaigns', { id: CAMP });
  const tela = await calculateCampaignMetrics({ tenantId: T, campaignId: CAMP });

  for (const campo of ['deliveredCount', 'readCount', 'repliedCount', 'classifiedCount', 'positiveCount', 'negativeCount', 'neutralCount', 'qualifiedCount', 'demoRequestedCount', 'optOutCount']) {
    assert.equal(campanha[campo], tela[campo], `divergencia em ${campo}`);
  }
  assert.equal(tela.qualificationRate, 100);
  assert.equal(tela.sentCount, 2, 'contato que falhou nao conta como enviado');
});

test('campanha sem contatos nao zera contador nenhum', async () => {
  await adapter.updateOne('outreachCampaigns', { id: CAMP }, { $set: { repliedCount: 7 } });
  assert.equal(await syncCampaignCounters({ tenantId: T, campaignId: CAMP }), null);
  assert.equal((await adapter.findOne('outreachCampaigns', { id: CAMP })).repliedCount, 7);
  assert.deepEqual(aggregateCampaignItems([]).positiveCount, 0);
});
