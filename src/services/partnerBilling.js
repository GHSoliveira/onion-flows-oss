// Cobranca dos Parceiros pela Onion (fase 5 do white label).
//
// Todo mes, o Parceiro com valor por cliente definido recebe uma fatura no
// Asaas: clientes ativos x valor por cliente, com Pix, boleto ou cartao a
// escolha dele. O Asaas avisa por webhook quando a fatura e paga ou vence.
// Com mais de 10 dias de atraso, os clientes do Parceiro param de responder
// (mesmo bloqueio da cobranca de tenants); quando ele paga, voltam sozinhos.
import crypto from 'node:crypto';
import adapter from '../../db/DatabaseAdapter.js';
import { decryptString, encryptString } from '../utils/crypto.js';
import { generateId } from '../utils/helpers.js';
import { applyBillingBlock } from './billingGuard.js';
import { createLog } from './logs.js';
import { invalidateTenantCache } from './tenantLimits.js';

export const DIAS_DE_CARENCIA = 10;
const MOTIVO_BLOQUEIO = 'partner_overdue';
const AMBIENTES = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3'
};
const CONFIG_ID = 'partner_billing';

const falha = (message, status = 400) => Object.assign(new Error(message), { status });
const agora = () => new Date().toISOString();

// Datas no fuso de Brasilia: o "mes" e o vencimento sao os do Brasil.
export const hojeBrasil = (data = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(data);
export const periodoDe = (data = new Date()) => hojeBrasil(data).slice(0, 7);
export const proximoPeriodo = (periodo) => {
  const [ano, mes] = periodo.split('-').map(Number);
  return mes === 12 ? `${ano + 1}-01` : `${ano}-${String(mes + 1).padStart(2, '0')}`;
};

// --- Configuracao (super admin) ---

const lerConfig = async () => (await adapter.findOne('platformSettings', { id: CONFIG_ID }, { projection: { _id: 0 } })) || { id: CONFIG_ID };

export const getBillingSettings = async () => {
  const config = await lerConfig();
  return {
    environment: config.environment || 'sandbox',
    hasApiKey: Boolean(config.asaasApiKey),
    webhookToken: config.webhookToken ? decryptString(config.webhookToken) : null,
    updatedAt: config.updatedAt || null
  };
};

export const saveBillingSettings = async ({ environment, apiKey }, actorId) => {
  const config = await lerConfig();
  const next = {
    ...config,
    id: CONFIG_ID,
    environment: AMBIENTES[environment] ? environment : (config.environment || 'sandbox'),
    // A chave e so de escrita: vazia mantem a atual.
    asaasApiKey: apiKey ? encryptString(String(apiKey).trim()) : config.asaasApiKey,
    webhookToken: config.webhookToken || encryptString(crypto.randomBytes(24).toString('base64url')),
    updatedAt: agora()
  };
  await adapter.updateOne('platformSettings', { id: CONFIG_ID }, { $set: next }, { upsert: true });
  await createLog('PARTNER_BILLING_SETTINGS', { environment: next.environment, apiKeyChanged: Boolean(apiKey) }, actorId);
  return getBillingSettings();
};

const asaas = async (caminho, { method = 'GET', body } = {}) => {
  const config = await lerConfig();
  const chave = config.asaasApiKey ? decryptString(config.asaasApiKey) : null;
  if (!chave) throw falha('Cobrança não configurada: falta a chave do Asaas.', 409);
  const res = await fetch(`${AMBIENTES[config.environment] || AMBIENTES.sandbox}${caminho}`, {
    method,
    headers: { access_token: chave, 'Content-Type': 'application/json', 'User-Agent': 'onion-flows' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const motivo = data?.errors?.[0]?.description || `Asaas respondeu ${res.status}`;
    throw falha(motivo, res.status === 401 ? 409 : 502);
  }
  return data;
};

export const testBillingConnection = async () => {
  await asaas('/customers?limit=1');
  return { ok: true };
};

// --- Dados de cobranca do Parceiro ---

const limparDocumento = (valor) => String(valor || '').replace(/\D/g, '');

export const updatePartnerBilling = async (partnerId, dados, actorId) => {
  const partner = await adapter.findOne('partners', { id: partnerId }, { projection: { _id: 0 } });
  if (!partner) throw falha('Parceiro não encontrado.', 404);
  const atual = partner.billing || {};
  const preco = dados.pricePerClient !== undefined ? Math.round(Number(dados.pricePerClient) * 100) / 100 : atual.pricePerClient;
  const billing = {
    ...atual,
    pricePerClient: Number.isFinite(preco) && preco > 0 ? preco : 0,
    dueDay: dados.dueDay !== undefined ? Math.min(28, Math.max(1, Number(dados.dueDay) || 10)) : (atual.dueDay || 10),
    legalName: dados.legalName !== undefined ? String(dados.legalName).trim() : (atual.legalName || ''),
    cpfCnpj: dados.cpfCnpj !== undefined ? limparDocumento(dados.cpfCnpj) : (atual.cpfCnpj || ''),
    email: dados.email !== undefined ? String(dados.email).trim() : (atual.email || ''),
    // Comecar a cobrar so no mes seguinte ao primeiro valor definido: ninguem
    // recebe a fatura de um mes inteiro no meio dele.
    startPeriod: atual.startPeriod || (preco > 0 ? proximoPeriodo(periodoDe()) : null)
  };
  if (billing.cpfCnpj && ![11, 14].includes(billing.cpfCnpj.length)) throw falha('CPF ou CNPJ inválido.');
  await adapter.updateOne('partners', { id: partnerId }, { $set: { billing, updatedAt: agora() } });
  await createLog('PARTNER_BILLING_UPDATE', { partnerId, pricePerClient: billing.pricePerClient, dueDay: billing.dueDay }, actorId);
  return billing;
};

// Cliente ativo: tenant da carteira que nao foi suspenso pelo Parceiro. Os
// bloqueados por atraso do proprio Parceiro continuam contando.
export const contarClientesAtivos = async (partnerId) => {
  const tenants = (await adapter.findMany('tenants', { query: { partnerId } })) || [];
  return tenants.filter((t) => !(t.billing?.blocked && t.billing?.blockReason !== MOTIVO_BLOQUEIO)).length;
};

export const listarFaturas = async (partnerId) => {
  const faturas = (await adapter.findMany('partnerInvoices', { query: { partnerId } })) || [];
  return faturas.sort((a, b) => String(b.period).localeCompare(String(a.period)));
};

const garantirClienteAsaas = async (partner) => {
  if (partner.billing?.asaasCustomerId) return partner.billing.asaasCustomerId;
  const billing = partner.billing || {};
  if (!billing.cpfCnpj) throw falha('Preencha o CPF ou CNPJ do Parceiro antes de cobrar.');
  const cliente = await asaas('/customers', {
    method: 'POST',
    body: { name: billing.legalName || partner.name, cpfCnpj: billing.cpfCnpj, email: billing.email || undefined, externalReference: partner.id }
  });
  await adapter.updateOne('partners', { id: partner.id }, { $set: { 'billing.asaasCustomerId': cliente.id, updatedAt: agora() } });
  return cliente.id;
};

// Vencimento no dia combinado; se esse dia ja passou ou esta a menos de 3
// dias (fatura gerada no meio do mes), vence 5 dias depois de hoje.
const vencimentoPara = (periodo, dia, hoje = hojeBrasil()) => {
  const combinado = `${periodo}-${String(dia).padStart(2, '0')}`;
  const limite = new Date(`${hoje}T12:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() + 3);
  if (combinado >= limite.toISOString().slice(0, 10)) return combinado;
  const novo = new Date(`${hoje}T12:00:00Z`);
  novo.setUTCDate(novo.getUTCDate() + 5);
  return novo.toISOString().slice(0, 10);
};

// Gera a fatura de um periodo. Idempotente: so uma fatura por Parceiro e mes.
export const gerarFatura = async (partnerId, periodo = periodoDe(), { forcar = false } = {}) => {
  const partner = await adapter.findOne('partners', { id: partnerId }, { projection: { _id: 0 } });
  if (!partner) throw falha('Parceiro não encontrado.', 404);
  const billing = partner.billing || {};
  if (!(billing.pricePerClient > 0)) return null;
  if (!forcar && billing.startPeriod && periodo < billing.startPeriod) return null;

  // Uma fatura valendo por mes. Cancelada ou estornada fica no historico: o
  // ciclo automatico nao recria, mas gerar na mao (forcar) cria outra.
  const doPeriodo = (await adapter.findMany('partnerInvoices', { query: { partnerId, period: periodo } })) || [];
  const valendo = doPeriodo.find((f) => !['canceled', 'refunded', 'error'].includes(f.status));
  if (valendo) return valendo;
  const existente = doPeriodo.find((f) => f.status === 'error') || null;
  if (!existente && doPeriodo.length && !forcar) return doPeriodo[0];

  const clientes = await contarClientesAtivos(partnerId);
  const valor = Math.round(clientes * billing.pricePerClient * 100) / 100;
  const fatura = existente || {
    id: generateId('pinv'),
    partnerId,
    period: periodo,
    createdAt: agora()
  };
  Object.assign(fatura, {
    activeClients: clientes,
    unitPrice: billing.pricePerClient,
    amount: valor,
    dueDate: vencimentoPara(periodo, billing.dueDay || 10),
    updatedAt: agora()
  });

  if (valor <= 0) {
    Object.assign(fatura, { status: 'nothing_due' });
    await adapter.updateOne('partnerInvoices', { id: fatura.id }, { $set: fatura }, { upsert: true });
    return fatura;
  }

  Object.assign(fatura, { status: 'creating' });
  await adapter.updateOne('partnerInvoices', { id: fatura.id }, { $set: fatura }, { upsert: true });
  try {
    const customer = await garantirClienteAsaas(partner);
    const cobranca = await asaas('/payments', {
      method: 'POST',
      body: {
        customer,
        billingType: 'UNDEFINED',
        value: valor,
        dueDate: fatura.dueDate,
        description: `Onion Flows ${periodo}: ${clientes} cliente(s) ativo(s) x R$ ${billing.pricePerClient.toFixed(2).replace('.', ',')}`,
        externalReference: fatura.id
      }
    });
    Object.assign(fatura, { status: 'pending', asaasPaymentId: cobranca.id, invoiceUrl: cobranca.invoiceUrl || null, lastError: null, updatedAt: agora() });
  } catch (error) {
    Object.assign(fatura, { status: 'error', lastError: error.message, updatedAt: agora() });
  }
  await adapter.updateOne('partnerInvoices', { id: fatura.id }, { $set: fatura });
  await createLog('PARTNER_INVOICE', { partnerId, invoiceId: fatura.id, period: periodo, amount: valor, status: fatura.status }, 'system');
  return fatura;
};

// --- Bloqueio por atraso ---

const bloquearParceiro = async (partner) => {
  if (partner.billing?.blocked) return;
  await adapter.updateOne('partners', { id: partner.id }, { $set: { 'billing.blocked': true, 'billing.blockedAt': agora(), updatedAt: agora() } });
  const tenants = (await adapter.findMany('tenants', { query: { partnerId: partner.id } })) || [];
  for (const tenant of tenants) {
    if (!tenant.billing?.blocked) await applyBillingBlock(tenant.id, true, MOTIVO_BLOQUEIO);
  }
  invalidateTenantCache();
  await createLog('PARTNER_BILLING_BLOCK', { partnerId: partner.id, tenants: tenants.length }, 'system');
};

const desbloquearParceiro = async (partnerId) => {
  const partner = await adapter.findOne('partners', { id: partnerId }, { projection: { _id: 0 } });
  if (!partner?.billing?.blocked) return;
  await adapter.updateOne('partners', { id: partnerId }, { $set: { 'billing.blocked': false, 'billing.blockedAt': null, updatedAt: agora() } });
  // So libera o que este bloqueio prendeu: cliente suspenso pelo Parceiro fica.
  const tenants = (await adapter.findMany('tenants', { query: { partnerId } })) || [];
  for (const tenant of tenants) {
    if (tenant.billing?.blocked && tenant.billing?.blockReason === MOTIVO_BLOQUEIO) await applyBillingBlock(tenant.id, false);
  }
  invalidateTenantCache();
  await createLog('PARTNER_BILLING_UNBLOCK', { partnerId }, 'system');
};

const diasEntre = (de, ate) => Math.floor((new Date(`${ate}T12:00:00Z`) - new Date(`${de}T12:00:00Z`)) / 86_400_000);

export const verificarAtrasos = async (hoje = hojeBrasil()) => {
  const abertas = ((await adapter.getCollection('partnerInvoices')) || [])
    .filter((f) => ['pending', 'overdue'].includes(f.status) && f.dueDate && diasEntre(f.dueDate, hoje) > DIAS_DE_CARENCIA);
  const parceiros = [...new Set(abertas.map((f) => f.partnerId))];
  for (const partnerId of parceiros) {
    const partner = await adapter.findOne('partners', { id: partnerId }, { projection: { _id: 0 } });
    if (partner) await bloquearParceiro(partner);
  }
  return parceiros;
};

// --- Webhook do Asaas ---

const STATUS_POR_EVENTO = {
  PAYMENT_RECEIVED: 'paid',
  PAYMENT_CONFIRMED: 'paid',
  PAYMENT_OVERDUE: 'overdue',
  PAYMENT_DELETED: 'canceled',
  PAYMENT_REFUNDED: 'refunded'
};

export const tokenDoWebhookConfere = async (recebido) => {
  const config = await lerConfig();
  const esperado = config.webhookToken ? decryptString(config.webhookToken) : null;
  if (!esperado || typeof recebido !== 'string') return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const processarWebhook = async (evento = {}) => {
  const novoStatus = STATUS_POR_EVENTO[evento.event];
  if (!novoStatus || !evento.payment) return { ignorado: true };
  // O Asaas reenvia eventos: cada id e tratado uma vez.
  if (evento.id) {
    const visto = await adapter.findOne('partnerBillingEvents', { id: evento.id });
    if (visto) return { repetido: true };
    await adapter.insertOne('partnerBillingEvents', { id: evento.id, event: evento.event, receivedAt: agora() });
  }
  const pagamento = evento.payment;
  const fatura = (pagamento.externalReference && await adapter.findOne('partnerInvoices', { id: pagamento.externalReference }))
    || await adapter.findOne('partnerInvoices', { asaasPaymentId: pagamento.id });
  if (!fatura) return { semFatura: true };
  // Fatura paga nao volta para vencida por um evento atrasado.
  if (fatura.status === 'paid' && novoStatus === 'overdue') return { mantida: true };

  const set = { status: novoStatus, updatedAt: agora() };
  if (novoStatus === 'paid') set.paidAt = agora();
  if (novoStatus === 'overdue') set.overdueAt = agora();
  await adapter.updateOne('partnerInvoices', { id: fatura.id }, { $set: set });
  await createLog('PARTNER_INVOICE_STATUS', { invoiceId: fatura.id, partnerId: fatura.partnerId, event: evento.event, status: novoStatus }, 'system');

  if (novoStatus === 'paid') {
    const pendentes = ((await adapter.findMany('partnerInvoices', { query: { partnerId: fatura.partnerId } })) || [])
      .filter((f) => f.id !== fatura.id && ['pending', 'overdue'].includes(f.status) && f.dueDate && diasEntre(f.dueDate, hojeBrasil()) > DIAS_DE_CARENCIA);
    if (!pendentes.length) await desbloquearParceiro(fatura.partnerId);
  }
  return { fatura: fatura.id, status: novoStatus };
};

// --- Ciclo automatico ---

export const rodarCicloDeCobranca = async (data = new Date()) => {
  const periodo = periodoDe(data);
  const parceiros = (await adapter.getCollection('partners')) || [];
  const geradas = [];
  for (const partner of parceiros) {
    if (partner.status === 'suspended' || !(partner.billing?.pricePerClient > 0)) continue;
    const fatura = await gerarFatura(partner.id, periodo).catch(() => null);
    if (fatura) geradas.push(fatura.id);
  }
  const bloqueados = await verificarAtrasos(hojeBrasil(data));
  return { periodo, geradas, bloqueados };
};

let timer = null;
export const startPartnerBillingWorker = () => {
  if (timer) return;
  const rodar = () => rodarCicloDeCobranca().catch((error) => console.error('[PARTNER_BILLING]', error.message));
  setTimeout(rodar, 60_000).unref?.();
  timer = setInterval(rodar, 60 * 60 * 1000);
  timer.unref?.();
  console.log('[PARTNER_BILLING] Ciclo de cobranca dos Parceiros ativo (a cada hora)');
};
export const stopPartnerBillingWorker = () => { if (timer) clearInterval(timer); timer = null; };
