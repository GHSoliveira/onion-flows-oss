import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Travas do Embedded Signup: numero de outro tenant e canal que ja funciona.
// Quando o onboarding e recusado, nenhuma chamada pode chegar na Meta.

const dbPath = path.join(os.tmpdir(), `onion-es-guard-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'es-guard-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_APP_ID = 'app_test';
process.env.WHATSAPP_APP_SECRET = 'secret_test';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { completeEmbeddedSignup } = await import('../src/services/embeddedSignup.js');
const { getWhatsAppConfig } = await import('../src/services/channelConfig.js');

const originalFetch = globalThis.fetch;
let chamadasMeta = [];

const resposta = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  chamadasMeta = [];
  globalThis.fetch = async (url) => {
    const alvo = String(url);
    chamadasMeta.push(alvo);
    if (alvo.includes('/oauth/access_token')) return resposta({ access_token: 'token_do_embedded_signup' });
    return resposta({ success: true });
  };
});

const canal = (tenantId, whatsapp) => ({
  id: `channels_${tenantId}`,
  tenantId,
  whatsapp: { enabled: true, ...whatsapp }
});

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();

  await adapter.insertOne('channelConfigs', canal('tenant_producao', {
    accessToken: 'token_do_usuario_de_sistema',
    wabaId: 'waba_producao',
    phoneNumberId: 'numero_producao'
  }));
  // Canal desligado e sem token, mas com o numero cadastrado.
  await adapter.insertOne('channelConfigs', canal('tenant_parado', {
    enabled: false,
    phoneNumberId: 'numero_parado'
  }));
  // Numero guardado so na lista de remetentes, nao no campo principal.
  await adapter.insertOne('channelConfigs', canal('tenant_remetentes', {
    accessToken: 'token_remetentes',
    phoneNumberId: 'numero_principal',
    senderNumbers: [
      { phoneNumberId: 'numero_principal', isDefault: true },
      { phoneNumberId: 'numero_secundario' }
    ]
  }));
});

after(() => {
  globalThis.fetch = originalFetch;
  try { fs.unlinkSync(dbPath); } catch {}
});

const onboarding = (tenantId, phoneNumberId, extra = {}) => completeEmbeddedSignup({
  tenantId,
  code: 'code_test',
  wabaId: 'waba_nova',
  phoneNumberId,
  ...extra
});

test('recusa numero que ja esta no canal de outro tenant, sem chamar a Meta', async () => {
  await assert.rejects(onboarding('tenant_novo', 'numero_producao'), (erro) => {
    assert.equal(erro.status, 409);
    assert.equal(erro.code, 'phone_number_in_use');
    assert.ok(!erro.message.includes('tenant_producao'), 'nao pode revelar o outro tenant');
    return true;
  });
  assert.deepEqual(chamadasMeta, []);

  const producao = await getWhatsAppConfig('tenant_producao');
  assert.equal(producao.accessToken, 'token_do_usuario_de_sistema');
});

test('confirmar substituicao nao libera numero de outro tenant', async () => {
  await assert.rejects(
    onboarding('tenant_novo', 'numero_producao', { confirmReplace: true }),
    { code: 'phone_number_in_use' }
  );
  assert.deepEqual(chamadasMeta, []);
});

test('canal desligado em outro tenant tambem conta como dono do numero', async () => {
  await assert.rejects(onboarding('tenant_novo', 'numero_parado'), { code: 'phone_number_in_use' });
  assert.deepEqual(chamadasMeta, []);
});

test('numero da lista de remetentes de outro tenant tambem e recusado', async () => {
  await assert.rejects(onboarding('tenant_novo', 'numero_secundario'), { code: 'phone_number_in_use' });
  assert.deepEqual(chamadasMeta, []);
});

test('canal que ja tem token exige confirmacao e fica intacto sem ela', async () => {
  await assert.rejects(onboarding('tenant_producao', 'numero_producao'), (erro) => {
    assert.equal(erro.status, 409);
    assert.equal(erro.code, 'whatsapp_already_connected');
    return true;
  });
  assert.deepEqual(chamadasMeta, []);

  const producao = await getWhatsAppConfig('tenant_producao');
  assert.equal(producao.accessToken, 'token_do_usuario_de_sistema');
  assert.equal(producao.wabaId, 'waba_producao');
});

test('confirmReplace so vale como true de verdade', async () => {
  await assert.rejects(
    onboarding('tenant_producao', 'numero_producao', { confirmReplace: 'true' }),
    { code: 'whatsapp_already_connected' }
  );
  assert.deepEqual(chamadasMeta, []);
});

test('tenant sem WhatsApp conecta sem precisar confirmar', async () => {
  const resultado = await onboarding('tenant_vazio', 'numero_novo');

  assert.equal(resultado.ok, true);
  assert.equal(resultado.passos.saved, true);
  assert.ok(chamadasMeta.some((url) => url.includes('/oauth/access_token')));

  const salvo = await getWhatsAppConfig('tenant_vazio');
  assert.equal(salvo.accessToken, 'token_do_embedded_signup');
  assert.equal(salvo.phoneNumberId, 'numero_novo');
  assert.equal(salvo.onboardedVia, 'embedded_signup');
});

test('com confirmacao, o proprio tenant substitui a credencial', async () => {
  const resultado = await onboarding('tenant_producao', 'numero_producao', { confirmReplace: true });

  assert.equal(resultado.ok, true);
  assert.ok(chamadasMeta.some((url) => url.includes('/oauth/access_token')));

  const producao = await getWhatsAppConfig('tenant_producao');
  assert.equal(producao.accessToken, 'token_do_embedded_signup');
  assert.equal(producao.wabaId, 'waba_nova');
});
