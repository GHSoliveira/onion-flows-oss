/**
 * Data retention worker.
 *
 * Periodically scans tenants whose tenantSettings.chatRetentionDays > 0 and
 * deletes closed chats older than the configured window, plus their
 * chatEvents. Inactive sessions and tenants with retention disabled (the
 * default) are untouched.
 *
 * Activation:
 *   DATA_RETENTION_WORKER_ENABLED=true   (default: false)
 *   DATA_RETENTION_INTERVAL_MIN=360      (default: 360 — runs every 6h)
 *
 * The worker also keeps adminAccessAudit, mfaSessions and adminIpAllowlist
 * tidy by calling their respective purge helpers. Failures are logged but
 * never crash the process.
 */
import adapter from '../../db/DatabaseAdapter.js';
import { createLog, purgeOldSystemLogs } from './logs.js';
import { purgeOldAuditEntries } from './adminAccessAudit.js';
import { purgeExpiredSessions } from './mfaSessions.js';
import { purgeExpired as purgeExpiredAllowlist } from './adminIpAllowlist.js';
import fs from 'fs/promises';
import path from 'path';

const INTERVAL_MIN = (() => {
  const raw = Number.parseInt(process.env.DATA_RETENTION_INTERVAL_MIN || '', 10);
  if (Number.isFinite(raw) && raw >= 5 && raw <= 24 * 60) return raw;
  return 360;
})();

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

let running = false;
let timer = null;

const collectTenantSettings = async () => {
  if (!adapter.db) await adapter.init();
  const rows = await adapter.db.collection('tenantSettings')
    .find(
      { $or: [{ chatRetentionDays: { $gt: 0 } }, { logRetentionDays: { $gt: 0 } }, { mediaRetentionDays: { $gt: 0 } }] },
      { projection: { _id: 0, tenantId: 1, chatRetentionDays: 1, logRetentionDays: 1, mediaRetentionDays: 1 } }
    )
    .toArray();
  return Array.isArray(rows) ? rows : [];
};

const purgeTenant = async (tenantId, retentionDays) => {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000).toISOString();
  const chatsCollection = adapter.db.collection('activeChats');
  const eventsCollection = adapter.db.collection('chatEvents');
  const messagesCollection = adapter.db.collection('chatMessages');
  const classificationsCollection = adapter.db.collection('messageClassifications');

  const expiredChats = await chatsCollection
    .find(
      {
        tenantId,
        status: 'closed',
        $or: [
          { closedAt: { $lt: cutoff } },
          { closedAt: { $exists: false }, updatedAt: { $lt: cutoff } }
        ]
      },
      { projection: { _id: 0, id: 1 } }
    )
    .limit(5000)
    .toArray();

  if (!expiredChats.length) {
    return { chats: 0, events: 0 };
  }

  const chatIds = expiredChats.map((chat) => chat.id).filter(Boolean);
  const eventsResult = await eventsCollection.deleteMany({ tenantId, chatId: { $in: chatIds } });
  const messagesResult = await messagesCollection.deleteMany({ tenantId, chatId: { $in: chatIds } });
  const classificationsResult = await classificationsCollection.deleteMany({ tenantId, chatId: { $in: chatIds } });
  const chatsResult = await chatsCollection.deleteMany({ tenantId, id: { $in: chatIds } });

  return {
    chats: chatsResult.deletedCount || 0,
    events: eventsResult.deletedCount || 0,
    messages: messagesResult.deletedCount || 0,
    classifications: classificationsResult.deletedCount || 0
  };
};

const purgeTenantMedia = async (tenantId, retentionDays) => {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000).toISOString();
  const collection = adapter.db.collection('mediaAssets');
  const assets = await collection.find(
    { tenantId, createdAt: { $lt: cutoff } },
    { projection: { _id: 0, id: 1, fileName: 1 } }
  ).limit(1000).toArray();
  if (!assets.length) return 0;

  const uploadsRoot = path.resolve(process.cwd(), 'uploads');
  const safeTenantId = String(tenantId).replace(/[^a-zA-Z0-9_-]/g, '');
  for (const asset of assets) {
    const safeFileName = path.basename(String(asset.fileName || ''));
    if (!safeFileName) continue;
    const filePath = path.resolve(uploadsRoot, safeTenantId, safeFileName);
    if (!filePath.startsWith(`${uploadsRoot}${path.sep}`)) continue;
    await fs.unlink(filePath).catch(() => {});
  }
  const ids = assets.map((asset) => asset.id).filter(Boolean);
  const result = ids.length ? await collection.deleteMany({ tenantId, id: { $in: ids } }) : { deletedCount: 0 };
  return result.deletedCount || 0;
};

