import adapter from '../../db/DatabaseAdapter.js';
import { whatsappInteractiveTemplateSchema } from '../schemas/index.js';
import { getMetaCatalogIntegration } from './metaCatalog.js';
import { invalidateRuntimeFlowCache } from './flowRuntimeCache.js';
import { generateId } from '../utils/helpers.js';

/**
 * Exportar e importar interactives do WhatsApp entre tenants.
 *
 * O id de documento e unico no banco inteiro (nao por tenant), entao item
 * importado sempre ganha id novo. Fluxos do tenant de destino que ainda apontam
 * para o id de origem (fluxo importado antes dos interactives) sao corrigidos no
 * fim da importacao, e o item guarda `importedFrom` para a importacao de fluxo
 * fazer a mesma troca quando vier depois.
 */

export const INTERACTIVE_COLLECTION = 'whatsappInteractiveTemplates';
export const EXPORT_FORMAT = 'onion-interactives';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_ITEMS = 500;
export const CONFLICT_MODES = ['copy', 'replace', 'skip'];

const CONTENT_FIELDS = ['name', 'kind', 'headerText', 'bodyText', 'footerText', 'actionTitle', 'sections', 'buttons', 'catalogId', 'productRetailerId', 'productSections'];

// Mesmo formato que a tela manda ao salvar: campo que nao se aplica ao tipo vai
// vazio, para substituir um item sem sobrar lista de outro tipo.
const EMPTY_CONTENT = {
  headerText: '',
  footerText: '',
  actionTitle: '',
  sections: [],
  buttons: [],
  catalogId: '',
  productRetailerId: '',
  productSections: []
};

const falha = (message, status = 400) => Object.assign(new Error(message), { status });

const pickContent = (item) => {
  const out = {};
  for (const field of CONTENT_FIELDS) {
    if (item?.[field] !== undefined && item[field] !== null) out[field] = structuredClone(item[field]);
  }
  return out;
};

const normName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');

const byName = (a, b) => String(a?.name || '').localeCompare(String(b?.name || ''), 'pt-BR');

/* ------------------------------ exportar ------------------------------ */

export const buildInteractiveExport = async ({ tenantId, ids = null, tenantName = null, now = new Date() }) => {
  if (!tenantId) throw falha('tenantId obrigatorio');
  const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
  const items = (await adapter.findDocuments(INTERACTIVE_COLLECTION, { tenantId }))
    .filter((item) => !wanted || wanted.has(String(item.id)))
    .sort(byName)
    .map((item) => ({ id: String(item.id), ...pickContent(item) }));

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    source: { tenantId, tenantName: tenantName || null },
    items
  };
};

/* ------------------------------ importar ------------------------------ */

export const validateInteractiveBundle = (bundle) => {
  if (!bundle || typeof bundle !== 'object' || bundle.format !== EXPORT_FORMAT) {
    throw falha('Este arquivo não é uma exportação de interactives da Onion.');
  }
  if (Number(bundle.version) > EXPORT_VERSION) {
    throw falha('Este arquivo foi gerado por uma versão mais nova da Onion.');
  }
  if (!Array.isArray(bundle.items) || !bundle.items.length) {
    throw falha('O arquivo não tem interactives.');
  }
  if (bundle.items.length > MAX_IMPORT_ITEMS) {
    throw falha(`Importe no máximo ${MAX_IMPORT_ITEMS} interactives de uma vez.`);
  }
  return bundle;
};

const uniqueCopyName = (base, takenNames) => {
  let candidate = `${base} (importado)`;
  for (let n = 2; takenNames.has(normName(candidate)); n += 1) candidate = `${base} (importado ${n})`;
  return candidate;
};

const catalogWarnings = (content, targetCatalogId) => {
  if (!['product', 'product_list'].includes(content.kind)) return [];
  if (!targetCatalogId) return ['Este tenant não tem catálogo da Meta configurado: a mensagem de produto só envia depois de configurar.'];
  if (content.catalogId && content.catalogId !== targetCatalogId) {
    return [`O Catalog ID do arquivo (${content.catalogId}) é diferente do catálogo deste tenant (${targetCatalogId}).`];
  }
  return [];
};

