import adapter from '../../db/DatabaseAdapter.js';
import { MAX_LOGS } from '../config/constants.js';
import { generateId } from '../utils/helpers.js';
import { maskPII } from '../utils/pii.js';
import { recordTenantActivity } from './tenantActivity.js';

// Retenção por data dos logs do sistema. Default 30 dias para casar com a
// política de privacidade publicada. Definir 0 desativa a expiração por data
// (mantém apenas o limite por quantidade via MAX_LOGS).
const RETENTION_DAYS = (() => {
  const raw = Number.parseInt(process.env.SYSTEM_LOGS_RETENTION_DAYS || '', 10);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 365 * 10) return raw;
  return 30;
})();

let io = null;
let logMaintenanceRunning = false;
let writesSinceMaintenance = 0;
let hasInitializedLogIndex = false;

export const setIo = (socketIo) => {
  io = socketIo;
};

export const getIo = () => io;

const runLogMaintenance = async (collection) => {
  if (logMaintenanceRunning) return;
  logMaintenanceRunning = true;

  try {
    const total = await collection.countDocuments();
    const overflow = total - MAX_LOGS;
    if (overflow <= 0) return;

    const oldLogs = await collection
      .find({}, { projection: { id: 1 } })
      .sort({ timestamp: 1 })
      .limit(overflow)
      .toArray();

    if (!oldLogs.length) return;
    const ids = oldLogs.map((l) => l.id).filter(Boolean);
    if (ids.length) {
      await collection.deleteMany({ id: { $in: ids } });
    }
  } catch (error) {
    console.error('Erro na manutencao de logs:', error.message || error);
  } finally {
    logMaintenanceRunning = false;
  }
};

// Limpa logs anteriores à janela de retenção. Chamado pelo worker periódico
// (dataRetentionWorker) e também ao final do hot-path com baixa frequência.
// Retorna a contagem de registros removidos.
export const purgeOldSystemLogs = async () => {
  if (RETENTION_DAYS <= 0) return 0;
  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('systemLogs');
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600_000).toISOString();
    const result = await collection.deleteMany({
      timestamp: { $lt: cutoff },
      $or: [{ tenantId: { $exists: false } }, { tenantId: null }]
    });
    return result.deletedCount || 0;
  } catch (error) {
    console.warn('[SYSTEM_LOGS] Falha ao purgar logs antigos:', error?.message || error);
    return 0;
  }
};

export const getSystemLogsRetentionDays = () => RETENTION_DAYS;

// Garantia independente: mesmo que o dataRetentionWorker esteja desligado,
// um timer interno roda a purgação a cada 12h. Idempotente — se o worker
// principal também estiver rodando, o trabalho extra é um deleteMany sem
// matches e o overhead é negligível.
const SELF_PURGE_INTERVAL_MS = 12 * 60 * 60 * 1000;
if (RETENTION_DAYS > 0 && process.env.NODE_ENV !== 'test') {
  setTimeout(() => { purgeOldSystemLogs().catch(() => {}); }, 5 * 60 * 1000).unref?.();
  setInterval(() => { purgeOldSystemLogs().catch(() => {}); }, SELF_PURGE_INTERVAL_MS).unref?.();
}

export const createLog = async (type, message, userId = 'system') => {
  // PII redaction must happen before serialization. createLog is called from
  // dozens of callsites with payloads carrying customer CPF, phone numbers,
  // tokens etc. Masking centrally here keeps callers untouched.
  const safeMessage = typeof message === 'object' && message !== null
    ? maskPII(message)
    : message;
  const logMessage = typeof safeMessage === 'object'
    ? JSON.stringify(safeMessage)
    : String(safeMessage || '');

  const newLog = {
    id: generateId('log'),
    timestamp: new Date().toISOString(),
    type,
    message: logMessage,
    userId,
    ...(safeMessage && typeof safeMessage === 'object' && safeMessage.tenantId
      ? { tenantId: String(safeMessage.tenantId) }
      : {})
  };

  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('systemLogs');

    if (!hasInitializedLogIndex) {
      hasInitializedLogIndex = true;
      collection.createIndex({ timestamp: -1 }).catch(() => {});
      collection.createIndex({ id: 1 }, { unique: true }).catch(() => {});
    }

    await collection.insertOne(newLog);
    recordTenantActivity({ type, payload: safeMessage, userId, timestamp: newLog.timestamp }).catch((error) => {
      console.warn('[TENANT_ACTIVITY] Falha ao normalizar evento:', error?.message || error);
    });
    console.log(`[LOG] ${type}: ${logMessage}`);

    if (io) {
      io.emit('new_log', newLog);
    }

    writesSinceMaintenance += 1;
    if (writesSinceMaintenance >= 50) {
      writesSinceMaintenance = 0;
      runLogMaintenance(collection).catch(() => {});
    }
  } catch (error) {
    console.error('Erro ao criar log:', error);
  }
};
