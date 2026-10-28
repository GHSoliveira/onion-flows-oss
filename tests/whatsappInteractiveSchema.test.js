import test from 'node:test';
import assert from 'node:assert/strict';
import { whatsappInteractiveTemplateSchema } from '../src/schemas/index.js';

const baseList = {
  name: 'menu_cardapio',
  kind: 'list',
  bodyText: 'Selecione uma opcao',
  actionTitle: 'Menu',
  buttons: [],
  productSections: []
};

test('lista com uma secao permite titulo vazio', () => {
  const result = whatsappInteractiveTemplateSchema.safeParse({
    ...baseList,
    sections: [{ title: '', rows: [{ id: 'carne', title: 'Carne' }] }]
  });

  assert.equal(result.success, true);
});

test('lista com varias secoes exige titulo em todas elas', () => {
  const result = whatsappInteractiveTemplateSchema.safeParse({
    ...baseList,
    sections: [
      { title: '', rows: [{ id: 'carne', title: 'Carne' }] },
      { title: 'Bebidas', rows: [{ id: 'agua', title: 'Agua' }] }
    ]
  });

  assert.equal(result.success, false);
  assert.match(result.error.issues[0].message, /precisa de titulo/);
});

test('lista com varias secoes e titulos validos e aceita', () => {
  const result = whatsappInteractiveTemplateSchema.safeParse({
    ...baseList,
    sections: [
      { title: 'Pasteis', rows: [{ id: 'carne', title: 'Carne' }] },
      { title: 'Bebidas', rows: [{ id: 'agua', title: 'Agua' }] }
    ]
  });

  assert.equal(result.success, true);
});

test('lista preserva SKU e preco internos usados pelo carrinho', () => {
  const result = whatsappInteractiveTemplateSchema.safeParse({
    ...baseList,
    sections: [{
      title: '',
      rows: [{ id: 'carne', title: 'Carne', sku: 'ESP_CARNE', unitPrice: '10.50' }]
    }]
  });

  assert.equal(result.success, true);
  assert.equal(result.data.sections[0].rows[0].sku, 'ESP_CARNE');
  assert.equal(result.data.sections[0].rows[0].unitPrice, 10.5);
});
