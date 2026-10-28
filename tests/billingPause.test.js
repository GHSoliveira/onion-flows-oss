import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Conta pausada por cobranca: a mensagem do cliente e gravada e o bot nao
// responde; campanha para. Ao regularizar, o bot volta e a campanha retoma.

const dbPath = path.join(os.tmpdir(), `billing-pause-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'billing-pause-test-only';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';
process.env.OUTREACH_SEND_JITTER_MIN_MS = '0';
process.env.OUTREACH_SEND_JITTER_MAX_MS = '0';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { handleWhatsAppWebhook } = await import('../src/services/whatsappHandler.js');
const { getChatMessages } = await import('../src/services/chatMessages.js');
const { processNextOutreachCampaign } = await import('../src/services/outreachCampaignWorker.js');
const { applyBillingBlock } = await import('../src/services/billingGuard.js');
const { invalidateTenantCache } = await import('../src/services/tenantLimits.js');

const T = 'tenant_pausado';
const CLIENTE = '5511977776666';

const webhook = (id, text) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba_pausa',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '5511900000000', phone_number_id: 'sender_pausa' },
        contacts: [{ wa_id: CLIENTE, profile: { name: 'Cliente' } }],
        messages: [{ from: CLIENTE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }]
      }
    }]
  }]
});

const bloquear = async (valor) => {
  await applyBillingBlock(T, valor, valor ? 'partner_overdue' : undefined);
  invalidateTenantCache();
};

before(async () => {
  await adapter.init();
  await adapter.insertOne('tenants', { id: T, name: 'Pausado', status: 'active', partnerId: 'partner_atrasado', billing: {} });
  await adapter.insertOne('channelConfigs', { id: `channels_${T}`, tenantId: T, whatsapp: { enabled: true, accessToken: 'token', phoneNumberId: 'sender_pausa', flowId: 'flow_oi' } });
  await adapter.insertOne('flows', {
    id: 'flow_oi', tenantId: T, name: 'Oi', status: 'published',
    published: {
      nodes: [
        { id: 'start', type: 'startNode', data: {} },
        { id: 'oi', type: 'messageNode', data: { text: 'Olá! Sou o assistente.' } },
        { id: 'fim', type: 'finalNode', data: { text: 'Até mais.' } }
      ],
      edges: [{ id: 'e1', source: 'start', target: 'oi' }, { id: 'e2', source: 'oi', target: 'fim' }]
    }
  });
});

after(async () => {
  await adapter.close?.();
  fs.rmSync(dbPath, { force: true });
});

test('pausada: a mensagem fica gravada, o bot nao responde e a conversa e marcada', async () => {
  await bloquear(true);
  await handleWhatsAppWebhook({ payload: webhook('wamid.pausa1', 'Oi, tem horário?'), tenantId: T });

  const [chat] = await adapter.findDocuments('activeChats', { tenantId: T });
  assert.ok(chat, 'a conversa existe');
  assert.ok(chat.billingPausedAt, 'marcada como recebida durante a pausa');
  const mensagens = await getChatMessages(chat.id);
  assert.deepEqual(mensagens.map((m) => m.sender), ['user']);
  assert.equal(mensagens[0].text, 'Oi, tem horário?');
});

test('regularizada: a proxima mensagem ja tem resposta do bot', async () => {
  await bloquear(false);
  await handleWhatsAppWebhook({ payload: webhook('wamid.pausa2', 'Oi de novo'), tenantId: T });

  const [chat] = await adapter.findDocuments('activeChats', { tenantId: T });
  const mensagens = await getChatMessages(chat.id);
  assert.equal(mensagens.filter((m) => m.sender === 'user').length, 2, 'nenhuma mensagem se perdeu');
  assert.ok(mensagens.some((m) => m.sender === 'bot' && /assistente/.test(m.text)), 'o bot voltou a responder');
});

test('campanha para durante a pausa e volta sozinha ao regularizar', async () => {
  await adapter.insertOne('outreachCampaigns', {
    id: 'camp_pausa', tenantId: T, name: 'Promo', channel: 'whatsapp', templateId: 'tpl', senderPhoneNumberId: 'sender_pausa',
    values: {}, cadenceId: null, status: 'pending', totalContacts: 1, pendingCount: 1, successCount: 0, failedCount: 0,
    createdAt: new Date(Date.now() - 1000).toISOString(), updatedAt: new Date().toISOString()
  });
  await adapter.insertOne('outreachCampaignItems', {
    id: 'camp_pausa_item', tenantId: T, campaignId: 'camp_pausa', contactId: 'c1', sortIndex: 0, contactName: 'Loja',
    phoneEntryId: null, phoneNumber: '5511900000009', templateId: 'tpl', status: 'pending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  await bloquear(true);

  const resultado = await processNextOutreachCampaign();
  assert.equal(resultado?.reason, 'billing_blocked');
  const pausada = await adapter.findOne('outreachCampaigns', { id: 'camp_pausa' });
  assert.equal(pausada.status, 'paused');
  assert.ok(pausada.billingPause?.pausedAt);
  assert.equal((await adapter.findOne('outreachCampaignItems', { id: 'camp_pausa_item' })).status, 'pending', 'nenhum envio saiu');

  // Pausa manual de outra campanha nao e mexida na retomada.
  await adapter.insertOne('outreachCampaigns', { id: 'camp_manual', tenantId: T, name: 'Manual', status: 'paused', cadenceId: null, createdAt: new Date().toISOString() });

  await bloquear(false);
  const retomada = await adapter.findOne('outreachCampaigns', { id: 'camp_pausa' });
  assert.equal(retomada.status, 'pending');
  assert.equal(retomada.billingPause, null);
  assert.equal((await adapter.findOne('outreachCampaigns', { id: 'camp_manual' })).status, 'paused');
});
