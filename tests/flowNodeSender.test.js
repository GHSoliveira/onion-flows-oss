import test from 'node:test';
import assert from 'node:assert/strict';

// Remetente fixado em no de fluxo copiado de outro tenant: no envio cai no
// remetente da conversa, e na importacao do fluxo o id estranho sai do no.

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JWT_SECRET = 'flow-node-sender-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { resolveFlowNodeWhatsAppSender } = await import('../src/services/channelConfig.js');
const { clearForeignSenders, remapInteractiveRefs } = await import('../client/src/utils/flowImport.js');

const config = {
  enabled: true,
  accessToken: 'tok',
  phoneNumberId: '1110001110',
  senderNumbers: [
    { phoneNumberId: '1110001110', label: 'Principal', enabled: true, isDefault: true },
    { phoneNumberId: '2220002220', label: 'Delivery', enabled: true },
    { phoneNumberId: '3330003330', label: 'Antigo', enabled: false }
  ]
};

test('envio: remetente de outro tenant cai no remetente da conversa e avisa o id ignorado', () => {
  const r = resolveFlowNodeWhatsAppSender(config, '9990009990', '2220002220');
  assert.equal(r.sender?.phoneNumberId, '2220002220');
  assert.equal(r.ignoredSenderId, '9990009990');
});

test('envio: remetente de outro tenant sem conversa vinculada usa o padrao', () => {
  const r = resolveFlowNodeWhatsAppSender(config, '9990009990', null);
  assert.equal(r.sender?.phoneNumberId, '1110001110');
});

test('envio: remetente do proprio tenant e respeitado', () => {
  const r = resolveFlowNodeWhatsAppSender(config, '2220002220', '1110001110');
  assert.equal(r.sender?.phoneNumberId, '2220002220');
  assert.equal(r.ignoredSenderId, null);
});

test('envio: remetente do proprio tenant desativado continua sem envio', () => {
  const r = resolveFlowNodeWhatsAppSender(config, '3330003330', '1110001110');
  assert.equal(r.sender, null);
  assert.equal(r.ignoredSenderId, null);
});

test('envio: no sem remetente segue a conversa; sem canal nao inventa remetente', () => {
  assert.equal(resolveFlowNodeWhatsAppSender(config, '', '2220002220').sender?.phoneNumberId, '2220002220');
  assert.equal(resolveFlowNodeWhatsAppSender(config, null, null).sender?.phoneNumberId, '1110001110');
  assert.deepEqual(resolveFlowNodeWhatsAppSender(null, '9990009990', null), { sender: null, ignoredSenderId: null });
});

const no = (id, data) => ({ id, type: 'whatsappTemplateNode', data });

test('importar fluxo: tira remetente que nao e do tenant e mantem o que e', () => {
  const nodes = [
    no('a', { senderPhoneNumberId: '9990009990', interactiveTemplateId: 'x' }),
    no('b', { senderPhoneNumberId: '2220002220' }),
    no('c', { text: 'sem remetente' }),
    { id: 'd', type: 'startNode' }
  ];
  const out = clearForeignSenders(nodes, ['1110001110', '2220002220', null]);
  assert.equal(out[0].data.senderPhoneNumberId, '');
  assert.equal(out[0].data.interactiveTemplateId, 'x', 'resto do no intacto');
  assert.equal(out[1].data.senderPhoneNumberId, '2220002220');
  assert.equal(out[2], nodes[2]);
  assert.equal(out[3], nodes[3]);
  assert.equal(nodes[0].data.senderPhoneNumberId, '9990009990', 'nao altera o original');
});

test('importar fluxo: tenant sem WhatsApp tira todo remetente fixado', () => {
  const out = clearForeignSenders([no('a', { senderPhoneNumberId: '2220002220' })], []);
  assert.equal(out[0].data.senderPhoneNumberId, '');
});

test('importar fluxo: interactive de origem vira o id local; referencia local fica', () => {
  const items = [
    { id: 'local_novo', importedFrom: { id: 'origem_1' } },
    { id: 'local_proprio' }
  ];
  const out = remapInteractiveRefs([
    no('a', { interactiveTemplateId: 'origem_1' }),
    no('b', { interactiveTemplateId: 'local_proprio' }),
    no('c', { interactiveTemplateId: 'sumiu' })
  ], items);
  assert.deepEqual(out.map((node) => node.data.interactiveTemplateId), ['local_novo', 'local_proprio', 'sumiu']);
});
