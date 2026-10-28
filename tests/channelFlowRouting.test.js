import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getWhatsAppMissingConfigurationFields,
  resolveWhatsAppFlowId
} from '../src/services/channelConfig.js';

test('roteamento operacional do phoneNumberId prevalece sobre configuracao legada', () => {
  const flowId = resolveWhatsAppFlowId({
    flowId: 'flow_legacy',
    senderNumbers: [{ phoneNumberId: '111', flowId: 'flow_sender', enabled: true }],
    routingEntries: [{
      id: 'channel_primary',
      platform: 'whatsapp',
      phoneNumberId: '111',
      senderPhoneNumberIds: ['111'],
      flowId: 'flow_operational',
      enabled: true
    }]
  }, '111');

  assert.equal(flowId, 'flow_operational');
});

test('entrada operacional unica sem identidade preserva compatibilidade', () => {
  const flowId = resolveWhatsAppFlowId({
    flowId: 'flow_legacy',
    senderNumbers: [{ phoneNumberId: '111', flowId: null, enabled: true }],
    routingEntries: [{
      id: 'channel_old',
      platform: 'whatsapp',
      flowId: 'flow_operational',
      enabled: true
    }]
  }, '111');

  assert.equal(flowId, 'flow_operational');
});

test('entrada WhatsApp normalizada continua resolvendo apos leitura da configuracao', () => {
  const flowId = resolveWhatsAppFlowId({
    flowId: null,
    senderNumbers: [{ phoneNumberId: '111', flowId: null, enabled: true }],
    routingEntries: [{
      id: 'channel_normalized',
      phoneNumberId: null,
      senderPhoneNumberIds: [],
      flowId: 'flow_operational',
      enabled: true,
      status: 'active'
    }]
  }, '111');

  assert.equal(flowId, 'flow_operational');
});

test('entradas operacionais ambiguas usam roteamento legado do remetente', () => {
  const flowId = resolveWhatsAppFlowId({
    flowId: 'flow_global',
    senderNumbers: [{ phoneNumberId: '111', flowId: 'flow_sender', enabled: true }],
    routingEntries: [
      { id: 'channel_a', platform: 'whatsapp', flowId: 'flow_a', enabled: true },
      { id: 'channel_b', platform: 'whatsapp', flowId: 'flow_b', enabled: true }
    ]
  }, '111');

  assert.equal(flowId, 'flow_sender');
});

test('monitoramento aceita flowId definido somente no roteamento operacional', () => {
  const missing = getWhatsAppMissingConfigurationFields({
    whatsapp: {
      enabled: true,
      accessToken: 'encrypted-token',
      phoneNumberId: '111',
      senderNumbers: [{ phoneNumberId: '111', flowId: null, enabled: true }],
      flowId: null,
      webhookVerifyToken: 'encrypted-verify-token'
    },
    entries: [{
      id: 'channel_primary',
      platform: 'whatsapp',
      phoneNumberId: '111',
      senderPhoneNumberIds: ['111'],
      flowId: 'flow_operational',
      enabled: true,
      status: 'active'
    }]
  });

  assert.deepEqual(missing, []);
});

test('monitoramento ainda informa flowId quando nenhum roteamento existe', () => {
  const missing = getWhatsAppMissingConfigurationFields({
    whatsapp: {
      enabled: true,
      accessToken: 'encrypted-token',
      phoneNumberId: '111',
      senderNumbers: [{ phoneNumberId: '111', flowId: null, enabled: true }],
      flowId: null,
      webhookVerifyToken: 'encrypted-verify-token'
    },
    entries: []
  });

  assert.deepEqual(missing, ['flowId']);
});
