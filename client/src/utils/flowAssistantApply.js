// Aplica no grafo as operacoes propostas pelo assistente de IA. Funcao pura:
// recebe nodes/edges atuais e devolve os novos, mais avisos do que nao deu
// para fazer. As saidas de menu, condicional e API HTTP seguem o mesmo
// formato que a configuracao manual gera (child_<node>_<saida>).

const TERMINAIS = new Set(['finalNode', 'endNode', 'gotoNode']);
const RAMIFICA = new Set(['menuNode', 'conditionNode', 'httpRequestNode']);
// Tipos que geram saidas pela configuracao e nao aceitam ligacao direta.
const SAIDAS_PROPRIAS = new Set(['menuNode', 'conditionNode', 'httpRequestNode', 'templateNode', 'scheduleNode', 'subflowNode']);

const caseNode = (id, label, tone) => ({ id, type: 'caseNode', position: { x: 0, y: 0 }, data: { label, ...(tone ? { tone } : {}) } });

// Saidas de um node que se divide, no formato da configuracao manual.
export const buildBranchChildren = (parentId, type, data, conditionLabel = (c) => String(c?.value || '')) => {
  const nodes = [];
  const edges = [];
  if (type === 'menuNode' && data.optionsSource === 'variable') {
    [['selected', 'Escolheu'], ['empty', 'Lista vazia']].forEach(([handle, label]) => {
      nodes.push(caseNode(`child_${parentId}_${handle}`, label, handle === 'empty' ? 'error' : undefined));
      edges.push({ id: `m_${parentId}_${handle}`, source: parentId, target: `child_${parentId}_${handle}`, sourceHandle: handle, type: 'default' });
    });
    if (data.hasElse !== false) {
      nodes.push(caseNode(`child_${parentId}_else`, 'Else'));
      edges.push({ id: `m_${parentId}_else`, source: parentId, target: `child_${parentId}_else`, sourceHandle: 'else', style: { strokeDasharray: 5 } });
    }
  } else if (type === 'menuNode' && data.createBranches !== false) {
    (Array.isArray(data.options) ? data.options : []).forEach((opt, index) => {
      const optionId = String(opt.id || index + 1);
      nodes.push(caseNode(`child_${parentId}_${optionId}`, opt.label || optionId));
      edges.push({ id: `m_${parentId}_${optionId}`, source: parentId, target: `child_${parentId}_${optionId}`, sourceHandle: optionId, type: 'default' });
    });
    if (data.hasElse !== false) {
      nodes.push(caseNode(`child_${parentId}_else`, 'Else'));
      edges.push({ id: `m_${parentId}_else`, source: parentId, target: `child_${parentId}_else`, sourceHandle: 'else', style: { strokeDasharray: 5 } });
    }
  }
  if (type === 'conditionNode') {
    (Array.isArray(data.conditions) ? data.conditions : []).forEach((cond) => {
      const condId = String(cond.id);
      nodes.push(caseNode(`child_${parentId}_${condId}`, conditionLabel(cond)));
      edges.push({ id: `edge_${parentId}_${condId}`, source: parentId, target: `child_${parentId}_${condId}`, sourceHandle: condId, type: 'smoothstep' });
    });
    if (data.hasElse !== false) {
      nodes.push(caseNode(`child_${parentId}_else`, 'Else'));
      edges.push({ id: `edge_${parentId}_else`, source: parentId, target: `child_${parentId}_else`, sourceHandle: 'else', style: { strokeDasharray: 5 } });
    }
  }
  if (type === 'httpRequestNode') {
    nodes.push(caseNode(`child_${parentId}_success`, 'Sucesso'));
    nodes.push(caseNode(`child_${parentId}_error`, 'Erro', 'error'));
    edges.push({ id: `e_${parentId}_success`, source: parentId, target: `child_${parentId}_success`, sourceHandle: 'success', type: 'smoothstep' });
    edges.push({ id: `e_${parentId}_error`, source: parentId, target: `child_${parentId}_error`, sourceHandle: 'error', type: 'smoothstep' });
  }
  return { nodes, edges };
};

