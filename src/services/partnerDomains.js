import adapter from '../../db/DatabaseAdapter.js';

// Endereco proprio da agencia: <subdominio>.<AGENCY_ROOT_DOMAIN>. O Cloudflare manda
// qualquer subdominio para o mesmo painel; aqui o subdominio vira o Parceiro,
// para a tela de login ja abrir com a marca dele e a API aceitar a origem.

export const AGENCY_ROOT_DOMAIN = String(process.env.AGENCY_ROOT_DOMAIN || 'example.com').trim().toLowerCase();

// Nomes que ja existem ou podem vir a existir na infraestrutura da Onion.
const RESERVADOS = new Set([
  'www', 'flows', 'api', 'api-dev', 'app', 'admin', 'painel', 'login', 'auth', 'sso', 'conta', 'contas',
  'mail', 'email', 'smtp', 'imap', 'pop', 'ftp', 'ns', 'ns1', 'ns2', 'dns', 'mx',
  'onion', 'onionws', 'status', 'docs', 'help', 'ajuda', 'suporte', 'support', 'blog', 'site', 'landing',
  'cdn', 'static', 'assets', 'media', 'files', 'img', 'dev', 'staging', 'stage', 'test', 'teste', 'sandbox',
  'demo', 'beta', 'preview', 'webhook', 'webhooks', 'hooks', 'ws', 'socket', 'turizmo', 'parceiro', 'parceiros'
]);

const erro = (message, status = 400) => Object.assign(new Error(message), { status });

export const isReservedSubdomain = (valor) => RESERVADOS.has(String(valor || '').toLowerCase());

// Valida e normaliza; null limpa o endereco.
export const normalizeSubdomain = (valor) => {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const sub = String(valor).trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(sub) || sub.includes('--')) {
    throw erro('Use de 3 a 40 letras minúsculas, números ou hífen, sem hífen no começo ou no fim.');
  }
  if (isReservedSubdomain(sub)) throw erro('Esse endereço é reservado. Escolha outro.');
  return sub;
};

// "agencia.example.com" -> "agencia"; qualquer outro host -> null.
export const subdomainFromHost = (host) => {
  const nome = String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const sufixo = `.${AGENCY_ROOT_DOMAIN}`;
  if (!nome.endsWith(sufixo)) return null;
  const sub = nome.slice(0, -sufixo.length);
  if (!sub || sub.includes('.') || isReservedSubdomain(sub)) return null;
  return /^[a-z0-9-]{3,40}$/.test(sub) ? sub : null;
};

// Origem https de um subdominio de agencia. Nao consulta o banco: o dominio e
// da Onion, entao qualquer subdominio valido pode chamar a API.
export const isAgencyOrigin = (origin) => {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && !url.port && Boolean(subdomainFromHost(url.hostname));
  } catch {
    return false;
  }
};

export const partnerUrl = (subdomain) => (subdomain ? `https://${subdomain}.${AGENCY_ROOT_DOMAIN}` : null);

export const findPartnerBySubdomain = async (subdomain) => {
  if (!subdomain) return null;
  const partner = await adapter.findOne('partners', { subdomain }, { projection: { _id: 0 } });
  return partner && partner.status !== 'inactive' ? partner : null;
};

export const setPartnerSubdomain = async (partnerId, valor) => {
  const partner = await adapter.findOne('partners', { id: partnerId });
  if (!partner) throw erro('Parceiro não encontrado', 404);
  const subdomain = normalizeSubdomain(valor);
  if (subdomain) {
    const dono = await adapter.findOne('partners', { subdomain });
    if (dono && dono.id !== partnerId) throw erro('Esse endereço já é de outro parceiro.', 409);
  }
  await adapter.updateOne('partners', { id: partnerId }, { $set: { subdomain, updatedAt: new Date().toISOString() } });
  return { subdomain, url: partnerUrl(subdomain) };
};
