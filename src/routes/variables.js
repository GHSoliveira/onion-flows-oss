import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { variableSchema } from '../schemas/index.js';
import { createLog } from '../services/logs.js';
import { generateId } from '../utils/helpers.js';

const router = express.Router();

router.get('/', authenticate, requireTenant, async (req, res) => {
  try {
    const variables = await adapter.getCollection('variables', req.tenantId);
    res.json(variables);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'fluxos', permission: 'fluxos.editar' }), requireTenant, async (req, res) => {
  try {
    const data = variableSchema.parse(req.body);

    const tenantId = req.user.role === 'SUPER_ADMIN'
      ? (req.body.tenantId || req.tenantId)
      : req.tenantId;

    const variable = {
      id: generateId('var'),
      ...data,
      isRoot: data.isRoot === true,
      enabled: data.enabled !== false,
      tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('variables');
    await collection.insertOne(variable);

    await createLog('VARIABLE_CREATE', { id: variable.id, name: variable.name, tenantId: variable.tenantId }, req.user.id);
    res.status(201).json(variable);
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'fluxos', permission: 'fluxos.editar' }), requireTenant, async (req, res) => {
  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('variables');

    const query = { id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.tenantId = req.tenantId;
    } else if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const variable = await collection.findOne(query);
    if (!variable) return res.status(404).json({ error: 'Variavel nao encontrada' });

    const updates = { ...req.body };
    delete updates._id;
    delete updates.id;

    const updated = {
      ...variable,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await collection.updateOne(query, { $set: updated });
    await createLog('VARIABLE_UPDATE', { id: updated.id, name: updated.name, tenantId: updated.tenantId }, req.user.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'fluxos', permission: 'fluxos.editar' }), requireTenant, async (req, res) => {
  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('variables');

    const query = { id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.tenantId = req.tenantId;
    } else if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const variable = await collection.findOne(query);
    if (!variable) return res.status(404).json({ error: 'Variavel nao encontrada' });

    await collection.deleteOne(query);

    await createLog('VARIABLE_DELETE', { id: variable.id, name: variable.name, tenantId: variable.tenantId }, req.user.id);
    res.json({ message: 'Variavel removida', deleted: variable });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
