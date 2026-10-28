import adapter from '../../db/DatabaseAdapter.js';
import { generateId } from '../utils/helpers.js';
import { validateScript } from '../utils/scriptValidator.js';

const SENSITIVE_KEY = /(secret|token|password|authorization|api[-_]?key|credential)/i;
const ENCRYPTED_VALUE = /^(enc:|encrypted:)/i;

const sanitizeString = (value) => {
  if (ENCRYPTED_VALUE.test(value)) return '***';
  if (/bearer\s+[a-z0-9._~+\/-]+/i.test(value)) return value.replace(/bearer\s+[a-z0-9._~+\/-]+/gi, 'Bearer ***');
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= 200000) {
    try { return JSON.stringify(sanitizeLibraryPayload(JSON.parse(value))); } catch { return value; }
  }
  return value;
};

export const sanitizeLibraryPayload = (value, key = '') => {
  if (SENSITIVE_KEY.test(key)) return '***';
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLibraryPayload(item));
  if (!value || typeof value !== 'object') return value;

  const copy = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    copy[childKey] = sanitizeLibraryPayload(childValue, childKey);
  }
  if (copy.type === 'secretNode' && copy.data && typeof copy.data === 'object') {
    copy.data = { ...copy.data, value: '***' };
  }
  return copy;
};

export const listLibraryItems = async (tenantId, { page, limit, skip }, filters = {}) => {
  const query = { tenantId };
  if (filters.type) query.type = filters.type;
  const [items, total] = await Promise.all([
    adapter.findMany('automationLibraryItems', {
      query,
      projection: { _id: 0, payload: 0 },
      sort: { updatedAt: -1 }, skip, limit
    }),
    adapter.countDocuments('automationLibraryItems', query)
  ]);
  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

export const getLibraryItem = (tenantId, id) => adapter.findOne(
  'automationLibraryItems', { tenantId, id }, { projection: { _id: 0 } }
);

export const createLibraryItem = async (tenantId, input, userId) => {
  const now = new Date().toISOString();
  const item = {
    id: generateId('library'), tenantId,
    name: input.name, description: input.description || '', type: input.type,
    tags: input.tags || [], payload: sanitizeLibraryPayload(input.payload),
    createdAt: now, updatedAt: now, createdBy: userId, updatedBy: userId
  };
  await adapter.insertOne('automationLibraryItems', item);
  return item;
};

export const updateLibraryItem = async (tenantId, id, input, userId) => {
  const current = await getLibraryItem(tenantId, id);
  if (!current) return null;
  const updates = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.payload !== undefined ? { payload: sanitizeLibraryPayload(input.payload) } : {}),
    updatedAt: new Date().toISOString(), updatedBy: userId
  };
  await adapter.updateOne('automationLibraryItems', { tenantId, id }, { $set: updates });
  return { ...current, ...updates };
};

export const deleteLibraryItem = async (tenantId, id) => {
  const current = await getLibraryItem(tenantId, id);
  if (!current) return null;
  await adapter.deleteMany('automationLibraryItems', { tenantId, id });
  return current;
};

const issue = (code, message, nodeId = null, severity = 'error') => ({ code, message, nodeId, severity });

export const validateFlowStructure = (snapshot = {}) => {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  const errors = [];
  const warnings = [];
  const nodeIds = new Set();
  const duplicateNodeIds = new Set();

  for (const node of nodes) {
    const id = String(node?.id || '').trim();
    if (!id) errors.push(issue('NODE_WITHOUT_ID', 'Existe um node sem ID.'));
    else if (nodeIds.has(id)) duplicateNodeIds.add(id);
    else nodeIds.add(id);
  }
  duplicateNodeIds.forEach((id) => errors.push(issue('DUPLICATE_NODE_ID', `ID de node duplicado: ${id}.`, id)));

  const starts = nodes.filter((node) => node?.type === 'startNode');
  const finals = nodes.filter((node) => node?.type === 'finalNode');
  if (starts.length !== 1) errors.push(issue('START_COUNT', `O fluxo deve possuir exatamente um startNode; encontrados: ${starts.length}.`));
  if (finals.length === 0) warnings.push(issue('NO_FINAL_NODE', 'O fluxo nao possui finalNode.', null, 'warning'));

  const adjacency = new Map();
  const edgeIds = new Set();
  for (const edge of edges) {
    if (edge?.id && edgeIds.has(edge.id)) errors.push(issue('DUPLICATE_EDGE_ID', `ID de conexao duplicado: ${edge.id}.`));
    if (edge?.id) edgeIds.add(edge.id);
    if (!nodeIds.has(edge?.source)) errors.push(issue('EDGE_SOURCE_MISSING', `Origem inexistente: ${edge?.source || '-'}.`));
    if (!nodeIds.has(edge?.target)) errors.push(issue('EDGE_TARGET_MISSING', `Destino inexistente: ${edge?.target || '-'}.`));
    if (nodeIds.has(edge?.source) && nodeIds.has(edge?.target)) {
      if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
      adjacency.get(edge.source).push(edge.target);
    }
  }

  const reachable = new Set();
  const queue = starts[0]?.id ? [starts[0].id] : [];
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const target of adjacency.get(id) || []) if (!reachable.has(target)) queue.push(target);
  }

  nodes.forEach((node) => {
    if (node?.id && starts.length === 1 && !reachable.has(node.id)) {
      warnings.push(issue('UNREACHABLE_NODE', 'Node nao alcancavel a partir do inicio.', node.id, 'warning'));
    }
    if (node?.type !== 'finalNode' && node?.id && !(adjacency.get(node.id) || []).length) {
      warnings.push(issue('DEAD_END', 'Node sem conexao de saida.', node.id, 'warning'));
    }
    if (node?.type === 'scriptNode' && String(node?.data?.script || '').trim()) {
      try { validateScript(String(node.data.script)); }
      catch (error) { errors.push(issue('INVALID_SCRIPT', error.message || 'Script invalido.', node.id)); }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: { nodes: nodes.length, edges: edges.length, reachableNodes: reachable.size, finalNodes: finals.length }
  };
};

export const validateStoredFlow = async (tenantId, flowId, source = 'published') => {
  const flow = await adapter.findOne('flows', { tenantId, id: flowId }, {
    projection: { _id: 0, id: 1, name: 1, draft: 1, published: 1, nodes: 1, edges: 1 }
  });
  if (!flow) return null;
  const snapshot = source === 'draft'
    ? (flow.draft || { nodes: flow.nodes || [], edges: flow.edges || [] })
    : (flow.published || { nodes: [], edges: [] });
  return { flow: { id: flow.id, name: flow.name }, source, ...validateFlowStructure(snapshot) };
};