export const importInteractiveTemplates = async ({
  tenantId,
  bundle,
  selectedIds = null,
  onConflict = 'copy',
  dryRun = false,
  now = new Date()
}) => {
  if (!tenantId) throw falha('tenantId obrigatorio');
  if (!CONFLICT_MODES.includes(onConflict)) throw falha('Modo de conflito inválido.');
  validateInteractiveBundle(bundle);

  const selected = Array.isArray(selectedIds) ? new Set(selectedIds.map(String)) : null;
  const existing = await adapter.findDocuments(INTERACTIVE_COLLECTION, { tenantId });
  // nome normalizado -> { id, name, fromThisImport }
  const names = new Map(existing.map((item) => [normName(item.name), { id: String(item.id), name: item.name, fromThisImport: false }]));
  const integration = await getMetaCatalogIntegration(tenantId).catch(() => null);
  const targetCatalogId = String(integration?.catalogId || '').trim() || null;
  const nowIso = now.toISOString();
  const sourceTenantId = bundle.source?.tenantId ? String(bundle.source.tenantId) : null;

  const results = [];
  const idMap = {};
  const seenSourceIds = new Set();

  for (const [index, raw] of bundle.items.entries()) {
    const sourceId = String(raw?.id || `item_${index + 1}`);
    if (selected && !selected.has(sourceId)) continue;

    const base = {
      sourceId,
      name: String(raw?.name || '').trim() || `Item ${index + 1}`,
      kind: raw?.kind || null,
      targetId: null,
      targetName: null,
      conflictWith: null,
      note: null,
      errors: [],
      warnings: []
    };

    if (seenSourceIds.has(sourceId)) {
      results.push({ ...base, status: 'invalid', errors: ['Item repetido no arquivo.'] });
      continue;
    }
    seenSourceIds.add(sourceId);

    const parsed = whatsappInteractiveTemplateSchema.safeParse(pickContent(raw));
    if (!parsed.success) {
      const issues = parsed.error.issues || parsed.error.errors || [];
      results.push({ ...base, status: 'invalid', errors: issues.map((issue) => issue.message).slice(0, 3) });
      continue;
    }

    const content = { ...EMPTY_CONTENT, ...parsed.data };
    const item = { ...base, name: content.name, kind: content.kind, warnings: catalogWarnings(content, targetCatalogId) };
    const conflict = names.get(normName(content.name)) || null;
    if (conflict) item.conflictWith = { id: conflict.fromThisImport ? null : conflict.id, name: conflict.name };

    if (conflict && onConflict === 'skip') {
      results.push({ ...item, status: 'skipped', note: conflict.fromThisImport ? 'Nome repetido no arquivo.' : null });
      // Fluxo que usava o item de origem passa a usar o que ja existe aqui.
      if (!conflict.fromThisImport) idMap[sourceId] = conflict.id;
      continue;
    }

    if (conflict && onConflict === 'replace') {
      if (conflict.fromThisImport) {
        results.push({ ...item, status: 'skipped', note: 'Nome repetido no arquivo: só o primeiro substitui.' });
        continue;
      }
      if (!dryRun) {
        await adapter.updateOne(INTERACTIVE_COLLECTION, { id: conflict.id, tenantId }, {
          $set: { ...content, importedFrom: { tenantId: sourceTenantId, id: sourceId, at: nowIso }, updatedAt: nowIso }
        });
      }
      names.set(normName(content.name), { ...conflict, fromThisImport: true });
      idMap[sourceId] = conflict.id;
      results.push({ ...item, status: 'replaced', targetId: conflict.id, targetName: conflict.name });
      continue;
    }

    const targetName = conflict ? uniqueCopyName(content.name, new Set(names.keys())) : content.name;
    const targetId = dryRun ? null : generateId('wa_int');
    if (!dryRun) {
      await adapter.insertOne(INTERACTIVE_COLLECTION, {
        id: targetId,
        tenantId,
        channel: 'whatsapp',
        type: 'interactive',
        ...content,
        name: targetName,
        importedFrom: { tenantId: sourceTenantId, id: sourceId, at: nowIso },
        createdAt: nowIso,
        updatedAt: nowIso
      });
      idMap[sourceId] = targetId;
    }
    names.set(normName(targetName), { id: targetId, name: targetName, fromThisImport: true });
    results.push({ ...item, status: 'created', targetId, targetName });
  }

  const flows = dryRun || !Object.keys(idMap).length
    ? []
    : await remapFlowInteractiveReferences({ tenantId, idMap, now });

  const count = (status) => results.filter((item) => item.status === status).length;
  return {
    dryRun: Boolean(dryRun),
    onConflict,
    source: {
      tenantId: sourceTenantId,
      tenantName: bundle.source?.tenantName || null,
      exportedAt: bundle.exportedAt || null
    },
    targetTenantId: tenantId,
    targetCatalogId,
    summary: { created: count('created'), replaced: count('replaced'), skipped: count('skipped'), invalid: count('invalid') },
    items: results,
    flows
  };
};

/* ---------------------- referencias nos fluxos ---------------------- */

// Troca `interactiveTemplateId` que aponta para um id de origem sem item neste
// tenant. Referencia valida nunca e tocada.
export const remapFlowInteractiveReferences = async ({ tenantId, idMap, now = new Date() }) => {
  const localIds = new Set((await adapter.findDocuments(INTERACTIVE_COLLECTION, { tenantId })).map((item) => String(item.id)));
  const flows = await adapter.findDocuments('flows', { tenantId });
  const updated = [];

  const remapNodes = (nodes) => {
    if (!Array.isArray(nodes)) return null;
    let changed = false;
    const next = nodes.map((node) => {
      const ref = node?.data?.interactiveTemplateId;
      if (!ref) return node;
      const key = String(ref);
      if (localIds.has(key) || !idMap[key]) return node;
      changed = true;
      return { ...node, data: { ...node.data, interactiveTemplateId: idMap[key] } };
    });
    return changed ? next : null;
  };

  for (const flow of flows) {
    const set = {};
    const top = remapNodes(flow.nodes);
    if (top) set.nodes = top;
    const draft = remapNodes(flow.draft?.nodes);
    if (draft) set.draft = { ...flow.draft, nodes: draft };
    const published = remapNodes(flow.published?.nodes);
    if (published) set.published = { ...flow.published, nodes: published };
    if (!Object.keys(set).length) continue;

    set.updatedAt = now.toISOString();
    await adapter.updateOne('flows', { id: flow.id, tenantId }, { $set: set });
    invalidateRuntimeFlowCache(tenantId, flow.id);
    updated.push({ id: flow.id, name: flow.name || flow.id });
  }
  return updated;
};
