import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Alertas da conta WhatsApp: webhook de conta -> alerta do tenant certo, sem
// duplicar entre reentrega da Meta e comparacao do sync.

const dbPath = path.join(os.tmpdir(), `onion-account-alerts-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'account-alerts-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { handleWhatsAppWebhook } = await import('../src/services/whatsappHandler.js');
const {
  diffInsightsToAlerts,
  listAccountAlerts,
  markAccountAlertsRead,
  parseAccountChanges,
  recordAccountAlert,
  recordAccountAlerts,
  translateAccountChange
} = await import('../src/services/whatsappAccountAlerts.js');

const webhook = (wabaId, field, value) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: wabaId, time: Math.floor(Date.now() / 1000), changes: [{ field, value }] }]
});

const canal = (tenantId, wabaId, phoneNumberId) => ({
  id: `channels_${tenantId}`,
  tenantId,
  whatsapp: { enabled: true, accessToken: 'token', wabaId, phoneNumberId }
});

const templateRecusado = {
  event: 'REJECTED',
  message_template_id: 111,
  message_template_name: 'promo_setembro',
  message_template_language: 'pt_BR',
  reason: 'INVALID_FORMAT',
  message_template_category: 'MARKETING',
  rejection_info: {
    reason: 'Parametros colados um no outro.',
    recommendation: 'Separe os parametros com texto.'
  }
};

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('channelConfigs', canal('tenant_conta', 'waba_conta', 'sender_conta'));
  await adapter.insertOne('channelConfigs', canal('tenant_outro', 'waba_outro', 'sender_outro'));
});

after(() => {
  try { fs.unlinkSync(dbPath); } catch {}
});

test('template recusado pelo webhook vira alerta do tenant dono da WABA', async () => {
  await handleWhatsAppWebhook({ payload: webhook('waba_conta', 'message_template_status_update', templateRecusado) });

  const { alerts, unread } = await listAccountAlerts('tenant_conta');
  assert.equal(alerts.length, 1);
  assert.equal(unread, 1);
  const [alerta] = alerts;
  assert.equal(alerta.title, 'Template recusado');
  assert.equal(alerta.severity, 'warning');
  assert.equal(alerta.source, 'webhook');
  assert.match(alerta.message, /promo_setembro/);
  assert.match(alerta.message, /formato inválido/);
  assert.match(alerta.message, /Sugestão da Meta: Separe os parametros/);

  assert.equal((await listAccountAlerts('tenant_outro')).alerts.length, 0);
  assert.equal((await adapter.findDocuments('activeChats', {})).length, 0, 'evento de conta nao abre conversa');
});

test('a Meta reenviando o mesmo evento nao duplica o alerta', async () => {
  await handleWhatsAppWebhook({ payload: webhook('waba_conta', 'message_template_status_update', templateRecusado) });
  assert.equal((await listAccountAlerts('tenant_conta')).alerts.length, 1);
});

test('o sync que encontra o mesmo template recusado nao duplica o alerta do webhook', async () => {
  const antes = { templates: { items: [{ id: '111', name: 'promo_setembro', status: 'PENDING', quality: null, category: 'MARKETING' }] } };
  const depois = { templates: { items: [{ id: '111', name: 'promo_setembro', status: 'REJECTED', quality: null, category: 'MARKETING', rejectedReason: 'INVALID_FORMAT' }] } };
  const candidatos = diffInsightsToAlerts(antes, depois, { wabaId: 'waba_conta' });
  assert.equal(candidatos.length, 1);

  assert.deepEqual(await recordAccountAlerts('tenant_conta', candidatos), []);
  assert.equal((await listAccountAlerts('tenant_conta')).alerts.length, 1);
});

test('WABA sem tenant vinculado nao grava alerta', async () => {
  await handleWhatsAppWebhook({ payload: webhook('waba_desconhecida', 'account_review_update', { decision: 'REJECTED' }) });
  const todos = await adapter.findDocuments('whatsappAccountAlerts', {});
  assert.ok(todos.every((a) => a.tenantId !== undefined && a.kind !== 'account_review'));
});

test('webhook de mensagem nao e lido como evento de conta', () => {
  const payload = { entry: [{ id: 'waba_conta', changes: [{ field: 'messages', value: { messages: [] } }] }] };
  assert.deepEqual(parseAccountChanges(payload), []);
});

test('eventos sem acao para o cliente nao viram alerta', () => {
  const nulos = [
    { field: 'account_update', value: { event: 'PARTNER_ADDED' } },
    { field: 'account_update', value: { event: 'VOLUME_BASED_PRICING_TIER_UPDATE' } },
    { field: 'message_template_status_update', value: { event: 'PENDING', message_template_id: 1 } },
    { field: 'account_alerts', value: { entity_type: 'BUSINESS', entity_id: '9', alert_info: { alert_status: 'NONE', alert_type: 'OBA_REJECTED' } } },
    { field: 'message_template_quality_update', value: { message_template_id: 1, previous_quality_score: 'UNKNOWN', new_quality_score: 'GREEN' } },
    { field: 'campo_inventado', value: {} }
  ];
  for (const change of nulos) {
    assert.equal(translateAccountChange({ wabaId: 'waba_conta', ...change }), null, `${change.field} ${JSON.stringify(change.value)}`);
  }
});

test('traduz queda de limite, nome aprovado, restricao e desconexao', () => {
  const limite = translateAccountChange({
    wabaId: 'w',
    field: 'phone_number_quality_update',
    value: { display_phone_number: '5511997000056', event: 'DOWNGRADE', max_daily_conversations_per_business: 'TIER_250', old_limit: 'TIER_2K' }
  });
  assert.equal(limite.severity, 'critical');
  assert.equal(limite.title, 'Limite de envio reduzido');
  assert.match(limite.message, /250 clientes por dia \(antes: 2\.000 clientes por dia\)/);

  const nome = translateAccountChange({
    wabaId: 'w',
    field: 'phone_number_name_update',
    value: { display_phone_number: '5511997000056', decision: 'APPROVED', requested_verified_name: 'Onion Web Solutions', rejection_reason: null }
  });
  assert.equal(nome.severity, 'success');
  assert.match(nome.message, /"Onion Web Solutions" foi aprovado/);

  const restricao = translateAccountChange({
    wabaId: 'w',
    field: 'account_update',
    value: { event: 'ACCOUNT_RESTRICTION', restriction_info: [{ restriction_type: 'RESTRICTED_BIZ_INITIATED_MESSAGING', expiration: 1790000000 }] }
  });
  assert.equal(restricao.severity, 'critical');
  assert.match(restricao.message, /não é possível iniciar conversas com clientes até \d{2}\/\d{2}\/\d{4}/);

  const desconexao = translateAccountChange({ wabaId: 'w', field: 'account_update', value: { event: 'PARTNER_REMOVED' } });
  assert.equal(desconexao.title, 'Conta desconectada da Onion');

  const oba = translateAccountChange({
    wabaId: 'w',
    field: 'account_alerts',
    value: { entity_type: 'BUSINESS', entity_id: '9', alert_info: { alert_severity: 'WARNING', alert_status: 'ACTIVE', alert_type: 'OBA_REJECTED', alert_description: 'Not eligible.' } }
  });
  assert.equal(oba.title, 'Selo de conta oficial recusado');
  assert.equal(oba.message, 'Not eligible.');

  const categoria = translateAccountChange({
    wabaId: 'w',
    field: 'template_category_update',
    value: { message_template_id: 5, message_template_name: 'aviso', correct_category: 'MARKETING', new_category: 'UTILITY', category_update_timestamp: 1790000000 }
  });
  assert.equal(categoria.title, 'Categoria do template vai mudar');
});

test('marcar como lido nao mexe em alerta de outro tenant', async () => {
  const doOutro = await recordAccountAlert('tenant_outro', {
    kind: 'phone_quality', severity: 'warning', title: 'Qualidade do número caiu', message: 'x', dedupKey: 'phone:1:quality:YELLOW'
  });

  assert.equal(await markAccountAlertsRead('tenant_conta', { ids: [doOutro.id] }), 0);
  assert.equal((await listAccountAlerts('tenant_outro')).unread, 1);

  assert.equal(await markAccountAlertsRead('tenant_conta'), 1);
  assert.equal((await listAccountAlerts('tenant_conta')).unread, 0);
  assert.equal((await listAccountAlerts('tenant_outro')).unread, 1);
});
