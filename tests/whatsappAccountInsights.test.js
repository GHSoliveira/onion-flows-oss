import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Retrato da conta WhatsApp para o dashboard: normalizacao dos formatos reais da
// Graph API, cache, alertas por comparacao e secao que falha sem apagar o resto.

const dbPath = path.join(os.tmpdir(), `onion-account-insights-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'account-insights-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const insightsModule = await import('../src/services/whatsappAccountInsights.js');
const {
  buildDateRange,
  getAccountInsights,
  normalizeHealth,
  summarizeMessages,
  summarizePricing,
  summarizeTemplatePerformance,
  summarizeTemplates
} = insightsModule;
const { listAccountAlerts } = await import('../src/services/whatsappAccountAlerts.js');

const DAY = 86400;
const agora = new Date();
const hojeUtc = Math.floor(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()) / 1000);
const diaBrasilia = (diasAtras) => hojeUtc - diasAtras * DAY + 3 * 3600;
const mais = (minutos) => new Date(agora.getTime() + minutos * 60 * 1000);

// Formatos copiados das respostas reais da Graph API v24.0.
const estado = { quality: 'GREEN', t2: 'PENDING', pricingFalha: false };
let chamadas = 0;
const originalFetch = globalThis.fetch;

const resposta = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const graphFake = async (url) => {
  chamadas += 1;
  const u = new URL(String(url));
  const fields = u.searchParams.get('fields') || '';

  if (u.pathname.endsWith('/sender_insights')) {
    return resposta({
      id: 'sender_insights',
      display_phone_number: '+55 11 9700-0056',
      verified_name: 'Onion Web Services',
      name_status: 'NON_EXISTS',
      new_name_status: 'PENDING_REVIEW',
      quality_rating: estado.quality,
      messaging_limit_tier: 'TIER_250',
      throughput: { level: 'STANDARD' },
      status: 'CONNECTED',
      account_mode: 'LIVE',
      health_status: {
        can_send_message: 'LIMITED',
        entities: [{
          entity_type: 'PHONE_NUMBER',
          id: 'sender_insights',
          can_send_message: 'LIMITED',
          errors: [{ error_code: 138024, error_description: 'WhatsApp Business calling cannot use SIP because it is not enabled.' }],
          additional_info: ['Your display name has not been approved yet. Your message limit will increase after the display name is approved.']
        }]
      }
    });
  }
  if (fields.startsWith('analytics.')) {
    return resposta({
      analytics: {
        granularity: 'DAY',
        data_points: [
          { start: diaBrasilia(2), end: diaBrasilia(1), sent: 83, delivered: 80 },
          { start: diaBrasilia(1), end: diaBrasilia(0), sent: 17, delivered: 17 },
          { start: diaBrasilia(90), end: diaBrasilia(89), sent: 999, delivered: 999 }
        ]
      }
    });
  }
  if (fields.startsWith('pricing_analytics.')) {
    if (estado.pricingFalha) return resposta({ error: { message: 'Temporarily unavailable', code: 2 } }, 500);
    return resposta({
      pricing_analytics: {
        data: [{
          data_points: [
            { start: diaBrasilia(2), end: diaBrasilia(1), pricing_type: 'FREE_CUSTOMER_SERVICE', pricing_category: 'SERVICE', volume: 35, cost: 0 },
            { start: diaBrasilia(2), end: diaBrasilia(1), pricing_type: 'REGULAR', pricing_category: 'MARKETING', volume: 2, cost: 0.125 },
            { start: diaBrasilia(1), end: diaBrasilia(0), pricing_type: 'REGULAR', pricing_category: 'MARKETING', volume: 2, cost: 0.125 }
          ]
        }]
      }
    });
  }
  if (u.pathname.endsWith('/waba_insights')) {
    return resposta({
      id: 'waba_insights',
      name: 'Empresa Exemplo',
      currency: 'USD',
      timezone_id: '25',
      account_review_status: 'APPROVED',
      business_verification_status: 'verified',
      ownership_type: 'SELF',
      owner_business_info: { name: 'Empresa Exemplo', id: '100000000000002' },
      is_enabled_for_insights: true,
      health_status: { can_send_message: 'AVAILABLE', entities: [{ entity_type: 'WABA', id: 'waba_insights', can_send_message: 'AVAILABLE' }] }
    });
  }
  if (u.pathname.endsWith('/message_templates')) {
    return resposta({
      data: [
        { id: '1', name: 'boas_vindas', status: 'APPROVED', category: 'MARKETING', language: 'pt_BR', quality_score: { score: 'GREEN' }, rejected_reason: 'NONE' },
        { id: '2', name: 'promo', status: estado.t2, category: 'MARKETING', language: 'pt_BR', quality_score: { score: 'UNKNOWN' }, rejected_reason: estado.t2 === 'REJECTED' ? 'PROMOTIONAL' : 'NONE' }
      ]
    });
  }
  if (u.pathname.endsWith('/template_analytics')) {
    return resposta({
      data: [{
        granularity: 'DAILY',
        data_points: [
          { template_id: '1', start: hojeUtc - DAY, end: hojeUtc, sent: 10, delivered: 10, read: 4, clicked: [{ type: 'quick_reply_button', button_content: 'Sim', count: 3 }] },
          { template_id: '1', start: hojeUtc, end: hojeUtc + DAY, sent: 0, delivered: 0, read: 0 }
        ]
      }]
    });
  }
  return resposta({ error: { message: `rota nao simulada: ${u.pathname} ${fields}` } }, 400);
};

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('channelConfigs', {
    id: 'channels_tenant_insights',
    tenantId: 'tenant_insights',
    whatsapp: { enabled: true, accessToken: 'token', wabaId: 'waba_insights', phoneNumberId: 'sender_insights' }
  });
  await adapter.insertOne('channelConfigs', {
    id: 'channels_tenant_sem_token',
    tenantId: 'tenant_sem_token',
    whatsapp: { enabled: false, phoneNumberId: 'sender_x' }
  });
  globalThis.fetch = graphFake;
});

after(() => {
  globalThis.fetch = originalFetch;
  try { fs.unlinkSync(dbPath); } catch {}
});

/* ------------------------------ normalizacao ------------------------------ */

test('janela de 30 dias termina hoje e cada dia sem dado vira zero', () => {
  const range = buildDateRange(30, agora);
  assert.equal(range.dates.length, 30);
  assert.equal(range.dates.at(-1), agora.toISOString().slice(0, 10));

  const resumo = summarizeMessages({
    data_points: [
      { start: diaBrasilia(1), sent: 5, delivered: 4 },
      { start: diaBrasilia(90), sent: 999, delivered: 999 }
    ]
  }, range.dates);
  assert.equal(resumo.days.length, 30);
  assert.equal(resumo.sent, 5, 'ponto fora da janela nao entra');
  assert.equal(resumo.days.filter((d) => d.sent === 0).length, 29);
});

test('custo separa gratuito de pago e soma sem erro de ponto flutuante', () => {
  const { dates } = buildDateRange(30, agora);
  const pricing = summarizePricing({
    data: [{
      data_points: [
        { start: diaBrasilia(3), pricing_type: 'FREE_CUSTOMER_SERVICE', pricing_category: 'SERVICE', volume: 35, cost: 0 },
        { start: diaBrasilia(3), pricing_type: 'REGULAR', pricing_category: 'MARKETING', volume: 1, cost: 0.1 },
        { start: diaBrasilia(2), pricing_type: 'REGULAR', pricing_category: 'MARKETING', volume: 1, cost: 0.2 },
        { start: diaBrasilia(2), pricing_type: 'FREE_ENTRY_POINT', pricing_category: 'UTILITY', volume: 3, cost: 0 }
      ]
    }]
  }, dates, 'usd');

  assert.equal(pricing.currency, 'USD');
  assert.equal(pricing.cost, 0.3);
  assert.equal(pricing.volume, 40);
  assert.equal(pricing.freeVolume, 38);
  assert.equal(pricing.paidVolume, 2);
  assert.deepEqual(pricing.categories.map((c) => c.category), ['SERVICE', 'UTILITY', 'MARKETING']);
});

test('templates que pedem atencao: recusado, pausado e qualidade ruim', () => {
  const resumo = summarizeTemplates([
    { id: 1, name: 'ok', status: 'APPROVED', category: 'UTILITY', quality_score: { score: 'GREEN' }, rejected_reason: 'NONE' },
    { id: 2, name: 'recusado', status: 'REJECTED', category: 'MARKETING', rejected_reason: 'PROMOTIONAL' },
    { id: 3, name: 'pausado', status: 'PAUSED', category: 'MARKETING' },
    { id: 4, name: 'amarelo', status: 'APPROVED', category: 'MARKETING', quality_score: { score: 'YELLOW' } },
    { id: 5, name: 'novo', status: 'PENDING', category: 'UTILITY' }
  ]);
  assert.equal(resumo.total, 5);
  assert.deepEqual(resumo.byStatus, { APPROVED: 2, REJECTED: 1, PAUSED: 1, PENDING: 1 });
  assert.deepEqual(resumo.attention.map((t) => t.name), ['recusado', 'pausado', 'amarelo']);
  assert.equal(resumo.items[0].rejectedReason, null);
  assert.equal(resumo.items[1].rejectedReason, 'PROMOTIONAL');
});

test('problema de chamada de voz fica separado do que afeta mensagens', () => {
  const { canSendMessage, issues } = normalizeHealth({
    can_send_message: 'limited',
    entities: [{
      entity_type: 'PHONE_NUMBER',
      errors: [{ error_code: 138024, error_description: 'WhatsApp Business calling cannot use SIP.' }],
      additional_info: ['Your display name has not been approved yet.']
    }]
  });
  assert.equal(canSendMessage, 'LIMITED');
  assert.deepEqual(issues.map((i) => i.area), ['calling', 'messaging']);
});

test('desempenho de template soma cliques em lista e calcula taxa de leitura', () => {
  const perf = summarizeTemplatePerformance(
    [{ data: [{ data_points: [
      { template_id: '9', sent: 10, delivered: 8, read: 2, clicked: [{ count: 1 }, { count: 2 }] },
      { template_id: '9', sent: 0, delivered: 0, read: 0 },
      { template_id: '7', sent: 0, delivered: 0, read: 0 }
    ] }] }],
    [{ id: '9', name: 'aviso', category: 'UTILITY' }]
  );
  assert.deepEqual(perf, [{ id: '9', sent: 10, delivered: 8, read: 2, clicked: 3, name: 'aviso', category: 'UTILITY', readRate: 0.25 }]);
});

/* --------------------------------- retrato --------------------------------- */

test('primeiro retrato busca tudo na Meta e nao gera alerta', async () => {
  const r = await getAccountInsights('tenant_insights', { now: agora });

  assert.equal(r.connected, true);
  assert.equal(r.cached, false);
  const { insights } = r;
  assert.equal(insights.phone.qualityRating, 'GREEN');
  assert.equal(insights.phone.canSendMessage, 'LIMITED');
  assert.equal(insights.account.ownerBusinessName, 'Empresa Exemplo');
  assert.equal(insights.messages.sent, 100);
  assert.equal(insights.pricing.cost, 0.25);
  assert.equal(insights.pricing.currency, 'USD');
  assert.equal(insights.templates.total, 2);
  assert.deepEqual(insights.templatePerformance.map((t) => [t.name, t.sent, t.clicked]), [['boas_vindas', 10, 3]]);
  assert.deepEqual(insights.errors, {});
  assert.equal((await listAccountAlerts('tenant_insights')).alerts.length, 0);
});

test('dentro de 15 minutos o dashboard le o retrato salvo sem chamar a Meta', async () => {
  const antes = chamadas;
  const r = await getAccountInsights('tenant_insights', { now: mais(10) });
  assert.equal(r.cached, true);
  assert.equal(chamadas, antes);
});

test('atualizar varias vezes seguidas nao consulta a Meta de novo', async () => {
  const antes = chamadas;
  const r = await getAccountInsights('tenant_insights', { refresh: true, now: mais(0.5) });
  assert.equal(r.cached, true);
  assert.equal(chamadas, antes);
});

test('mudanca entre retratos vira alerta uma vez so', async () => {
  estado.quality = 'YELLOW';
  estado.t2 = 'REJECTED';

  const r = await getAccountInsights('tenant_insights', { refresh: true, now: mais(20) });
  assert.equal(r.cached, false);
  assert.equal(r.newAlerts, 2);

  const { alerts } = await listAccountAlerts('tenant_insights');
  assert.deepEqual(alerts.map((a) => a.kind).sort(), ['phone_quality', 'template_status']);
  assert.ok(alerts.every((a) => a.source === 'sync'));

  const denovo = await getAccountInsights('tenant_insights', { refresh: true, now: mais(40) });
  assert.equal(denovo.newAlerts, 0);
});

test('secao que falha mantem o ultimo valor bom e registra o erro', async () => {
  estado.pricingFalha = true;
  const r = await getAccountInsights('tenant_insights', { refresh: true, now: mais(60) });

  assert.equal(r.insights.pricing.cost, 0.25, 'custo anterior continua no dashboard');
  assert.match(r.insights.errors.pricing, /Temporarily unavailable/);
  assert.equal(r.insights.phone.qualityRating, 'YELLOW', 'as outras secoes atualizam normalmente');
  assert.equal(r.newAlerts, 0);
  estado.pricingFalha = false;
});

test('canal sem token nao consulta a Meta', async () => {
  const antes = chamadas;
  const r = await getAccountInsights('tenant_sem_token', { now: agora });
  assert.deepEqual(r, { connected: false, reason: 'missing_credentials' });
  assert.equal(chamadas, antes);
});
