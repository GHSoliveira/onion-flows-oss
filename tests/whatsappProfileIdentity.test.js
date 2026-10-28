import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Nome de exibicao e foto de perfil: chamadas certas na Graph API, limite de
// pedidos de nome e novo registro automatico quando o nome e aprovado.

const dbPath = path.join(os.tmpdir(), `onion-profile-identity-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'profile-identity-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_APP_ID = 'app_configurado';
process.env.WHATSAPP_APP_SECRET = 'segredo_configurado';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const identity = await import('../src/services/whatsappProfileIdentity.js');
const { handleWhatsAppAccountWebhook, listAccountAlerts } = await import('../src/services/whatsappAccountAlerts.js');

const originalFetch = globalThis.fetch;
let chamadas = [];
const resposta = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const graphFake = async (url, opts = {}) => {
  const u = new URL(String(url));
  const caminho = u.pathname.replace(/^\/v\d+\.\d+\//, '');
  const metodo = opts.method || 'GET';
  chamadas.push({ caminho, metodo, query: Object.fromEntries(u.searchParams), headers: opts.headers || {}, body: opts.body });

  if (caminho === 'debug_token') return resposta({ data: { app_id: 'app_do_token', is_valid: true } });
  if (caminho === 'app_do_token/uploads' && metodo === 'POST') return resposta({ id: 'upload:sessao123' });
  if (caminho === 'upload:sessao123' && metodo === 'POST') return resposta({ h: '4::referencia' });
  if (caminho.endsWith('/whatsapp_business_profile')) {
    return metodo === 'POST' ? resposta({ success: true }) : resposta({ data: [{ profile_picture_url: 'https://pps.whatsapp.net/nova.jpg' }] });
  }
  if (caminho.endsWith('/register') && metodo === 'POST') return resposta({ success: true });
  if (caminho === 'num_com_pin' && metodo === 'POST') return resposta({ success: true });
  if (caminho === 'num_com_pin') return resposta({ display_phone_number: '+55 11 9710-0001', verified_name: 'Loja A', name_status: 'APPROVED', new_display_name: 'Loja Nova', new_name_status: 'PENDING_REVIEW' });
  if (caminho === 'num_sem_pin') return resposta({ display_phone_number: '+55 11 9710-0002' });
  return resposta({ error: { message: `rota nao simulada: ${metodo} ${caminho}` } }, 400);
};

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('channelConfigs', {
    id: 'channels_tenant_pin',
    tenantId: 'tenant_pin',
    whatsapp: { enabled: true, accessToken: 'tok_a', wabaId: 'waba_pin', phoneNumberId: 'num_com_pin', registrationPin: '123456' }
  });
  await adapter.insertOne('channelConfigs', {
    id: 'channels_tenant_sem_pin',
    tenantId: 'tenant_sem_pin',
    whatsapp: { enabled: true, accessToken: 'tok_b', wabaId: 'waba_sem_pin', phoneNumberId: 'num_sem_pin' }
  });
  globalThis.fetch = graphFake;
});

beforeEach(() => { chamadas = []; });

after(() => {
  globalThis.fetch = originalFetch;
  try { fs.unlinkSync(dbPath); } catch {}
});

test('foto: aceita so JPG e PNG de ate 5 MB', () => {
  assert.throws(() => identity.decodeImageDataUrl('data:image/gif;base64,R0lGODlh'), /JPG ou PNG/);
  assert.throws(() => identity.decodeImageDataUrl('isso nao e imagem'), /invalida/);
  const grande = `data:image/png;base64,${Buffer.alloc(identity.PROFILE_PICTURE_MAX_BYTES + 1).toString('base64')}`;
  assert.throws(() => identity.decodeImageDataUrl(grande), /5 MB/);
  assert.equal(identity.decodeImageDataUrl(PNG_1PX).mimeType, 'image/png');
});

test('foto: sobe no app dono do token e atualiza o perfil com a referencia', async () => {
  const r = await identity.updateProfilePicture({ accessToken: 'tok_a', phoneNumberId: 'num_com_pin', dataUrl: PNG_1PX, fileName: 'Logo Loja.png' });
  assert.equal(r.profilePictureUrl, 'https://pps.whatsapp.net/nova.jpg');

  const sessao = chamadas.find((c) => c.caminho === 'app_do_token/uploads');
  assert.ok(sessao, 'sessao aberta no app devolvido pelo debug_token');
  assert.equal(sessao.query.file_type, 'image/png');
  assert.equal(Number(sessao.query.file_length), identity.decodeImageDataUrl(PNG_1PX).buffer.length);
  assert.equal(sessao.query.file_name, 'Logo_Loja.png');

  const envio = chamadas.find((c) => c.caminho === 'upload:sessao123');
  assert.equal(envio.headers.Authorization, 'OAuth tok_a');
  assert.equal(envio.headers.file_offset, '0');

  const perfil = chamadas.find((c) => c.caminho === 'num_com_pin/whatsapp_business_profile' && c.metodo === 'POST');
  assert.deepEqual(JSON.parse(perfil.body), { messaging_product: 'whatsapp', profile_picture_handle: '4::referencia' });
});

test('nome: valida antes de enviar a Meta', () => {
  assert.throws(() => identity.validateDisplayName('ab'), /3 caracteres/);
  assert.throws(() => identity.validateDisplayName('Loja www.site.com'), /link/);
  assert.equal(identity.validateDisplayName('  Pastelaria   do Chefe '), 'Pastelaria do Chefe');
});

test('nome: envia new_display_name, registra o pedido e respeita 10 por 30 dias', async () => {
  const r = await identity.requestDisplayNameChange({ tenantId: 'tenant_pin', accessToken: 'tok_a', phoneNumberId: 'num_com_pin', name: 'Loja Nova', pinStored: true });
  const pedido = chamadas.find((c) => c.caminho === 'num_com_pin' && c.metodo === 'POST');
  assert.deepEqual(JSON.parse(pedido.body), { new_display_name: 'Loja Nova' });
  assert.equal(r.newNameStatus, 'PENDING_REVIEW');
  assert.equal(r.nameChanges.used, 1);
  assert.equal(r.pinStored, true);

  for (let i = 0; i < 9; i += 1) {
    await adapter.insertOne(identity.DISPLAY_NAME_REQUESTS_COLLECTION, { id: `antigo_${i}`, tenantId: 'tenant_pin', phoneNumberId: 'num_com_pin', name: 'x', createdAt: new Date().toISOString() });
  }
  chamadas = [];
  await assert.rejects(
    identity.requestDisplayNameChange({ tenantId: 'tenant_pin', accessToken: 'tok_a', phoneNumberId: 'num_com_pin', name: 'Mais Um Nome' }),
    (erro) => erro.status === 429
  );
  assert.equal(chamadas.filter((c) => c.metodo === 'POST').length, 0, 'nao chega a Meta depois do limite');
});

const webhookNomeAprovado = (wabaId, display) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: wabaId, changes: [{ field: 'phone_number_name_update', value: { display_phone_number: display, decision: 'APPROVED', requested_verified_name: 'Loja Nova', rejection_reason: null } }] }]
});

test('nome aprovado: com PIN guardado, registra o numero de novo sozinho', async () => {
  await handleWhatsAppAccountWebhook(webhookNomeAprovado('waba_pin', '551197100001'));

  const registro = chamadas.find((c) => c.caminho === 'num_com_pin/register');
  assert.ok(registro, 'registro disparado');
  assert.deepEqual(JSON.parse(registro.body), { messaging_product: 'whatsapp', pin: '123456' });

  const { alerts } = await listAccountAlerts('tenant_pin');
  assert.ok(alerts.some((a) => a.title === 'Número registrado com o novo nome' && a.severity === 'success'));
});

test('nome aprovado: sem PIN, nao registra e avisa o prazo de 14 dias', async () => {
  await handleWhatsAppAccountWebhook(webhookNomeAprovado('waba_sem_pin', '551197100002'));

  assert.equal(chamadas.filter((c) => c.caminho.endsWith('/register')).length, 0);
  const { alerts } = await listAccountAlerts('tenant_sem_pin');
  const aviso = alerts.find((a) => a.title === 'Registre o número para ativar o novo nome');
  assert.ok(aviso);
  assert.match(aviso.message, /14 dias/);
});
