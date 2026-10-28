import express from 'express';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { pageFromQuery } from '../services/outreachDomain.js';
import internalTasksRouter from './internalTasks.js';

const router = express.Router();
router.use(authenticate, requireTenant);
router.use('/internal', internalTasksRouter);
router.get('/assigned', authorize(['ADMIN', 'MANAGER', 'AGENT'], { permission: 'atendimento.historico' }), async (req, res) => {
  const { page, limit, skip } = pageFromQuery(req.query);
  const query = {
    tenantId: req.tenantId,
    ...(req.user.role === 'AGENT' ? { assignedTo: req.user.id } : {}),
    status: { $ne: 'deleted' }
  };
  const [items, total] = await Promise.all([
    adapter.findMany('commercialTasks', { query, projection: { _id: 0 }, sort: { dueAt: 1, createdAt: -1 }, skip, limit }),
    adapter.countDocuments('commercialTasks', query)
  ]);
  res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});
export default router;