export const applyAssistantOperations = ({
  nodes: nodesIniciais,
  edges: edgesIniciais,
  operations,
  makeNode,
  conditionLabel,
  integrations = [],
  labels = {},
  idPrefix = `ai${Date.now().toString(36)}`
}) => {
  let nodes = [...nodesIniciais];
  let edges = [...edgesIniciais];
  const refs = new Map();
  const avisos = [];
  const criados = [];
  const soltos = new Set();
  let contador = 0;
  const novoId = (tipo) => `${tipo}_${idPrefix}_${contador++}`;
  const novoEdgeId = (origem, destino) => `ai_${origem}_${destino}_${contador++}`;

  const porId = (id) => nodes.find((node) => node.id === id);
  const resolver = (idOuRef) => refs.get(idOuRef) || (porId(idOuRef) ? idOuRef : null);
  const nome = (node) => node?.data?.customName || node?.data?.label || labels[node?.type] || node?.type || 'node';

  const regerarSaidas = (node) => {
    if (!RAMIFICA.has(node.type)) return;
    const { nodes: filhos, edges: ligacoes } = buildBranchChildren(node.id, node.type, node.data || {}, conditionLabel);
    const idsFilhos = new Set(filhos.map((filho) => filho.id));
    const prefixo = `child_${node.id}_`;
    // Saida que deixou de existir sai junto com o que ligava nela.
    const removidos = new Set(nodes.filter((item) => item.id.startsWith(prefixo) && !idsFilhos.has(item.id)).map((item) => item.id));
    nodes = nodes.filter((item) => !removidos.has(item.id));
    edges = edges.filter((edge) => !removidos.has(edge.source) && !(edge.source === node.id && String(edge.target).startsWith(prefixo)));
    filhos.forEach((filho) => {
      const existente = porId(filho.id);
      if (existente) {
        nodes = nodes.map((item) => (item.id === filho.id ? { ...item, data: { ...item.data, ...filho.data } } : item));
      } else {
        nodes.push(makeNode('caseNode', filho.id, filho.data));
      }
    });
    edges = [...edges, ...ligacoes];
  };

  // Origens de uma ligacao: o proprio node, ou a(s) saida(s) dele quando se
  // divide. "Depois do menu" sem dizer a opcao = todas as opcoes que ainda nao
  // tem continuacao (o Else e a lista vazia ficam de fora: sao desvios).
  const origensDe = (from, contexto) => {
    const id = resolver(from?.node);
    const node = id && porId(id);
    if (!node) {
      avisos.push(`${contexto}: node de origem não encontrado.`);
      return [];
    }
    if (TERMINAIS.has(node.type)) {
      avisos.push(`${contexto}: "${nome(node)}" encerra o fluxo e não tem continuação.`);
      return [];
    }
    if (!SAIDAS_PROPRIAS.has(node.type)) return [node.id];
    const padrao = node.type === 'httpRequestNode' ? 'success' : (node.type === 'menuNode' && node.data?.optionsSource === 'variable' ? 'selected' : null);
    const branch = from?.branch || padrao;
    if (branch) {
      const saida = porId(`child_${node.id}_${branch}`);
      if (saida) return [saida.id];
      avisos.push(`${contexto}: "${nome(node)}" não tem a saída ${branch}.`);
      return [];
    }
    if (['menuNode', 'conditionNode'].includes(node.type)) {
      const livres = nodes.filter((item) => item.id.startsWith(`child_${node.id}_`)
        && !['else', 'empty'].includes(item.id.slice(`child_${node.id}_`.length))
        && !edges.some((edge) => edge.source === item.id));
      if (livres.length) return livres.map((item) => item.id);
    }
    avisos.push(`${contexto}: escolha uma saída de "${nome(node)}".`);
    return [];
  };

  const ligar = (origem, destino) => {
    edges = edges.filter((edge) => edge.source !== origem);
    edges.push({ id: novoEdgeId(origem, destino), source: origem, target: destino, sourceHandle: null, type: 'flowEdge' });
  };

  (Array.isArray(operations) ? operations : []).forEach((op) => {
    if (op.op === 'add_node') {
      const origens = origensDe(op.after, `Novo ${labels[op.type] || op.type}`);
      if (!origens.length) return;
      const origem = origens[0];
      const id = novoId(op.type);
      const data = { ...(op.data || {}) };
      if (op.type === 'httpRequestNode' && data.integrationId) {
        const integracao = integrations.find((item) => item.id === data.integrationId);
        if (integracao) Object.assign(data, { integrationName: integracao.name, integrationIcon: integracao.icon });
        else delete data.integrationId;
      }
      const node = makeNode(op.type, id, data);
      nodes.push(node);
      refs.set(op.ref, id);
      criados.push(id);
      const continuacao = origens.length === 1 ? edges.find((edge) => edge.source === origem) : null;
      origens.forEach((item) => ligar(item, id));
      regerarSaidas(node);
      // Entrou no meio: o que vinha depois continua depois do node novo.
      if (continuacao && continuacao.target !== id) {
        if (!TERMINAIS.has(op.type) && !SAIDAS_PROPRIAS.has(op.type)) ligar(id, continuacao.target);
        else soltos.add(continuacao.target);
      }
      return;
    }
    if (op.op === 'update_node') {
      const id = resolver(op.id);
      const atual = id && porId(id);
      if (!atual) {
        avisos.push('Alteração: node não encontrado.');
        return;
      }
      const atualizado = { ...atual, data: { ...atual.data, ...(op.data || {}) } };
      nodes = nodes.map((node) => (node.id === id ? atualizado : node));
      const mexeuNasSaidas = ['options', 'conditions', 'hasElse', 'optionsSource'].some((chave) => chave in (op.data || {}));
      if (mexeuNasSaidas) regerarSaidas(atualizado);
      return;
    }
    if (op.op === 'connect') {
      const origens = origensDe(op.from, 'Ligação');
      const destino = resolver(op.to);
      if (!origens.length) return;
      if (!destino || origens.includes(destino)) {
        avisos.push('Ligação: destino não encontrado.');
        return;
      }
      origens.forEach((item) => ligar(item, destino));
    }
  });

  // So avisa do que continuou solto depois de todas as operacoes.
  soltos.forEach((id) => {
    if (!edges.some((edge) => edge.target === id)) avisos.push(`"${nome(porId(id))}" ficou sem ligação; ligue numa saída do node novo.`);
  });

  return { nodes, edges, createdIds: criados, warnings: avisos };
};