const runOnce = async () => {
  if (running) return;
  running = true;
  const startedAt = Date.now();
  let totalChats = 0;
  let totalEvents = 0;
  let totalMessages = 0;
  let totalMedia = 0;
  let tenantsProcessed = 0;

  try {
    const settings = await collectTenantSettings();
    for (const entry of settings) {
      const tenantId = String(entry?.tenantId || '').trim();
      const retentionDays = Number(entry?.chatRetentionDays);
      const logRetentionDays = Number(entry?.logRetentionDays);
      const mediaRetentionDays = Number(entry?.mediaRetentionDays);
      const hasChatRetention = Number.isFinite(retentionDays) && retentionDays > 0;
      const hasLogRetention = Number.isFinite(logRetentionDays) && logRetentionDays > 0;
      const hasMediaRetention = Number.isFinite(mediaRetentionDays) && mediaRetentionDays > 0;
      if (!tenantId || (!hasChatRetention && !hasLogRetention && !hasMediaRetention)) continue;
      try {
        const result = Number.isFinite(retentionDays) && retentionDays > 0
          ? await purgeTenant(tenantId, retentionDays)
          : { chats: 0, events: 0, messages: 0 };
        totalChats += result.chats;
        totalEvents += result.events;
        totalMessages += result.messages || 0;
        tenantsProcessed += 1;
        if (result.chats > 0) {
          await createLog('DATA_RETENTION_PURGE', {
            tenantId,
            retentionDays,
            deletedChats: result.chats,
            deletedEvents: result.events,
            deletedMessages: result.messages || 0,
            deletedClassifications: result.classifications || 0
          }, 'system');
        }
        if (hasLogRetention) {
          const logCutoff = new Date(Date.now() - logRetentionDays * 24 * 3600_000).toISOString();
          await adapter.db.collection('systemLogs').deleteMany({ tenantId, timestamp: { $lt: logCutoff } });
          await adapter.db.collection('tenantAuditEvents').deleteMany({ tenantId, timestamp: { $lt: logCutoff } });
          await adapter.db.collection('tenantIncidents').deleteMany({ tenantId, updatedAt: { $lt: logCutoff }, status: { $in: ['resolved', 'ignored'] } });
        }
        if (hasMediaRetention) {
          const deletedMedia = await purgeTenantMedia(tenantId, mediaRetentionDays);
          totalMedia += deletedMedia;
          if (deletedMedia > 0) {
            await createLog('MEDIA_RETENTION_PURGE', { tenantId, mediaRetentionDays, deletedMedia }, 'system');
          }
        }
      } catch (error) {
        console.warn(`[DATA_RETENTION] Falha no tenant ${tenantId}:`, error?.message || error);
      }
    }

    // Side-housekeeping: outras coleções com TTL próprio
    const housekeeping = await Promise.allSettled([
      purgeOldAuditEntries(),
      purgeExpiredSessions(),
      purgeExpiredAllowlist(),
      purgeOldSystemLogs()
    ]);
    const purgedLogs = housekeeping[3]?.status === 'fulfilled' ? (housekeeping[3].value || 0) : 0;
    if (purgedLogs > 0) {
      console.log(`[DATA_RETENTION] ${purgedLogs} logs antigos removidos`);
    }
  } catch (error) {
    console.error('[DATA_RETENTION] Ciclo falhou:', error?.message || error);
  } finally {
    running = false;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (tenantsProcessed > 0 || totalChats > 0 || totalMedia > 0) {
      console.log(`[DATA_RETENTION] ${tenantsProcessed} tenants, ${totalChats} chats, ${totalEvents} eventos, ${totalMessages} mensagens e ${totalMedia} midias removidos em ${elapsed}s`);
    }
  }
};

export const startDataRetentionWorker = () => {
  if (!truthy(process.env.DATA_RETENTION_WORKER_ENABLED)) {
    console.log('[DATA_RETENTION] Desligado por configuracao');
    return;
  }
  if (timer) return;
  console.log(`[DATA_RETENTION] Worker ativo, intervalo ${INTERVAL_MIN}min`);
  // First run after 60s to let the rest of the boot settle
  setTimeout(() => { runOnce().catch(() => {}); }, 60_000);
  timer = setInterval(() => { runOnce().catch(() => {}); }, INTERVAL_MIN * 60_000);
};

export const stopDataRetentionWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

// Exposto para invocação manual via endpoint super-admin (futuro) ou testes.
export const runDataRetentionNow = runOnce;
