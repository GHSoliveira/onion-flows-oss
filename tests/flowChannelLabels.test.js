import test from 'node:test';
import assert from 'node:assert/strict';
import { flowChannelLabels } from '../client/src/services/flowChannelLabels.js';
test('flow labels list configured named channels and do not duplicate legacy platform', () => {
  const labels = flowChannelLabels({ entries: [{ platform: 'whatsapp', name: 'Principal', flowId: 'f1' }, { platform: 'web', name: 'Site', flowId: 'f1' }, { platform: 'telegram', name: 'Suporte', flowId: 'f2', enabled: false }], whatsapp: { flowId: 'old' } });
  assert.deepEqual(labels.get('f1'), ['Principal', 'Site']);
  assert.deepEqual(labels.get('f2'), ['Suporte (desativado)']);
  assert.equal(labels.has('old'), false);
  assert.equal(labels.has('unrouted'), false);
});
test('legacy senders inherit default flow unless overridden and disabled routes are marked', () => {
  const labels = flowChannelLabels({ whatsapp: { flowId: 'default', enabled: true, senderNumbers: [{ label: 'Loja' }, { label: 'Entrega', flowId: 'delivery', enabled: false }] }, telegram: { flowId: 'default' } });
  assert.deepEqual(labels.get('default'), ['Loja', 'Bot Telegram']);
  assert.deepEqual(labels.get('delivery'), ['Entrega (desativado)']);
  assert.equal(flowChannelLabels({}).size, 0);
  assert.deepEqual(flowChannelLabels({whatsapp:{flowId:'default'}}).get('default'), ['Canal principal (WhatsApp)']);
});
