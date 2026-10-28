import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Desconectar o numero de um tenant: conexao apagada (e nao so desligada),
// numero livre para outro tenant, Telegram intacto e saida do webhook na Meta
// so quando nenhum outro tenant usa a mesma WABA.

const dbPath = path.join(os.tmpdir(), `onion-wa-disconnect-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'wa-disconnect-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { disconnectWhatsApp } = await import('../src/services/whatsappDisconnect.js');
const { findWhatsAppPhoneNumberOwners, getAllWhatsAppConfigs, getChannelConfig, getWhatsAppConfig } = await import('../src/services/channelConfig.js');

const originalFetch = globalThis.fetch;
let chamadas = [];

beforeEach(() => {
  chamadas = [];
  globalThis.fetch = async (url, opts = {}) => {
    const alvo = String(url);
    chamadas.push({ alvo, metodo: opts.method || 'GET', auth: opts.headers?.Authorization || null });
    if (alvo.includes('waba_quebrada')) return { ok: false, status: 400, json: async () => ({ error: { message: 'token expirado' } }) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
});

const canal = (tenantId, whatsapp, extra = {}) => ({ id: `channels_${tenantId}`, tenantId, whatsapp: { enabled: true, ...whatsapp }, ...extra });

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('channelConfigs', canal('tenant_sai', {
    accessToken: 'token_sai', wabaId: 'waba_sai', phoneNumberId: 'num_sai', registrationPin: '123456',
    onboardedVia: 'embedded_signup', businessId: 'biz_sai'
  }, { telegram: { enabled: true, botToken: 'bot_do_tenant' } }));
  await adapter.insertOne('channelConfigs', canal('tenant_divide_a', { accessToken: 'token_a', wabaId: 'waba_dividida', phoneNumberId: 'num_a' }));
  await adapter.insertOne('channelConfigs', canal('tenant_divide_b', { accessToken: 'token_b', wabaId: 'waba_dividida', phoneNumberId: 'num_b' }));
  await adapter.insertOne('channelConfigs', canal('tenant_meta_falha', { accessToken: 'token_c', wabaId: 'waba_quebrada', phoneNumberId: 'num_c' }));
  await adapter.insertOne('channelConfigs', { id: 'channels_tenant_sem_wa', tenantId: 'tenant_sem_wa', telegram: { enabled: true, botToken: 'bot' } });
});

after(() => {
  globalThis.fetch = originalFetch;
  try { fs.unlinkSync(dbPath); } catch {}
});

test('desconectar: apaga token, PIN e numero, libera o numero e sai do webhook da WABA', async () => {
  const r = await disconnectWhatsApp({ tenantId: 'tenant_sai', actorId: 'u_admin' });
  assert.deepEqual(r, { disconnected: true, metaUnsubscribed: true, metaWarning: null, phoneNumberCount: 1 });

  const saida = chamadas.find((c) => c.alvo.includes('waba_sai/subscribed_apps'));
  assert.ok(saida, 'chamou a Meta');
  assert.equal(saida.metodo, 'DELETE');
  assert.equal(saida.auth, 'Bearer token_sai');

  const wa = await getWhatsAppConfig('tenant_sai');
  assert.equal(wa.enabled, false);
  assert.equal(wa.accessToken, null);
  assert.equal(wa.registrationPin, undefined);
  assert.equal(wa.phoneNumberId, null);
  assert.deepEqual(wa.senderNumbers, []);
  assert.equal(wa.lastConnection.wabaId, 'waba_sai');
  assert.equal(wa.disconnectedBy, 'u_admin');

  assert.deepEqual(await findWhatsAppPhoneNumberOwners('num_sai'), [], 'trava do Embedded Signup libera o numero');
  assert.ok(!(await getAllWhatsAppConfigs()).some((entry) => entry.tenantId === 'tenant_sai'), 'fora do roteamento');
  assert.equal((await getChannelConfig('tenant_sai')).telegram.botToken, 'bot_do_tenant', 'Telegram intacto');
});

test('WABA usada por outro tenant: desconecta aqui sem tirar o webhook da Meta', async () => {
  const r = await disconnectWhatsApp({ tenantId: 'tenant_divide_a' });
  assert.equal(r.disconnected, true);
  assert.equal(r.metaUnsubscribed, false);
  assert.match(r.metaWarning, /Outro tenant/);
  assert.equal(chamadas.filter((c) => c.metodo === 'DELETE').length, 0);
  assert.equal((await getWhatsAppConfig('tenant_divide_b')).accessToken, 'token_b', 'outro tenant intacto');
});

test('Meta falha: numero desconectado mesmo assim, com aviso', async () => {
  const r = await disconnectWhatsApp({ tenantId: 'tenant_meta_falha' });
  assert.equal(r.disconnected, true);
  assert.equal(r.metaUnsubscribed, false);
  assert.match(r.metaWarning, /token expirado/);
  assert.equal((await getWhatsAppConfig('tenant_meta_falha')).accessToken, null);
});

test('tenant sem WhatsApp (ou ja desconectado): 404 e nada vai para a Meta', async () => {
  await assert.rejects(disconnectWhatsApp({ tenantId: 'tenant_sem_wa' }), (erro) => erro.status === 404);
  await assert.rejects(disconnectWhatsApp({ tenantId: 'tenant_sai' }), (erro) => erro.status === 404);
  assert.equal(chamadas.length, 0);
});
