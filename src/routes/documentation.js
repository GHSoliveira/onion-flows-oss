import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { superAdminIpCheck } from '../middleware/superAdminIp.js';
import { getDocumentationPagesForRole } from '../services/documentationContent.js';

const router = express.Router();

router.get('/', authenticate, superAdminIpCheck, (req, res) => {
  res.set('Cache-Control', 'private, no-store, max-age=0');
  res.json({
    pages: getDocumentationPagesForRole(req.user?.role),
    role: req.user?.role || null
  });
});

export default router;