import { dockedAnchors } from './flowAnchors.js';

const SYSTEM_VARIABLES = new Set([
  'CHANNEL',
  'CHAT_ID',
  'TENANT_ID',
  'CHANNEL_USER_ID',
  'CHANNEL_CHAT_ID',
  'WA_ID',
  'TG_ID',
  'CUSTOMER_CPF',
  'ULTIMA_RESPOSTA_CLIENTE',
  'WTN_BOTAO_TEXTO',
  'WTN_BOTAO_PAYLOAD',
  'LAST_MESSAGE_FLOW',
  'HTTP_STATUS',
  'HTTP_OK',
  'HTTP_RAW',
  'HTTP_ERROR_MESSAGE'
]);

const OUTPUT_OPTIONAL_TYPES = new Set([
  'endNode',
  'finalNode',
  'gotoNode',
  'holderNode',
  // Trilho de saida do subfluxo: e terminal por definicao, quem continua e o
  // fluxo pai.
  'subflowReturnNode'
]);

const hasOptionalOutput = (node) => (
  OUTPUT_OPTIONAL_TYPES.has(node?.type)
  || (node?.type === 'queueNode' && node?.data?.continueFlowAfterQueue === false)
);

const REFERENCE_EXCLUDED_KEYS = new Set([
  'id',
  'customName',
  'variableName',
  'varName',
  'jsonPath',
  'validationPattern',
  'script',
  'code',
  'targetAnchor',
  'anchorName',
  'templateId',
  'whatsappTemplateId',
  'interactiveTemplateId',
  'scheduleId',
  'queueId'
]);

const cleanName = (value) => String(value || '').trim();

const nodeLabel = (node) => {
  const customName = cleanName(node?.data?.customName);
  if (customName) return customName;
  if (node?.type === 'anchorNode' && cleanName(node?.data?.anchorName)) return `Ancora "${cleanName(node.data.anchorName)}"`;
  const text = cleanName(node?.data?.text).replace(/\s+/g, ' ');
  if (text) return text.length > 48 ? `${text.slice(0, 47)}...` : text;
  return cleanName(node?.type || node?.id) || 'Node';
};

const addDefined = (target, value) => {
  const name = cleanName(value);
  if (name) target.add(name);
};

const collectScriptDefinitions = (script, target) => {
  const source = String(script || '');
  const dotPattern = /\bvars\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
  const bracketPattern = /\bvars\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]\s*=/g;
  let match;
  while ((match = dotPattern.exec(source))) addDefined(target, match[1]);
  while ((match = bracketPattern.exec(source))) addDefined(target, match[1]);
};

const collectDefinedVariables = (nodes, variables) => {
  const defined = new Set(SYSTEM_VARIABLES);
  (Array.isArray(variables) ? variables : []).forEach((variable) => {
    addDefined(defined, variable?.name ?? variable?.variableName ?? variable);
  });

  nodes.forEach((node) => {
    const data = node?.data || {};
    if (['inputNode', 'setValueNode', 'secretNode'].includes(node.type)) {
      addDefined(defined, data.variableName);
    }
    if (node.type === 'ratingNode') addDefined(defined, data.variableName || 'nota');
    if (node.type === 'menuNode' && (data.setVarEnabled || data.optionsSource === 'variable')) addDefined(defined, data.variableName);
    if (node.type === 'httpRequestNode') {
      (Array.isArray(data.mappings) ? data.mappings : []).forEach((mapping) => addDefined(defined, mapping?.varName));
    }
    if (node.type === 'whatsappTemplateNode') {
      addDefined(defined, data.saveResponseTextVar);
      addDefined(defined, data.saveResponsePayloadVar);
      addDefined(defined, data.saveButtonTextVar);
    }
    if (node.type === 'holderNode') {
      addDefined(defined, data.lastMessageVar);
      addDefined(defined, data.listVar);
      addDefined(defined, data.textVar);
      addDefined(defined, data.countVar);
    }
    if (node.type === 'catalogNode') {
      const prefix = cleanName(data.varPrefix || 'PRODUTO').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
      ['ID', 'NOME', 'PRECO', 'DESCRICAO', 'SKU', 'CATEGORIA'].forEach((suffix) => addDefined(defined, `${prefix}_${suffix}`));
    }
    if (node.type === 'cartNode') {
      addDefined(defined, data.itemsVar || 'CARRINHO_ITENS');
      addDefined(defined, data.totalVar || 'CARRINHO_TOTAL');
      addDefined(defined, data.itemCountVar || 'CARRINHO_QUANTIDADE');
      addDefined(defined, data.summaryVar || 'CARRINHO_RESUMO');
      addDefined(defined, data.okVar || 'CARRINHO_OK');
      addDefined(defined, data.errorVar || 'CARRINHO_ERRO');
    }
    if (node.type === 'scriptNode') collectScriptDefinitions(data.script || data.code, defined);
    if (node.type === 'sequentialNode') {
      (Array.isArray(data.steps) ? data.steps : []).forEach((step) => {
        if (step?.type === 'input' || step?.type === 'menu') addDefined(defined, step.variableName);
        if (step?.type === 'script') collectScriptDefinitions(step.script || step.code, defined);
      });
    }
    (Array.isArray(data.varMap) ? data.varMap : []).forEach((mapping) => {
      // O alias local e a origem global sao conhecidos pelo proprio node.
      addDefined(defined, mapping?.local);
      addDefined(defined, mapping?.global);
    });
  });

  return defined;
};

