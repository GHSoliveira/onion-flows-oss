import adapter from '../../db/DatabaseAdapter.js';
import { COLLECTIONS, createDomainId, normalizeIdentifier, nowIso } from './outreachDomain.js';

const validReasons = new Set([
  'opt_out', 'manual', 'invalid_number', 'complaint', 'legal', 'duplicate', 'customer_request'
]);

export const findSuppression = async ({ tenantId, channel, identifier }) => {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  if (!tenantId || !channel || !normalizedIdentifier) return null;
  return adapter.findOne(COLLECTIONS.suppression, {
    tenantId,
    channel: String(channel).toLowerCase(),
    normalizedIdentifier
  });
};

export const isContactSuppressed = async (params) => Boolean(await findSuppression(params));

export const suppressContact = async ({
  tenantId,
  contactId = null,
  channel = 'whatsapp',
  identifier,
  reason = 'manual',
  source = 'manual',
  global = false,
  createdBy = null
}) => {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  if (!tenantId || !normalizedIdentifier) throw new Error('tenantId e identificador sao obrigatorios');
  const normalizedReason = validReasons.has(reason) ? reason : 'manual';
  const existing = await findSuppression({ tenantId, channel, identifier: normalizedIdentifier });
  if (existing) return existing;
  const record = {
    id: createDomainId('suppression'),
    tenantId,
    contactId,
    channel: String(channel || 'whatsapp').toLowerCase(),
    normalizedIdentifier,
    reason: normalizedReason,
    source: String(source || 'manual'),
    global: Boolean(global),
    createdAt: nowIso(),
    createdBy
  };
  await adapter.insertOne(COLLECTIONS.suppression, record);
  return record;
};

export const removeSuppression = async ({ tenantId, suppressionId }) => {
  const existing = await adapter.findOne(COLLECTIONS.suppression, { tenantId, id: suppressionId });
  if (!existing) return null;
  await adapter.deleteMany(COLLECTIONS.suppression, { tenantId, id: suppressionId });
  return existing;
};

export const listSuppressions = async ({ tenantId, page = 1, limit = 25 }) => {
  const query = { tenantId };
  const [items, total] = await Promise.all([
    adapter.findMany(COLLECTIONS.suppression, {
      query,
      projection: { _id: 0 },
      sort: { createdAt: -1 },
      skip: (page - 1) * limit,
      limit
    }),
    adapter.countDocuments(COLLECTIONS.suppression, query)
  ]);
  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

