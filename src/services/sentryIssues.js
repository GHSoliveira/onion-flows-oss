// Problemas abertos no Sentry para o dashboard do super admin. O token
// (SENTRY_API_TOKEN, so leitura) fica no servidor: o painel pergunta aqui e
// nunca ve o token. Resposta guardada por 60 s para nao gastar a cota da API
// do Sentry a cada abertura do dashboard.

const API = (process.env.SENTRY_API_URL || 'https://sentry.io/api/0').replace(/\/+$/, '');
const CACHE_MS = 60000;
let cache = { at: 0, key: '', value: null };
let orgSlug = null;

const sentryFetch = async (pathname, fetchImpl) => {
  const response = await fetchImpl(`${API}${pathname}`, {
    headers: { Authorization: `Bearer ${process.env.SENTRY_API_TOKEN}` },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const error = new Error(`sentry_api_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

const resolveOrg = async (fetchImpl) => {
  if (process.env.SENTRY_ORG) return process.env.SENTRY_ORG;
  if (orgSlug) return orgSlug;
  // Token so com project:read/event:read nao lista organizacoes (403); a
  // lista de projetos traz a organizacao de cada um.
  try {
    const orgs = await sentryFetch('/organizations/', fetchImpl);
    orgSlug = orgs?.[0]?.slug || null;
  } catch (error) {
    if (error.status !== 403) throw error;
    const projects = await sentryFetch('/projects/', fetchImpl);
    orgSlug = projects?.[0]?.organization?.slug || null;
  }
  if (!orgSlug) throw new Error('sentry_sem_organizacao');
  return orgSlug;
};

export const summarizeIssue = (issue) => ({
  id: issue.id,
  shortId: issue.shortId,
  title: issue.title,
  culprit: issue.culprit || null,
  level: issue.level || 'error',
  project: issue.project?.slug || null,
  count: Number(issue.count) || 0,
  users: Number(issue.userCount) || 0,
  firstSeen: issue.firstSeen,
  lastSeen: issue.lastSeen,
  link: issue.permalink
});

export const getSentryIssues = async ({ fetchImpl = fetch, now = Date.now() } = {}) => {
  if (!process.env.SENTRY_API_TOKEN) return { configured: false, issues: [] };
  const key = process.env.SENTRY_API_TOKEN.slice(-6);
  if (cache.value && cache.key === key && now - cache.at < CACHE_MS) return cache.value;
  try {
    const org = await resolveOrg(fetchImpl);
    const params = new URLSearchParams({ query: 'is:unresolved', statsPeriod: '14d', sort: 'date', limit: '10' });
    const issues = await sentryFetch(`/organizations/${encodeURIComponent(org)}/issues/?${params}`, fetchImpl);
    const value = { configured: true, org, issues: (issues || []).map(summarizeIssue), fetchedAt: new Date(now).toISOString() };
    cache = { at: now, key, value };
    return value;
  } catch (error) {
    // Token errado ou Sentry fora: o card avisa, o dashboard segue.
    return { configured: true, issues: [], error: error.status === 401 || error.status === 403 ? 'token_invalido' : 'sentry_indisponivel' };
  }
};

export const resetSentryIssuesCache = () => { cache = { at: 0, key: '', value: null }; orgSlug = null; };
