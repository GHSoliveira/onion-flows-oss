// Layout rigido do editor de fluxo: a posicao de cada node sai da estrutura,
// nao de arrastar. Cada node fica a uma distancia fixa (LAYOUT_GAP_X) a direita
// de quem aponta para ele, com o topo alinhado (os handles ficam no mesmo Y, a
// linha sai reta). Ramos irmaos descem em faixas que nao se sobrepoem.
//
// As medidas sao fixas por tipo, e nao medidas na tela, para o layout ser uma
// funcao so dos dados: abrir, desfazer e refazer chegam sempre na mesma posicao.

import { ANCHOR_DOCK_OFFSET, dockedAnchors } from './flowAnchors.js';

export const LAYOUT_GAP_X = 72;
export const LAYOUT_GAP_Y = 28;
const ROOT_GAP_Y = LAYOUT_GAP_Y * 3;

const WIDTH_BY_TYPE = { startNode: 156, caseNode: 184 };
const DEFAULT_WIDTH = 248;
// Altura reservada: o node padrao tem ate 3 linhas de resumo (126px).
const SLOT_BY_TYPE = { startNode: 58, caseNode: 46 };
const DEFAULT_SLOT = 126;

export const layoutWidth = (node) => WIDTH_BY_TYPE[node?.type] || DEFAULT_WIDTH;
const layoutSlot = (node) => SLOT_BY_TYPE[node?.type] || DEFAULT_SLOT;

const isLayoutNode = (node) => node && !String(node.id || '').startsWith('visual_block_');

const byPosition = (a, b) => (
  Number(a.position?.y || 0) - Number(b.position?.y || 0)
  || Number(a.position?.x || 0) - Number(b.position?.x || 0)
  || String(a.id).localeCompare(String(b.id))
);

// Devolve um Map id -> {x, y}. Nodes fora do grafo (blocos visuais) ficam de fora.
export const computeFlowLayout = (nodes = [], edges = [], { startId = 'start' } = {}) => {
  // Ancora presa fica fora da corrente: vai em cima do node dela no fim.
  const presas = dockedAnchors(nodes, edges);
  const graph = (Array.isArray(nodes) ? nodes : []).filter((node) => isLayoutNode(node) && !presas.has(node.id));
  const byId = new Map(graph.map((node) => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Map();
  (Array.isArray(edges) ? edges : []).forEach((edge) => {
    if (!byId.has(edge.source) || !byId.has(edge.target) || edge.source === edge.target) return;
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge.target);
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
  });
  // Ordem dos ramos: a de cima continua em cima (as opcoes do menu nascem em ordem).
  outgoing.forEach((targets, source) => {
    const unicos = [...new Set(targets)].map((id) => byId.get(id)).sort(byPosition).map((node) => node.id);
    outgoing.set(source, unicos);
  });

  const positions = new Map();
  const visitado = new Set();

  // Coloca o node e a subarvore dele a partir de (x, y); devolve o fundo da faixa.
  const colocar = (rootId, rootX, rootY) => {
    // Pilha explicita: fluxo longo nao estoura a recursao.
    const pilha = [{ id: rootId, x: rootX, y: rootY, filhos: null, indice: 0, fundo: 0, proximoY: 0 }];
    let fundoFinal = rootY;
    while (pilha.length) {
      const atual = pilha[pilha.length - 1];
      const node = byId.get(atual.id);
      if (atual.filhos === null) {
        visitado.add(atual.id);
        positions.set(atual.id, { x: Math.round(atual.x), y: Math.round(atual.y) });
        atual.filhos = (outgoing.get(atual.id) || []).filter((id) => !visitado.has(id));
        atual.fundo = atual.y + layoutSlot(node);
        atual.proximoY = atual.y;
      }
      // Filho ja colocado por outro caminho no meio do caminho: pula.
      while (atual.indice < atual.filhos.length && visitado.has(atual.filhos[atual.indice])) atual.indice += 1;
      if (atual.indice < atual.filhos.length) {
        const filhoId = atual.filhos[atual.indice];
        atual.indice += 1;
        pilha.push({ id: filhoId, x: atual.x + layoutWidth(node) + LAYOUT_GAP_X, y: atual.proximoY, filhos: null, indice: 0, fundo: 0, proximoY: 0, pai: atual });
        continue;
      }
      pilha.pop();
      if (atual.pai) {
        atual.pai.fundo = Math.max(atual.pai.fundo, atual.fundo);
        atual.pai.proximoY = atual.fundo + LAYOUT_GAP_Y;
      } else {
        fundoFinal = atual.fundo;
      }
    }
    return fundoFinal;
  };

  const raizes = [
    ...(byId.has(startId) ? [byId.get(startId)] : []),
    ...graph.filter((node) => node.id !== startId && !incoming.get(node.id)).sort(byPosition)
  ];
  let y = 0;
  raizes.forEach((raiz) => {
    if (visitado.has(raiz.id)) return;
    y = colocar(raiz.id, 0, y) + ROOT_GAP_Y;
  });
  // Ciclos sem entrada: o que sobrou entra no fim, na ordem atual.
  graph.filter((node) => !visitado.has(node.id)).sort(byPosition).forEach((node) => {
    if (visitado.has(node.id)) return;
    y = colocar(node.id, 0, y) + ROOT_GAP_Y;
  });

  const porAlvo = new Map();
  presas.forEach((alvoId, ancoraId) => {
    const alvo = positions.get(alvoId);
    if (!alvo) return;
    const empilhadas = porAlvo.get(alvoId) || 0;
    porAlvo.set(alvoId, empilhadas + 1);
    positions.set(ancoraId, { x: alvo.x, y: alvo.y - ANCHOR_DOCK_OFFSET * (empilhadas + 1) });
  });

  return positions;
};

// Aplica o layout; devolve o mesmo array se nada mudou (evita render a toa).
export const applyFlowLayout = (nodes, edges, options) => {
  const positions = computeFlowLayout(nodes, edges, options);
  let mudou = false;
  const proximos = nodes.map((node) => {
    const alvo = positions.get(node.id);
    if (!alvo) return node;
    if (Number(node.position?.x) === alvo.x && Number(node.position?.y) === alvo.y) return node;
    mudou = true;
    return { ...node, position: alvo };
  });
  return mudou ? proximos : nodes;
};
