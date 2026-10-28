import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { createLog } from '../services/logs.js';
import { generateId } from '../utils/helpers.js';

const router = express.Router();

const normalizeQueueName = (value) => String(value || '').trim().toUpperCase();

const buildQueuePayload = (body = {}) => ({
  name: normalizeQueueName(body.name),
  color: String(body.color || '#3b82f6').trim() || '#3b82f6',
  description: String(body.description || '').trim(),
  entryMessage: String(body.entryMessage || '').trim(),
  waitingMessage: String(body.waitingMessage || '').trim(),
  active: body.active === undefined ? true : Boolean(body.active)
});

router.get('/', authenticate, requireTenant, async (req, res) => {
  try {
    const queues = await adapter.getCollection('queues', req.tenantId);
    res.json(queues || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(['ADMIN'], { manager: 'equipe', permission: 'equipe.filas' }), requireTenant, async (req, res) => {
  try {
    const payload = buildQueuePayload(req.body || {});
    const { name } = payload;
    if (!name) return res.status(400).json({ error: 'Nome e obrigatorio' });

    const tenantId = req.user.role === 'SUPER_ADMIN'
      ? (req.query.tenantId || req.body.tenantId || req.tenantId)
      : req.tenantId;

    const newQueue = {
      id: generateId('q'),
      ...payload,
      tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('queues');
    await collection.insertOne(newQueue);

    await createLog('QUEUE_CREATE', { id: newQueue.id, name: newQueue.name, tenantId: newQueue.tenantId }, req.user.id);
    res.json(newQueue);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authenticate, authorize(['ADMIN'], { manager: 'equipe', permission: 'equipe.filas' }), requireTenant, async (req, res) => {
  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('queues');

    const query = { id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.tenantId = req.tenantId;
    } else if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const queue = await collection.findOne(query);
    if (!queue) return res.status(404).json({ error: 'Fila nao encontrada' });

    const payload = buildQueuePayload({
      ...queue,
      ...(req.body || {})
    });

    if (!payload.name) return res.status(400).json({ error: 'Nome e obrigatorio' });

    const duplicate = await collection.findOne({
      tenantId: queue.tenantId,
      name: payload.name,
      id: { $ne: queue.id }
    });
    if (duplicate) return res.status(409).json({ error: 'Ja existe uma fila com este nome' });

    const updatedAt = new Date().toISOString();
    const updatedQueue = {
      ...queue,
      ...payload,
      updatedAt
    };

    await collection.updateOne({ id: queue.id }, { $set: updatedQueue });

    if (queue.name !== payload.name) {
      await adapter.db.collection('users').updateMany(
        { tenantId: queue.tenantId, queues: queue.name },
        { $set: { 'queues.$': payload.name, updatedAt } }
      );
      await adapter.db.collection('activeChats').updateMany(
        { tenantId: queue.tenantId, queue: queue.name },
        { $set: { queue: payload.name, updatedAt } }
      );
    }

    await createLog('QUEUE_UPDATE', { id: updatedQueue.id, name: updatedQueue.name, tenantId: updatedQueue.tenantId }, req.user.id);
    res.json(updatedQueue);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id/agents', authenticate, authorize(['ADMIN'], { manager: 'equipe', permission: 'equipe.filas' }), requireTenant, async (req, res) => {
  try {
    const agentIds = Array.isArray(req.body?.agentIds)
      ? req.body.agentIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [];

    if (!adapter.db) await adapter.init();
    const queueCollection = adapter.db.collection('queues');

    const query = { id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.tenantId = req.tenantId;
    } else if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const queue = await queueCollection.findOne(query);
    if (!queue) return res.status(404).json({ error: 'Fila nao encontrada' });

    const usersCollection = adapter.db.collection('users');
    const agents = await usersCollection.find({
      tenantId: queue.tenantId,
      role: 'AGENT'
    }).toArray();

    const selected = new Set(agentIds);
    const updatedAt = new Date().toISOString();
    await Promise.all(agents.map(async (agent) => {
      const queues = Array.isArray(agent.queues) ? agent.queues : [];
      const hasQueue = queues.includes(queue.name);
      const shouldHaveQueue = selected.has(agent.id);
      if (hasQueue === shouldHaveQueue) return;

      const nextQueues = shouldHaveQueue
        ? [...queues, queue.name]
        : queues.filter((name) => name !== queue.name);

      await usersCollection.updateOne(
        { id: agent.id },
        { $set: { queues: nextQueues, updatedAt } }
      );
    }));

    await createLog('QUEUE_AGENT_BINDINGS_UPDATE', {
      id: queue.id,
      name: queue.name,
      tenantId: queue.tenantId,
      agentCount: agentIds.length
    }, req.user.id);

    res.json({ ok: true, queueId: queue.id, queueName: queue.name, agentIds });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(['ADMIN'], { manager: 'equipe', permission: 'equipe.filas' }), requireTenant, async (req, res) => {
  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('queues');

    const query = { id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.tenantId = req.tenantId;
    } else if (req.tenantId) {
      query.tenantId = req.tenantId;
    }

    const queue = await collection.findOne(query);
    if (!queue) return res.status(404).json({ error: 'Fila nao encontrada' });

    await collection.deleteOne(query);
    await adapter.db.collection('users').updateMany(
      { tenantId: queue.tenantId, queues: queue.name },
      { $pull: { queues: queue.name }, $set: { updatedAt: new Date().toISOString() } }
    );

    await createLog('QUEUE_DELETE', { id: queue.id, name: queue.name, tenantId: queue.tenantId }, req.user.id);
    res.json({ message: 'Fila removida' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
