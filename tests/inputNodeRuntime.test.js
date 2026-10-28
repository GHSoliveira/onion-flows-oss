import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `onion-input-node-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.JWT_SECRET = 'input-node-runtime-test-secret-not-for-production';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { applyUserInput, getChatById } = await import('../src/services/flowRunner.js');

const tenantId = 'tenant_input_test';
const sendMessage = async () => null;
const flowData = {
  nodes: [
    {
      id: 'input_email',
      type: 'inputNode',
      data: {
        text: 'Qual e o seu e-mail?',
        variableName: 'EMAIL',
        validationType: 'email',
        errorText: 'E-mail invalido.',
        maxAttempts: 3,
        onFailBehavior: 'branch'
      }
    },
    { id: 'holder_valid', type: 'holderNode', data: { text: '' } },
    { id: 'holder_invalid', type: 'holderNode', data: { text: '' } }
  ],
  edges: [
    { id: 'edge_valid', source: 'input_email', sourceHandle: 'default', target: 'holder_valid' },
    { id: 'edge_invalid', source: 'input_email', sourceHandle: 'invalid', target: 'holder_invalid' }
  ]
};

const insertChat = (id, nodeId = 'input_email') => adapter.insertOne('activeChats', {
  id,
  tenantId,
  status: 'bot',
  currentNodeId: nodeId,
  currentNodeEnteredAt: new Date().toISOString(),
  flowStarted: true,
  messages: [],
  vars: {},
  inputAttempts: {}
});

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
});

after(async () => {
  await adapter.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

test('input validado persiste tentativas e usa o ramo invalido no limite', async () => {
  await insertChat('chat_invalid');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const chat = await getChatById('chat_invalid');
    const result = await applyUserInput({
      chat,
      flowData,
      text: 'email-invalido',
      templates: [],
      schedules: [],
      sendMessage
    });
    const updated = await getChatById('chat_invalid');

    if (attempt < 3) {
      assert.equal(result.reason, 'input_validation_error');
      assert.equal(updated.currentNodeId, 'input_email');
      assert.equal(updated.inputAttempts.input_email, attempt);
    } else {
      assert.equal(result.reason, 'input_validation_branch');
      assert.equal(updated.currentNodeId, 'holder_invalid');
      assert.equal(updated.inputAttempts.input_email, undefined);
    }
  }
});

test('input legado sem validationType preserva texto cru e segue a saida padrao', async () => {
  await insertChat('chat_legacy');
  const legacyFlow = {
    nodes: [
      { id: 'input_email', type: 'inputNode', data: { variableName: 'RESPOSTA' } },
      { id: 'holder_valid', type: 'holderNode', data: { text: '' } }
    ],
    edges: [{ id: 'edge_valid', source: 'input_email', target: 'holder_valid' }]
  };
  const raw = '  valor sem normalizar  ';

  const result = await applyUserInput({
    chat: await getChatById('chat_legacy'),
    flowData: legacyFlow,
    text: raw,
    templates: [],
    schedules: [],
    sendMessage
  });
  const updated = await getChatById('chat_legacy');

  assert.equal(result.reason, 'inputNode');
  assert.equal(updated.vars.RESPOSTA, raw);
  assert.equal(updated.currentNodeId, 'holder_valid');
});
