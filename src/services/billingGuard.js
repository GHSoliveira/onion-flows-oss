import adapter from '../../db/DatabaseAdapter.js';
import { createLog } from './logs.js';
import { COLLECTIONS } from './outreachDomain.js';
import { getTenantById } from './tenantLimits.js';

const GRACE_DAYS = 10;

export const isBillingBlocked = (tenant) => {
  const billing = tenant?.billing;
  if (!billing) return false;

  // Trust unblock overrides everything
  if (billing.trustUnblockUntil) {
    const expiry = new Date(billing.trustUnblockUntil);
    if (!isNaN(expiry.getTime()) && Date.now() <= expiry.getTime()) return false;
  }

  if (billing.blocked === true) return true;

  if (billing.paymentStatus === 'overdue' && billing.overdueAt) {
    const daysOverdue = Math.floor(
      (Date.now() - new Date(billing.overdueAt).getTime()) / 86_400_000
    );
    if (daysOverdue >= GRACE_DAYS) return true;
  }

  return false;
};

export const applyBillingBlock = async (tenantId, blocked, reason = 'manual') => {
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection('tenants');
  const tenant = await collection.findOne({ id: tenantId });
  if (!tenant) return null;

  const now = new Date().toISOString();
  const billing = {
    ...(tenant.billing || {}),
    blocked,
    blockedAt: blocked ? now : null,
    blockReason: blocked ? reason : null,
  };

  await collection.updateOne({ id: tenantId }, { $set: { billing, updatedAt: now } });
  if (!blocked) await resumeBillingPausedCampaigns(tenantId).catch((error) => {
    console.warn('[BILLING] Falha ao retomar campanhas pausadas pela cobranca', error?.message || error);
  });
  return { ...tenant, billing };
};

// --- Pausa por cobranca ---
// Bloqueado nao perde nada: a mensagem do cliente e gravada, so o bot nao
// responde; campanha e envio ativo param. Ao pagar, tudo volta sozinho.

export const isTenantBillingPaused = async (tenantId) => isBillingBlocked(await getTenantById(tenantId));

// Marca a conversa que chegou durante a pausa (uma vez), para a equipe achar
// depois quem ficou sem resposta.
export const markChatBillingPaused = async (chatId) => {
  const chat = await adapter.findOne('activeChats', { id: chatId }, { projection: { _id: 0, id: 1, billingPausedAt: 1 } });
  if (!chat || chat.billingPausedAt) return;
  await adapter.updateOne('activeChats', { id: chatId }, { $set: { billingPausedAt: new Date().toISOString() } });
};

// Antes de cada envio de campanha ou passo de cadencia.
export const pauseCampaignIfBillingBlocked = async (campaign) => {
  if (!campaign?.tenantId || !campaign?.id) return null;
  if (!(await isTenantBillingPaused(campaign.tenantId))) return null;
  const at = new Date().toISOString();
  await adapter.updateOne(COLLECTIONS.campaigns, { tenantId: campaign.tenantId, id: campaign.id }, {
    $set: { status: 'paused', billingPause: { pausedAt: at, previousStatus: campaign.status || null }, updatedAt: at }
  });
  const executions = await adapter.findMany(COLLECTIONS.cadenceExecutions, {
    query: { tenantId: campaign.tenantId, campaignId: campaign.id, status: { $in: ['scheduled', 'waiting'] } },
    limit: 100000
  });
  for (const execution of executions) {
    await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: execution.id }, { $set: { status: 'paused', stopReason: 'billing_blocked', updatedAt: at } });
  }
  await createLog('OUTREACH_CAMPAIGN_BILLING_PAUSE', { tenantId: campaign.tenantId, campaignId: campaign.id }, 'system').catch(() => {});
  return { ...campaign, status: 'paused' };
};

// So retoma o que a cobranca pausou: pausa manual ou por qualidade fica.
export const resumeBillingPausedCampaigns = async (tenantId) => {
  const campanhas = await adapter.findMany(COLLECTIONS.campaigns, { query: { tenantId, status: 'paused' }, limit: 100000 });
  const at = new Date().toISOString();
  let retomadas = 0;
  for (const campaign of campanhas) {
    if (!campaign.billingPause || campaign.qualityPause) continue;
    await adapter.updateOne(COLLECTIONS.campaigns, { tenantId, id: campaign.id }, {
      $set: { status: campaign.cadenceId ? 'scheduled' : 'pending', billingPause: null, billingResumedAt: at, updatedAt: at }
    });
    const executions = await adapter.findMany(COLLECTIONS.cadenceExecutions, { query: { tenantId, campaignId: campaign.id, status: 'paused' }, limit: 100000 });
    for (const execution of executions) {
      if (!['billing_blocked', 'campaign_paused'].includes(execution.stopReason)) continue;
      await adapter.updateOne(COLLECTIONS.cadenceExecutions, { id: execution.id }, {
        $set: { status: 'waiting', stopReason: null, nextExecutionAt: execution.nextExecutionAt || at, updatedAt: at }
      });
    }
    retomadas += 1;
  }
  if (retomadas) await createLog('OUTREACH_CAMPAIGN_BILLING_RESUME', { tenantId, campaigns: retomadas }, 'system').catch(() => {});
  return retomadas;
};

export const runAutoBlockScan = async () => {
  if (!adapter.db) await adapter.init();
  const collection = adapter.db.collection('tenants');
  const tenants = await collection.find({}).toArray();
  const blocked = [];
  const now = new Date().toISOString();

  for (const tenant of tenants) {
    const billing = tenant.billing;
    if (!billing || billing.blocked) continue;
    // Cliente de agencia paga a agencia, nao a Onion: quem bloqueia por atraso
    // e a fatura do Parceiro (partnerBilling), nunca esta varredura.
    if (tenant.partnerId) continue;
    if (billing.paymentStatus !== 'overdue' || !billing.overdueAt) continue;

    // Skip if trust unblock is still active
    if (billing.trustUnblockUntil) {
      const expiry = new Date(billing.trustUnblockUntil);
      if (!isNaN(expiry.getTime()) && Date.now() <= expiry.getTime()) continue;
    }

    const daysOverdue = Math.floor(
      (Date.now() - new Date(billing.overdueAt).getTime()) / 86_400_000
    );
    if (daysOverdue >= GRACE_DAYS) {
      await collection.updateOne(
        { id: tenant.id },
        { $set: { billing: { ...billing, blocked: true, blockedAt: now, blockReason: 'auto_overdue' }, updatedAt: now } }
      );
      blocked.push(tenant.id);
    }
  }

  return blocked;
};
