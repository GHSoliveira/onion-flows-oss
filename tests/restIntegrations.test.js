import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Integracoes REST do cliente: a chave e guardada cifrada, nunca volta para a
// tela, e o node HTTP so consegue chamar o servidor cadastrado.

const dbPath = path.join(os.tmpdir(), `rest-integrations-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'rest-integrations-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.DATA_ENCRYPTION_KEYS = `k1:${crypto.randomBytes(32).toString('base64')}`;
process.env.ACTIVE_DATA_KEY = 'k1';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

// DNS falso: hosts publicos resolvem para um IP publico; "interno" para rede privada.
mock.method(dns, 'lookup', async (host) => ({ address: host.startsWith('interno') ? '10.0.0.5' : '93.184.216.34', family: 4 }));

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: router } = await import('../src/routes/restIntegrations.js');
const integracoes = await import('../src/services/restIntegrations.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_integ';
const fetchOriginal = global.fetch;
const chamadasExternas = [];
let server;
let base;

before(async () => {
  await adapter.init();
  await adapter.insertOne('tenants', { id: T, name: 'Integ', status: 'active' });
  await adapter.insertOne('tenants', { id: 'tenant_outro', name: 'Outro', status: 'active' });
  await adapter.insertOne('users', { id: 'u_admin', tenantId: T, username: 'admin', name: 'Admin', role: 'ADMIN' });
  await adapter.insertOne('users', { id: 'u_agente', tenantId: T, username: 'agente', name: 'Agente', role: 'AGENT' });
  await adapter.insertOne('users', { id: 'u_outro', tenantId: 'tenant_outro', username: 'outro', name: 'Outro', role: 'ADMIN' });

  global.fetch = async (url, opcoes = {}) => {
    if (String(url).startsWith('http://127.0.0.1')) return fetchOriginal(url, opcoes);
    chamadasExternas.push({ url: String(url), opcoes });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const app = express();
  app.use(express.json());
  app.use('/rest-integrations', router);
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

const chamar = async (userId, method, url, body) => {
  const token = jwt.sign({ userId }, JWT_SECRET_VALUE, { expiresIn: 60 });
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let id;

test('cria integracao; a chave fica cifrada e nunca volta', async () => {
  const r = await chamar('u_admin', 'POST', '/rest-integrations', {
    name: 'ERP', icon: 'database', description: 'Pedidos', baseUrl: 'https://api.erp.com.br/v1/', authType: 'bearer', secret: 'segredo-123'
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.baseUrl, 'https://api.erp.com.br/v1');
  assert.equal(r.body.hasSecret, true);
  assert.ok(!JSON.stringify(r.body).includes('segredo-123'));
  id = r.body.id;
  const guardado = await adapter.findOne('restIntegrations', { id });
  assert.ok(guardado.secret && !guardado.secret.includes('segredo-123'));
  const lista = await chamar('u_admin', 'GET', '/rest-integrations');
  assert.ok(!JSON.stringify(lista.body).includes('segredo'));
});

test('so https e so servidor publico', async () => {
  const http = await chamar('u_admin', 'POST', '/rest-integrations', { name: 'X', baseUrl: 'http://api.erp.com.br', authType: 'none' });
  assert.equal(http.status, 400);
  const interno = await chamar('u_admin', 'POST', '/rest-integrations', { name: 'X', baseUrl: 'https://interno.empresa', authType: 'none' });
  assert.equal(interno.status, 400);
  const semChave = await chamar('u_admin', 'POST', '/rest-integrations', { name: 'X', baseUrl: 'https://api.erp.com.br', authType: 'bearer' });
  assert.equal(semChave.status, 400);
});

test('atendente nao cria; outro cliente nao enxerga', async () => {
  assert.equal((await chamar('u_agente', 'POST', '/rest-integrations', { name: 'X', baseUrl: 'https://a.com', authType: 'none' })).status, 403);
  const outro = await chamar('u_outro', 'GET', '/rest-integrations');
  assert.deepEqual(outro.body, []);
  assert.equal((await chamar('u_outro', 'PATCH', `/rest-integrations/${id}`, { name: 'Roubada' })).status, 404);
});

test('trocar o servidor exige informar a chave de novo', async () => {
  const sem = await chamar('u_admin', 'PATCH', `/rest-integrations/${id}`, { baseUrl: 'https://atacante.com' });
  assert.equal(sem.status, 400);
  const nome = await chamar('u_admin', 'PATCH', `/rest-integrations/${id}`, { name: 'ERP Principal' });
  assert.equal(nome.status, 200);
  assert.equal(nome.body.hasSecret, true);
});

test('caminho com variavel nao muda o servidor nem sai do caminho base', () => {
  const b = 'https://api.erp.com.br/v1';
  assert.equal(integracoes.buildIntegrationUrl(b, '/clientes/{cpf}', { cpf: '123.456' }), 'https://api.erp.com.br/v1/clientes/123.456');
  assert.equal(integracoes.buildIntegrationUrl(b, 'busca?q={q}', { q: 'a b&c=1' }), 'https://api.erp.com.br/v1/busca?q=a%20b%26c%3D1');
  assert.equal(integracoes.buildIntegrationUrl(b, '/x/{v}', { v: '@atacante.com/' }), 'https://api.erp.com.br/v1/x/%40atacante.com%2F');
  assert.throws(() => integracoes.buildIntegrationUrl(b, '/../admin', {}), /fora do endereço/);
  assert.throws(() => integracoes.buildIntegrationUrl(b, '/x/{v}/../../..', { v: 'a' }), /fora do endereço/);
});

test('cabecalho de autenticacao por tipo', () => {
  assert.deepEqual(integracoes.authHeaders({ authType: 'header', headerName: 'X-Api-Key', secret: 'k' }), { 'X-Api-Key': 'k' });
  assert.deepEqual(integracoes.authHeaders({ authType: 'basic', username: 'u', secret: 'p' }), { Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` });
  assert.deepEqual(integracoes.authHeaders({ authType: 'none' }), {});
});

test('testar chama o servidor com a chave e guarda o resultado', async () => {
  const r = await chamar('u_admin', 'POST', `/rest-integrations/${id}/test`, { path: '/status' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  const chamada = chamadasExternas.at(-1);
  assert.equal(chamada.url, 'https://api.erp.com.br/v1/status');
  assert.equal(chamada.opcoes.headers.Authorization, 'Bearer segredo-123');
  assert.equal(chamada.opcoes.redirect, 'error');
  const lista = await chamar('u_admin', 'GET', '/rest-integrations');
  assert.equal(lista.body[0].lastOk, true);
});

test('o node so resolve integracao do proprio cliente', async () => {
  const pronto = await integracoes.prepareIntegrationRequest({ tenantId: T, integrationId: id, path: '/pedidos/{n}', vars: { n: 7 } });
  assert.equal(pronto.url, 'https://api.erp.com.br/v1/pedidos/7');
  await assert.rejects(() => integracoes.prepareIntegrationRequest({ tenantId: 'tenant_outro', integrationId: id, path: '/', vars: {} }), /não encontrada/);
});

test('nao exclui integracao em uso num fluxo', async () => {
  await adapter.insertOne('flows', { id: 'f1', tenantId: T, name: 'Pedidos', nodes: [{ id: 'n1', type: 'httpRequestNode', data: { integrationId: id, path: '/x' } }] });
  const r = await chamar('u_admin', 'DELETE', `/rest-integrations/${id}`);
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.flows, ['Pedidos']);
  await adapter.deleteMany('flows', { id: 'f1' });
  assert.equal((await chamar('u_admin', 'DELETE', `/rest-integrations/${id}`)).status, 200);
});
