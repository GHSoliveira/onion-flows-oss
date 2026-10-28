import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Parceiro (nivel H): agencia com carteira de clientes. Nada de um Parceiro
// pode vazar para outro, nem para tenants da Onion; dentro de um cliente da
// propria carteira ele age como ADMIN daquele tenant, e so dele.

const dbPath = path.join(os.tmpdir(), `partner-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'partner-test-only-secret-value';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { partnerRouter, partnersAdminRouter } = await import('../src/routes/partner.js');
const { default: usersRouter } = await import('../src/routes/users.js');
const { default: brandingRouter } = await import('../src/routes/branding.js');
const { default: tenantModulesRouter } = await import('../src/routes/tenantModules.js');
const { default: authRouter } = await import('../src/routes/auth.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

let server;
let base;

before(async () => {
  await adapter.init();
  await adapter.insertOne('users', { id: 'u_onion', username: 'onion.root', name: 'ONION', role: 'SUPER_ADMIN', permissions: ['*'] });
  await adapter.insertOne('tenants', { id: 'tenant_onion', name: 'Cliente direto da Onion', status: 'active', settings: { maxUsers: 50 } });
  await adapter.insertOne('users', { id: 'u_admin_onion', tenantId: 'tenant_onion', username: 'admin.onion', name: 'ADMIN ONION', role: 'ADMIN' });
  const app = express();
  app.use(express.json());
  app.use('/partner', partnerRouter);
  app.use('/partners', partnersAdminRouter);
  app.use('/users', usersRouter);
  app.use('/branding', brandingRouter);
  app.use('/tenant-modules', tenantModulesRouter);
  app.use('/auth', authRouter);
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

const estado = {};
const login = (username) => ({ name: username.toUpperCase(), username, password: 'senha-de-teste-123' });

test('so a Onion cria Parceiro', async () => {
  const negado = await chamar('u_admin_onion', 'POST', '/partners', { name: 'Agência A', user: login('agencia.a') });
  assert.equal(negado.status, 403);
  for (const [chave, nome] of [['a', 'Agência A'], ['b', 'Agência B']]) {
    const r = await chamar('u_onion', 'POST', '/partners', { name: nome, maxTenants: 2, user: login(`agencia.${chave}`) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.user.role, 'PARTNER');
    assert.equal(r.body.user.password, undefined);
    estado[chave] = { partnerId: r.body.partner.id, userId: r.body.user.id };
  }
});

test('Parceiro cria cliente com o primeiro admin e respeita o limite de clientes', async () => {
  const r = await chamar(estado.a.userId, 'POST', '/partner/tenants', { name: 'Pet Shop da A', plan: 'pro', maxUsers: 4, admin: login('dono.petshop.a') });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.admin.role, 'ADMIN');
  assert.equal(r.body.admin.tenantId, r.body.tenant.id);
  estado.a.tenantId = r.body.tenant.id;
  const segundo = await chamar(estado.a.userId, 'POST', '/partner/tenants', { name: 'Clínica da A', admin: login('dono.clinica.a') });
  assert.equal(segundo.status, 201);
  const terceiro = await chamar(estado.a.userId, 'POST', '/partner/tenants', { name: 'Terceiro', admin: login('dono.terceiro.a') });
  assert.equal(terceiro.status, 409);

  const b = await chamar(estado.b.userId, 'POST', '/partner/tenants', { name: 'Loja da B', admin: login('dono.loja.b') });
  assert.equal(b.status, 201);
  estado.b.tenantId = b.body.tenant.id;
});

test('cada Parceiro lista so a propria carteira', async () => {
  const a = await chamar(estado.a.userId, 'GET', '/partner/tenants');
  assert.deepEqual(a.body.items.map((t) => t.name).sort(), ['Clínica da A', 'Pet Shop da A']);
  const b = await chamar(estado.b.userId, 'GET', '/partner/tenants');
  assert.deepEqual(b.body.items.map((t) => t.name), ['Loja da B']);
});

test('dentro de um cliente da carteira o Parceiro age como admin daquele tenant', async () => {
  const r = await chamar(estado.a.userId, 'GET', `/users?tenantId=${estado.a.tenantId}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map((u) => u.username), ['dono.petshop.a']);
  const criado = await chamar(estado.a.userId, 'POST', `/users?tenantId=${estado.a.tenantId}`, { ...login('atendente.petshop.a'), role: 'AGENT' });
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  assert.equal(criado.body.tenantId, estado.a.tenantId);
});

test('cliente de outro Parceiro e cliente direto da Onion ficam fechados', async () => {
  assert.equal((await chamar(estado.a.userId, 'GET', `/users?tenantId=${estado.b.tenantId}`)).status, 403);
  assert.equal((await chamar(estado.a.userId, 'GET', '/users?tenantId=tenant_onion')).status, 403);
  assert.equal((await chamar(estado.a.userId, 'PATCH', `/partner/tenants/${estado.b.tenantId}`, { name: 'Invadido' })).status, 404);
  const loja = await adapter.findOne('tenants', { id: estado.b.tenantId });
  assert.equal(loja.name, 'Loja da B');
});

test('fora de um cliente o Parceiro nao usa rotas de tenant nem da Onion', async () => {
  assert.equal((await chamar(estado.a.userId, 'GET', '/users')).status, 403);
  assert.equal((await chamar(estado.a.userId, 'GET', '/partners')).status, 403);
  assert.equal((await chamar(estado.a.userId, 'POST', '/partners', { name: 'Nova', user: login('nova.agencia') })).status, 403);
});

