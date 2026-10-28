import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Os templates de prospeccao tem botoes "Quero ver" e "Nao, obrigado". O toque
// chega da Meta como mensagem do tipo "button", nao "text". Este teste segue o
// dado do webhook ate o Turizmo: resposta salva, atribuida ao item da
// campanha, evento lead.replied na fila e classificacao certa sem IA.

const dbPath = path.join(os.tmpdir(), `template-button-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'template-button-test-only';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.TURIZMO_INTEGRATION_ENABLED = 'true';
process.env.TURIZMO_API_KEY = 'outbound-disabled-in-tests';
process.env.AI_CLASSIFICATION_ENABLED = 'true';
// Qualquer chamada de IA de verdade falharia no teste: o botao nao pode depender dela.
process.env.AI_PROVIDER = 'openai';
process.env.OPENAI_API_KEY = '';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { handleWhatsAppWebhook } = await import('../src/services/whatsappHandler.js');
const { classifyMessage } = await import('../src/services/aiClassification.js');

const T = 'tenant_botao';
const PHONE_ID = 'phone_botao';
const TEMPLATE_WAMID = 'wamid.template_enviado';

const toque = (from, id, texto) => ({
  payload: {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'waba_botao',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: PHONE_ID },
          contacts: [{ wa_id: from, profile: { name: 'Pet Shop Amor Animal' } }],
          messages: [{
            from,
            id,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'button',
            context: { from: '5511900000000', id: TEMPLATE_WAMID },
            button: { text: texto, payload: texto }
          }]
        }
      }]
    }]
  }
});

const semear = async (cliente) => {
  await adapter.insertOne('contacts', {
    id: `contact_${cliente}`, tenantId: T, name: 'Pet Shop Amor Animal', turizmoLeadId: `lead_${cliente}`,
    phones: [{ id: 'p1', number: cliente, normalizedNumber: cliente, channel: 'whatsapp', isPrimary: true }]
  });
  await adapter.insertOne('outreachCampaigns', { id: 'campaign_pet', tenantId: T, name: 'Pet shop - campanha teste', status: 'completed', turizmoCampaignId: 'tur_camp_pet' });
  await adapter.insertOne('outreachCampaignItems', {
    id: `item_${cliente}`, tenantId: T, campaignId: 'campaign_pet', contactId: `contact_${cliente}`, turizmoLeadId: `lead_${cliente}`,
    status: 'sent', phoneNumber: cliente, sentAt: new Date(Date.now() - 60000).toISOString(), outreachId: `outreach_${cliente}`
  });
  await adapter.insertOne('contactOutreachHistory', {
    id: `outreach_${cliente}`, tenantId: T, contactId: `contact_${cliente}`, campaignId: 'campaign_pet', campaignItemId: `item_${cliente}`,
    turizmoLeadId: `lead_${cliente}`, providerMessageId: TEMPLATE_WAMID, status: 'sent', createdAt: new Date(Date.now() - 60000).toISOString(), repliedAt: null
  });
};

before(async () => { await adapter.init(); });

beforeEach(async () => {
  for (const colecao of ['tenants', 'channelConfigs', 'contacts', 'activeChats', 'chatMessages', 'chatEvents', 'outreachCampaigns',
    'outreachCampaignItems', 'contactOutreachHistory', 'integrationOutbox', 'messageClassifications', 'contactSuppression', 'outreachMetricEvents']) {
    await adapter.deleteMany(colecao, {});
  }
  await adapter.insertOne('tenants', { id: T, name: 'Onion teste', plan: 'pro', status: 'active' });
  await adapter.insertOne('channelConfigs', { id: `channels_${T}`, tenantId: T, whatsapp: { enabled: true, accessToken: 'token', wabaId: 'waba_botao', phoneNumberId: PHONE_ID } });
});

after(async () => { await adapter.close?.(); fs.rmSync(dbPath, { force: true }); });

const eventos = async (tipo) => (await adapter.findMany('integrationOutbox', { query: { tenantId: T } }))
  .filter((evento) => (evento.eventType || evento.type) === tipo);

test('"Quero ver" vira resposta da campanha, vai ao Turizmo e e classificado como pedido de demo', async () => {
  const cliente = '5511999990101';
  await semear(cliente);

  await handleWhatsAppWebhook(toque(cliente, 'wamid.toque_quero', 'Quero ver'));

  const mensagem = await adapter.findOne('chatMessages', { tenantId: T, providerMessageId: 'wamid.toque_quero' });
  assert.ok(mensagem, 'o toque no botao foi salvo como mensagem');
  assert.equal(mensagem.text, 'Quero ver');
  assert.equal(mensagem.campaignItemId, `item_${cliente}`, 'atribuido ao item certo da campanha');

  const item = await adapter.findOne('outreachCampaignItems', { tenantId: T, id: `item_${cliente}` });
  assert.equal(item.status, 'replied');
  assert.ok(item.repliedAt);

  const [respondeu] = await eventos('lead.replied');
  assert.ok(respondeu, 'o Turizmo recebe lead.replied');
  assert.equal(respondeu.payload.data.turizmoLeadId, `lead_${cliente}`);
  assert.equal(respondeu.payload.data.campaignItemId, `item_${cliente}`);

  await classifyMessage({ tenantId: T, messageId: mensagem.messageId || mensagem.id });
  const classificacao = await adapter.findOne('messageClassifications', { tenantId: T, campaignItemId: `item_${cliente}` });
  assert.ok(classificacao, 'classificado');
  assert.equal(classificacao.intent, 'pediu_demo');
  assert.equal(classificacao.provider, 'quick_reply', 'sem IA: o botao tem significado fixo');
  assert.ok(classificacao.confidence >= 0.8, 'confianca suficiente para o Turizmo seguir sozinho');

  const [classificado] = await eventos('lead.classified');
  assert.ok(classificado, 'o Turizmo recebe lead.classified');
  assert.equal(classificado.payload.data.intent, 'pediu_demo');
});

test('"Não, obrigado" encerra a cadencia sem descadastrar o numero', async () => {
  const cliente = '5511999990202';
  await semear(cliente);

  await handleWhatsAppWebhook(toque(cliente, 'wamid.toque_nao', 'Não, obrigado'));
  const mensagem = await adapter.findOne('chatMessages', { tenantId: T, providerMessageId: 'wamid.toque_nao' });
  assert.equal(mensagem.campaignItemId, `item_${cliente}`);

  await classifyMessage({ tenantId: T, messageId: mensagem.messageId || mensagem.id });
  const classificacao = await adapter.findOne('messageClassifications', { tenantId: T, campaignItemId: `item_${cliente}` });
  assert.equal(classificacao.intent, 'negativo');
  assert.equal(classificacao.nextAction, 'stop_cadence');
  assert.equal(classificacao.optOutDetected, false);
  assert.equal((await adapter.findMany('contactSuppression', { query: { tenantId: T } })).length, 0,
    'recusar a oferta nao e pedir bloqueio: o numero nao entra na lista de supressao');
});
