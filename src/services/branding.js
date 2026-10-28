// Marca exibida no painel (white label): a do Parceiro do tenant por baixo e a
// aba Identidade do tenant por cima. Campo vazio = o painel usa a marca padrao
// da Onion.
import adapter from '../../db/DatabaseAdapter.js';

export const BRAND_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const texto = (value, max) => {
  const clean = String(value ?? '').trim();
  return clean ? clean.slice(0, max) : null;
};

// So https: logo, icone e imagem do login viram src de imagem e href de favicon no navegador.
const urlSegura = (value) => {
  const clean = String(value ?? '').trim();
  if (!clean) return null;
  try {
    return new URL(clean).protocol === 'https:' ? clean : null;
  } catch {
    return null;
  }
};

export const sanitizeBranding = (identity = {}) => ({
  productName: texto(identity.productName, 60),
  organizationName: texto(identity.organizationName, 120),
  logoUrl: urlSegura(identity.logoUrl),
  faviconUrl: urlSegura(identity.faviconUrl),
  loginImageUrl: urlSegura(identity.loginImageUrl),
  primaryColor: BRAND_COLOR_PATTERN.test(String(identity.primaryColor || '')) ? identity.primaryColor.toLowerCase() : null,
  supportEmail: texto(identity.supportEmail, 160),
  supportWhatsapp: String(identity.supportWhatsapp || '').replace(/\D/g, '').slice(0, 15) || null
});

// Junta camadas: o que estiver preenchido na de cima vence.
const mesclar = (...camadas) => {
  const brand = sanitizeBranding({});
  for (const camada of camadas) {
    for (const [key, value] of Object.entries(sanitizeBranding(camada || {}))) {
      if (value) brand[key] = value;
    }
  }
  return brand;
};

const comOrigem = (brand, source) => ({ ...brand, source: Object.values(brand).some(Boolean) ? source : 'default' });

export const resolvePartnerBranding = async (partnerId) => {
  if (!partnerId) return comOrigem(mesclar(), 'default');
  const partner = await adapter.findOne('partners', { id: partnerId }, { projection: { _id: 0, branding: 1 } });
  return comOrigem(mesclar(partner?.branding), 'partner');
};

// Marca de um tenant: a do Parceiro dele por baixo e a aba Identidade do tenant
// por cima, campo a campo.
export const resolveBranding = async (tenantId) => {
  if (!tenantId) return comOrigem(mesclar(), 'default');
  const [tenant, document] = await Promise.all([
    adapter.findOne('tenants', { id: tenantId }, { projection: { _id: 0, partnerId: 1 } }),
    adapter.findOne('tenantModuleSettings', { tenantId }, { projection: { _id: 0, modules: 1 } })
  ]);
  const partner = tenant?.partnerId
    ? await adapter.findOne('partners', { id: tenant.partnerId }, { projection: { _id: 0, branding: 1 } })
    : null;
  const identity = document?.modules?.identity || {};
  const brand = mesclar(partner?.branding, identity);
  const temTenant = Object.values(sanitizeBranding(identity)).some(Boolean);
  return comOrigem(brand, temTenant ? 'tenant' : 'partner');
};
