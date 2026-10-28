import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Permissoes extras do gestor (MANAGER): o ADMIN marca no cadastro e elas so
// somam acesso. Gestor sem nenhuma continua so leitura; com "equipe" mexe so em
// atendentes, nunca em outro gestor, admin ou nas proprias permissoes.

const dbPath = path.join(os.tmpdir(), `manager-permissions-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'manager-permissions-test-only-secret';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: usersRouter } = await import('../src/routes/users.js');
const { default: queuesRouter } = await import('../src/routes/queues.js');
const { default: cannedRouter } = await import('../src/routes/cannedResponses.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_gestor';
let server;
let base;

before(async () => {
  await adapter.init();
  await adapter.insertOne('tenants', { id: T, name: 'Pet Shop Gestor', status: 'active', settings: { maxUsers: 50 } });
  const user = (id, role, extra = {}) => adapter.insertOne('users', { id, tenantId: T, username: id, name: id.toUpperCase(), role, queues: [], ...extra });
  await user('u_admin', 'ADMIN');
  await user('u_gestor_leitura', 'MANAGER');
  await user('u_gestor_equipe', 'MANAGER', { managerPermissions: ['equipe'] });
  await user('u_gestor_respostas', 'MANAGER', { managerPermissions: ['respostas'] });
  await user('u_outro_gestor', 'MANAGER');
  await user('u_carol', 'AGENT');

  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use('/queues', queuesRouter);
  app.use('/cannedResponses', cannedRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
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

const novoUsuario = (username, role, extra = {}) => ({ username, name: username.toUpperCase(), password: 'senha-de-teste-1', role, ...extra });
const usuario = (id) => adapter.findOne('users', { id });

test('gestor sem permissao marcada continua so leitura', async () => {
  assert.equal((await chamar('u_gestor_leitura', 'GET', '/users')).status, 200);
  assert.equal((await chamar('u_gestor_leitura', 'POST', '/users', novoUsuario('leitura.agente', 'AGENT'))).status, 403);
  assert.equal((await chamar('u_gestor_leitura', 'POST', '/queues', { name: 'FILA LEITURA' })).status, 403);
  assert.equal((await chamar('u_gestor_leitura', 'POST', '/cannedResponses', { name: 'Oi', message: 'Oi!' })).status, 403);
});

test('gestor com "equipe" cria e edita atendente e mexe em filas', async () => {
  const criado = await chamar('u_gestor_equipe', 'POST', '/users', novoUsuario('equipe.agente', 'AGENT', { managerPermissions: ['fluxos'] }));
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  assert.equal(criado.body.role, 'AGENT');
  assert.deepEqual(criado.body.managerPermissions, []);

  const editado = await chamar('u_gestor_equipe', 'PUT', '/users/u_carol', { name: 'CAROL', username: 'u_carol', role: 'AGENT', queues: ['BANHO E TOSA'] });
  assert.equal(editado.status, 200, JSON.stringify(editado.body));
  assert.deepEqual(editado.body.queues, ['BANHO E TOSA']);

  assert.ok([200, 201].includes((await chamar('u_gestor_equipe', 'POST', '/queues', { name: 'BANHO E TOSA' })).status));
  // "equipe" nao libera outra area.
  assert.equal((await chamar('u_gestor_equipe', 'POST', '/cannedResponses', { name: 'Oi', message: 'Oi!' })).status, 403);
});

test('gestor com "equipe" nao cria nem promove gestor ou admin', async () => {
  assert.equal((await chamar('u_gestor_equipe', 'POST', '/users', novoUsuario('equipe.admin', 'ADMIN'))).status, 403);
  assert.equal((await chamar('u_gestor_equipe', 'POST', '/users', novoUsuario('equipe.gestor', 'MANAGER'))).status, 403);
  const promover = await chamar('u_gestor_equipe', 'PUT', '/users/u_carol', { name: 'CAROL', username: 'u_carol', role: 'ADMIN' });
  assert.equal(promover.status, 403);
  assert.equal((await usuario('u_carol')).role, 'AGENT');
});

test('gestor com "equipe" nao mexe em admin, em outro gestor nem em si mesmo', async () => {
  assert.equal((await chamar('u_gestor_equipe', 'PUT', '/users/u_admin', { name: 'X', username: 'u_admin', role: 'AGENT' })).status, 403);
  assert.equal((await chamar('u_gestor_equipe', 'DELETE', '/users/u_admin')).status, 403);
  assert.equal((await chamar('u_gestor_equipe', 'DELETE', '/users/u_outro_gestor')).status, 403);
  const proprio = await chamar('u_gestor_equipe', 'PUT', '/users/u_gestor_equipe', {
    name: 'EU', username: 'u_gestor_equipe', role: 'MANAGER', managerPermissions: ['equipe', 'fluxos', 'conversas']
  });
  assert.equal(proprio.status, 403);
  assert.deepEqual((await usuario('u_gestor_equipe')).managerPermissions, ['equipe']);
  assert.ok(await usuario('u_admin'));
});

test('admin marca permissoes do gestor; so entram as do catalogo', async () => {
  const criado = await chamar('u_admin', 'POST', '/users', novoUsuario('admin.gestor', 'MANAGER', { managerPermissions: ['equipe', 'fluxos', '*', 'whatsapp', 'equipe'] }));
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  assert.deepEqual(criado.body.managerPermissions, ['equipe', 'fluxos']);

  // Edicao sem o campo preserva o que estava marcado.
  const semCampo = await chamar('u_admin', 'PUT', `/users/${criado.body.id}`, { name: 'GESTORA', username: 'admin.gestor', role: 'MANAGER' });
  assert.deepEqual(semCampo.body.managerPermissions, ['equipe', 'fluxos']);

  const desmarcar = await chamar('u_admin', 'PUT', `/users/${criado.body.id}`, { name: 'GESTORA', username: 'admin.gestor', role: 'MANAGER', managerPermissions: ['conversas'] });
  assert.deepEqual(desmarcar.body.managerPermissions, ['conversas']);

  // Deixou de ser gestor: as permissoes somem junto.
  const virouAgente = await chamar('u_admin', 'PUT', `/users/${criado.body.id}`, { name: 'GESTORA', username: 'admin.gestor', role: 'AGENT', managerPermissions: ['conversas'] });
  assert.deepEqual(virouAgente.body.managerPermissions, []);
});

test('gestor com "respostas" edita respostas rapidas e nada de equipe', async () => {
  const criada = await chamar('u_gestor_respostas', 'POST', '/cannedResponses', { name: 'Horario', message: 'Abrimos as 8h.' });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  assert.equal((await chamar('u_gestor_respostas', 'POST', '/users', novoUsuario('respostas.agente', 'AGENT'))).status, 403);
});

test('agente nao ganha nada com managerPermissions gravado por engano', async () => {
  await adapter.insertOne('users', { id: 'u_agente_marcado', tenantId: T, username: 'u_agente_marcado', name: 'X', role: 'AGENT', managerPermissions: ['equipe', 'respostas'] });
  assert.equal((await chamar('u_agente_marcado', 'POST', '/users', novoUsuario('marcado.agente', 'AGENT'))).status, 403);
  assert.equal((await chamar('u_agente_marcado', 'POST', '/cannedResponses', { name: 'Oi', message: 'Oi!' })).status, 403);
});
