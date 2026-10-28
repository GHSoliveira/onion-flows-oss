import adapter from '../../db/DatabaseAdapter.js';
import { generateId } from '../utils/helpers.js';

const INCIDENT_MARKERS = ['ERROR', 'FAILED', 'FAILURE', 'TIMEOUT', 'INVALID'];
const AUDIT_MARKERS = ['CREATE', 'UPDATE', 'DELETE', 'PUBLISH', 'RESTORE', 'ASSIGN', 'TRANSFER', 'BINDING', 'SETTINGS'];
const METADATA_KEYS = new Set([
  'id', 'module', 'flowId', 'nodeId', 'chatId', 'channel', 'operation', 'status',
  'code', 'queueId', 'name', 'changedFields', 'templateId', 'templateName', 'phoneNumberId'
]);

const text = (value, max = 500) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, max) : null;
};

const safeMetadata = (payload = {}) => Object.fromEntries(
  Object.entries(payload)
    .filter(([key]) => METADATA_KEYS.has(key))
    .map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, 50) : value])
);

export const classifyTenantActivity = (type) => {
  const normalized = String(type || '').toUpperCase();
  if (INCIDENT_MARKERS.some((marker) => normalized.includes(marker))) return 'incident';
  if (AUDIT_MARKERS.some((marker) => normalized.includes(marker))) return 'audit';
  return null;
};

const incidentFingerprint = (type, payload = {}) => [
  type,
  payload.operation || '',
  payload.code || '',
  payload.templateId || '',
  payload.nodeId || ''
].map((item) => String(item)).join('|').slice(0, 500);

const recordIncident = async ({ tenantId, type, payload, userId, timestamp }) => {
  const fingerprint = incidentFingerprint(type, payload);
  const existing = await adapter.findOne('tenantIncidents', { tenantId, fingerprint, status: 'open' }, { projection: { id: 1 } });
  const now = timestamp || new Date().toISOString();
  if (existing?.id) {
    await adapter.updateOne('tenantIncidents', { tenantId, id: existing.id }, {
      $set: { lastSeenAt: now, updatedAt: now, metadata: safeMetadata(payload) },
      $inc: { occurrenceCount: 1 }
    });
    return existing.id;
  }

  const id = generateId('incident');
  await adapter.insertOne('tenantIncidents', {
    id,
    tenantId,
    fingerprint,
    source: text(payload.channel || payload.source || 'system', 40),
    type: text(type, 120),
    severity: ['warning', 'error', 'critical'].includes(payload.severity) ? payload.severity : 'error',
    title: text(payload.title || type, 180),
    message: text(payload.message || payload.details || 'Falha operacional registrada.', 1000),
    status: 'open',
    occurrenceCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    metadata: safeMetadata(payload)
  });
  return id;
};

const recordAudit = async ({ tenantId, type, payload, userId, timestamp }) => {
  const now = timestamp || new Date().toISOString();
  const id = generateId('audit');
  await adapter.insertOne('tenantAuditEvents', {
    id,
    tenantId,
    type: text(type, 120),
    actorId: text(userId, 120) || 'system',
    summary: text(payload.title || payload.name || type, 240),
    metadata: safeMetadata(payload),
    timestamp: now
  });
  return id;
};

export const recordTenantActivity = async ({ type, payload = {}, userId = 'system', timestamp = null } = {}) => {
  const tenantId = text(payload?.tenantId, 160);
  if (!tenantId) return null;
  const classification = classifyTenantActivity(type);
  if (!classification) return null;
  if (classification === 'incident') return recordIncident({ tenantId, type, payload, userId, timestamp });
  return recordAudit({ tenantId, type, payload, userId, timestamp });
};

export const updateTenantIncidentStatus = async ({ tenantId, incidentId, status, userId }) => {
  const existing = await adapter.findOne('tenantIncidents', { tenantId, id: incidentId }, { projection: { _id: 0 } });
  if (!existing) return null;
  const now = new Date().toISOString();
  await adapter.updateOne('tenantIncidents', { tenantId, id: incidentId }, {
    $set: { status, updatedAt: now, resolvedAt: status === 'resolved' ? now : null, resolvedBy: status === 'resolved' ? userId : null }
  });
  return { ...existing, status, updatedAt: now, resolvedAt: status === 'resolved' ? now : null, resolvedBy: status === 'resolved' ? userId : null };
};
