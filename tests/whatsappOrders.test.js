import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOrderCart, extractWhatsAppOrder } from '../src/services/whatsappOrders.js';

const pedidoCru = (items, extra = {}) => ({
  catalog_id: '100000000000003',
  text: 'Entregar depois das 18h',
  product_items: items,
  ...extra
});

test('pedido sem itens aproveitaveis nao vira mensagem', () => {
  assert.equal(extractWhatsAppOrder(null), null);
  assert.equal(extractWhatsAppOrder({ product_items: [] }), null);
  assert.equal(extractWhatsAppOrder({ product_items: [{ product_retailer_id: '', quantity: 1 }] }), null);
  assert.equal(extractWhatsAppOrder({ product_items: [{ product_retailer_id: 'SKU1', quantity: 0 }] }), null);
});

test('le quantidade e preco em texto e guarda o valor cru', () => {
  const pedido = extractWhatsAppOrder(pedidoCru([
    { product_retailer_id: 'SKU1', quantity: '2', item_price: '29.90', currency: 'brl' }
  ]));
  assert.equal(pedido.catalogId, '100000000000003');
  assert.equal(pedido.observacao, 'Entregar depois das 18h');
  assert.deepEqual(pedido.itens[0], {
    retailerId: 'SKU1',
    quantidade: 2,
    precoUnitario: 29.9,
    precoInformado: '29.90',
    moeda: 'BRL'
  });
});

test('resolve nome pelo retailer_id da sincronizacao e grava no formato do cartNode', () => {
  const pedido = extractWhatsAppOrder(pedidoCru([
    { product_retailer_id: 'CAMISETA_P', quantity: 2, item_price: 29.9, currency: 'BRL' },
    { product_retailer_id: 'BONE', quantity: 1, item_price: 45, currency: 'BRL' }
  ]));
  const catalogo = [
    { id: 'item_1', name: 'Camiseta P', metaProductRetailerId: 'CAMISETA_P', price: 29.9 },
    { id: 'item_2', name: 'Boné', sku: 'BONE', price: 45 }
  ];

  const carrinho = buildOrderCart(pedido, catalogo);

  assert.equal(carrinho.vars.CARRINHO_TOTAL, 104.8);
  assert.equal(carrinho.vars.CARRINHO_QUANTIDADE, 3);
  assert.equal(carrinho.vars.CARRINHO_OK, true);
  assert.equal(carrinho.vars.CARRINHO_ERRO, null);
  assert.equal(carrinho.vars.CARRINHO_ORIGEM, 'whatsapp_catalogo');
  assert.deepEqual(carrinho.vars.CARRINHO_ITENS.map((item) => item.nome), ['Camiseta P', 'Boné']);
  assert.equal(carrinho.vars.CARRINHO_ITENS[0].id, 'item_1');
  assert.ok(carrinho.texto.startsWith('Pedido pelo catálogo do WhatsApp:'));
  assert.ok(carrinho.texto.includes('Camiseta P'));
  assert.ok(carrinho.texto.includes('Observação: Entregar depois das 18h'));
  assert.equal(carrinho.meta.whatsappOrder.itens[1].catalogItemId, 'item_2');
});

test('retailer_id oficial tem prioridade sobre sku de outro item', () => {
  const pedido = extractWhatsAppOrder(pedidoCru([
    { product_retailer_id: 'ABC', quantity: 1, item_price: 10, currency: 'BRL' }
  ]));
  const catalogo = [
    { id: 'errado', name: 'Produto errado', sku: 'ABC', price: 10 },
    { id: 'certo', name: 'Produto certo', metaProductRetailerId: 'ABC', price: 10 }
  ];
  assert.equal(buildOrderCart(pedido, catalogo).vars.CARRINHO_ITENS[0].nome, 'Produto certo');
});

test('produto fora do catalogo interno usa o retailer_id como nome', () => {
  const pedido = extractWhatsAppOrder(pedidoCru([
    { product_retailer_id: 'CRIADO_NO_COMMERCE', quantity: 1, item_price: 12, currency: 'BRL' }
  ]));
  const carrinho = buildOrderCart(pedido, []);
  assert.equal(carrinho.vars.CARRINHO_ITENS[0].nome, 'CRIADO_NO_COMMERCE');
  assert.equal(carrinho.vars.CARRINHO_TOTAL, 12);
});

test('item sem preco usa o preco do catalogo interno', () => {
  const pedido = extractWhatsAppOrder(pedidoCru([
    { product_retailer_id: 'SKU1', quantity: 3 }
  ]));
  const carrinho = buildOrderCart(pedido, [{ id: 'i1', name: 'Caneca', sku: 'SKU1', price: 20 }]);
  assert.equal(carrinho.vars.CARRINHO_TOTAL, 60);
  assert.equal(carrinho.vars.CARRINHO_OK, true);
});

test('item sem preco em lugar nenhum sai do total mas continua visivel', () => {
  const pedido = extractWhatsAppOrder(pedidoCru([
    { product_retailer_id: 'COM_PRECO', quantity: 1, item_price: 10, currency: 'BRL' },
    { product_retailer_id: 'SEM_PRECO', quantity: 2 }
  ]));
  const carrinho = buildOrderCart(pedido, []);
  assert.equal(carrinho.vars.CARRINHO_TOTAL, 10);
  assert.equal(carrinho.vars.CARRINHO_OK, false);
  assert.match(carrinho.vars.CARRINHO_ERRO, /SEM_PRECO/);
  assert.ok(carrinho.texto.includes('Sem preço informado: 2x SEM_PRECO'));
  assert.equal(carrinho.meta.whatsappOrder.itens.length, 2);
});