const extractReferencesFromText = (text) => {
  const references = new Set();
  const pattern = /\{\{?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}?/g;
  let match;
  while ((match = pattern.exec(String(text || '')))) {
    references.add(match[1].split('.')[0]);
  }
  return references;
};

const collectNodeReferences = (value, key = '') => {
  const references = new Set();
  if (REFERENCE_EXCLUDED_KEYS.has(key)) return references;
  if (typeof value === 'string') return extractReferencesFromText(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectNodeReferences(item, key).forEach((name) => references.add(name)));
    return references;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => {
      collectNodeReferences(childValue, childKey).forEach((name) => references.add(name));
    });
  }
  return references;
};

const hasConnectedDestination = (edge, nodeById, outgoingByNode) => {
  if (!edge) return false;
  const target = nodeById.get(edge.target);
  if (target?.type !== 'caseNode') return true;
  return (outgoingByNode.get(target.id) || []).length > 0;
};

const issue = (severity, code, node, message) => ({
  severity,
  code,
  nodeId: node?.id || null,
  message,
  nodeLabel: node ? nodeLabel(node) : null
});

// Variaveis que o node ESCREVE. Espelha collectDefinedVariables, mas por node,
// para o painel conseguir apontar onde cada variavel nasce.
const collectNodeWrites = (node) => {
  const writes = new Set();
  const data = node?.data || {};

  if (['inputNode', 'setValueNode', 'secretNode'].includes(node.type)) addDefined(writes, data.variableName);
  if (node.type === 'ratingNode') addDefined(writes, data.variableName || 'nota');
  if (node.type === 'menuNode' && (data.setVarEnabled || data.optionsSource === 'variable')) addDefined(writes, data.variableName);
  if (node.type === 'httpRequestNode') {
    (Array.isArray(data.mappings) ? data.mappings : []).forEach((mapping) => addDefined(writes, mapping?.varName));
  }
  if (node.type === 'whatsappTemplateNode') {
    addDefined(writes, data.saveResponseTextVar);
    addDefined(writes, data.saveResponsePayloadVar);
    addDefined(writes, data.saveButtonTextVar);
  }
  if (node.type === 'holderNode') {
    addDefined(writes, data.lastMessageVar);
    addDefined(writes, data.listVar);
    addDefined(writes, data.textVar);
    addDefined(writes, data.countVar);
  }
  if (node.type === 'catalogNode') {
    const prefix = cleanName(data.varPrefix || 'PRODUTO').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    ['ID', 'NOME', 'PRECO', 'DESCRICAO', 'SKU', 'CATEGORIA'].forEach((suffix) => addDefined(writes, `${prefix}_${suffix}`));
  }
  if (node.type === 'cartNode') {
    addDefined(writes, data.itemsVar || 'CARRINHO_ITENS');
    addDefined(writes, data.totalVar || 'CARRINHO_TOTAL');
    addDefined(writes, data.itemCountVar || 'CARRINHO_QUANTIDADE');
    addDefined(writes, data.summaryVar || 'CARRINHO_RESUMO');
    addDefined(writes, data.okVar || 'CARRINHO_OK');
    addDefined(writes, data.errorVar || 'CARRINHO_ERRO');
  }
  if (node.type === 'scriptNode') collectScriptDefinitions(data.script || data.code, writes);
  if (node.type === 'sequentialNode') {
    (Array.isArray(data.steps) ? data.steps : []).forEach((step) => {
      if (step?.type === 'input' || step?.type === 'menu') addDefined(writes, step.variableName);
      if (step?.type === 'script') collectScriptDefinitions(step.script || step.code, writes);
    });
  }
  return writes;
};

