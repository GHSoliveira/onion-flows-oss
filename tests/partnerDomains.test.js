import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Endereco proprio da agencia (agencia.example.com): validacao, unicidade,
// marca publica na tela de login e origem aceita pela API.

const dbPath = path.join(os.tmpdir(), `partner-domains-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'partner-domains-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { partnerRouter, partnersAdminRouter } = await import('../src/routes/partner.js');
const { default: brandingRouter } = await import('../src/routes/branding.js');
const dominios = await import('../src/services/partnerDomains.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

let server;
let base;

before(async () => {
  await adapter.init();
  await adapter.insertOne('users', { id: 'u_onion', username: 'onion', name: 'ONION', role: 'SUPER_ADMIN', permissions: ['*'] });
  await adapter.insertOne('partners', { id: 'partner_a', name: 'Agência A', status: 'active', maxTenants: 20, branding: { productName: 'Atende A', primaryColor: '#123456' } });
  await adapter.insertOne('partners', { id: 'partner_b', name: 'Agência B', status: 'active', maxTenants: 20, branding: {}, subdomain: 'agenciab' });
  await adapter.insertOne('users', { id: 'u_parceiro', username: 'agencia.a', name: 'AGÊNCIA', role: 'PARTNER', partnerId: 'partner_a' });
  const app = express();
  app.use(express.json());
  app.use('/partner', partnerRouter);
  app.use('/partners', partnersAdminRouter);
  app.use('/branding', brandingRouter);
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
  const token = userId ? jwt.sign({ userId }, JWT_SECRET_VALUE, { expiresIn: 60 }) : null;
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('regras do subdominio', () => {
  assert.equal(dominios.normalizeSubdomain(' Agencia-A '), 'agencia-a');
  assert.equal(dominios.normalizeSubdomain(''), null);
  for (const ruim of ['ab', '-agencia', 'agencia-', 'agên', 'a.b', 'ag--x', 'x'.repeat(41)]) {
    assert.throws(() => dominios.normalizeSubdomain(ruim), /letras minúsculas/, ruim);
  }
  for (const reservado of ['www', 'flows', 'api-dev', 'admin']) {
    assert.throws(() => dominios.normalizeSubdomain(reservado), /reservado/, reservado);
  }
});

test('host e origem: so subdominio de primeiro nivel, https e nao reservado', () => {
  assert.equal(dominios.subdomainFromHost('agenciab.example.com'), 'agenciab');
  assert.equal(dominios.subdomainFromHost('AgenciaB.example.com:443'), 'agenciab');
  assert.equal(dominios.subdomainFromHost('flows.example.com'), null);
  assert.equal(dominios.subdomainFromHost('x.y.example.com'), null);
  assert.equal(dominios.subdomainFromHost('agenciab.example.com.evil.com'), null);
  assert.equal(dominios.isAgencyOrigin('https://agenciab.example.com'), true);
  assert.equal(dominios.isAgencyOrigin('http://agenciab.example.com'), false);
  assert.equal(dominios.isAgencyOrigin('https://agenciab.example.com:8443'), false);
  assert.equal(dominios.isAgencyOrigin('https://api-dev.example.com'), false);
  assert.equal(dominios.isAgencyOrigin('https://example.com.evil.com'), false);
});

test('Onion define o endereco; repetido e recusado; parceiro ve o proprio', async () => {
  const ok = await chamar('u_onion', 'PATCH', '/partners/partner_a/address', { subdomain: 'Agencia-A' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.url, 'https://agencia-a.example.com');
  const repetido = await chamar('u_onion', 'PATCH', '/partners/partner_a/address', { subdomain: 'agenciab' });
  assert.equal(repetido.status, 409);
  assert.equal((await chamar('u_parceiro', 'PATCH', '/partners/partner_a/address', { subdomain: 'outra' })).status, 403);
  const me = await chamar('u_parceiro', 'GET', '/partner/me');
  assert.equal(me.body.partner.url, 'https://agencia-a.example.com');
});

test('tela de login no endereco da agencia recebe a marca dela, sem login', async () => {
  const marca = await chamar(null, 'GET', '/branding/public?host=agencia-a.example.com');
  assert.equal(marca.status, 200);
  assert.equal(marca.body.productName, 'Atende A');
  assert.equal(marca.body.primaryColor, '#123456');
  const desconhecido = await chamar(null, 'GET', '/branding/public?host=ninguem.example.com');
  assert.equal(desconhecido.body.source, 'default');
  const principal = await chamar(null, 'GET', '/branding/public?host=flows.example.com');
  assert.equal(principal.body.source, 'default');
});

test('parceiro novo ja pode nascer com endereco', async () => {
  const r = await chamar('u_onion', 'POST', '/partners', {
    name: 'Agência C', subdomain: 'agenciac', user: { name: 'C', username: 'agencia.c', password: 'senha-de-teste-1' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.partner.subdomain, 'agenciac');
  const tomado = await chamar('u_onion', 'POST', '/partners', {
    name: 'Agência D', subdomain: 'agenciac', user: { name: 'D', username: 'agencia.d', password: 'senha-de-teste-1' }
  });
  assert.equal(tomado.status, 409);
  assert.equal(await adapter.findOne('users', { username: 'agencia.d' }), null);
});
