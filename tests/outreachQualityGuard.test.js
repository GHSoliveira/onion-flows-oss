import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Pausa automatica por qualidade: quando a Meta sinaliza queda (numero,
// template ou conta), a campanha para antes do proximo envio e so volta com
// alguem ciente do motivo.

const dbPath = path.join(os.tmpdir(), `outreach-quality-guard-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'outreach-quality-guard-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';
process.env.OUTREACH_SEND_JITTER_MIN_MS = '0';
process.env.OUTREACH_SEND_JITTER_MAX_MS = '0';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const guard = await import('../src/services/outreachQualityGuard.js');
const { processNextOutreachCampaign } = await import('../src/services/outreachCampaignWorker.js');
const { handleWhatsAppWebhook } = await import('../src/services/whatsappHandler.js');
const { buildHealthAlert, buildPhoneQualityAlert, buildTemplateStatusAlert, buildTierAlert } = await import('../src/services/whatsappAccountAlerts.js');
const { default: outreachRouter } = await import('../src/routes/outreach.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_quality';
const WABA = 'waba_quality';
const NUMERO = '+55 11 90000-0000';

// Retrato como o de producao hoje: numero LIMITED so porque o nome de exibicao
// ainda nao foi aprovado. Isso NAO pode pausar nada.
const retrato = ({ quality = 'GREEN', canSend = 'LIMITED', accountCanSend = 'AVAILABLE', templates = [] } = {}) => ({
  id: `wa_insights_${T}`,
  tenantId: T,
  wabaId: WABA,
  phoneNumberId: 'phone_quality',
  fetchedAt: new Date().toISOString(),
  insights: {
    phone: {
      id: 'phone_quality', displayPhoneNumber: NUMERO, qualityRating: quality, messagingLimitTier: 'TIER_250', canSendMessage: canSend,
      healthIssues: [{ area: 'messaging', code: null, description: 'Your display name has not been approved yet.' }]
    },
    account: { id: WABA, canSendMessage: accountCanSend, healthIssues: [] },
    templates: { items: templates }
  }
});

const gravarRetrato = (opcoes) => adapter.saveDocument('whatsappAccountSnapshots', retrato(opcoes));

const campanha = (id, extra = {}) => ({
  id, tenantId: T, name: `Campanha ${id}`, channel: 'whatsapp', templateId: 'tpl_prospeccao', senderPhoneNumberId: 'phone_quality',
  values: {}, cadenceId: null, status: 'pending', totalContacts: 1, pendingCount: 1, successCount: 0, failedCount: 0,
  createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString(), ...extra
});

const item = (campaignId) => ({
  id: `${campaignId}_item`, tenantId: T, campaignId, contactId: 'contact_1', sortIndex: 0, contactName: 'Clínica',
  phoneEntryId: null, phoneNumber: '5511900000001', templateId: 'tpl_prospeccao', status: 'pending',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
});

before(async () => {
  await adapter.init();
});

beforeEach(async () => {
  for (const collection of ['outreachCampaigns', 'outreachCampaignItems', 'whatsappAccountSnapshots', 'whatsappAccountAlerts', 'whatsappTemplates', 'channelConfigs', 'users', 'cadenceExecutions', 'cadences']) {
    await adapter.deleteMany(collection, {});
  }
  await adapter.insertOne('channelConfigs', { id: `channels_${T}`, tenantId: T, whatsapp: { enabled: true, accessToken: 'token', wabaId: WABA, phoneNumberId: 'phone_quality' } });
  await adapter.insertOne('whatsappTemplates', { id: 'tpl_prospeccao', tenantId: T, metaTemplateId: '9001', name: 'prospeccao_clinicas', language: 'pt_BR', status: 'APPROVED' });
  await adapter.insertOne('whatsappTemplates', { id: 'tpl_outro', tenantId: T, metaTemplateId: '9002', name: 'lembrete', language: 'pt_BR', status: 'APPROVED' });
});

after(async () => {
  await adapter.close?.();
  fs.rmSync(dbPath, { force: true });
});

test('classificacao: queda real pausa; LIMITED do nome pendente, melhora e aprovacao nao', () => {
  const pausa = (alert) => Boolean(guard.qualitySignalFromAlert(alert));
  assert.equal(pausa(buildPhoneQualityAlert({ phone: NUMERO, previous: 'GREEN', next: 'YELLOW' })), true);
  assert.equal(pausa(buildPhoneQualityAlert({ phone: NUMERO, previous: 'YELLOW', next: 'GREEN' })), false);
  assert.equal(pausa(buildHealthAlert({ entityType: 'phone', entityId: '5511900000000', previous: 'AVAILABLE', next: 'LIMITED' })), false);
  assert.equal(pausa(buildHealthAlert({ entityType: 'phone', entityId: '5511900000000', previous: 'LIMITED', next: 'BLOCKED' })), true);
  assert.equal(pausa(buildTierAlert({ phone: NUMERO, previous: 'TIER_2K', next: 'TIER_250' })), true);
  assert.equal(pausa(buildTierAlert({ phone: NUMERO, previous: 'TIER_250', next: 'TIER_2K' })), false);
  assert.equal(pausa(buildTemplateStatusAlert({ id: '9001', name: 'x', status: 'PAUSED' })), true);
  assert.equal(pausa(buildTemplateStatusAlert({ id: '9001', name: 'x', status: 'APPROVED' })), false);

  assert.deepEqual(guard.qualitySignalsFromInsights(retrato().insights), [], 'estado de producao atual nao gera sinal');
});

test('worker: numero com qualidade media pausa antes de enviar e registra o motivo', async () => {
  await gravarRetrato({ quality: 'YELLOW' });
  await adapter.insertOne('outreachCampaigns', campanha('camp_a'));
  await adapter.insertOne('outreachCampaignItems', item('camp_a'));

  const resultado = await processNextOutreachCampaign();
  assert.equal(resultado?.paused, true);

  const salva = await adapter.findOne('outreachCampaigns', { id: 'camp_a' });
  assert.equal(salva.status, 'paused');
  assert.equal(salva.qualityPause.source, 'send_check');
  assert.match(salva.qualityPause.reasons[0].key, /quality:YELLOW$/);

  const pendente = await adapter.findOne('outreachCampaignItems', { id: 'camp_a_item' });
  assert.equal(pendente.status, 'pending', 'nenhum envio saiu');
  assert.equal(pendente.sentAt ?? null, null);

  const alertas = await adapter.findMany('whatsappAccountAlerts', { query: { tenantId: T, kind: 'outreach_quality_pause' } });
  assert.equal(alertas.length, 1);

  assert.deepEqual(await processNextOutreachCampaign(), { idle: true }, 'campanha pausada sai da fila do worker');
});

test('template: so pausa a campanha que usa o template sinalizado', async () => {
  await gravarRetrato({ templates: [{ id: '9002', name: 'lembrete', language: 'pt_BR', status: 'APPROVED', quality: 'RED' }] });
  const usaOutro = campanha('camp_outro', { templateId: 'tpl_outro' });
  const usaProspeccao = campanha('camp_prosp');
  await adapter.insertOne('outreachCampaigns', usaOutro);
  await adapter.insertOne('outreachCampaigns', usaProspeccao);

  assert.equal(await guard.checkCampaignQuality(usaProspeccao), null);
  assert.equal((await guard.checkCampaignQuality(usaOutro))?.status, 'paused');
  assert.equal((await adapter.findOne('outreachCampaigns', { id: 'camp_prosp' })).status, 'pending');
});

test('webhook: numero sinalizado pela Meta pausa na hora, sem esperar o sync', async () => {
  await gravarRetrato();
  await adapter.insertOne('outreachCampaigns', campanha('camp_web', { status: 'processing' }));
  await adapter.insertOne('outreachCampaigns', campanha('camp_feita', { status: 'completed' }));

  await handleWhatsAppWebhook({ payload: {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, time: Math.floor(Date.now() / 1000), changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: NUMERO, event: 'FLAGGED', current_limit: 'TIER_250' } }] }]
  } });

  const pausada = await adapter.findOne('outreachCampaigns', { id: 'camp_web' });
  assert.equal(pausada.status, 'paused');
  assert.equal(pausada.qualityPause.source, 'webhook');
  assert.equal((await adapter.findOne('outreachCampaigns', { id: 'camp_feita' })).status, 'completed', 'campanha encerrada nao muda');
});

const chamar = async (rota, body = undefined) => {
  await adapter.insertOne('users', { id: 'u_admin', username: 'admin', role: 'ADMIN', tenantId: T, permissions: ['*'] }).catch(() => {});
  const app = express();
  app.use(express.json());
  app.use('/outreach', outreachRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const token = jwt.sign({ userId: 'u_admin' }, JWT_SECRET_VALUE, { expiresIn: 60 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/outreach${rota}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('retomar: exige ciencia; sinal ja visto nao pausa de novo, piora pausa', async () => {
  await gravarRetrato({ quality: 'YELLOW' });
  await adapter.insertOne('outreachCampaigns', campanha('camp_r'));
  await guard.checkCampaignQuality(await adapter.findOne('outreachCampaigns', { id: 'camp_r' }));

  const semCiencia = await chamar('/campaigns/camp_r/resume');
  assert.equal(semCiencia.status, 409);
  assert.equal(semCiencia.body.code, 'quality_ack_required');
  assert.equal((await adapter.findOne('outreachCampaigns', { id: 'camp_r' })).status, 'paused');

  const comCiencia = await chamar('/campaigns/camp_r/resume', { acknowledgeQuality: true });
  assert.equal(comCiencia.status, 200);
  const retomada = await adapter.findOne('outreachCampaigns', { id: 'camp_r' });
  assert.equal(retomada.status, 'pending');
  assert.equal(retomada.qualityPause, null);
  assert.ok(retomada.qualityAck.some((key) => /quality:YELLOW$/.test(key)));

  assert.equal(await guard.checkCampaignQuality(retomada), null, 'o mesmo amarelo ja foi aceito');

  await gravarRetrato({ quality: 'RED' });
  const piorou = await guard.checkCampaignQuality(await adapter.findOne('outreachCampaigns', { id: 'camp_r' }));
  assert.equal(piorou?.status, 'paused');
  assert.match(piorou.qualityPause.reasons[0].key, /quality:RED$/);
});

test('retomar: sinal que sumiu sai da ciencia e volta a pausar se reaparecer', async () => {
  await gravarRetrato({ quality: 'GREEN' });
  await adapter.insertOne('outreachCampaigns', campanha('camp_ack', { qualityAck: [`phone:5511900000000:quality:YELLOW`] }));

  assert.equal(await guard.checkCampaignQuality(await adapter.findOne('outreachCampaigns', { id: 'camp_ack' })), null);
  assert.deepEqual((await adapter.findOne('outreachCampaigns', { id: 'camp_ack' })).qualityAck, []);

  await gravarRetrato({ quality: 'YELLOW' });
  assert.equal((await guard.checkCampaignQuality(await adapter.findOne('outreachCampaigns', { id: 'camp_ack' })))?.status, 'paused');
});

test('cadencia: passo seguinte nao envia com numero em qualidade baixa e a campanha pausa junto', async () => {
  process.env.CADENCE_ENGINE_ENABLED = 'true';
  const { processNextCadenceExecution } = await import('../src/services/cadenceEngine.js');
  await gravarRetrato({ quality: 'RED' });
  await adapter.insertOne('cadences', {
    id: 'cad_1', tenantId: T, status: 'active', timezone: 'America/Sao_Paulo', allowedWeekdays: [0, 1, 2, 3, 4, 5, 6], allowedStartTime: '00:00', allowedEndTime: '23:59',
    steps: [{ order: 1, delayMinutes: 0, action: 'send_template', templateId: 'tpl_outro', values: {} }]
  });
  await adapter.insertOne('outreachCampaigns', campanha('camp_cad', { cadenceId: 'cad_1', status: 'processing' }));
  await adapter.insertOne('outreachCampaignItems', item('camp_cad'));
  await adapter.insertOne('cadenceExecutions', {
    id: 'exec_1', tenantId: T, cadenceId: 'cad_1', campaignId: 'camp_cad', campaignItemId: 'camp_cad_item', contactId: 'contact_1',
    currentStep: 0, status: 'waiting', nextExecutionAt: new Date(Date.now() - 60000).toISOString(), attemptCount: 0
  });

  const resultado = await processNextCadenceExecution();
  assert.deepEqual(resultado, { paused: true, reason: 'quality_guard' });
  assert.equal((await adapter.findOne('cadenceExecutions', { id: 'exec_1' })).status, 'paused');
  assert.equal((await adapter.findOne('outreachCampaigns', { id: 'camp_cad' })).status, 'paused');
  assert.equal((await adapter.findOne('outreachCampaignItems', { id: 'camp_cad_item' })).sentAt ?? null, null);
});
