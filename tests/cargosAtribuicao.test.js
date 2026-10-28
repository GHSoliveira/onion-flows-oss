import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Etapa 3 dos cargos: a tela de usuarios grava o nivel. Quem atribui precisa
// gerenciar a familia (A, B ou C) e nao da o que nao tem; ninguem muda o
// proprio cargo nem remove o proprio acesso.

const dbPath = path.join(os.tmpdir(), `cargos-atribuicao-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'cargos-atribuicao-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: usersRouter } = await import('../src/routes/users.js');
const { default: cargosRouter } = await import('../src/routes/cargos.js');
const { default: tenantModulesRouter } = await import('../src/routes/tenantModules.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const T = 'tenant_atribuicao';
let server;
let base;

before(async () => {
  await adapter.init();
  await adapter.insertOne('tenants', { id: T, name: 'Atribuição', status: 'active', settings: { maxUsers: 100 } });
  const user = (id, role, extra = {}) => adapter.insertOne('users', { id, tenantId: T, username: id, name: id, role, ...extra });
  await user('u_admin', 'ADMIN');
  await user('u_gestor_equipe', 'MANAGER', { managerPermissions: ['equipe'] });
  await user('u_b5', 'MANAGER', { cargo: { nivel: 'B5' } });
  await user('u_b9', 'MANAGER', { cargo: { nivel: 'B9' } });
  await user('u_c5', 'ADMIN', { cargo: { nivel: 'C5' } });
  await user('u_alvo_c', 'ADMIN');
  await user('u_alvo_a', 'AGENT');
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use('/cargos', cargosRouter);
  app.use('/tenant-modules', tenantModulesRouter);
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
  const res = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
};

let n = 0;
const novo = (cargo) => ({ name: `Pessoa ${++n}`, username: `pessoa.${n}`, password: 'senha-teste-123', role: 'AGENT', cargo });

test('admin de hoje cria pessoa com nivel; o papel acompanha a familia', async () => {
  const r = await chamar('u_admin', 'POST', '/users', novo({ nivel: 'B3' }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.role, 'MANAGER');
  assert.deepEqual(r.body.cargo, { nivel: 'B3', adicionadas: [], removidas: [] });
  assert.equal(r.body.cargoEfetivo.codigo, 'B3');
});

test('gestor de hoje com "equipe" cria atendente com nivel, mas nao gestor', async () => {
  assert.equal((await chamar('u_gestor_equipe', 'POST', '/users', novo({ nivel: 'A4' }))).status, 201);
  assert.equal((await chamar('u_gestor_equipe', 'POST', '/users', novo({ nivel: 'B1' }))).status, 403);
});

test('B5 cria atendente; B9 cria gestor; ninguem da caixa que nao tem', async () => {
  assert.equal((await chamar('u_b5', 'POST', '/users', novo({ nivel: 'A2' }))).status, 201);
  assert.equal((await chamar('u_b5', 'POST', '/users', novo({ nivel: 'B3' }))).status, 403);
  assert.equal((await chamar('u_b9', 'POST', '/users', novo({ nivel: 'B3' }))).status, 201);
  const escalada = await chamar('u_b9', 'POST', '/users', novo({ nivel: 'A2', adicionadas: ['config.whatsapp'] }));
  assert.equal(escalada.status, 403);
  assert.match(escalada.body.error, /Conectar WhatsApp/);
});

test('C5 nao cria C6 para ganhar o WhatsApp por tabela', async () => {
  assert.equal((await chamar('u_c5', 'POST', '/users', novo({ nivel: 'C6' }))).status, 403);
  assert.equal((await chamar('u_c5', 'POST', '/users', novo({ nivel: 'C5' }))).status, 201);
});

test('nivel fora do catalogo ou de plataforma e recusado', async () => {
  assert.equal((await chamar('u_admin', 'POST', '/users', novo({ nivel: 'Z7' }))).status, 400);
  assert.equal((await chamar('u_admin', 'POST', '/users', novo({ nivel: 'A8' }))).status, 400);
});

test('ninguem muda o proprio cargo nem remove o proprio acesso', async () => {
  const proprio = await chamar('u_b9', 'PUT', '/users/u_b9', { name: 'B9', username: 'u_b9', cargo: { nivel: 'B9', adicionadas: ['config.empresa'] } });
  assert.equal(proprio.status, 403);
  assert.equal((await chamar('u_admin', 'DELETE', '/users/u_admin')).status, 403);
});

test('gestor com nivel nao edita nem remove admin; edita atendente', async () => {
  assert.equal((await chamar('u_b5', 'PUT', '/users/u_alvo_c', { name: 'X', username: 'u_alvo_c', cargo: { nivel: 'A2' } })).status, 403);
  assert.equal((await chamar('u_b5', 'DELETE', '/users/u_alvo_c')).status, 403);
  const editado = await chamar('u_b5', 'PUT', '/users/u_alvo_a', { name: 'Alvo', username: 'u_alvo_a', cargo: { nivel: 'A2', removidas: ['atendimento.historico'] } });
  assert.equal(editado.status, 200, JSON.stringify(editado.body));
  assert.equal(editado.body.role, 'AGENT');
  assert.deepEqual(editado.body.cargo.removidas, ['atendimento.historico']);
});

test('catalogo traz niveis de cliente, nomes da empresa e o que o ator gerencia', async () => {
  const salvo = await chamar('u_admin', 'PATCH', '/tenant-modules/settings/cargos', { A2: 'Recepção', B5: 'Supervisor de loja' });
  assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
  assert.equal((await chamar('u_admin', 'PATCH', '/tenant-modules/settings/cargos', { Z7: 'Dono' })).status, 400);
  const r = await chamar('u_b5', 'GET', '/cargos');
  assert.equal(r.status, 200);
  assert.ok(r.body.niveis.every((nivel) => ['A', 'B', 'C'].includes(nivel.familia)));
  assert.equal(r.body.niveis.find((nivel) => nivel.codigo === 'A2').nome, 'Recepção');
  assert.equal(r.body.niveis.find((nivel) => nivel.codigo === 'A4').nome, 'Atendente com atendimento ativo');
  assert.deepEqual(r.body.ator.gerencia, ['A']);
  assert.equal(r.body.ator.codigo, 'B5');
});
