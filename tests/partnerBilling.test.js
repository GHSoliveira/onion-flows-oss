import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';

// Cobranca dos Parceiros (fase 5): fatura mensal no Asaas por cliente ativo,
// aviso de pagamento por webhook e bloqueio dos clientes depois de 10 dias de
// atraso, com liberacao automatica quando paga. O Asaas e simulado.

const dbPath = path.join(os.tmpdir(), `partner-billing-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'partner-billing-test-only';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { partnerRouter, partnersAdminRouter, partnerBillingWebhookRouter } = await import('../src/routes/partner.js');
const billing = await import('../src/services/partnerBilling.js');
const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');

const fetchOriginal = global.fetch;
const asaas = { chamadas: [] };
let server;
let base;
let tokenWebhook;

before(async () => {
  await adapter.init();
  await adapter.insertOne('users', { id: 'u_onion', username: 'onion', name: 'ONION', role: 'SUPER_ADMIN', permissions: ['*'] });
  await adapter.insertOne('partners', { id: 'partner_a', name: 'Agência A', status: 'active', maxTenants: 20, branding: {} });
  await adapter.insertOne('users', { id: 'u_parceiro', username: 'agencia.a', name: 'AGÊNCIA', role: 'PARTNER', partnerId: 'partner_a' });
  await adapter.insertOne('tenants', { id: 't_ativo', name: 'Ativo', partnerId: 'partner_a', status: 'active', billing: { paymentStatus: 'open' } });
  await adapter.insertOne('tenants', { id: 't_ativo2', name: 'Ativo 2', partnerId: 'partner_a', status: 'active', billing: { paymentStatus: 'open' } });
  await adapter.insertOne('tenants', { id: 't_suspenso', name: 'Suspenso pelo parceiro', partnerId: 'partner_a', status: 'active', billing: { blocked: true, blockReason: 'partner' } });

  // Asaas simulado: so o que a cobranca usa.
  global.fetch = async (url, opcoes = {}) => {
    const destino = String(url);
    if (!destino.startsWith('https://api-sandbox.asaas.com/v3')) return fetchOriginal(url, opcoes);
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    asaas.chamadas.push({ metodo: opcoes.method || 'GET', caminho: destino.replace('https://api-sandbox.asaas.com/v3', ''), corpo, chave: opcoes.headers?.access_token });
    const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (destino.endsWith('/customers') && opcoes.method === 'POST') return json({ id: 'cus_123' });
    if (destino.endsWith('/payments')) return json({ id: `pay_${asaas.chamadas.length}`, status: 'PENDING', invoiceUrl: 'https://sandbox.asaas.com/i/abc' });
    return json({ data: [] });
  };

  const app = express();
  app.use(express.json());
  app.use('/partner', partnerRouter);
  app.use('/partners', partnersAdminRouter);
  app.use('/billing', partnerBillingWebhookRouter);
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

const chamar = async (userId, method, url, body, headers = {}) => {
  const token = userId ? jwt.sign({ userId }, JWT_SECRET_VALUE, { expiresIn: 60 }) : null;
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const periodo = billing.periodoDe();

test('Onion configura o Asaas; a chave nunca volta na resposta', async () => {
  const salvo = await chamar('u_onion', 'PUT', '/partners/billing-settings', { environment: 'sandbox', apiKey: '$aact_teste_123' });
  assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
  assert.equal(salvo.body.hasApiKey, true);
  assert.ok(salvo.body.webhookToken.length >= 20);
  assert.ok(!JSON.stringify(salvo.body).includes('aact_teste'));
  tokenWebhook = salvo.body.webhookToken;
  assert.equal((await chamar('u_parceiro', 'GET', '/partners/billing-settings')).status, 403);
});

test('valor por cliente vale a partir do mes seguinte', async () => {
  const r = await chamar('u_onion', 'PATCH', '/partners/partner_a/billing', { pricePerClient: 49.9, dueDay: 10, cpfCnpj: '12.345.678/0001-90', legalName: 'Agência A LTDA', email: 'financeiro@agencia-a.com.br' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.startPeriod, billing.proximoPeriodo(periodo));
  const ciclo = await billing.rodarCicloDeCobranca();
  assert.deepEqual(ciclo.geradas, []);
  assert.equal(asaas.chamadas.length, 0);
});

test('fatura cobra so os clientes ativos e e criada uma vez por mes', async () => {
  const r = await chamar('u_onion', 'POST', '/partners/partner_a/invoices/generate');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.activeClients, 2);
  assert.equal(r.body.amount, 99.8);
  assert.equal(r.body.status, 'pending');
  // Vencimento no dia 10, ou 5 dias depois de hoje se o dia 10 ja passou.
  const hoje = billing.hojeBrasil();
  const cincoDias = new Date(`${hoje}T12:00:00Z`);
  cincoDias.setUTCDate(cincoDias.getUTCDate() + 5);
  const tresDias = new Date(`${hoje}T12:00:00Z`);
  tresDias.setUTCDate(tresDias.getUTCDate() + 3);
  const esperado = `${periodo}-10` >= tresDias.toISOString().slice(0, 10) ? `${periodo}-10` : cincoDias.toISOString().slice(0, 10);
  assert.equal(r.body.dueDate, esperado);
  const pagamento = asaas.chamadas.find((c) => c.caminho === '/payments');
  assert.equal(pagamento.corpo.billingType, 'UNDEFINED');
  assert.equal(pagamento.corpo.value, 99.8);
  assert.equal(pagamento.corpo.externalReference, r.body.id);
  assert.equal(pagamento.chave, '$aact_teste_123');
  const antes = asaas.chamadas.length;
  const deNovo = await chamar('u_onion', 'POST', '/partners/partner_a/invoices/generate');
  assert.equal(deNovo.body.id, r.body.id);
  assert.equal(asaas.chamadas.length, antes);
});

test('aviso do Asaas sem o token certo e recusado; evento repetido conta uma vez', async () => {
  const fatura = (await billing.listarFaturas('partner_a'))[0];
  const evento = { id: 'evt_1', event: 'PAYMENT_OVERDUE', payment: { id: fatura.asaasPaymentId, externalReference: fatura.id } };
  assert.equal((await chamar(null, 'POST', '/billing/asaas/webhook', evento, { 'asaas-access-token': 'errado' })).status, 401);
  const r = await chamar(null, 'POST', '/billing/asaas/webhook', evento, { 'asaas-access-token': tokenWebhook });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'overdue');
  const repetido = await chamar(null, 'POST', '/billing/asaas/webhook', evento, { 'asaas-access-token': tokenWebhook });
  assert.equal(repetido.body.repetido, true);
});

test('mais de 10 dias de atraso bloqueia os clientes; pagar libera, menos o suspenso pelo Parceiro', async () => {
  const fatura = (await billing.listarFaturas('partner_a'))[0];
  const venceu = new Date(`${fatura.dueDate}T12:00:00Z`);
  const dezDias = new Date(venceu.getTime() + 10 * 86_400_000).toISOString().slice(0, 10);
  const onzeDias = new Date(venceu.getTime() + 11 * 86_400_000).toISOString().slice(0, 10);
  assert.deepEqual(await billing.verificarAtrasos(dezDias), []);
  assert.deepEqual(await billing.verificarAtrasos(onzeDias), ['partner_a']);
  const ativo = await adapter.findOne('tenants', { id: 't_ativo' });
  assert.equal(ativo.billing.blocked, true);
  assert.equal(ativo.billing.blockReason, 'partner_overdue');
  assert.equal((await adapter.findOne('tenants', { id: 't_suspenso' })).billing.blockReason, 'partner');
  // Bloqueado por atraso continua contando como cliente ativo.
  assert.equal(await billing.contarClientesAtivos('partner_a'), 2);
  // Com atraso, o Parceiro nao reativa cliente nem cria cliente novo para furar o bloqueio.
  assert.equal((await chamar('u_parceiro', 'PATCH', '/partner/tenants/t_ativo', { status: 'active' })).status, 402);
  assert.equal((await chamar('u_parceiro', 'POST', '/partner/tenants', { name: 'Novo', admin: { name: 'X', username: 'novo.dono', password: 'senha-de-teste-1' } })).status, 402);

  const pago = await chamar(null, 'POST', '/billing/asaas/webhook', { id: 'evt_2', event: 'PAYMENT_RECEIVED', payment: { id: fatura.asaasPaymentId, externalReference: fatura.id } }, { 'asaas-access-token': tokenWebhook });
  assert.equal(pago.body.status, 'paid');
  assert.equal((await adapter.findOne('tenants', { id: 't_ativo' })).billing.blocked, false);
  assert.equal((await adapter.findOne('tenants', { id: 't_ativo2' })).billing.blocked, false);
  assert.equal((await adapter.findOne('tenants', { id: 't_suspenso' })).billing.blocked, true);
  assert.equal((await adapter.findOne('partners', { id: 'partner_a' })).billing.blocked, false);
});

test('fatura paga nao volta a vencida por aviso atrasado', async () => {
  const fatura = (await billing.listarFaturas('partner_a'))[0];
  const r = await chamar(null, 'POST', '/billing/asaas/webhook', { id: 'evt_3', event: 'PAYMENT_OVERDUE', payment: { id: fatura.asaasPaymentId, externalReference: fatura.id } }, { 'asaas-access-token': tokenWebhook });
  assert.equal(r.body.mantida, true);
  assert.equal((await billing.listarFaturas('partner_a'))[0].status, 'paid');
});

test('Parceiro ve a propria cobranca sem dados internos do Asaas', async () => {
  const r = await chamar('u_parceiro', 'GET', '/partner/billing');
  assert.equal(r.status, 200);
  assert.equal(r.body.pricePerClient, 49.9);
  assert.equal(r.body.activeClients, 2);
  assert.equal(r.body.invoices[0].status, 'paid');
  assert.equal(r.body.invoices[0].asaasPaymentId, undefined);
  assert.equal(r.body.invoices[0].invoiceUrl, 'https://sandbox.asaas.com/i/abc');
});

test('varredura da tela Billing nao bloqueia cliente de agencia por status manual', async () => {
  const { runAutoBlockScan } = await import('../src/services/billingGuard.js');
  const vencidoHa15Dias = new Date(Date.now() - 15 * 86_400_000).toISOString();
  await adapter.insertOne('tenants', { id: 't_direto_vencido', name: 'Direto', status: 'active', billing: { paymentStatus: 'overdue', overdueAt: vencidoHa15Dias } });
  await adapter.insertOne('tenants', { id: 't_agencia_vencido', name: 'Da agência', partnerId: 'partner_x', status: 'active', billing: { paymentStatus: 'overdue', overdueAt: vencidoHa15Dias } });
  const bloqueados = await runAutoBlockScan();
  assert.ok(bloqueados.includes('t_direto_vencido'));
  assert.ok(!bloqueados.includes('t_agencia_vencido'));
  assert.notEqual((await adapter.findOne('tenants', { id: 't_agencia_vencido' })).billing.blocked, true);
});

test('fatura cancelada no mes: gerar na mao cria outra; o ciclo automatico nao recria', async () => {
  await adapter.insertOne('partners', { id: 'partner_c', name: 'Agência C', status: 'active', maxTenants: 20, branding: {} });
  await adapter.insertOne('tenants', { id: 't_c1', name: 'Cliente C', partnerId: 'partner_c', status: 'active', billing: {} });
  await chamar('u_onion', 'PATCH', '/partners/partner_c/billing', { pricePerClient: 149, cpfCnpj: '12.345.678/0001-90', legalName: 'Agência C' });
  const primeira = await chamar('u_onion', 'POST', '/partners/partner_c/invoices/generate');
  assert.equal(primeira.body.amount, 149);
  assert.equal(primeira.body.alreadyExisted, false);
  const cancelada = await chamar(null, 'POST', '/billing/asaas/webhook', { id: 'evt_c1', event: 'PAYMENT_DELETED', payment: { id: primeira.body.asaasPaymentId, externalReference: primeira.body.id } }, { 'asaas-access-token': tokenWebhook });
  assert.equal(cancelada.body.status, 'canceled');

  // O ciclo automatico (ja cobrando neste mes) respeita o cancelamento.
  await adapter.updateOne('partners', { id: 'partner_c' }, { $set: { 'billing.startPeriod': periodo } });
  assert.equal((await billing.gerarFatura('partner_c', periodo)).id, primeira.body.id);

  await chamar('u_onion', 'PATCH', '/partners/partner_c/billing', { pricePerClient: 5 });
  const segunda = await chamar('u_onion', 'POST', '/partners/partner_c/invoices/generate');
  assert.notEqual(segunda.body.id, primeira.body.id);
  assert.equal(segunda.body.amount, 5);
  assert.equal(segunda.body.status, 'pending');

  const deNovo = await chamar('u_onion', 'POST', '/partners/partner_c/invoices/generate');
  assert.equal(deNovo.body.id, segunda.body.id);
  assert.equal(deNovo.body.alreadyExisted, true);
  assert.equal((await billing.listarFaturas('partner_c')).length, 2, 'a cancelada fica no historico');
});
