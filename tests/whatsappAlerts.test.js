import test from 'node:test';
import assert from 'node:assert/strict';

test('traduz catalog_id invalido como catalogo nao vinculado ao WABA', async () => {
  process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters';
  const { buildWhatsAppAlert } = await import('../src/services/whatsappAlerts.js');
  const alert = buildWhatsAppAlert({
    operation: 'interactive_send',
    tenantId: 'tenant_test',
    data: {
      error: {
        code: 131009,
        message: '(#131009) Parameter value is not valid',
        error_data: { details: 'Invalid catalog_id.' }
      }
    }
  });

  assert.equal(alert.title, 'Catalogo nao vinculado ao WhatsApp');
  assert.match(alert.message, /nao esta vinculado/i);
});

test('traduz produto ainda nao indexado no catalogo WhatsApp', async () => {
  process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters';
  const { buildWhatsAppAlert } = await import('../src/services/whatsappAlerts.js');
  const alert = buildWhatsAppAlert({
    operation: 'interactive_send',
    data: {
      error: {
        code: 131009,
        message: '(#131009) Parameter value is not valid',
        error_data: {
          details: 'product not found for product_retailer_id, espeto_carne, in catalog_id, 123'
        }
      }
    }
  });

  assert.equal(alert.title, 'Produto ainda indisponivel no WhatsApp');
  assert.match(alert.message, /ainda nao foi indexado/i);
});
