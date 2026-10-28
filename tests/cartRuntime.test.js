import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCartOperation } from '../src/services/cartRuntime.js';

const baseData = {
  operation: 'add',
  productIdVar: 'PEDIDO_ID',
  productNameVar: 'PEDIDO',
  quantityVar: 'QUANTIDADE',
  priceSource: 'map',
  priceMap: [
    { id: 'carne', name: 'Pastel de carne', unitPrice: 10, sku: 'PST_CARNE' },
    { id: 'agua', name: 'Agua', unitPrice: 4 }
  ]
};

test('cartNode clears every cart output', () => {
  const result = applyCartOperation({ CARRINHO_ITENS: [{ nome: 'Antigo' }], CARRINHO_TOTAL: 99 }, {
    ...baseData,
    operation: 'clear'
  });

  assert.deepEqual(result.CARRINHO_ITENS, []);
  assert.equal(result.CARRINHO_TOTAL, 0);
  assert.equal(result.CARRINHO_QUANTIDADE, 0);
  assert.equal(result.CARRINHO_RESUMO, '');
  assert.equal(result.CARRINHO_OK, true);
  assert.equal(result.CARRINHO_ERRO, null);
});

test('cartNode adds products and calculates totals', () => {
  const result = applyCartOperation({ PEDIDO_ID: 'carne', PEDIDO: 'Carne', QUANTIDADE: '2' }, baseData);

  assert.deepEqual(result.CARRINHO_ITENS, [{
    id: 'carne',
    nome: 'Pastel de carne',
    quantidade: 2,
    precoUnitario: 10,
    subtotal: 20,
    sku: 'PST_CARNE'
  }]);
  assert.equal(result.CARRINHO_TOTAL, 20);
  assert.equal(result.CARRINHO_QUANTIDADE, 2);
  assert.match(result.CARRINHO_RESUMO, /2x Pastel de carne/);
});

test('cartNode merges repeated products on later loop passes', () => {
  const first = applyCartOperation({ PEDIDO_ID: 'agua', PEDIDO: 'Agua', QUANTIDADE: 1 }, baseData);
  const second = applyCartOperation({ ...first, PEDIDO_ID: 'agua', PEDIDO: 'Agua', QUANTIDADE: 3 }, baseData);

  assert.equal(second.CARRINHO_ITENS.length, 1);
  assert.equal(second.CARRINHO_ITENS[0].quantidade, 4);
  assert.equal(second.CARRINHO_TOTAL, 16);
});

test('cartNode supports a unit price variable', () => {
  const result = applyCartOperation({ PEDIDO_ID: 'custom', PEDIDO: 'Produto customizado', QUANTIDADE: '2', PRECO: '12,50' }, {
    ...baseData,
    priceSource: 'variable',
    unitPriceVar: 'PRECO'
  });

  assert.equal(result.CARRINHO_TOTAL, 25);
  assert.equal(result.CARRINHO_ITENS[0].precoUnitario, 12.5);
});

test('cartNode reports invalid input without losing existing items', () => {
  const first = applyCartOperation({ PEDIDO_ID: 'agua', PEDIDO: 'Agua', QUANTIDADE: 1 }, baseData);
  const result = applyCartOperation({ ...first, PEDIDO_ID: 'inexistente', PEDIDO: 'Outro', QUANTIDADE: 1 }, baseData);

  assert.equal(result.CARRINHO_OK, false);
  assert.match(result.CARRINHO_ERRO, /Preco/);
  assert.deepEqual(result.CARRINHO_ITENS, first.CARRINHO_ITENS);
  assert.equal(result.CARRINHO_TOTAL, first.CARRINHO_TOTAL);
});
