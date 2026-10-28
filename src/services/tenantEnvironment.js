import adapter from '../../db/DatabaseAdapter.js';

// Ambiente da empresa. E um eixo separado de `status` (ativo/deletado) e de
// `plan` (faixa de cobranca): diz se os dados daquela empresa valem como
// operacao real ou se sao de teste.
//
// Default e 'production': empresa sem o campo continua contando em tudo, entao
// nada muda para o que ja existe.
export const TENANT_ENVIRONMENTS = Object.freeze(['production', 'development']);
export const DEFAULT_TENANT_ENVIRONMENT = 'production';

export const normalizeTenantEnvironment = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return TENANT_ENVIRONMENTS.includes(normalized) ? normalized : DEFAULT_TENANT_ENVIRONMENT;
};

export const isDevelopmentTenantRecord = (tenant) => (
  normalizeTenantEnvironment(tenant?.environment) === 'development'
);

const CACHE_TTL_MS = Math.max(5000, Number(process.env.TENANT_ENVIRONMENT_CACHE_TTL_MS || 30000));
let cachedIds = null;
let cachedAt = 0;

export const invalidateDevelopmentTenantCache = () => {
  cachedIds = null;
  cachedAt = 0;
};

// Ids das empresas de desenvolvimento. Cacheado porque e consultado em toda
// agregacao cross-tenant (dashboard, monitoramento, relatorios).
export const listDevelopmentTenantIds = async () => {
  if (cachedIds && Date.now() - cachedAt < CACHE_TTL_MS) return cachedIds;
  try {
    const tenants = await adapter.findMany('tenants', {
      projection: { _id: 0, id: 1, environment: 1 }
    });
    const ids = new Set(
      (Array.isArray(tenants) ? tenants : [])
        .filter(isDevelopmentTenantRecord)
        .map((tenant) => String(tenant.id))
        .filter(Boolean)
    );
    cachedIds = ids;
    cachedAt = Date.now();
    return ids;
  } catch (error) {
    console.warn('[TENANT_ENV] Falha ao listar empresas de desenvolvimento:', error.message);
    return cachedIds || new Set();
  }
};

// Remove de uma lista os registros que pertencem a empresas de desenvolvimento.
// `pick` extrai o tenantId do item; por padrao usa item.tenantId.
export const excludeDevelopmentRecords = (items, developmentIds, pick = (item) => item?.tenantId) => {
  if (!developmentIds || developmentIds.size === 0) return Array.isArray(items) ? items : [];
  return (Array.isArray(items) ? items : []).filter((item) => !developmentIds.has(String(pick(item) || '')));
};

export const setTenantEnvironment = async (tenantId, environment) => {
  const normalized = normalizeTenantEnvironment(environment);
  await adapter.updateOne('tenants', { id: tenantId }, {
    $set: { environment: normalized, updatedAt: new Date().toISOString() }
  });
  invalidateDevelopmentTenantCache();
  return normalized;
};