// Cruza as variaveis cadastradas do tenant com o que o fluxo realmente usa.
// Retorna, por variavel usada, os nodes que a leem ou escrevem, para o painel
// centralizar o canvas no node certo.
export const collectVariableUsage = ({ nodes = [], variables = [] } = {}) => {
  const registered = [];
  const seen = new Set();
  (Array.isArray(variables) ? variables : []).forEach((variable) => {
    const name = cleanName(variable?.name ?? variable?.variableName ?? variable);
    if (!name || seen.has(name)) return;
    seen.add(name);
    registered.push(name);
  });

  const usageByName = new Map(registered.map((name) => [name, []]));

  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    if (!node || node.type === 'caseNode') return;
    const reads = collectNodeReferences(node.data || {});
    const writes = collectNodeWrites(node);

    usageByName.forEach((entries, name) => {
      const isWrite = writes.has(name);
      const isRead = reads.has(name);
      if (!isWrite && !isRead) return;
      entries.push({
        nodeId: node.id,
        nodeLabel: nodeLabel(node),
        nodeType: node.type,
        kind: isWrite && isRead ? 'both' : (isWrite ? 'write' : 'read')
      });
    });
  });

  const used = [];
  const unused = [];
  registered.forEach((name) => {
    const entries = usageByName.get(name) || [];
    if (entries.length) used.push({ name, nodes: entries });
    else unused.push({ name });
  });

  return { used, unused, total: registered.length };
};

