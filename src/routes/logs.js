import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize, requireSuperAdminPermission } from '../middleware/authorization.js';
import adapter from '../../db/DatabaseAdapter.js';

const router = express.Router();

// Apenas SUPER_ADMIN pode acessar logs de auditoria
router.get('/', authenticate, authorize(['SUPER_ADMIN']), requireSuperAdminPermission(['logs:read']), async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const limitRaw = parseInt(req.query.limit || '200', 10) || 200;
    const limit = Math.min(Math.max(limitRaw, 1), 1000);
    const logs = await adapter.getCollection('systemLogs');
    const total = logs?.length || 0;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const sliced = (logs || []).slice(start, start + limit);
    res.json({ logs: sliced, total, page, totalPages, limit });
  } catch (error) {
    res.status(500).json({ logs: [], total: 0, page: 1, totalPages: 1 });
  }
});

export default router;
