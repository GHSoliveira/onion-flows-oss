import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { tagSchema } from '../schemas/index.js';
import { generateId } from '../utils/helpers.js';

const router = express.Router();

router.get('/', authenticate, authorize(['ADMIN', 'MANAGER', 'SUPER_ADMIN'], { permission: 'operacao.ver' }), requireTenant, async (req, res) => {
  try {
    const tags = await adapter.getCollection('tags', req.tenantId);
    res.json(tags);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'respostas', permission: 'respostas.editar' }), requireTenant, async (req, res) => {
  try {
    const data = tagSchema.parse(req.body);

    const tag = {
      id: generateId('tag'),
      ...data,
      color: data.color || '#3B82F6',
      tenantId: req.user.role === 'SUPER_ADMIN' ? req.body.tenantId : req.tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await adapter.insertOne('tags', tag);
    res.status(201).json(tag);
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'respostas', permission: 'respostas.editar' }), requireTenant, async (req, res) => {
  try {
    const { name, color } = req.body;
    const tag = await adapter.findOne('tags', { id: req.params.id });

    if (!tag) return res.status(404).json({ error: 'Tag não encontrada' });

    if (req.user.role !== 'SUPER_ADMIN' && tag.tenantId !== req.tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    const updates = { name, color, updatedAt: new Date().toISOString() };
    await adapter.updateOne('tags', { id: req.params.id }, { $set: updates });
    res.json({ ...tag, ...updates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'respostas', permission: 'respostas.editar' }), requireTenant, async (req, res) => {
  try {
    const allTags = await adapter.getCollection('tags');
    const tag = allTags.find(t => t.id === req.params.id);

    if (!tag) return res.status(404).json({ error: 'Tag não encontrada' });

    if (req.user.role !== 'SUPER_ADMIN' && tag.tenantId !== req.tenantId) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    // Usar deleteOne diretamente para persistir no MongoDB
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('tags');
    await collection.deleteOne({ id: req.params.id });

    res.json({ message: 'Tag removida', deleted: tag });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
