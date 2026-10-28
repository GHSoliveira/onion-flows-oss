import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import { getTenantModuleSettings } from '../services/tenantModules.js';
import { FAMILIAS, FAMILIAS_DO_CLIENTE, NIVEIS, NOMES_PADRAO, PERMISSOES, familiasQueGerencia, resumoCargo } from '../services/cargos.js';

// Catalogo de cargos para a tela de usuarios: permissoes, niveis de cliente,
// nomes (os da empresa por cima dos padrao) e o que quem esta logado pode
// atribuir.
const router = express.Router();

router.get('/', authenticate, requireTenant, async (req, res) => {
  try {
    const nomesDaEmpresa = req.tenantId ? await getTenantModuleSettings(req.tenantId, 'cargos') : {};
    const niveis = Object.entries(NIVEIS)
      .filter(([codigo]) => FAMILIAS_DO_CLIENTE.includes(codigo.charAt(0)))
      .map(([codigo, permissoes]) => ({
        codigo,
        familia: codigo.charAt(0),
        nome: String(nomesDaEmpresa?.[codigo] || '').trim() || NOMES_PADRAO[codigo] || codigo,
        nomePadrao: NOMES_PADRAO[codigo] || codigo,
        permissoes
      }));
    res.json({
      permissoes: PERMISSOES,
      familias: Object.fromEntries(FAMILIAS_DO_CLIENTE.map((familia) => [familia, FAMILIAS[familia].nome])),
      niveis,
      ator: { ...resumoCargo(req.user), gerencia: familiasQueGerencia(req.user) }
    });
  } catch (error) {
    res.status(500).json({ error: 'Falha ao carregar os cargos' });
  }
});

export default router;
