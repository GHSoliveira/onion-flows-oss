/**
 * Detector de anomalias em login.
 *
 * Registra os últimos N IPs vistos por usuário em `userLoginIps`. Quando um
 * login bem-sucedido vem de um IP que não está no histórico recente, dispara:
 *   - evento Socket.IO `admin_ip_alert` para a sala `role:SUPER_ADMIN`
 *     com outcome='login_new_ip'
 *   - entrada em `adminAccessAudit` (via recordAccessEvent)
 *
 * Reuso de canais existentes:
 *   - getIo() de logs.js → broadcast Socket.IO
 *   - recordAccessEvent de adminAccessAudit.js → persistência auditável
 *
 * O histórico é limitado a HISTORY_SIZE entradas mais recentes para não
 * crescer indefinidamente. Aliás, qualquer mudança no formato é compatível
 * com inserts antigos (campo `ips` é array de strings simples).
 */
import adapter from '../../db/DatabaseAdapter.js';
import { recordAccessEvent } from './adminAccessAudit.js';

const COLLECTION = 'userLoginIps';
const HISTORY_SIZE = 10;

const ensureCollection = async () => {
  if (!adapter.db) await adapter.init();
  return adapter.db.collection(COLLECTION);
};

/**
 * Avalia o login: se IP já é conhecido para esse user, atualiza timestamp.
 * Se for novo, anexa ao histórico e emite alerta.
 */
export const noteLogin = async ({ userId, role, tenantId, ip, userAgent }) => {
  if (!userId || !ip) return { knownIp: true };
  try {
    const collection = await ensureCollection();
    const record = await collection.findOne({ userId }, { projection: { _id: 0 } });
    const knownIps = Array.isArray(record?.ips) ? record.ips : [];
    const isKnown = knownIps.includes(ip);
    const now = new Date().toISOString();

    if (isKnown) {
      await collection.updateOne(
        { userId },
        { $set: { lastSeenAt: now } }
      );
      return { knownIp: true };
    }

    const nextIps = [ip, ...knownIps].slice(0, HISTORY_SIZE);
    await collection.updateOne(
      { userId },
      { $set: { userId, ips: nextIps, lastSeenAt: now, lastNewIp: ip, lastNewIpAt: now } },
      { upsert: true }
    );

    // Primeiro login do user nunca dispara alerta — só transitions a partir do segundo
    if (!record) return { knownIp: false, firstLogin: true };

    await recordAccessEvent({
      outcome: 'login_new_ip',
      reason: 'first_time_ip',
      clientIp: ip,
      method: 'POST',
      path: '/api/auth/login',
      userId,
      role: role || null,
      tenantId: tenantId || null,
      source: 'login'
    });

    return { knownIp: false, firstLogin: false, userAgent: userAgent || null };
  } catch (error) {
    console.warn('[LOGIN_ANOMALY] Falha ao avaliar login:', error?.message || error);
    return { knownIp: true, error: true };
  }
};
