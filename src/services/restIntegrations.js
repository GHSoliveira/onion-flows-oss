import adapter from '../../db/DatabaseAdapter.js';
import { encryptString, tryDecrypt } from '../utils/crypto.js';
import { validateExternalUrl } from '../utils/externalUrl.js';
import { generateId } from '../utils/helpers.js';

// Integracoes do cliente (por enquanto so API REST): endereco base, forma de
// autenticacao e uma chave secreta guardada cifrada. O node HTTP escolhe a
// integracao e informa so o caminho; o servidor junta o endereco e a chave na
// hora de chamar, entao a chave nunca vai para o fluxo nem volta para a tela.

const COLLECTION = 'restIntegrations';

export const INTEGRATION_ICONS = ['globe', 'database', 'cart', 'card', 'truck', 'users', 'calendar', 'package', 'mail', 'cloud', 'server', 'zap', 'store', 'file'];
export const AUTH_TYPES = ['none', 'bearer', 'header', 'basic'];
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);

const agora = () => new Date().toISOString();

const erro = (status, message) => Object.assign(new Error(message), { status });

const texto = (valor, max) => String(valor ?? '').trim().slice(0, max);

const normalizarBaseUrl = (valor) => {
  let url;
  try {
    url = new URL(String(valor || '').trim());
  } catch {
    throw erro(400, 'Endereço base inválido');
  }
  if (url.protocol !== 'https:') throw erro(400, 'O endereço base precisa começar com https://');
  if (url.username || url.password) throw erro(400, 'Não coloque usuário ou senha no endereço; use a autenticação');
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
};

const conferirEnderecoPublico = async (baseUrl) => {
  try {
    await validateExternalUrl(baseUrl);
  } catch (error) {
    if (error?.code === 'ENOTFOUND' || error?.code === 'EAI_AGAIN') throw erro(400, 'Endereço não encontrado');
    throw erro(400, error.message);
  }
};

// Visao para a tela: sem a chave, so se ela existe.
export const publicView = (doc) => {
  if (!doc) return null;
  const { secret, _id, ...resto } = doc;
  return { ...resto, hasSecret: Boolean(secret) };
};

const montar = (entrada, atual = {}) => {
  const name = entrada.name !== undefined ? texto(entrada.name, 60) : atual.name;
  if (!name) throw erro(400, 'Dê um nome para a integração');
  const authType = entrada.authType !== undefined ? String(entrada.authType) : (atual.authType || 'none');
  if (!AUTH_TYPES.includes(authType)) throw erro(400, 'Tipo de autenticação inválido');
  const headerName = authType === 'header'
    ? texto(entrada.headerName !== undefined ? entrada.headerName : atual.headerName, 60)
    : '';
  if (authType === 'header' && (!/^[A-Za-z0-9-]+$/.test(headerName) || BLOCKED_HEADERS.has(headerName.toLowerCase()))) {
    throw erro(400, 'Nome do cabeçalho inválido');
  }
  const icon = entrada.icon !== undefined ? String(entrada.icon) : (atual.icon || 'globe');
  return {
    type: 'rest',
    name,
    description: entrada.description !== undefined ? texto(entrada.description, 200) : (atual.description || ''),
    icon: INTEGRATION_ICONS.includes(icon) ? icon : 'globe',
    baseUrl: entrada.baseUrl !== undefined ? normalizarBaseUrl(entrada.baseUrl) : atual.baseUrl,
    authType,
    headerName,
    username: authType === 'basic' ? texto(entrada.username !== undefined ? entrada.username : atual.username, 120) : ''
  };
};

const novaChave = (valor) => {
  if (typeof valor !== 'string' || !valor.trim()) return null;
  if (valor.length > 4000) throw erro(400, 'Chave muito longa');
  return encryptString(valor.trim());
};

export const listIntegrations = async (tenantId) => {
  const itens = (await adapter.findMany(COLLECTION, { query: { tenantId } })) || [];
  return itens
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'))
    .map(publicView);
};

