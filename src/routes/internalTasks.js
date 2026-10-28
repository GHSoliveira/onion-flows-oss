import express from 'express';
import { internalTasks } from '../services/internalTasks.js';

// Mounted below /api/tasks authentication and tenant middleware.
const router = express.Router();
const handle = (operation, status = 200) => async (req, res) => {
  try {
    const ctx = { tenantId: req.tenantId, user: req.user };
    res.status(status).json(await operation(ctx, req));
  } catch (error) {
    const statusCode = [400, 403, 404, 409].includes(error.status) ? error.status : 500;
    if (statusCode === 500) console.error('[INTERNAL_TASKS] Operation failed', { method: req.method, tenantId: req.tenantId });
    res.status(statusCode).json({ error: statusCode === 500 ? 'Erro ao processar tarefa.' : error.message });
  }
};
router.get('/', handle((ctx, req) => internalTasks.list(ctx, req.query)));
router.post('/', handle((ctx, req) => internalTasks.create(ctx, req.body), 201));
router.get('/:id', handle((ctx, req) => internalTasks.get(ctx, req.params.id)));
router.post('/:id/actions', handle((ctx, req) => internalTasks.transition(ctx, req.params.id, req.body)));
export default router;
