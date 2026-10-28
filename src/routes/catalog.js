import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { createLog } from '../services/logs.js';
import { generateId } from '../utils/helpers.js';
import {
  getMetaCatalogIntegration,
  inspectMetaCatalog,
  saveMetaCatalogIntegration,
  syncMetaCatalogItem,
  syncMetaCatalogItems
} from '../services/metaCatalog.js';

const router = express.Router();

const normalizeText = (value) => String(value || '').trim();

const resolveTenantId = (req) => {
  if (req.user?.role === 'SUPER_ADMIN') {
    return req.body?.tenantId || req.query?.tenantId || req.tenantId || null;
  }
  return req.tenantId || null;
};

router.get('/items', authenticate, requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId é obrigatório' });
    }

    const q = normalizeText(req.query.q).toLowerCase();
    const category = normalizeText(req.query.category).toLowerCase();
    const activeFilter = normalizeText(req.query.active).toLowerCase();
    const metaFilter = normalizeText(req.query.meta).toLowerCase();
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100', 10) || 100, 1), 500);

    const all = await adapter.getCollection('catalogItems', tenantId);
    let filtered = Array.isArray(all) ? all : [];

    if (activeFilter && activeFilter !== 'all') {
      const wantsActive = activeFilter === 'true' || activeFilter === '1' || activeFilter === 'yes';
      filtered = filtered.filter((item) => Boolean(item.active !== false) === wantsActive);
    }

    if (category) {
      filtered = filtered.filter((item) => String(item.category || '').toLowerCase() === category);
    }

    if (metaFilter === 'ready' || metaFilter === 'synced') {
      filtered = filtered.filter((item) => item.metaSyncStatus === 'synced' && item.metaProductRetailerId && item.metaCatalogId);
    } else if (metaFilter === 'error') {
      filtered = filtered.filter((item) => item.metaSyncStatus === 'error');
    }

    if (q) {
      filtered = filtered.filter((item) => {
        const haystack = [
          item.name,
          item.description,
          item.sku,
          item.category
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    filtered.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    res.json({ items, total, page, totalPages, limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/items', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'catalogo.editar' }), requireTenant, async (req, res) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId é obrigatório' });
    }

    const name = normalizeText(req.body?.name);
    if (!name) {
      return res.status(400).json({ error: 'name é obrigatório' });
    }

    const now = new Date().toISOString();
    const item = {
      id: generateId('catalog'),
      tenantId,
      name,
      description: normalizeText(req.body?.description),
      sku: normalizeText(req.body?.sku),
      category: normalizeText(req.body?.category),
      mediaUrl: normalizeText(req.body?.mediaUrl),
      productUrl: normalizeText(req.body?.productUrl),
      brand: normalizeText(req.body?.brand),
      currency: normalizeText(req.body?.currency || 'BRL').toUpperCase(),
      availability: normalizeText(req.body?.availability || 'in stock'),
      condition: normalizeText(req.body?.condition || 'new'),
      price: req.body?.price === '' || req.body?.price === undefined || req.body?.price === null
        ? null
        : Number(req.body.price),
      active: req.body?.active !== false,
      createdAt: now,
      updatedAt: now
    };

    if (item.price !== null && !Number.isFinite(item.price)) {
      return res.status(400).json({ error: 'price inválido' });
    }

    if (!adapter.db) await adapter.init();
    await adapter.db.collection('catalogItems').insertOne(item);
    await createLog('CATALOG_ITEM_CREATE', { itemId: item.id, tenantId, name: item.name }, req.user?.id || 'system');
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/items/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'catalogo.editar' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId é obrigatório' });
    }

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('catalogItems');
    const query = { id: req.params.id, tenantId };
    const current = await collection.findOne(query);
    if (!current) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }

    const updates = {
      name: req.body?.name !== undefined ? normalizeText(req.body.name) : current.name,
      description: req.body?.description !== undefined ? normalizeText(req.body.description) : current.description,
      sku: req.body?.sku !== undefined ? normalizeText(req.body.sku) : current.sku,
      category: req.body?.category !== undefined ? normalizeText(req.body.category) : current.category,
      mediaUrl: req.body?.mediaUrl !== undefined ? normalizeText(req.body.mediaUrl) : current.mediaUrl,
      productUrl: req.body?.productUrl !== undefined ? normalizeText(req.body.productUrl) : current.productUrl,
      brand: req.body?.brand !== undefined ? normalizeText(req.body.brand) : current.brand,
      currency: req.body?.currency !== undefined ? normalizeText(req.body.currency).toUpperCase() : (current.currency || 'BRL'),
      availability: req.body?.availability !== undefined ? normalizeText(req.body.availability) : (current.availability || 'in stock'),
      condition: req.body?.condition !== undefined ? normalizeText(req.body.condition) : (current.condition || 'new'),
      active: req.body?.active !== undefined ? Boolean(req.body.active) : current.active,
      updatedAt: new Date().toISOString(),
      ...(current.metaSyncStatus === 'synced' ? { metaSyncStatus: 'stale' } : {})
    };

    if (req.body?.price !== undefined) {
      updates.price = req.body.price === '' || req.body.price === null ? null : Number(req.body.price);
      if (updates.price !== null && !Number.isFinite(updates.price)) {
        return res.status(400).json({ error: 'price inválido' });
      }
    } else {
      updates.price = current.price ?? null;
    }

    await collection.updateOne(query, { $set: updates });
    const updated = { ...current, ...updates };
    await createLog('CATALOG_ITEM_UPDATE', { itemId: updated.id, tenantId, name: updated.name }, req.user?.id || 'system');
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/meta', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'catalogo.editar' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const integration = await getMetaCatalogIntegration(tenantId);
    res.json({
      integration: integration ? {
        ...integration,
        configured: Boolean(integration.catalogId),
        accessTokenStoredInChannel: true
      } : null
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/meta/test', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'catalogo.editar' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const catalog = await inspectMetaCatalog({ tenantId, catalogId: req.body?.catalogId || null });
    res.json({ ok: true, catalog });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || null });
  }
});

router.put('/meta', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'catalogo.editar' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const integration = await saveMetaCatalogIntegration({ tenantId, input: req.body || {}, actorId: req.user?.id || null });
    await createLog('META_CATALOG_CONNECT', {
      tenantId,
      catalogId: integration.catalogId,
      remoteName: integration.remoteName
    }, req.user?.id || 'system');
    res.json({ integration });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || null });
  }
});

router.post('/meta/sync', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'catalogo.editar' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const result = await syncMetaCatalogItems({ tenantId, itemIds: req.body?.itemIds || null });
    await createLog('META_CATALOG_SYNC', { tenantId, total: result.total, success: result.success, failed: result.failed }, req.user?.id || 'system');
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || null });
  }
});

router.post('/items/:id/meta-sync', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'catalogo.editar' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    const result = await syncMetaCatalogItem({ tenantId, itemId: req.params.id });
    await createLog('META_CATALOG_ITEM_SYNC', {
      tenantId,
      itemId: req.params.id,
      productId: result.response.id
    }, req.user?.id || 'system');
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || null });
  }
});

router.delete('/items/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'catalogo.editar' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId é obrigatório' });
    }

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('catalogItems');
    const query = { id: req.params.id, tenantId };
    const item = await collection.findOne(query);
    if (!item) {
      return res.status(404).json({ error: 'Item não encontrado' });
    }

    await collection.deleteOne(query);
    await createLog('CATALOG_ITEM_DELETE', { itemId: item.id, tenantId, name: item.name }, req.user?.id || 'system');
    res.json({ success: true, deleted: item });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
