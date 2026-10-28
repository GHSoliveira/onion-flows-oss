import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import { resolveBranding, resolvePartnerBranding } from '../services/branding.js';
import { findPartnerBySubdomain, subdomainFromHost } from '../services/partnerDomains.js';

// Marca do tenant de quem esta logado. Qualquer papel le: o atendente tambem ve
// o painel com a marca do cliente.
const router = express.Router();

// Tela de login no endereco da agencia (agencia.<AGENCY_ROOT_DOMAIN>): ainda sem
// usuario, a marca vem do Parceiro dono do subdominio. Endereco desconhecido
// devolve a marca padrao.
router.get('/public', async (req, res) => {
  try {
    const partner = await findPartnerBySubdomain(subdomainFromHost(req.query.host));
    res.set('Cache-Control', 'public, max-age=300');
    if (!partner) return res.json({ source: 'default' });
    res.json(await resolvePartnerBranding(partner.id));
  } catch (error) {
    res.status(500).json({ error: 'Falha ao carregar a marca' });
  }
});

router.get('/', authenticate, async (req, res, next) => {
  // Parceiro fora de um cliente ve a propria marca.
  if (req.user.role !== 'PARTNER') return next();
  try {
    res.json(await resolvePartnerBranding(req.user.partnerId));
  } catch (error) {
    res.status(500).json({ error: 'Falha ao carregar a marca' });
  }
}, requireTenant, async (req, res) => {
  try {
    res.json(await resolveBranding(req.tenantId || null));
  } catch (error) {
    res.status(500).json({ error: 'Falha ao carregar a marca' });
  }
});

export default router;