export const lintFlow = ({ nodes = [], edges = [], variables = [] } = {}) => {
  const safeNodes = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  const safeEdges = Array.isArray(edges) ? edges.filter(Boolean) : [];
  const nodeById = new Map(safeNodes.map((node) => [node.id, node]));
  const outgoingByNode = new Map();
  safeEdges.forEach((edge) => {
    if (!outgoingByNode.has(edge.source)) outgoingByNode.set(edge.source, []);
    outgoingByNode.get(edge.source).push(edge);
  });
  const problems = [];

  safeNodes.forEach((node) => {
    if (!hasOptionalOutput(node)) {
      if ((outgoingByNode.get(node.id) || []).length === 0) {
        problems.push(issue('error', 'node_without_output', node, `${nodeLabel(node)} nao possui saida conectada.`));
      }
    }
  });

  const anchors = new Map();
  safeNodes.filter((node) => node.type === 'anchorNode').forEach((node) => {
    const name = cleanName(node.data?.anchorName);
    if (name) anchors.set(name, node);
  });

  safeNodes.filter((node) => node.type === 'gotoNode').forEach((node) => {
    const target = cleanName(node.data?.targetAnchor);
    if (!target || !anchors.has(target)) {
      problems.push(issue('error', 'goto_missing_anchor', node, target
        ? `A ancora "${target}" nao existe.`
        : 'Selecione uma ancora de destino.'));
    }
  });

  safeNodes.filter((node) => node.type === 'inputNode').forEach((node) => {
    if (!cleanName(node.data?.variableName)) {
      problems.push(issue('error', 'input_missing_variable', node, 'O node de entrada nao possui variavel de destino.'));
    }
  });

  safeNodes.filter((node) => node.type === 'cartNode' && (node.data?.operation || 'add') === 'add').forEach((node) => {
    if (!cleanName(node.data?.productIdVar) && !cleanName(node.data?.productNameVar)) {
      problems.push(issue('error', 'cart_missing_product', node, 'Defina a variavel de ID ou nome do produto.'));
    }
    if (!cleanName(node.data?.quantityVar)) {
      problems.push(issue('error', 'cart_missing_quantity', node, 'Defina a variavel de quantidade.'));
    }
    if ((node.data?.priceSource || 'map') === 'variable' && !cleanName(node.data?.unitPriceVar)) {
      problems.push(issue('error', 'cart_missing_price_variable', node, 'Defina a variavel com o preco unitario.'));
    }
    if ((node.data?.priceSource || 'map') === 'map') {
      const validPrices = (Array.isArray(node.data?.priceMap) ? node.data.priceMap : [])
        .filter((entry) => (cleanName(entry?.id) || cleanName(entry?.name)) && Number.isFinite(Number(entry?.unitPrice)) && Number(entry.unitPrice) >= 0);
      if (!validPrices.length) {
        problems.push(issue('error', 'cart_missing_price_map', node, 'Adicione ao menos um produto com preco valido ao carrinho.'));
      }
    }
  });

  safeNodes.filter((node) => node.type === 'httpRequestNode').forEach((node) => {
    const errorEdge = (outgoingByNode.get(node.id) || []).find((edge) => String(edge.sourceHandle) === 'error');
    if (!hasConnectedDestination(errorEdge, nodeById, outgoingByNode)) {
      problems.push(issue('error', 'http_error_disconnected', node, 'A rota de erro da requisicao HTTP nao esta conectada.'));
    }
  });

  safeNodes.filter((node) => node.type === 'menuNode' && node.data?.optionsSource === 'variable').forEach((node) => {
    const outgoing = outgoingByNode.get(node.id) || [];
    if (!String(node.data?.optionsVariable || '').trim()) {
      problems.push(issue('error', 'menu_dynamic_source', node, 'Menu dinamico sem a variavel com a lista de opcoes.'));
    }
    if (!String(node.data?.variableName || '').trim()) {
      problems.push(issue('warning', 'menu_dynamic_target', node, 'Menu dinamico sem variavel para guardar a escolha.'));
    }
    const escolheu = outgoing.find((edge) => String(edge.sourceHandle) === 'selected');
    if (!hasConnectedDestination(escolheu, nodeById, outgoingByNode)) {
      problems.push(issue('error', 'menu_option_disconnected', node, 'A saida "Escolheu" do menu dinamico nao possui destino conectado.'));
    }
    const vazia = outgoing.find((edge) => String(edge.sourceHandle) === 'empty');
    if (!hasConnectedDestination(vazia, nodeById, outgoingByNode)) {
      problems.push(issue('warning', 'menu_dynamic_empty', node, 'A saida "Lista vazia" nao esta conectada: se a lista vier sem itens, o fluxo para.'));
    }
  });

  safeNodes.filter((node) => node.type === 'menuNode' && node.data?.createBranches !== false && node.data?.optionsSource !== 'variable').forEach((node) => {
    const outgoing = outgoingByNode.get(node.id) || [];
    (Array.isArray(node.data?.options) ? node.data.options : []).forEach((option, index) => {
      const optionId = String(option?.id ?? index + 1);
      const optionEdge = outgoing.find((edge) => String(edge.sourceHandle) === optionId);
      if (!hasConnectedDestination(optionEdge, nodeById, outgoingByNode)) {
        const label = cleanName(option?.label || option?.value || optionId);
        problems.push(issue('error', 'menu_option_disconnected', node, `A opcao "${label}" nao possui destino conectado.`));
      }
    });
  });

  const roots = safeNodes.filter((node) => node.type === 'startNode' || node.type === 'commandNode');
  const reachable = new Set();
  const queue = roots.map((node) => node.id);
  while (queue.length) {
    const currentId = queue.shift();
    if (!currentId || reachable.has(currentId)) continue;
    reachable.add(currentId);
    (outgoingByNode.get(currentId) || []).forEach((edge) => queue.push(edge.target));
    const current = nodeById.get(currentId);
    if (current?.type === 'gotoNode') {
      const anchor = anchors.get(cleanName(current.data?.targetAnchor));
      if (anchor) queue.push(anchor.id);
    }
  }
  // Ancora presa so marca o destino de um "Ir para": sem salto apontando,
  // ela nao atrapalha nada.
  const presas = dockedAnchors(safeNodes, safeEdges);
  safeNodes.forEach((node) => {
    if (!reachable.has(node.id) && !presas.has(node.id)) {
      problems.push(issue('warning', 'node_unreachable', node, `${nodeLabel(node)} nao e alcancavel pelo inicio ou por um comando.`));
    }
  });

  const definedVariables = collectDefinedVariables(safeNodes, variables);
  safeNodes.forEach((node) => {
    collectNodeReferences(node.data || {}).forEach((name) => {
      if (!definedVariables.has(name)) {
        problems.push(issue('warning', 'undefined_variable', node, `A variavel {${name}} e usada, mas nao foi encontrada no fluxo.`));
      }
    });
  });

  const seen = new Set();
  return problems.filter((problem) => {
    const key = `${problem.code}:${problem.nodeId}:${problem.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export default lintFlow;
