/**
 * Detector de burst de operações destrutivas por usuário.
 *
 * Quando um mesmo `userId` dispara mais de THRESHOLD ações destrutivas em
 * WINDOW_MS, emite alerta `admin_ip_alert` (outcome='delete_burst') no socket
 * para SUPER_ADMIN online e grava em adminAccessAudit.
 *
 * Storage in-memory por simplicidade — adequado para single-instance ou
 * tolerância a falsos negativos em multi-instance. Em multi-instance estrito,
 * trocar Map por contador em Redis.
 */
import { recordAccessEvent } from './adminAccessAudit.js';

const WINDOW_MS = 5 * 60 * 1000;
const THRESHOLD = 3;

const buckets = new Map(); // userId → { count, firstAt, alerted }

const purgeOld = (now) => {
  for (const [key, entry] of buckets) {
    if (now - entry.firstAt > WINDOW_MS) buckets.delete(key);
  }
};

export const noteDestructiveAction = async ({ userId, role, tenantId, clientIp, path, method, kind }) => {
  if (!userId) return;
  const now = Date.now();
  purgeOld(now);
  const existing = buckets.get(userId);
  if (!existing || now - existing.firstAt > WINDOW_MS) {
    buckets.set(userId, { count: 1, firstAt: now, alerted: false });
    return;
  }
  existing.count += 1;
  if (existing.count >= THRESHOLD && !existing.alerted) {
    existing.alerted = true;
    try {
      await recordAccessEvent({
        outcome: 'delete_burst',
        reason: `${existing.count} ações destrutivas em ${Math.round((now - existing.firstAt) / 1000)}s`,
        clientIp: clientIp || null,
        method: method || null,
        path: path || null,
        userId,
        role: role || null,
        tenantId: tenantId || null,
        source: kind || 'destructive'
      });
    } catch (error) {
      console.warn('[DELETE_BURST] Falha ao registrar evento:', error?.message || error);
    }
  }
};

export const __test = { buckets, WINDOW_MS, THRESHOLD };
