import adapter from '../../db/DatabaseAdapter.js';

// Subfluxo: trecho de atendimento com uma entrada e uma saida, referenciado por
// varios fluxos. Editar um subfluxo altera todos os fluxos que o usam, por isso
// ele tem rascunho e publicado, igual ao fluxo.
//
// Estrutura do grafo interno:
//   startNode          -> entrada (mesmo tipo do fluxo, reaproveita o runtime)
//   subflowReturnNode  -> saida normal, devolve o controle ao fluxo pai
//
// Nos proibidos dentro do subfluxo: gotoNode e anchorNode (ancora e escopo do
// fluxo) e subflowNode (sem aninhamento, por decisao de projeto).
export const SUBFLOW_FORBIDDEN_NODE_TYPES = Object.freeze(['gotoNode', 'anchorNode', 'subflowNode']);

export const SUBFLOW_ENTRY_TYPE = 'startNode';
export const SUBFLOW_RETURN_TYPE = 'subflowReturnNode';

// Saidas fixas do subflowNode no fluxo pai. Sao definidas pelo sistema, nunca
// pelo autor do subfluxo: assim editar o subfluxo nunca quebra o contrato.
export const SUBFLOW_OUTPUTS = Object.freeze([
  { id: 'success', label: 'Prosseguir' },
  { id: 'resumed', label: 'Retomou' },
  { id: 'error', label: 'Excecao' }
]);

const CACHE_TTL_MS = Math.max(5000, Number(process.env.SUBFLOW_CACHE_TTL_MS || 60000));
const cache = new Map();

const cacheKey = (tenantId, subflowId) => `${tenantId}::${subflowId}`;

export const invalidateSubflowCache = (tenantId = null, subflowId = null) => {
  if (!tenantId) { cache.clear(); return; }
  if (subflowId) { cache.delete(cacheKey(tenantId, subflowId)); return; }
  [...cache.keys()]
    .filter((key) => key.startsWith(`${tenantId}::`))
    .forEach((key) => cache.delete(key));
};

export const getSubflowById = async (tenantId, subflowId) => {
  if (!tenantId || !subflowId) return null;
  const key = cacheKey(tenantId, subflowId);
  const entry = cache.get(key);
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.value;

  const record = await adapter.findOne('subflows', { tenantId, id: subflowId }, { projection: { _id: 0 } });
  cache.set(key, { value: record || null, at: Date.now() });
  return record || null;
};

// O runtime so enxerga a versao publicada: rascunho nao afeta quem esta no ar.
export const getPublishedSubflowGraph = async (tenantId, subflowId) => {
  const subflow = await getSubflowById(tenantId, subflowId);
  if (!subflow) return null;
  const snapshot = subflow.published;
  if (!snapshot || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length) return null;
  return {
    id: subflow.id,
    name: subflow.name,
    nodes: snapshot.nodes,
    edges: Array.isArray(snapshot.edges) ? snapshot.edges : []
  };
};

export const listSubflows = async (tenantId) => {
  if (!tenantId) return [];
  const items = await adapter.findMany('subflows', {
    query: { tenantId },
    projection: { _id: 0 },
    sort: { updatedAt: -1 }
  });
  return Array.isArray(items) ? items : [];
};

// Fluxos que referenciam o subfluxo. Usado no modal de detalhes para avisar
// antes de editar e para bloquear exclusao.
export const findSubflowUsage = async (tenantId, subflowId) => {
  if (!tenantId || !subflowId) return [];
  const flows = await adapter.findMany('flows', {
    query: { tenantId },
    projection: { _id: 0, id: 1, name: 1, status: 1, draft: 1, published: 1 }
  });

  const usesSubflow = (snapshot) => (Array.isArray(snapshot?.nodes) ? snapshot.nodes : [])
    .some((node) => node?.type === 'subflowNode' && node?.data?.subflowId === subflowId);

  return (Array.isArray(flows) ? flows : [])
    .map((flow) => ({
      flowId: flow.id,
      name: flow.name,
      status: flow.status || 'draft',
      inDraft: usesSubflow(flow.draft),
      inPublished: usesSubflow(flow.published)
    }))
    .filter((item) => item.inDraft || item.inPublished);
};

// Validacao estrutural. Roda no save e antes de publicar; a versao publicada
// precisa estar integra, senao o fluxo pai cai na saida de excecao em producao.
export const validateSubflowGraph = ({ nodes = [], edges = [] } = {}) => {
  const problems = [];
  const list = Array.isArray(nodes) ? nodes : [];

  const entries = list.filter((node) => node?.type === SUBFLOW_ENTRY_TYPE);
  if (entries.length === 0) problems.push({ code: 'sem_entrada', message: 'O subfluxo precisa de um ponto de entrada.' });
  if (entries.length > 1) problems.push({ code: 'entrada_duplicada', message: 'O subfluxo so pode ter uma entrada.' });

  const returns = list.filter((node) => node?.type === SUBFLOW_RETURN_TYPE);
  if (returns.length === 0) problems.push({ code: 'sem_saida', message: 'O subfluxo precisa de um ponto de saida.' });
  if (returns.length > 1) problems.push({ code: 'saida_duplicada', message: 'O subfluxo so pode ter uma saida.' });

  list.forEach((node) => {
    if (SUBFLOW_FORBIDDEN_NODE_TYPES.includes(node?.type)) {
      problems.push({
        code: 'no_proibido',
        nodeId: node.id,
        message: `O node "${node?.data?.customName || node?.type}" nao pode ser usado dentro de um subfluxo.`
      });
    }
  });

  // A saida precisa ser alcancavel a partir da entrada, senao o subfluxo nunca
  // devolve o controle e o fluxo pai trava.
  if (entries.length === 1 && returns.length === 1) {
    const outgoing = new Map();
    (Array.isArray(edges) ? edges : []).forEach((edge) => {
      if (!edge?.source) return;
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      outgoing.get(edge.source).push(edge.target);
    });
    const seen = new Set();
    const stack = [entries[0].id];
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      (outgoing.get(current) || []).forEach((target) => stack.push(target));
    }
    if (!seen.has(returns[0].id)) {
      problems.push({
        code: 'saida_inalcancavel',
        nodeId: returns[0].id,
        message: 'A saida nao e alcancavel a partir da entrada.'
      });
    }
  }

  return problems;
};