export const getIntegration = (tenantId, id) => adapter.findOne(COLLECTION, { id, tenantId });

export const createIntegration = async (tenantId, entrada = {}, userId = null) => {
  const dados = montar(entrada);
  if (!dados.baseUrl) throw erro(400, 'Informe o endereço base');
  await conferirEnderecoPublico(dados.baseUrl);
  const secret = novaChave(entrada.secret);
  if (dados.authType !== 'none' && !secret) throw erro(400, 'Informe a chave secreta');
  const doc = {
    id: generateId('integ'),
    tenantId,
    ...dados,
    secret,
    createdBy: userId,
    createdAt: agora(),
    updatedAt: agora()
  };
  await adapter.insertOne(COLLECTION, doc);
  return publicView(doc);
};

export const updateIntegration = async (tenantId, id, entrada = {}) => {
  const atual = await getIntegration(tenantId, id);
  if (!atual) throw erro(404, 'Integração não encontrada');
  const dados = montar(entrada, atual);
  const trocouEndereco = new URL(dados.baseUrl).origin !== new URL(atual.baseUrl).origin;
  if (trocouEndereco) await conferirEnderecoPublico(dados.baseUrl);
  let secret = novaChave(entrada.secret) || atual.secret || null;
  // Trocar o servidor sem informar a chave de novo mandaria a chave guardada
  // para um endereco que quem cadastrou nao aprovou.
  if (trocouEndereco && atual.secret && !novaChave(entrada.secret) && dados.authType !== 'none') {
    throw erro(400, 'Ao trocar o servidor, informe a chave secreta de novo');
  }
  if (dados.authType === 'none') secret = null;
  if (dados.authType !== 'none' && !secret) throw erro(400, 'Informe a chave secreta');
  const set = { ...dados, secret, updatedAt: agora() };
  await adapter.updateOne(COLLECTION, { id, tenantId }, { $set: set });
  return publicView({ ...atual, ...set });
};

// Fluxos e subfluxos que usam a integracao, para nao apagar uma em uso.
export const flowsUsingIntegration = async (tenantId, id) => {
  const marca = `"integrationId":"${id}"`;
  const nomes = [];
  for (const colecao of ['flows', 'subflows']) {
    const docs = (await adapter.findMany(colecao, { query: { tenantId } })) || [];
    docs.forEach((doc) => { if (JSON.stringify(doc).includes(marca)) nomes.push(doc.name || doc.id); });
  }
  return nomes;
};

export const deleteIntegration = async (tenantId, id) => {
  const atual = await getIntegration(tenantId, id);
  if (!atual) throw erro(404, 'Integração não encontrada');
  const emUso = await flowsUsingIntegration(tenantId, id);
  if (emUso.length) throw Object.assign(erro(409, `Usada em: ${emUso.slice(0, 5).join(', ')}`), { flows: emUso });
  await adapter.deleteMany(COLLECTION, { id, tenantId });
  return { ok: true };
};

const valorDaVariavel = (vars, caminho) => {
  let valor = vars;
  for (const chave of caminho.split(/[.[\]]/).filter(Boolean)) {
    if (valor === undefined || valor === null) return undefined;
    valor = valor[chave];
  }
  return valor;
};

// Junta endereco base e caminho. Valores de variavel entram codificados, entao
// "{cpf}" nao consegue mudar o servidor nem sair do caminho base.
export const buildIntegrationUrl = (baseUrl, caminho = '', vars = {}) => {
  const bruto = String(caminho || '').trim();
  const preenchido = bruto.replace(/\{([\w.[\]]+)\}/g, (marca, nome) => {
    const valor = valorDaVariavel(vars, nome);
    return valor === undefined ? marca : encodeURIComponent(String(valor));
  });
  const junto = !preenchido ? baseUrl
    : preenchido.startsWith('?') ? `${baseUrl}${preenchido}`
      : `${baseUrl}/${preenchido.replace(/^\/+/, '')}`;
  let final;
  try {
    final = new URL(junto);
  } catch {
    throw new Error('Caminho inválido');
  }
  const base = new URL(baseUrl);
  const prefixo = base.pathname.replace(/\/+$/, '');
  if (final.origin !== base.origin || (prefixo && final.pathname !== prefixo && !final.pathname.startsWith(`${prefixo}/`))) {
    throw new Error('Caminho fora do endereço da integração');
  }
  return final.toString();
};

