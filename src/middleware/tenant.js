import adapter from '../../db/DatabaseAdapter.js';

/**
 * Tenant isolation middleware
 */
export const requireTenant = async (req, res, next) => {
  const user = req.user;
  const queryTenantId = req.query.tenantId;

  if (user.role === 'SUPER_ADMIN') {
    if (queryTenantId !== undefined && (typeof queryTenantId !== 'string' || !queryTenantId.trim())) {
      return res.status(400).json({ error: 'Tenant invalido' });
    }
    if (queryTenantId) {
      // Validate that the tenant actually exists
      const tenant = await adapter.findOne('tenants', { id: queryTenantId }, { projection: { id: 1 } });
      if (!tenant) {
        return res.status(404).json({ error: 'Tenant não encontrado' });
      }
      req.tenantId = queryTenantId;
    }
    return next();
  }

  if (!user.tenantId) {
    return res.status(400).json({ error: 'Usuário não pertence a nenhum tenant' });
  }

  req.tenantId = user.tenantId;
  next();
};
