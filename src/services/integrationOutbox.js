import adapter from '../../db/DatabaseAdapter.js';
import { z } from 'zod';
import { envFlag, envInt } from '../utils/env.js';
import { COLLECTIONS, createDomainId, nowIso, sanitizeIntegrationError } from './outreachDomain.js';

const destination = 'turizmo';
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
let circuit = { failures: 0, openedAt: 0 };

export const TURIZMO_EVENT_TYPES = Object.freeze([
  'integration.test',
  'campaign.created',
  'campaign.started',
  'campaign.completed',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'lead.replied',
  'lead.classified',
  'lead.opted_out',
  'meeting.requested',
  'attendance.queued',
  'attendance.assigned',
  'attendance.transferred',
  'attendance.message_waiting',
  'attendance.closed',
  'automation.command.executed',
  'automation.command.failed'
]);

export const turizmoEventEnvelopeSchema = z.object({
  eventId: z.string().trim().min(1).max(160),
  eventVersion: z.number().int().positive(),
  type: z.enum(TURIZMO_EVENT_TYPES),
  tenantId: z.string().trim().min(1).max(160),
  occurredAt: z.string().datetime(),
  producer: z.literal('onion-flows'),
  idempotencyKey: z.string().trim().min(1).max(500),
  data: z.record(z.string(), z.unknown())
}).strict();

const enabled = () => envFlag('TURIZMO_INTEGRATION_ENABLED', false);
const maxAttempts = () => envInt('TURIZMO_EVENT_MAX_ATTEMPTS', 8, { min: 1, max: 50 });
const timeoutMs = () => envInt('TURIZMO_EVENT_TIMEOUT_MS', 10000, { min: 1000, max: 120000 });
const circuitThreshold = () => envInt('TURIZMO_CIRCUIT_FAILURE_THRESHOLD', 5, { min: 1, max: 100 });
const circuitResetMs = () => envInt('TURIZMO_CIRCUIT_RESET_MS', 30000, { min: 1000, max: 600000 });

const nextRetryAt = (attempt) => {
  const base = Math.min(15 * 60 * 1000, 1000 * (2 ** Math.min(10, attempt)));
  const jitter = Math.floor(Math.random() * Math.max(250, base * 0.2));
  return new Date(Date.now() + base + jitter).toISOString();
};

const isCircuitOpen = () => {
  if (circuit.failures < circuitThreshold()) return false;
  if (Date.now() - circuit.openedAt >= circuitResetMs()) {
    circuit = { failures: 0, openedAt: 0 };
    return false;
  }
  return true;
};

export const createTurizmoEvent = ({
  tenantId,
  type,
  aggregateType,
  aggregateId,
  data,
  idempotencyKey,
  eventVersion = 1
}) => {
  const envelope = turizmoEventEnvelopeSchema.parse({
    eventId: createDomainId('evt'),
    eventVersion,
    type,
    tenantId,
    occurredAt: nowIso(),
    producer: 'onion-flows',
    idempotencyKey,
    data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  });
  return { ...envelope, aggregateType: aggregateType || null, aggregateId: aggregateId || null };
};

