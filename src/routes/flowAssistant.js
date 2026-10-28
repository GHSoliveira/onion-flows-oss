import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { createLog } from '../services/logs.js';
import { planFlowChanges } from '../services/flowAssistant.js';

// Assistente de IA do editor de fluxo. So devolve a proposta; quem aplica e o
// editor, depois que a pessoa confirma.
const router = express.Router();

// Limite simples por usuario: cada pedido custa uma chamada de IA.
const JANELA_MS = 60_000;
const MAX_POR_JANELA = 12;
const pedidos = new Map();
const dentroDoLimite = (userId) => {
  const agora = Date.now();
  const recentes = (pedidos.get(userId) || []).filter((momento) => agora - momento < JANELA_MS);
  if (recentes.length >= MAX_POR_JANELA) return false;
  recentes.push(agora);
  pedidos.set(userId, recentes);
  return true;
};

router.post('/', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { manager: 'fluxos', permission: 'fluxos.editar' }), requireTenant, async (req, res) => {
  if (!dentroDoLimite(req.user.id)) {
    return res.status(429).json({ error: 'Muitos pedidos seguidos. Espere um minuto.' });
  }
  try {
    const resultado = await planFlowChanges({ instruction: req.body?.instruction, body: req.body?.flow || {} });
    await createLog('FLOW_ASSISTANT_PLAN', {
      tenantId: req.tenantId,
      flowId: String(req.body?.flowId || '').slice(0, 80) || null,
      operations: resultado.operations.length,
      discarded: resultado.discarded,
      model: resultado.model
    }, req.user.id);
    res.json(resultado);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Falha no assistente' });
  }
});

export default router;
