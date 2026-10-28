import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetaProductPayload } from '../src/services/metaCatalog.js';

const baseItem = {
  id: 'catalog_1',
  name: 'Produto de teste',
  description: 'Descricao do produto',
  sku: 'SKU Cafe 01',
  mediaUrl: 'https://cdn.example.com/produto.jpg',
  productUrl: 'https://example.com/produtos/1',
  price: 19.9,
  active: true
};

test('meta catalog converte produto interno para payload idempotente da Graph API', () => {
  const payload = buildMetaProductPayload(baseItem, { currency: 'BRL', defaultBrand: 'Onion Store' });

  assert.equal(payload.retailer_id, 'SKU_Cafe_01');
  assert.equal(payload.price, 1990);
  assert.equal(payload.currency, 'BRL');
  assert.equal(payload.brand, 'Onion Store');
  assert.equal(payload.availability, 'in stock');
  assert.equal(payload.allow_upsert, true);
});

test('meta catalog marca item inativo como indisponivel', () => {
  const payload = buildMetaProductPayload({ ...baseItem, active: false }, { currency: 'BRL' });
  assert.equal(payload.availability, 'out of stock');
});

test('meta catalog permite produto sem pagina externa', () => {
  const payload = buildMetaProductPayload({
    ...baseItem,
    sku: 'ITEM-SEM-LINK',
    productUrl: ''
  }, { currency: 'BRL' });

  assert.equal(payload.url, undefined);
  assert.equal(payload.retailer_id, 'ITEM-SEM-LINK');
});

test('meta catalog rejeita midia ou pagina sem HTTPS publico', () => {
  assert.throws(
    () => buildMetaProductPayload({ ...baseItem, mediaUrl: '/uploads/produto.jpg' }, { currency: 'BRL' }),
    /URL da imagem precisa ser uma URL publica completa/
  );
  assert.throws(
    () => buildMetaProductPayload({ ...baseItem, productUrl: 'http://example.com/produto' }, { currency: 'BRL' }),
    /URL publica do produto precisa usar HTTPS/
  );
});
