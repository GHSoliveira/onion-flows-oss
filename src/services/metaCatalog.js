import adapter from '../../db/DatabaseAdapter.js';
import { getWhatsAppConfig } from './channelConfig.js';

const GRAPH_VERSION = process.env.META_CATALOG_GRAPH_VERSION || 'v24.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;
const REQUEST_TIMEOUT_MS = Math.max(Number(process.env.META_CATALOG_TIMEOUT_MS || 20000), 5000);

const normalizeText = (value) => String(value ?? '').trim();

const asAbsoluteHttpsUrl = (value, label) => {
  const normalized = normalizeText(value);
  if (!normalized) throw new Error(`${label} e obrigatoria para sincronizar com a Meta`);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${label} precisa ser uma URL publica completa`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} precisa usar HTTPS`);
  return parsed.toString();
};

const parseGraphError = (payload, fallback) => {
  const message = payload?.error?.message || fallback;
  const details = payload?.error?.error_data?.details;
  const error = new Error(details ? `${message} | ${details}` : message);
  error.status = Number(payload?.error?.code) === 190 ? 401 : 502;
  error.code = payload?.error?.code || null;
  error.subcode = payload?.error?.error_subcode || null;
  return error;
};

const graphRequest = async ({ path, accessToken, method = 'GET', body = null, form = null, query = null }) => {
  if (!accessToken) throw new Error('Access token do WhatsApp nao configurado');
  const url = new URL(`${GRAPH_BASE_URL}/${String(path || '').replace(/^\/+/, '')}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
    },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw parseGraphError(payload, `Meta Catalog API respondeu HTTP ${response.status}`);
  }
  return payload;
};

const getCollection = async (name) => {
  if (!adapter.db) await adapter.init();
  return adapter.db.collection(name);
};

const sanitizeRetailerId = (value) => {
  const normalized = normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  if (!normalized) throw new Error('Defina um SKU valido antes de sincronizar o produto');
  return normalized;
};

export const buildMetaProductPayload = (item, integration) => {
  const price = Number(item?.price);
  if (!Number.isFinite(price) || price < 0) {
    throw new Error('O produto precisa de um preco valido para sincronizar com a Meta');
  }

  const currency = normalizeText(item?.currency || integration?.currency || 'BRL').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Moeda invalida; utilize o codigo ISO com 3 letras');

  const productUrl = normalizeText(item?.productUrl);

  return {
    retailer_id: sanitizeRetailerId(item?.sku || item?.id),
    name: normalizeText(item?.name).slice(0, 200),
    description: (normalizeText(item?.description) || normalizeText(item?.name)).slice(0, 5000),
    availability: item?.active === false ? 'out of stock' : normalizeText(item?.availability || 'in stock'),
    condition: normalizeText(item?.condition || 'new'),
    price: Math.round(price * 100),
    currency,
    image_url: asAbsoluteHttpsUrl(item?.mediaUrl, 'URL da imagem'),
    ...(productUrl ? { url: asAbsoluteHttpsUrl(productUrl, 'URL publica do produto') } : {}),
    brand: (normalizeText(item?.brand || integration?.defaultBrand) || 'Sem marca').slice(0, 100),
    allow_upsert: true
  };
};

export const getMetaCatalogIntegration = async (tenantId) => {
  if (!tenantId) return null;
  const collection = await getCollection('catalogIntegrations');
  return collection.findOne({ tenantId, provider: 'meta' });
};

const getCatalogRuntime = async (tenantId, overrideCatalogId = null) => {
  const [integration, whatsapp] = await Promise.all([
    getMetaCatalogIntegration(tenantId),
    getWhatsAppConfig(tenantId)
  ]);
  const catalogId = normalizeText(overrideCatalogId || integration?.catalogId);
  if (!catalogId) throw new Error('Configure o Catalog ID da Meta antes de sincronizar');
  if (!whatsapp?.accessToken) throw new Error('Configure o access token no canal WhatsApp antes de sincronizar');
  return { integration, whatsapp, catalogId };
};

export const inspectMetaCatalog = async ({ tenantId, catalogId = null }) => {
  const runtime = await getCatalogRuntime(tenantId, catalogId);
  const catalog = await graphRequest({
    path: runtime.catalogId,
    accessToken: runtime.whatsapp.accessToken,
    query: { fields: 'id,name,product_count,vertical' }
  });
  return {
    id: catalog.id || runtime.catalogId,
    name: catalog.name || null,
    productCount: Number(catalog.product_count || 0),
    vertical: catalog.vertical || null
  };
};

const listWabaCatalogs = async (runtime) => {
  const wabaId = normalizeText(runtime?.whatsapp?.wabaId);
  if (!wabaId) throw new Error('Configure o WABA ID no canal WhatsApp antes de conectar o catalogo');

  const response = await graphRequest({
    path: `${wabaId}/product_catalogs`,
    accessToken: runtime.whatsapp.accessToken,
    query: { fields: 'id,name' }
  });
  return Array.isArray(response?.data) ? response.data : [];
};

export const ensureMetaCatalogLinkedToWaba = async ({ tenantId, catalogId = null }) => {
  const runtime = await getCatalogRuntime(tenantId, catalogId);
  const wabaId = normalizeText(runtime.whatsapp?.wabaId);
  let catalogs = await listWabaCatalogs(runtime);
  let linked = catalogs.some((catalog) => normalizeText(catalog?.id) === runtime.catalogId);

  if (!linked) {
    await graphRequest({
      path: `${wabaId}/product_catalogs`,
      accessToken: runtime.whatsapp.accessToken,
      method: 'POST',
      form: { catalog_id: runtime.catalogId }
    });
    catalogs = await listWabaCatalogs(runtime);
    linked = catalogs.some((catalog) => normalizeText(catalog?.id) === runtime.catalogId);
  }

  if (!linked) {
    const error = new Error('A Meta nao confirmou o vinculo do catalogo com a conta WhatsApp Business');
    error.status = 502;
    throw error;
  }

  return { linked: true, wabaId, catalogs };
};

const enableWhatsAppCommerceSettings = async (runtime) => {
  const phoneNumberId = normalizeText(runtime?.whatsapp?.phoneNumberId);
  if (!phoneNumberId) throw new Error('Configure o Phone Number ID no canal WhatsApp antes de conectar o catalogo');

  await graphRequest({
    path: `${phoneNumberId}/whatsapp_commerce_settings`,
    accessToken: runtime.whatsapp.accessToken,
    method: 'POST',
    query: {
      is_cart_enabled: true,
      is_catalog_visible: true
    }
  });
  return { requested: true, phoneNumberId };
};

export const saveMetaCatalogIntegration = async ({ tenantId, input, actorId = null }) => {
  const catalogId = normalizeText(input?.catalogId);
  if (!/^\d+$/.test(catalogId)) throw new Error('Catalog ID da Meta invalido');
  const currency = normalizeText(input?.currency || 'BRL').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Moeda invalida; utilize um codigo ISO como BRL');

  const remote = await inspectMetaCatalog({ tenantId, catalogId });
  const binding = await ensureMetaCatalogLinkedToWaba({ tenantId, catalogId });
  const runtime = await getCatalogRuntime(tenantId, catalogId);
  const commerce = await enableWhatsAppCommerceSettings(runtime);
  const collection = await getCollection('catalogIntegrations');
  const current = await collection.findOne({ tenantId, provider: 'meta' });
  const now = new Date().toISOString();
  const record = {
    ...(current || {}),
    id: current?.id || `catalog_meta_${tenantId}`,
    tenantId,
    provider: 'meta',
    catalogId,
    currency,
    defaultBrand: normalizeText(input?.defaultBrand),
    enabled: input?.enabled !== false,
    status: 'connected',
    wabaId: binding.wabaId,
    wabaLinked: true,
    wabaLinkedAt: now,
    commercePhoneNumberId: commerce.phoneNumberId,
    commerceSettingsRequested: true,
    commerceSettingsRequestedAt: now,
    remoteName: remote.name,
    remoteProductCount: remote.productCount,
    remoteVertical: remote.vertical,
    verifiedAt: now,
    updatedAt: now,
    updatedBy: actorId,
    createdAt: current?.createdAt || now
  };
  await collection.updateOne(
    { tenantId, provider: 'meta' },
    { $set: record },
    { upsert: true }
  );
  return record;
};

const persistItemSyncState = async (tenantId, itemId, patch) => {
  const collection = await getCollection('catalogItems');
  await collection.updateOne(
    { tenantId, id: itemId },
    { $set: { ...patch, updatedAt: new Date().toISOString() } }
  );
  return collection.findOne({ tenantId, id: itemId });
};

export const syncMetaCatalogItem = async ({ tenantId, itemId }) => {
  const itemCollection = await getCollection('catalogItems');
  const item = await itemCollection.findOne({ tenantId, id: itemId });
  if (!item) {
    const error = new Error('Item de catalogo nao encontrado');
    error.status = 404;
    throw error;
  }

  const runtime = await getCatalogRuntime(tenantId);
  if (!runtime.integration?.enabled) throw new Error('A integracao com o catalogo Meta esta desativada');
  const product = buildMetaProductPayload(item, runtime.integration);
  const startedAt = new Date().toISOString();
  await persistItemSyncState(tenantId, itemId, {
    metaCatalogId: runtime.catalogId,
    metaProductRetailerId: product.retailer_id,
    metaSyncStatus: 'syncing',
    metaSyncStartedAt: startedAt,
    metaSyncError: null
  });

  try {
    const response = await graphRequest({
      path: `${runtime.catalogId}/products`,
      accessToken: runtime.whatsapp.accessToken,
      method: 'POST',
      body: product
    });
    const syncedAt = new Date().toISOString();
    const updated = await persistItemSyncState(tenantId, itemId, {
      metaCatalogId: runtime.catalogId,
      metaProductId: response?.id || item?.metaProductId || null,
      metaProductRetailerId: product.retailer_id,
      metaSyncStatus: 'synced',
      metaSyncedAt: syncedAt,
      metaSyncError: null
    });
    return { item: updated, response: { id: response?.id || null } };
  } catch (error) {
    await persistItemSyncState(tenantId, itemId, {
      metaCatalogId: runtime.catalogId,
      metaProductRetailerId: product.retailer_id,
      metaSyncStatus: 'error',
      metaSyncError: String(error?.message || 'Falha ao sincronizar').slice(0, 500),
      metaSyncFailedAt: new Date().toISOString()
    });
    throw error;
  }
};

export const syncMetaCatalogItems = async ({ tenantId, itemIds = null }) => {
  const collection = await getCollection('catalogItems');
  const query = { tenantId, active: { $ne: false } };
  if (Array.isArray(itemIds) && itemIds.length) query.id = { $in: itemIds.map(normalizeText).filter(Boolean) };
  const items = await collection.find(query).sort({ updatedAt: 1 }).limit(500).toArray();
  const results = [];

  // Sequential processing avoids bursts against Meta and keeps per-item state deterministic.
  for (const item of items) {
    try {
      const result = await syncMetaCatalogItem({ tenantId, itemId: item.id });
      results.push({ itemId: item.id, ok: true, productId: result.response.id });
    } catch (error) {
      results.push({ itemId: item.id, ok: false, error: String(error?.message || 'Falha desconhecida').slice(0, 500) });
    }
  }

  return {
    total: results.length,
    success: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results
  };
};
