// Ancora presa a um node: anchorNode sem entrada e com uma saida so. O motor
// segue igual (o "Ir para" salta para a ancora e ela continua pela ligacao);
// o editor so a desenha como uma etiqueta em cima do node, fora da corrente e
// sem linha.

// Nodes que nao recebem ancora presa.
export const ANCHOR_TARGET_BLOCKED = new Set(['startNode', 'anchorNode', 'caseNode', 'gotoNode', 'visualBlockNode']);

// Distancia da etiqueta ate o topo do node (altura dela + folga).
export const ANCHOR_DOCK_OFFSET = 26;

// Map ancoraId -> id do node onde ela esta presa.
export const dockedAnchors = (nodes = [], edges = []) => {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  const comEntrada = new Set();
  const saidas = new Map();
  (Array.isArray(edges) ? edges : []).forEach((edge) => {
    if (!byId.has(edge.source) || !byId.has(edge.target)) return;
    comEntrada.add(edge.target);
    saidas.set(edge.source, [...(saidas.get(edge.source) || []), edge.target]);
  });
  const presas = new Map();
  byId.forEach((node) => {
    if (node.type !== 'anchorNode' || comEntrada.has(node.id)) return;
    const alvos = saidas.get(node.id) || [];
    if (alvos.length !== 1) return;
    const alvo = byId.get(alvos[0]);
    if (!alvo || ANCHOR_TARGET_BLOCKED.has(alvo.type)) return;
    presas.set(node.id, alvo.id);
  });
  return presas;
};

export const canDockAnchor = (node, presas) => Boolean(node)
  && !String(node.id || '').startsWith('visual_block_')
  && !ANCHOR_TARGET_BLOCKED.has(node.type)
  && ![...presas.values()].includes(node.id);

// Primeiro nome livre: ancora_1, ancora_2...
export const nextAnchorName = (nodes = []) => {
  const usados = new Set(nodes
    .filter((node) => node.type === 'anchorNode')
    .map((node) => String(node.data?.anchorName || '').trim().toLowerCase()));
  let indice = 1;
  while (usados.has(`ancora_${indice}`)) indice += 1;
  return `ancora_${indice}`;
};
