import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeChatState } from '../src/services/chatStateGuard.js';

test('sanitizeChatState limpa runtime invalido em chat humano aberto', () => {
  const input = {
    id: 'chat_1',
    status: 'open',
    agentId: 'agent_1',
    activeOutreach: false,
    currentNodeId: 'input_1',
    currentNodeEnteredAt: '2026-03-15T10:00:00.000Z',
    delayNodeId: 'delay_1',
    delayNextNodeId: 'message_2',
    delayUntil: '2026-03-15T10:05:00.000Z',
    waitingSince: '2026-03-15T09:59:00.000Z',
    messages: [],
    vars: {}
  };

  const result = sanitizeChatState(input);

  assert.equal(result.changed, true);
  assert.equal(result.chat.currentNodeId, null);
  assert.equal(result.chat.currentNodeEnteredAt, null);
  assert.equal(result.chat.delayNodeId, null);
  assert.equal(result.chat.delayNextNodeId, null);
  assert.equal(result.chat.delayUntil, null);
  assert.equal(result.chat.waitingSince, null);
});

test('sanitizeChatState corrige bot com vinculo de agente e outreach pendente', () => {
  const input = {
    id: 'chat_2',
    status: 'bot',
    agentId: 'agent_1',
    agentName: 'Agente',
    activeOutreach: true,
    outreachPendingReply: true,
    messages: [],
    vars: {}
  };

  const result = sanitizeChatState(input);

  assert.equal(result.chat.agentId, null);
  assert.equal(result.chat.agentName, null);
  assert.equal(result.chat.activeOutreach, false);
  assert.equal(result.chat.outreachPendingReply, false);
});

test('sanitizeChatState preenche fila ATIVO para outreach ativo e deduplica ids processados', () => {
  const input = {
    id: 'chat_3',
    status: 'open',
    activeOutreach: true,
    outreachPendingReply: true,
    processedMessageIds: ['abc', 'abc', '', 'def'],
    messages: [],
    vars: {}
  };

  const result = sanitizeChatState(input);

  assert.equal(result.chat.queue, 'ATIVO');
  assert.deepEqual(result.chat.processedMessageIds, ['abc', 'def']);
});
