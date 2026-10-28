import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { webhookSchema } from '../schemas/index.js';
import { generateId } from '../utils/helpers.js';

const router = express.Router();

router.get('/', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.empresa' }), requireTenant, async (req, res) => {
  try {
    const webhooks = await adapter.getCollection('webhooks', req.tenantId);
    res.json(webhooks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.empresa' }), requireTenant, async (req, res) => {
  try {
    const data = webhookSchema.parse(req.body);

    const webhook = {
      id: generateId('wh'),
      ...data,
      secret: data.secret || null,
      tenantId: req.user.role === 'SUPER_ADMIN' ? req.body.tenantId : req.tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await adapter.insertOne('webhooks', webhook);
    res.status(201).json(webhook);
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.empresa' }), requireTenant, async (req, res) => {
  try {
    const { name, url, events, secret } = req.body;
    const webhook = await adapter.findOne('webhooks', { id: req.params.id });

    if (!webhook) return res.status(404).json({ error: 'Webhook não encontrado' });

    if (req.user.role !== 'SUPER_ADMIN' && webhook.tenantId !== req.tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const updates = { name, url, events, secret, updatedAt: new Date().toISOString() };
    await adapter.updateOne('webhooks', { id: req.params.id }, { $set: updates });
    res.json({ ...webhook, ...updates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.empresa' }), requireTenant, async (req, res) => {
  try {
    const allWebhooks = await adapter.getCollection('webhooks');
    const webhook = allWebhooks.find(w => w.id === req.params.id);

    if (!webhook) return res.status(404).json({ error: 'Webhook não encontrado' });

    if (req.user.role !== 'SUPER_ADMIN' && webhook.tenantId !== req.tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    // Usar deleteOne diretamente para persistir no MongoDB
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('webhooks');
    await collection.deleteOne({ id: req.params.id });

    res.json({ message: 'Webhook removido', deleted: webhook });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