export const enqueueTurizmoEvent = async (event) => {
  const parsed = turizmoEventEnvelopeSchema.safeParse({
    eventId: event?.eventId || createDomainId('evt'),
    eventVersion: event?.eventVersion || 1,
    type: event?.type,
    tenantId: event?.tenantId,
    occurredAt: event?.occurredAt || nowIso(),
    producer: event?.producer || 'onion-flows',
    idempotencyKey: event?.idempotencyKey,
    data: event?.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {}
  });
  if (!parsed.success) {
    const error = new Error('Evento Turizmo invalido');
    error.code = 'invalid_turizmo_event';
    error.status = 400;
    error.details = parsed.error.flatten();
    throw error;
  }
  const envelope = parsed.data;
  const existing = await adapter.findOne(COLLECTIONS.outbox, {
    tenantId: envelope.tenantId,
    destination,
    idempotencyKey: envelope.idempotencyKey
  });
  if (existing) return existing;
  const now = nowIso();
  const record = {
    id: createDomainId('outbox'),
    tenantId: envelope.tenantId,
    destination,
    eventId: envelope.eventId,
    eventType: envelope.type,
    aggregateType: event.aggregateType || null,
    aggregateId: event.aggregateId || null,
    idempotencyKey: envelope.idempotencyKey,
    payload: envelope,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: now,
    lastAttemptAt: null,
    lastError: null,
    deliveredAt: null,
    createdAt: now,
    updatedAt: now
  };
  try {
    await adapter.insertOne(COLLECTIONS.outbox, record);
  } catch (error) {
    if (String(error?.code) === '11000') {
      return adapter.findOne(COLLECTIONS.outbox, { tenantId: envelope.tenantId, destination, idempotencyKey: envelope.idempotencyKey });
    }
    throw error;
  }
  return record;
};