// Texto curto de cada operacao para a pessoa revisar antes de aplicar.
export const describeOperations = (operations, nodes, labels = {}) => {
  const nomes = new Map(nodes.map((node) => [node.id, node.data?.customName || labels[node.type] || node.type]));
  const refs = new Map();
  const nomeDe = (id) => refs.get(id) || nomes.get(id) || id;
  return (Array.isArray(operations) ? operations : []).map((op) => {
    if (op.op === 'create_variable') return { kind: 'variavel', text: `Criar variável ${op.name}` };
    if (op.op === 'add_node') {
      const rotulo = op.data?.customName || labels[op.type] || op.type;
      refs.set(op.ref, rotulo);
      const detalhe = op.data?.text ? ` · "${String(op.data.text).slice(0, 70)}${String(op.data.text).length > 70 ? '…' : ''}"` : '';
      const guarda = op.data?.variableName ? ` · guarda em ${op.data.variableName}` : '';
      const saida = op.after?.branch ? ` (saída ${op.after.branch})` : '';
      return { kind: 'novo', text: `${rotulo}${detalhe}${guarda} — depois de ${nomeDe(op.after?.node)}${saida}` };
    }
    if (op.op === 'update_node') {
      const campos = Object.keys(op.data || {}).join(', ');
      return { kind: 'alterar', text: `Alterar ${nomeDe(op.id)}${campos ? ` (${campos})` : ''}` };
    }
    if (op.op === 'connect') {
      return { kind: 'ligar', text: `Ligar ${nomeDe(op.from?.node)}${op.from?.branch ? ` (saída ${op.from.branch})` : ''} → ${nomeDe(op.to)}` };
    }
    return { kind: 'outro', text: op.op };
  });
};
