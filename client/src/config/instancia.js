// Contato de suporte e dados legais desta instalacao. Cada instalacao define os
// seus no .env do painel; os valores padrao sao so marcadores.
const env = import.meta.env;

export const contatoSuporte = {
  email: env.VITE_SUPPORT_EMAIL || 'suporte@example.com',
  whatsapp: String(env.VITE_SUPPORT_WHATSAPP || '').replace(/\D/g, '')
};

export const empresa = {
  name: env.VITE_PRODUCT_NAME || 'Onion Web Flows',
  companyName: env.VITE_LEGAL_COMPANY_NAME || 'Sua Empresa Ltda',
  cnpj: env.VITE_LEGAL_CNPJ || '00.000.000/0000-00',
  contactEmail: contatoSuporte.email,
  lastUpdated: '2026-09-03'
};

// Dominio onde cada agencia ganha um endereco proprio (agencia.<dominio>).
export const dominioRaiz = env.VITE_ROOT_DOMAIN || 'example.com';