export const authHeaders = (integration) => {
  const chave = integration?.secret ? tryDecrypt(integration.secret) : '';
  switch (integration?.authType) {
    case 'bearer': return { Authorization: `Bearer ${chave}` };
    case 'header': return { [integration.headerName]: chave };
    case 'basic': return { Authorization: `Basic ${Buffer.from(`${integration.username || ''}:${chave}`).toString('base64')}` };
    default: return {};
  }
};

export const prepareIntegrationRequest = async ({ tenantId, integrationId, path, vars }) => {
  const integration = tenantId ? await getIntegration(tenantId, integrationId) : null;
  if (!integration) throw new Error('Integração não encontrada');
  const url = buildIntegrationUrl(integration.baseUrl, path, vars);
  await validateExternalUrl(url);
  return { url, authHeaders: authHeaders(integration), integration };
};

// Ultimo resultado de cada integracao, para a tela mostrar o erro mais recente.
// Sucesso so grava quando muda algo ou a cada 10 minutos, para nao escrever
// no banco a cada mensagem.
const ultimoSucessoGravado = new Map();
export const recordIntegrationResult = async (tenantId, id, { ok, status = null, error = null }) => {
  try {
    if (ok) {
      const antes = ultimoSucessoGravado.get(id) || 0;
      if (Date.now() - antes < 10 * 60_000) return;
      ultimoSucessoGravado.set(id, Date.now());
      await adapter.updateOne(COLLECTION, { id, tenantId }, { $set: { lastStatus: status, lastSuccessAt: agora(), lastOk: true } });
      return;
    }
    ultimoSucessoGravado.delete(id);
    await adapter.updateOne(COLLECTION, { id, tenantId }, {
      $set: { lastStatus: status, lastOk: false, lastError: texto(error || `HTTP ${status}`, 300), lastErrorAt: agora() }
    });
  } catch (falha) {
    console.warn('[INTEGRACAO] Falha ao registrar resultado:', falha.message);
  }
};

// Chamada de teste feita pela tela: mesmo caminho do node, sem variaveis.
export const testIntegration = async (tenantId, id, { method = 'GET', path = '' } = {}) => {
  const metodo = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method).toUpperCase()) ? String(method).toUpperCase() : 'GET';
  const inicio = Date.now();
  let request;
  try {
    request = await prepareIntegrationRequest({ tenantId, integrationId: id, path, vars: {} });
  } catch (error) {
    throw erro(error.message === 'Integração não encontrada' ? 404 : 400, error.message);
  }
  try {
    const res = await fetch(request.url, {
      method: metodo,
      headers: { Accept: 'application/json', ...request.authHeaders },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    const corpo = await res.text();
    ultimoSucessoGravado.delete(id);
    await recordIntegrationResult(tenantId, id, { ok: res.ok, status: res.status, error: res.ok ? null : `HTTP ${res.status}` });
    return { ok: res.ok, status: res.status, durationMs: Date.now() - inicio, preview: corpo.slice(0, 2000) };
  } catch (error) {
    const mensagem = error?.name === 'TimeoutError' ? 'Sem resposta em 10 segundos' : (error?.cause?.message || error.message);
    await recordIntegrationResult(tenantId, id, { ok: false, error: mensagem });
    return { ok: false, status: null, durationMs: Date.now() - inicio, error: mensagem };
  }
};
