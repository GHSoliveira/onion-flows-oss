/**
 * Lockout por usuário após N tentativas falhas.
 *
 * Defesa em profundidade complementar ao rate-limit por IP do /login.
 * O atacante pode rotacionar IPs, mas o nome de usuário sempre é o mesmo;
 * este tracker conta falhas POR USERNAME e bloqueia o login (independente
 * do IP) quando o limite é cruzado.
 *
 * Persistido em MongoDB para sobreviver a restarts e funcionar em múltiplas
 * instâncias do backend. Janela de contagem é fechada após sucesso ou
 * expiração natural.
 *
 * Constantes:
 *   MAX_ATTEMPTS  = 5    falhas antes do bloqueio
 *   WINDOW_MS     = 15m  janela de contagem
 *   LOCK_MS       = 15m  duração do bloqueio
 */
import adapter from '../../db/DatabaseAdapter.js';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const COLLECTION = 'loginAttempts';

const nowIso = () => new Date().toISOString();
const isoToMs = (iso) => {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

const ensureCollection = async () => {
  if (!adapter.db) await adapter.init();
  return adapter.db.collection(COLLECTION);
};

/**
 * Verifica se o username está bloqueado no momento. Retorna `{ locked,
 * lockedUntil }`. Não modifica estado.
 */
export const checkLock = async (username) => {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return { locked: false, lockedUntil: null };
  const collection = await ensureCollection();
  const record = await collection.findOne({ username: u }, { projection: { _id: 0 } });
  if (!record?.lockedUntil) return { locked: false, lockedUntil: null };
  const until = isoToMs(record.lockedUntil);
  if (until > Date.now()) return { locked: true, lockedUntil: record.lockedUntil };
  return { locked: false, lockedUntil: null };
};

/**
 * Registra uma tentativa falha. Se atingir MAX_ATTEMPTS dentro de WINDOW_MS,
 * configura `lockedUntil = now + LOCK_MS`. Retorna o estado atualizado.
 */
export const registerFailure = async (username) => {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return { locked: false };
  const collection = await ensureCollection();
  const record = await collection.findOne({ username: u }, { projection: { _id: 0 } });
  const now = Date.now();

  if (record?.lockedUntil && isoToMs(record.lockedUntil) > now) {
    // Já bloqueado — mantém estado, só atualiza timestamp da última falha.
    await collection.updateOne(
      { username: u },
      { $set: { lastFailedAt: nowIso() } }
    );
    return { locked: true, lockedUntil: record.lockedUntil };
  }

  // Conta apenas falhas dentro da janela móvel
  const firstMs = isoToMs(record?.firstFailedAt);
  const inWindow = firstMs && (now - firstMs) <= WINDOW_MS;
  const nextCount = inWindow ? (record.failedCount || 0) + 1 : 1;
  const update = {
    username: u,
    failedCount: nextCount,
    firstFailedAt: inWindow ? record.firstFailedAt : nowIso(),
    lastFailedAt: nowIso(),
    lockedUntil: null
  };

  if (nextCount >= MAX_ATTEMPTS) {
    update.lockedUntil = new Date(now + LOCK_MS).toISOString();
  }

  await collection.updateOne(
    { username: u },
    { $set: update },
    { upsert: true }
  );

  return {
    locked: Boolean(update.lockedUntil),
    lockedUntil: update.lockedUntil,
    failedCount: nextCount,
    remainingAttempts: Math.max(0, MAX_ATTEMPTS - nextCount)
  };
};

/**
 * Limpa o histórico de falhas (chamado após login bem-sucedido).
 */
export const clearFailures = async (username) => {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return;
  const collection = await ensureCollection();
  await collection.deleteOne({ username: u });
};

export const __config = { MAX_ATTEMPTS, WINDOW_MS, LOCK_MS };