test('admin de tenant nao entra no painel do Parceiro', async () => {
  assert.equal((await chamar('u_admin_onion', 'GET', '/partner/tenants')).status, 403);
});

test('heartbeat mantem o papel de Parceiro mesmo dentro de um cliente', async () => {
  const r = await chamar(estado.a.userId, 'GET', `/auth/heartbeat?tenantId=${estado.a.tenantId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'PARTNER');
  assert.equal(r.body.user.partnerId, estado.a.partnerId);
});

test('marca do Parceiro vale nos clientes dele e o cliente pode sobrescrever', async () => {
  const salva = await chamar(estado.a.userId, 'PATCH', '/partner/branding', { productName: 'Atende A', primaryColor: '#123abc', supportEmail: 'oi@agencia-a.com.br' });
  assert.equal(salva.status, 200, JSON.stringify(salva.body));
  const doAdminA = await adapter.findOne('users', { username: 'dono.petshop.a' });
  const herdada = await chamar(doAdminA.id, 'GET', '/branding');
  assert.equal(herdada.body.productName, 'Atende A');
  assert.equal(herdada.body.primaryColor, '#123abc');
  assert.equal(herdada.body.source, 'partner');

  await chamar(doAdminA.id, 'PATCH', '/tenant-modules/settings/identity', { productName: 'Pet Shop Atende' });
  const sobrescrita = await chamar(doAdminA.id, 'GET', '/branding');
  assert.equal(sobrescrita.body.productName, 'Pet Shop Atende');
  assert.equal(sobrescrita.body.primaryColor, '#123abc');
  assert.equal(sobrescrita.body.source, 'tenant');

  const doB = await adapter.findOne('users', { username: 'dono.loja.b' });
  assert.equal((await chamar(doB.id, 'GET', '/branding')).body.productName, null);
  assert.equal((await chamar(estado.a.userId, 'GET', '/branding')).body.productName, 'Atende A');
});

test('suspender cliente bloqueia o tenant e reativar libera', async () => {
  const suspenso = await chamar(estado.a.userId, 'PATCH', `/partner/tenants/${estado.a.tenantId}`, { status: 'suspended' });
  assert.equal(suspenso.status, 200, JSON.stringify(suspenso.body));
  assert.equal(suspenso.body.status, 'suspended');
  assert.equal((await adapter.findOne('tenants', { id: estado.a.tenantId })).billing.blocked, true);
  const ativo = await chamar(estado.a.userId, 'PATCH', `/partner/tenants/${estado.a.tenantId}`, { status: 'active' });
  assert.equal(ativo.body.status, 'active');
});

test('Onion passa um tenant existente para a carteira de um Parceiro', async () => {
  const r = await chamar('u_onion', 'PUT', '/partners/tenants/tenant_onion', { partnerId: estado.b.partnerId });
  assert.equal(r.status, 200);
  assert.equal((await chamar(estado.b.userId, 'GET', '/users?tenantId=tenant_onion')).status, 200);
  await chamar('u_onion', 'PUT', '/partners/tenants/tenant_onion', { partnerId: null });
  assert.equal((await chamar(estado.b.userId, 'GET', '/users?tenantId=tenant_onion')).status, 403);
});

test('admin de tenant, inclusive Parceiro dentro do cliente, nao cria SUPER_ADMIN', async () => {
  const pelaOnion = await chamar('u_admin_onion', 'POST', '/users', { ...login('falso.super.1'), role: 'SUPER_ADMIN' });
  assert.equal(pelaOnion.status, 403);
  const peloParceiro = await chamar(estado.a.userId, 'POST', `/users?tenantId=${estado.a.tenantId}`, { ...login('falso.super.2'), role: 'SUPER_ADMIN' });
  assert.equal(peloParceiro.status, 403);
  assert.equal(await adapter.findOne('users', { username: 'falso.super.1' }), null);
  assert.equal(await adapter.findOne('users', { username: 'falso.super.2' }), null);
});

test('Onion cria mais um acesso para uma agencia que ja existe; login repetido e recusado', async () => {
  const negado = await chamar(estado.a.userId, 'POST', `/partners/${estado.a.partnerId}/access`, login('agencia.a.segundo'));
  assert.equal(negado.status, 403);
  const r = await chamar('u_onion', 'POST', `/partners/${estado.a.partnerId}/access`, login('agencia.a.segundo'));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'PARTNER');
  assert.equal(r.body.user.partnerId, estado.a.partnerId);
  assert.equal(r.body.user.password, undefined);
  assert.equal((await chamar('u_onion', 'POST', `/partners/${estado.a.partnerId}/access`, login('agencia.a.segundo'))).status, 400);
  assert.equal((await chamar('u_onion', 'POST', '/partners/nao_existe/access', login('agencia.fantasma'))).status, 404);
  const lista = await chamar('u_onion', 'GET', '/partners');
  assert.equal(lista.body.items.find((p) => p.id === estado.a.partnerId).accesses, 2);
  // O acesso novo entra no painel da agencia e ve a carteira dela.
  const carteira = await chamar(r.body.user.id, 'GET', '/partner/tenants');
  assert.equal(carteira.status, 200);
});
