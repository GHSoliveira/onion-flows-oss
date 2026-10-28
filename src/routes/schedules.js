import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { scheduleSchema } from '../schemas/index.js';
import { invalidateRuntimeSchedulesCache } from '../services/flowRuntimeCache.js';
import { generateId } from '../utils/helpers.js';

const router = express.Router();

router.get('/', authenticate, requireTenant, async (req, res) => {
  try {
    const schedules = await adapter.getCollection('schedules', req.tenantId);
    res.json(schedules);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.empresa' }), requireTenant, async (req, res) => {
  try {
    const data = scheduleSchema.parse(req.body);

    const schedule = {
      id: generateId('sch'),
      ...data,
      tenantId: req.user.role === 'SUPER_ADMIN'
        ? (req.body.tenantId || req.tenantId)
        : req.tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('schedules');
    await collection.insertOne(schedule);
    invalidateRuntimeSchedulesCache(schedule.tenantId);

    res.status(201).json(schedule);
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.empresa' }), requireTenant, async (req, res) => {
  try {
    const { id } = req.params;

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('schedules');

    const query = { id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.tenantId = req.tenantId;
    } else if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const schedule = await collection.findOne(query);

    if (!schedule) {
      return res.status(404).json({ error: 'Horario nao encontrado' });
    }

    await collection.deleteOne(query);
    invalidateRuntimeSchedulesCache(schedule.tenantId);
    res.json({ message: 'Horario removido', deleted: schedule });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
