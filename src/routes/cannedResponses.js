import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { cannedResponseSchema } from '../schemas/index.js';
import { generateId } from '../utils/helpers.js';

const router = express.Router();

router.get('/', authenticate, authorize(['AGENT', 'ADMIN', 'MANAGER', 'SUPER_ADMIN'], { permission: 'atendimento.historico' }), requireTenant, async (req, res) => {
  try {
    const responses = await adapter.getCollection('cannedResponses', req.tenantId);
    res.json(responses);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'respostas', permission: 'respostas.editar' }), requireTenant, async (req, res) => {
  try {
    const data = cannedResponseSchema.parse(req.body);

    const response = {
      id: generateId('cr'),
      ...data,
      tenantId: req.user.role === 'SUPER_ADMIN' ? req.body.tenantId : req.tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await adapter.insertOne('cannedResponses', response);
    res.status(201).json(response);
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'respostas', permission: 'respostas.editar' }), requireTenant, async (req, res) => {
  try {
    const { name, message, shortcut } = req.body;
    const response = await adapter.findOne('cannedResponses', { id: req.params.id });

    if (!response) return res.status(404).json({ error: 'Canned Response não encontrado' });

    if (req.user.role !== 'SUPER_ADMIN' && response.tenantId !== req.tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const updates = { name, message, shortcut, updatedAt: new Date().toISOString() };
    await adapter.updateOne('cannedResponses', { id: req.params.id }, { $set: updates });
    res.json({ ...response, ...updates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'respostas', permission: 'respostas.editar' }), requireTenant, async (req, res) => {
  try {
    const allResponses = await adapter.getCollection('cannedResponses');
    const response = allResponses.find(r => r.id === req.params.id);

    if (!response) return res.status(404).json({ error: 'Canned Response não encontrado' });

    if (req.user.role !== 'SUPER_ADMIN' && response.tenantId !== req.tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    // Usar deleteOne diretamente para persistir no MongoDB
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('cannedResponses');
    await collection.deleteOne({ id: req.params.id });

    res.json({ message: 'Canned Response removido', deleted: response });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
