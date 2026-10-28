import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { createLog } from '../services/logs.js';
import {
  createIntegration,
  deleteIntegration,
  listIntegrations,
  testIntegration,
  updateIntegration
} from '../services/restIntegrations.js';

// Integracoes do cliente usadas pelo node HTTP. A chave secreta so entra:
// nenhuma resposta devolve o valor, apenas se ela existe.
const router = express.Router();
const editar = authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'fluxos', permission: 'fluxos.editar' });

const responder = (res, error, padrao) => res.status(error.status || 500).json({ error: error.status ? error.message : padrao });

router.get('/', authenticate, requireTenant, async (req, res) => {
  try {
    res.json(await listIntegrations(req.tenantId));
  } catch (error) {
    responder(res, error, 'Falha ao carregar as integrações');
  }
});

router.post('/', authenticate, editar, requireTenant, async (req, res) => {
  try {
    const integracao = await createIntegration(req.tenantId, req.body || {}, req.user.id);
    await createLog('REST_INTEGRATION_CREATED', { tenantId: req.tenantId, integrationId: integracao.id, name: integracao.name }, req.user.id);
    res.status(201).json(integracao);
  } catch (error) {
    responder(res, error, 'Falha ao criar a integração');
  }
});

router.patch('/:id', authenticate, editar, requireTenant, async (req, res) => {
  try {
    const integracao = await updateIntegration(req.tenantId, req.params.id, req.body || {});
    await createLog('REST_INTEGRATION_UPDATED', {
      tenantId: req.tenantId,
      integrationId: integracao.id,
      secretChanged: typeof req.body?.secret === 'string' && Boolean(req.body.secret.trim())
    }, req.user.id);
    res.json(integracao);
  } catch (error) {
    responder(res, error, 'Falha ao salvar a integração');
  }
});

router.delete('/:id', authenticate, editar, requireTenant, async (req, res) => {
  try {
    await deleteIntegration(req.tenantId, req.params.id);
    await createLog('REST_INTEGRATION_DELETED', { tenantId: req.tenantId, integrationId: req.params.id }, req.user.id);
    res.json({ ok: true });
  } catch (error) {
    if (error.flows) return res.status(409).json({ error: error.message, flows: error.flows });
    responder(res, error, 'Falha ao excluir a integração');
  }
});

router.post('/:id/test', authenticate, editar, requireTenant, async (req, res) => {
  try {
    res.json(await testIntegration(req.tenantId, req.params.id, req.body || {}));
  } catch (error) {
    responder(res, error, 'Falha ao testar a integração');
  }
});

export default router;
