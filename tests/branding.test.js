import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Marca do painel (white label, fase 1): o admin preenche na aba Identidade e
// qualquer usuario do tenant recebe a marca. Logo e icone so com https, cor so
// #RRGGBB, e a marca de um tenant nunca aparece para outro.

const dbPath = path.join(os.tmpdir(), `branding-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'branding-test-only-secret-value';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: brandingRouter } = await import('../src/routes/branding.js');
const { default: tenantModulesRouter } = await import('../src/routes/tenantModules.js');
const { sanitizeBranding } = await import('../src/services/branding.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

let server;
let base;

before(async () => {
  await adapter.init();
  for (const t of ['tenant_agencia', 'tenant_outro']) await adapter.insertOne('tenants', { id: t, name: t, status: 'active' });
  await adapter.insertOne('users', { id: 'u_admin', tenantId: 'tenant_agencia', username: 'admin', name: 'ADMIN', role: 'ADMIN' });
  await adapter.insertOne('users', { id: 'u_agente', tenantId: 'tenant_agencia', username: 'agente', name: 'AGENTE', role: 'AGENT' });
  await adapter.insertOne('users', { id: 'u_outro', tenantId: 'tenant_outro', username: 'outro', name: 'OUTRO', role: 'AGENT' });
  const app = express();
  app.use(express.json());
  app.use('/branding', brandingRouter);
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
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const identidade = {
  organizationName: 'Agência Exemplo LTDA',
  productName: 'Atende+',
  logoUrl: 'https://cdn.exemplo.com.br/logo.png',
  faviconUrl: 'https://cdn.exemplo.com.br/icone.png',
  loginImageUrl: 'https://cdn.exemplo.com.br/fundo.jpg',
  primaryColor: '#E4572E',
  supportEmail: 'suporte@exemplo.com.br',
  supportWhatsapp: '+55 (11) 99999-0000'
};

test('sem identidade preenchida, a marca volta vazia e o painel usa a padrao', async () => {
  const r = await chamar('u_agente', 'GET', '/branding');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'default');
  assert.equal(r.body.productName, null);
});

test('admin salva a identidade e o atendente recebe a marca', async () => {
  const salvo = await chamar('u_admin', 'PATCH', '/tenant-modules/settings/identity', identidade);
  assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
  const r = await chamar('u_agente', 'GET', '/branding');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    productName: 'Atende+',
    organizationName: 'Agência Exemplo LTDA',
    logoUrl: 'https://cdn.exemplo.com.br/logo.png',
    faviconUrl: 'https://cdn.exemplo.com.br/icone.png',
    loginImageUrl: 'https://cdn.exemplo.com.br/fundo.jpg',
    primaryColor: '#e4572e',
    supportEmail: 'suporte@exemplo.com.br',
    supportWhatsapp: '5511999990000',
    source: 'tenant'
  });
});

test('marca de um tenant nao aparece para outro', async () => {
  const r = await chamar('u_outro', 'GET', '/branding');
  assert.equal(r.body.source, 'default');
  assert.equal(r.body.productName, null);
});

test('logo sem https e cor fora do formato sao recusados', async () => {
  for (const ruim of [{ logoUrl: 'http://cdn.exemplo.com.br/logo.png' }, { faviconUrl: 'javascript:alert(1)' }, { loginImageUrl: 'http://cdn.exemplo.com.br/fundo.jpg' }, { primaryColor: 'red' }, { supportWhatsapp: 'abc' }]) {
    const r = await chamar('u_admin', 'PATCH', '/tenant-modules/settings/identity', { ...identidade, ...ruim });
    assert.equal(r.status, 400, JSON.stringify(ruim));
  }
});

test('agente nao altera a identidade', async () => {
  const r = await chamar('u_agente', 'PATCH', '/tenant-modules/settings/identity', identidade);
  assert.equal(r.status, 403);
});

test('dado gravado antes da validacao nao vira url insegura nem cor quebrada', () => {
  const marca = sanitizeBranding({ logoUrl: 'javascript:alert(1)', faviconUrl: 'http://x.com/a.png', primaryColor: 'blue;}', productName: '  ' });
  assert.equal(marca.logoUrl, null);
  assert.equal(marca.faviconUrl, null);
  assert.equal(marca.primaryColor, null);
  assert.equal(marca.productName, null);
});
