import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Caminho completo do pedido: webhook da Meta -> parser -> chat -> carrinho.
// Antes da correcao, `type: "order"` caia no return do parser e sumia sem aviso.

const dbPath = path.join(os.tmpdir(), `onion-whatsapp-order-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'whatsapp-order-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { handleWhatsAppWebhook } = await import('../src/services/whatsappHandler.js');
const { getChatById } = await import('../src/services/flowRunner.js');
const { getChatMessages } = await import('../src/services/chatMessages.js');

const CLIENTE = '5511988887777';

const canal = (tenantId, phoneNumberId) => ({
  id: `channels_${tenantId}`,
  tenantId,
  whatsapp: { enabled: true, accessToken: 'test-access-token', phoneNumberId }
});

const webhook = (phoneNumberId, message) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba_test',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '5511900000000', phone_number_id: phoneNumberId },
        contacts: [{ wa_id: CLIENTE, profile: { name: 'Cliente Teste' } }],
        messages: [{ from: CLIENTE, timestamp: String(Math.floor(Date.now() / 1000)), ...message }]
      }
    }]
  }]
});

const pedido = (id) => ({
  id,
  type: 'order',
  order: {
    catalog_id: 'catalog_test',
    text: 'Pode entregar amanhã',
    product_items: [
      { product_retailer_id: 'CAMISETA_P', quantity: '2', item_price: '29.90', currency: 'BRL' },
      { product_retailer_id: 'SEM_CADASTRO', quantity: 1, item_price: 5, currency: 'BRL' }
    ]
  }
});

const unicoChat = async (tenantId) => {
  const chats = await adapter.findDocuments('activeChats', { tenantId });
  assert.equal(chats.length, 1, `esperava um chat em ${tenantId}`);
  return chats[0];
};

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();

  // tenant_pedido: sem fluxo, isola a gravacao do pedido.
  await adapter.insertOne('tenants', { id: 'tenant_pedido', name: 'Tenant Pedido', status: 'active' });
  await adapter.insertOne('channelConfigs', canal('tenant_pedido', 'sender_pedido'));
  await adapter.insertOne('catalogItems', {
    id: 'item_camiseta',
    tenantId: 'tenant_pedido',
    name: 'Camiseta P',
    metaProductRetailerId: 'CAMISETA_P',
    price: 29.9,
    active: true
  });

  // tenant_menu: fluxo publicado que para num menu, para provar o desvio.
  await adapter.insertOne('tenants', { id: 'tenant_menu', name: 'Tenant Menu', status: 'active' });
  await adapter.insertOne('channelConfigs', canal('tenant_menu', 'sender_menu'));
  await adapter.insertOne('flows', {
    id: 'flow_menu',
    tenantId: 'tenant_menu',
    name: 'Menu',
    status: 'published',
    published: {
      nodes: [
        { id: 'start', type: 'startNode', data: {} },
        {
          id: 'menu',
          type: 'menuNode',
          data: {
            text: 'Escolha:\n1 - Comprar\n2 - Falar com alguém',
            options: [{ id: '1', label: 'Comprar' }, { id: '2', label: 'Falar' }],
            invalidSelectionMessage: 'Selecione uma opção válida.'
          }
        },
        { id: 'child_menu_1', type: 'caseNode', data: { label: 'Comprar' } },
        { id: 'child_menu_2', type: 'caseNode', data: { label: 'Falar' } },
        { id: 'fim_1', type: 'messageNode', data: { text: 'Opção 1' } },
        { id: 'fim_2', type: 'messageNode', data: { text: 'Opção 2' } }
      ],
      edges: [
        { id: 'e_start', source: 'start', target: 'menu' },
        { id: 'e_menu_1', source: 'menu', target: 'child_menu_1', sourceHandle: '1' },
        { id: 'e_menu_2', source: 'menu', target: 'child_menu_2', sourceHandle: '2' },
        { id: 'e_case_1', source: 'child_menu_1', target: 'fim_1' },
        { id: 'e_case_2', source: 'child_menu_2', target: 'fim_2' }
      ]
    }
  });
});

after(() => {
  try { fs.unlinkSync(dbPath); } catch {}
});

test('pedido do carrinho vira mensagem no chat com itens e variaveis do carrinho', async () => {
  const resultado = await handleWhatsAppWebhook({
    payload: webhook('sender_pedido', pedido('wamid.pedido_1')),
    tenantId: 'tenant_pedido'
  });
  assert.equal(resultado.processed, 1);

  const chat = await unicoChat('tenant_pedido');
  const doCliente = (await getChatMessages(chat.id)).filter((m) => m.sender === 'user');
  assert.equal(doCliente.length, 1);

  const mensagem = doCliente[0];
  assert.ok(mensagem.text.startsWith('Pedido pelo catálogo do WhatsApp:'));
  assert.ok(mensagem.text.includes('Camiseta P'));
  assert.ok(mensagem.text.includes('Observação: Pode entregar amanhã'));
  assert.equal(mensagem.providerMessageId, 'wamid.pedido_1');
  assert.equal(mensagem.meta.whatsappOrder.itens.length, 2);
  assert.equal(mensagem.meta.whatsappOrder.itens[0].catalogItemId, 'item_camiseta');

  const atualizado = await getChatById(chat.id);
  assert.equal(atualizado.vars.CARRINHO_TOTAL, 64.8);
  assert.equal(atualizado.vars.CARRINHO_QUANTIDADE, 3);
  assert.equal(atualizado.vars.CARRINHO_OK, true);
  assert.equal(atualizado.vars.CARRINHO_ORIGEM, 'whatsapp_catalogo');
  assert.deepEqual(atualizado.vars.CARRINHO_ITENS.map((item) => item.nome), ['Camiseta P', 'SEM_CADASTRO']);
});

test('o mesmo pedido reentregue pela Meta nao aparece duas vezes', async () => {
  await handleWhatsAppWebhook({
    payload: webhook('sender_pedido', pedido('wamid.pedido_1')),
    tenantId: 'tenant_pedido'
  });

  const chat = await unicoChat('tenant_pedido');
  const doCliente = (await getChatMessages(chat.id)).filter((m) => m.sender === 'user');
  assert.equal(doCliente.length, 1);
});

test('pedido nao e tratado como resposta ao menu em que o fluxo esta parado', async () => {
  await handleWhatsAppWebhook({
    payload: webhook('sender_menu', { id: 'wamid.oi', type: 'text', text: { body: 'oi' } }),
    tenantId: 'tenant_menu'
  });

  const chat = await unicoChat('tenant_menu');
  assert.equal((await getChatById(chat.id)).currentNodeId, 'menu', 'o fluxo precisa estar parado no menu');

  await handleWhatsAppWebhook({
    payload: webhook('sender_menu', pedido('wamid.pedido_menu')),
    tenantId: 'tenant_menu'
  });

  const depois = await getChatById(chat.id);
  assert.equal(depois.currentNodeId, 'menu', 'o fluxo continua no menu');

  const mensagens = await getChatMessages(chat.id);
  assert.ok(
    !mensagens.some((m) => m.sender === 'bot' && /opção válida/i.test(m.text)),
    'o bot nao pode responder opcao invalida para um pedido'
  );
  assert.equal(mensagens.at(-1).sender, 'user');
  assert.ok(mensagens.at(-1).text.startsWith('Pedido pelo catálogo do WhatsApp:'));
  assert.equal(depois.vars.CARRINHO_ORIGEM, 'whatsapp_catalogo');
});

test('a conversa guarda o fluxo que a atendeu (painel e relatorios)', async () => {
  const chat = await getChatById((await unicoChat('tenant_menu')).id);
  assert.equal(chat.flowId, 'flow_menu');
  assert.equal(chat.flowName, 'Menu');
});
