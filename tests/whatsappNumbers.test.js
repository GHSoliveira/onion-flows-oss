import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Numeros de WhatsApp: o que vem da Meta ja traz codigo do pais e nao pode
// ganhar "55"; o que e digitado segue a regra do Brasil. E o aviso automatico da
// conta oficial da Meta nao abre conversa.

const dbPath = path.join(os.tmpdir(), `onion-whatsapp-numbers-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'whatsapp-numbers-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { normalizeWhatsappNumber, normalizeWhatsappWaId } = await import('../src/services/activeOutreach.js');
const { handleWhatsAppWebhook } = await import('../src/services/whatsappHandler.js');

const TENANT = 'tenant_numeros';

const webhook = (from, id, name = 'Cliente') => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba_numeros',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '5511900000000', phone_number_id: 'sender_numeros' },
        contacts: [{ wa_id: from, profile: { name } }],
        messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'oi' } }]
      }
    }]
  }]
});

// O envio falso so registra no console; captura o destino de cada envio.
const enviosPara = [];
const originalLog = console.log;

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('tenants', { id: TENANT, name: 'Tenant Numeros', status: 'active' });
  await adapter.insertOne('channelConfigs', {
    id: `channels_${TENANT}`,
    tenantId: TENANT,
    whatsapp: { enabled: true, accessToken: 'test-access-token', phoneNumberId: 'sender_numeros' }
  });
  await adapter.insertOne('flows', {
    id: 'flow_numeros',
    tenantId: TENANT,
    name: 'Resposta',
    status: 'published',
    published: {
      nodes: [
        { id: 'start', type: 'startNode', data: {} },
        { id: 'resposta', type: 'messageNode', data: { text: 'Oi! Recebemos sua mensagem.' } }
      ],
      edges: [{ id: 'e1', source: 'start', target: 'resposta' }]
    }
  });
  console.log = (...args) => {
    if (args[0] === '[WHATSAPP][SANDBOX] Fake send ok' && args[1]?.to) enviosPara.push(args[1].to);
    return originalLog(...args);
  };
});

after(() => {
  console.log = originalLog;
  try { fs.unlinkSync(dbPath); } catch {}
});

test('numero da Meta: estrangeiro de 11 digitos nao ganha 55', () => {
  assert.equal(normalizeWhatsappWaId('16465894000'), '16465894000');
  assert.equal(normalizeWhatsappWaId('51912345678'), '51912345678', 'celular do Peru igual a um BR sem DDI');
  assert.equal(normalizeWhatsappWaId('5511998150000'), '5511998150000');
});

test('numero da Meta: nono digito so em celular brasileiro antigo, nunca em fixo', () => {
  assert.equal(normalizeWhatsappWaId('551198150000'), '5511998150000');
  assert.equal(normalizeWhatsappWaId('551130251234'), '551130251234');
  assert.equal(normalizeWhatsappWaId(''), '');
});

test('numero digitado: regra do Brasil, com + e fixo respeitados', () => {
  assert.equal(normalizeWhatsappNumber('(11) 99815-0000'), '5511998150000');
  assert.equal(normalizeWhatsappNumber('11 9815-0000'), '5511998150000', 'celular antigo com 10 digitos');
  assert.equal(normalizeWhatsappNumber('(11) 3025-1234'), '551130251234', 'fixo nao ganha 9');
  assert.equal(normalizeWhatsappNumber('+1 646 589 4000'), '16465894000');
  assert.equal(normalizeWhatsappNumber('16465894000'), '16465894000', 'sem 9 na terceira posicao nao e celular BR');
  assert.equal(normalizeWhatsappNumber('+55 11 3025-1234'), '551130251234');
});

test('cliente dos EUA recebe a resposta no proprio numero', async () => {
  enviosPara.length = 0;
  await handleWhatsAppWebhook({ payload: webhook('16465894000', 'wamid.eua_1', 'Cliente EUA'), tenantId: TENANT });

  const chats = await adapter.findDocuments('activeChats', { tenantId: TENANT, channelUserId: '16465894000' });
  assert.equal(chats.length, 1, 'conversa gravada com o numero como veio da Meta');
  assert.ok(enviosPara.length > 0, 'o bot respondeu');
  assert.ok(enviosPara.every((to) => to === '16465894000'), `resposta foi para: ${enviosPara.join(', ')}`);
  assert.equal((await adapter.findDocuments('activeChats', { tenantId: TENANT, channelUserId: '5516465894000' })).length, 0);
});

test('aviso da conta oficial da Meta nao abre conversa nem recebe resposta', async () => {
  enviosPara.length = 0;
  await handleWhatsAppWebhook({ payload: webhook('16465894168', 'wamid.meta_1', 'WhatsApp Business'), tenantId: TENANT });

  const chats = (await adapter.findDocuments('activeChats', { tenantId: TENANT }))
    .filter((c) => String(c.channelUserId).endsWith('6465894168'));
  assert.equal(chats.length, 0);
  assert.deepEqual(enviosPara, []);
});