const deliver = async (record) => {
  const baseUrl = String(process.env.TURIZMO_BASE_URL || 'http://localhost:4545').replace(/\/+$/, '');
  const apiKey = String(process.env.TURIZMO_API_KEY || '');
  if (!apiKey) {
    const error = new Error('TURIZMO_API_KEY nao configurada');
    error.retryable = false;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(`${baseUrl}/api/integrations/onion/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-API-Key': apiKey,
        'Idempotency-Key': record.idempotencyKey
      },
      body: JSON.stringify(record.payload),
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(body?.message || body?.error || `Turizmo HTTP ${response.status}`);
      error.status = response.status;
      error.code = body?.code || response.status;
      error.retryable = RETRYABLE_STATUS.has(response.status);
      throw error;
    }
    return { status: response.status, body: body || null };
  } finally {
    clearTimeout(timer);
  }
};

const diagnosticError = ({ code, message, status, cause = null, record = null, durationMs = 0 }) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.outboxId = record?.id || null;
  error.eventId = record?.eventId || null;
  error.durationMs = durationMs;
  error.turizmoStatus = Number(cause?.status || 0) || null;
  return error;
};

export const testTurizmoIntegration = async ({ tenantId }) => {
  if (!enabled() || !process.env.TURIZMO_API_KEY) {
    throw diagnosticError({
      code: 'turizmo_not_configured',
      message: 'Integracao Turizmo nao esta ativa ou configurada',
      status: 503
    });
  }
  const event = createTurizmoEvent({
    tenantId,
    type: 'integration.test',
    aggregateType: 'integration',
    aggregateId: tenantId,
    idempotencyKey: `integration-test:${tenantId}:${createDomainId('diagnostic')}`,
    data: { diagnostic: true, message: 'Teste de conectividade Onion para Turizmo' }
  });
  const record = await enqueueTurizmoEvent(event);
  const startedAt = Date.now();
  await adapter.updateOne(COLLECTIONS.outbox, { id: record.id }, {
    $set: { status: 'processing', attemptCount: 1, lastAttemptAt: nowIso(), updatedAt: nowIso() }
  });
  try {
    const result = await deliver(record);
    const deliveredAt = nowIso();
    await adapter.updateOne(COLLECTIONS.outbox, { id: record.id }, {
      $set: { status: 'delivered', deliveredAt, lastError: null, updatedAt: deliveredAt }
    });
    return {
      ok: true,
      configured: true,
      reachable: true,
      authenticated: true,
      outboxId: record.id,
      eventId: record.eventId,
      durationMs: Date.now() - startedAt,
      turizmoStatus: result.status
    };
  } catch (cause) {
    const durationMs = Date.now() - startedAt;
    const timedOut = cause?.name === 'AbortError' || /abort|timeout/i.test(String(cause?.message || ''));
    const authenticationFailed = [401, 403].includes(Number(cause?.status));
    const code = timedOut ? 'turizmo_timeout' : (authenticationFailed ? 'turizmo_authentication_failed' : 'turizmo_unreachable');
    const status = timedOut ? 504 : 502;
    const persistedStatus = authenticationFailed ? 'dead_letter' : 'retry';
    await adapter.updateOne(COLLECTIONS.outbox, { id: record.id }, {
      $set: {
        status: persistedStatus,
        nextAttemptAt: persistedStatus === 'retry' ? nextRetryAt(1) : null,
        lastError: sanitizeIntegrationError(cause),
        updatedAt: nowIso()
      }
    });
    throw diagnosticError({
      code,
      message: timedOut
        ? 'Tempo limite excedido ao contatar o Turizmo'
        : (authenticationFailed ? 'Autenticacao rejeitada pelo Turizmo' : 'Turizmo indisponivel'),
      status,
      cause,
      record,
      durationMs
    });
  }
};

export const processNextTurizmoEvent = async ({ outboxId = null } = {}) => {
  if (!enabled()) return { idle: true, disabled: true };
  if (isCircuitOpen()) return { idle: true, circuitOpen: true };
  const now = nowIso();
  const query = {
    destination,
    status: { $in: ['pending', 'retry'] },
    nextAttemptAt: { $lte: now },
    ...(outboxId ? { id: outboxId } : {})
  };
  const rows = await adapter.findMany(COLLECTIONS.outbox, { query, sort: { nextAttemptAt: 1, createdAt: 1 }, limit: 1 });
  const record = rows[0];
  if (!record) return { idle: true };
  const attempt = Number(record.attemptCount || 0) + 1;
  await adapter.updateOne(COLLECTIONS.outbox, { id: record.id }, {
    $set: { status: 'processing', attemptCount: attempt, lastAttemptAt: now, updatedAt: now }
  });
  try {
    await deliver(record);
    circuit = { failures: 0, openedAt: 0 };
    const deliveredAt = nowIso();
    await adapter.updateOne(COLLECTIONS.outbox, { id: record.id }, {
      $set: { status: 'delivered', deliveredAt, lastError: null, updatedAt: deliveredAt }
    });
    return { ok: true, id: record.id, eventId: record.eventId };
  } catch (error) {
    circuit.failures += 1;
    circuit.openedAt = Date.now();
    const retryable = error?.retryable !== false && attempt < maxAttempts();
    const failedAt = nowIso();
    await adapter.updateOne(COLLECTIONS.outbox, { id: record.id }, {
      $set: {
        status: retryable ? 'retry' : 'dead_letter',
        nextAttemptAt: retryable ? nextRetryAt(attempt) : null,
        lastError: sanitizeIntegrationError(error),
        updatedAt: failedAt
      }
    });
    if (retryable) return { ok: false, retry: true, id: record.id };
    throw error;
  }
};

export const retryTurizmoEvent = async ({ tenantId, outboxId }) => {
  const record = await adapter.findOne(COLLECTIONS.outbox, { tenantId, id: outboxId, destination });
  if (!record) return null;
  await adapter.updateOne(COLLECTIONS.outbox, { id: outboxId }, {
    $set: { status: 'pending', nextAttemptAt: nowIso(), lastError: null, updatedAt: nowIso() }
  });
  return { ...record, status: 'pending', nextAttemptAt: nowIso(), lastError: null };
};

export const getTurizmoStatus = async ({ tenantId = null } = {}) => {
  const baseUrl = String(process.env.TURIZMO_BASE_URL || 'http://localhost:4545').replace(/\/+$/, '');
  const counts = {};
  for (const status of ['pending', 'retry', 'processing', 'delivered', 'dead_letter']) {
    counts[status] = await adapter.countDocuments(COLLECTIONS.outbox, { destination, status, ...(tenantId ? { tenantId } : {}) });
  }
  return {
    enabled: enabled(),
    configured: Boolean(process.env.TURIZMO_API_KEY),
    baseUrl,
    circuitOpen: isCircuitOpen(),
    counts,
    checkedAt: nowIso()
  };
};
