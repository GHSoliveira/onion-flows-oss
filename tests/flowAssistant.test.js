import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Assistente do editor: a IA so propoe operacoes; o servidor descarta o que
// nao fecha com o fluxo (tipo inventado, node inexistente, campo estranho).
// O Gemini e simulado.

const dbPath = path.join(os.tmpdir(), `flow-assistant-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'flow-assistant-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.GEMINI_API_KEY = 'chave-falsa-de-teste';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: router } = await import('../src/routes/flowAssistant.js');
const assistente = await import('../src/services/flowAssistant.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_assist';
const fetchOriginal = global.fetch;
let respostaIa = null;
let ultimoPedido = null;
let server;
let base;

before(async () => {
  await adapter.init();
  await adapter.insertOne('tenants', { id: T, name: 'Assist', status: 'active' });
  await adapter.insertOne('users', { id: 'u_admin', tenantId: T, username: 'admin', name: 'Admin', role: 'ADMIN' });
  await adapter.insertOne('users', { id: 'u_agente', tenantId: T, username: 'agente', name: 'Agente', role: 'AGENT' });
  global.fetch = async (url, opcoes = {}) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return fetchOriginal(url, opcoes);
    ultimoPedido = JSON.parse(opcoes.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(respostaIa) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = express();
  app.use(express.json());
  app.use('/flow-assistant', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  global.fetch = fetchOriginal;
  await new Promise((resolve) => server.close(resolve));
  await adapter.close?.();
  fs.rmSync(dbPath, { force: true });
});

const chamar = async (userId, body) => {
  const token = jwt.sign({ userId }, JWT_SECRET_VALUE, { expiresIn: 60 });
  const res = await fetch(`${base}/flow-assistant`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const fluxo = {
  nodes: [
    { id: 'start', type: 'startNode' },
    { id: 'msg_1', type: 'messageNode', text: 'Olá! Bem-vindo.' }
  ],
  edges: [{ source: 'start', target: 'msg_1' }],
  selectedNodeId: 'msg_1',
  variables: ['nome'],
  queues: ['Atendimento']
};

test('pedido vira operacoes validadas e o fluxo vai junto para a IA', async () => {
  respostaIa = {
    reply: 'Vou perguntar o CPF depois da boas-vindas e guardar em cpf_cliente.',
    operations: [
      { op: 'create_variable', name: 'CPF Cliente' },
      { op: 'add_node', ref: 'n1', type: 'inputNode', data: { text: 'Qual o seu CPF?', variableName: 'cpf_cliente', validationType: 'cpf', script: 'malicioso()' }, after: { node: 'msg_1' } },
      { op: 'add_node', ref: 'n2', type: 'messageNode', data: { text: 'Obrigado, {nome}!' }, after: { node: 'n1' } }
    ]
  };
  const r = await chamar('u_admin', { instruction: 'depois da boas-vindas pergunta o CPF e guarda em cpf_cliente', flow: fluxo });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.operations.length, 3);
  assert.deepEqual(r.body.operations[0], { op: 'create_variable', name: 'CPF_Cliente' });
  assert.equal(r.body.operations[1].data.variableName, 'cpf_cliente');
  assert.equal(r.body.operations[1].data.script, undefined);
  assert.equal(r.body.operations[2].after.node, 'n1');
  const enviado = JSON.parse(ultimoPedido.contents[0].parts[0].text);
  assert.equal(enviado.fluxo.selectedNodeId, 'msg_1');
  assert.equal(enviado.fluxo.nodes[1].text, 'Olá! Bem-vindo.');
});

test('descarta tipo inventado, node inexistente e operacao de apagar', () => {
  const { operations, discarded } = assistente.validarOperacoes([
    { op: 'add_node', ref: 'x', type: 'scriptNode', data: {}, after: { node: 'msg_1' } },
    { op: 'add_node', ref: 'y', type: 'messageNode', data: { text: 'oi' }, after: { node: 'nao_existe' } },
    { op: 'delete_node', id: 'msg_1' },
    { op: 'update_node', id: 'msg_1', data: { text: 'Novo texto', mediaUrl: 'x' } },
    { op: 'connect', from: { node: 'msg_1' }, to: 'msg_1' }
  ], { nodes: fluxo.nodes });
  assert.equal(discarded, 4);
  assert.deepEqual(operations, [{ op: 'update_node', id: 'msg_1', data: { text: 'Novo texto' } }]);
});

test('menu e condicional saem com ids e operadores validos', () => {
  const { operations } = assistente.validarOperacoes([
    { op: 'add_node', ref: 'm', type: 'menuNode', data: { text: '1 - Agendar\n2 - Falar com alguém', options: [{ id: '1', label: 'Agendar' }, { id: 'dois!', label: 'Falar' }], hasElse: 'sim' }, after: { node: 'msg_1' } },
    { op: 'add_node', ref: 'c', type: 'conditionNode', data: { conditions: [{ id: 'c1', variable: 'idade', operator: 'maior', value: '18' }] }, after: { node: 'm', branch: '1' } }
  ], { nodes: fluxo.nodes });
  assert.deepEqual(operations[0].data.options.map((o) => o.id), ['1', 'dois']);
  assert.equal(operations[0].data.hasElse, true);
  assert.equal(operations[1].data.conditions[0].operator, '==');
  assert.deepEqual(operations[1].after, { node: 'm', branch: '1' });
});

test('pergunta quando falta informacao e nao propoe nada', async () => {
  respostaIa = { reply: 'Para qual fila devo transferir?', needsClarification: true, operations: [] };
  const r = await chamar('u_admin', { instruction: 'transfere pra fila', flow: fluxo });
  assert.equal(r.body.needsClarification, true);
  assert.deepEqual(r.body.operations, []);
});

test('atendente nao usa o assistente; pedido vazio e recusado', async () => {
  assert.equal((await chamar('u_agente', { instruction: 'oi', flow: fluxo })).status, 403);
  assert.equal((await chamar('u_admin', { instruction: '   ', flow: fluxo })).status, 400);
});

test('fila e integracao precisam existir: corrige maiuscula, avisa o resto', () => {
  const { operations, warnings } = assistente.validarOperacoes([
    { op: 'add_node', ref: 'f1', type: 'queueNode', data: { queueName: 'atendimento' }, after: { node: 'msg_1' } },
    { op: 'add_node', ref: 'f2', type: 'queueNode', data: { queueName: 'Vendas' }, after: { node: 'f1' } },
    { op: 'add_node', ref: 'h', type: 'httpRequestNode', data: { integrationId: 'integ_x', path: '/a' }, after: { node: 'f2' } }
  ], { nodes: fluxo.nodes, queues: ['Atendimento'], integrations: [] });
  assert.equal(operations[0].data.queueName, 'Atendimento');
  assert.equal(operations[1].data.queueName, '');
  assert.equal(operations[2].data.integrationId, undefined);
  assert.equal(warnings.length, 2);
});

test('Gemini sobrecarregado: tenta o modelo leve; falha final vira 503, nunca 502', async () => {
  const modelosChamados = [];
  let falharTodos = false;
  global.fetch = async (url, opcoes = {}) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return fetchOriginal(url, opcoes);
    modelosChamados.push(decodeURIComponent(String(url).split('/models/')[1].split(':')[0]));
    if (falharTodos || modelosChamados.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'high demand' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'ok', operations: [] }) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await chamar('u_admin', { instruction: 'oi', flow: fluxo });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(modelosChamados.length, 2);
  assert.notEqual(modelosChamados[0], modelosChamados[1]);
  falharTodos = true;
  const falha = await chamar('u_admin', { instruction: 'oi de novo', flow: fluxo });
  assert.equal(falha.status, 503);
  assert.match(falha.body.error, /sobrecarregada/);
});

test('menu da IA nasce com botoes/lista e aceita menu dinamico', () => {
  const { operations } = assistente.validarOperacoes([
    { op: 'add_node', ref: 'm1', type: 'menuNode', data: { text: 'Como posso ajudar?', options: [{ id: '1', label: 'Agendar' }] }, after: { node: 'msg_1' } },
    { op: 'add_node', ref: 'm2', type: 'menuNode', data: { text: 'Qual horário?', optionsSource: 'variable', optionsVariable: 'horarios', optionLabelPath: 'rotulo', optionValuePath: 'id', variableName: 'horario', optionsDisplay: 'carrossel' }, after: { node: 'm1', branch: '1' } }
  ], { nodes: fluxo.nodes });
  assert.equal(operations[0].data.optionsDisplay, 'auto');
  assert.equal(operations[1].data.optionsSource, 'variable');
  assert.equal(operations[1].data.optionsDisplay, 'auto');
  assert.equal(operations[1].data.optionsVariable, 'horarios');
});

test('Else do menu so fica ligado quando o plano usa ele', () => {
  const { operations } = assistente.validarOperacoes([
    { op: 'add_node', ref: 'a', type: 'menuNode', data: { text: 'A?', options: [{ id: '1', label: 'Sim' }] }, after: { node: 'msg_1' } },
    { op: 'add_node', ref: 'b', type: 'menuNode', data: { text: 'B?', options: [{ id: '1', label: 'Sim' }] }, after: { node: 'a', branch: '1' } },
    { op: 'add_node', ref: 'c', type: 'messageNode', data: { text: 'Não entendi' }, after: { node: 'b', branch: 'else' } }
  ], { nodes: fluxo.nodes });
  assert.equal(operations[0].data.hasElse, false);
  assert.equal(operations[1].data.hasElse, true);
  assert.equal(operations[0].data.options[0].value, 'Sim');
});
