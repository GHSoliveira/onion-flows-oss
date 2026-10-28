const clone = (value) => JSON.parse(JSON.stringify(value));

export const instantiateFlowSnippet = (snippet, suffix, center = { x: 0, y: 0 }) => {
  const sourceNodes = Array.isArray(snippet?.nodes) ? snippet.nodes : [];
  const token = String(suffix || Date.now());
  const idMap = new Map(sourceNodes.map((node, index) => [node.id, `${node.type}_${token}_${index}`]));
  const anchorMap = new Map();
  sourceNodes.filter((node) => node.type === 'anchorNode').forEach((node) => {
    const oldName = String(node.data?.anchorName || '').trim();
    if (oldName) anchorMap.set(oldName, `${oldName}_${token}`);
  });
  const xs = sourceNodes.map((node) => Number(node.position?.x || 0));
  const ys = sourceNodes.map((node) => Number(node.position?.y || 0));
  const sourceCenter = {
    x: xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0,
    y: ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0
  };
  const nodes = sourceNodes.map((node) => ({
    ...clone(node),
    id: idMap.get(node.id),
    selected: true,
    position: {
      x: center.x + Number(node.position?.x || 0) - sourceCenter.x,
      y: center.y + Number(node.position?.y || 0) - sourceCenter.y
    },
    data: {
      ...clone(node.data || {}),
      ...(node.type === 'secretNode' ? { value: '' } : {}),
      ...(node.type === 'anchorNode' && anchorMap.has(node.data?.anchorName) ? { anchorName: anchorMap.get(node.data.anchorName) } : {}),
      ...(node.type === 'gotoNode' && anchorMap.has(node.data?.targetAnchor) ? { targetAnchor: anchorMap.get(node.data.targetAnchor) } : {})
    }
  }));
  const edges = (snippet?.edges || []).map((edge, index) => ({
    ...clone(edge),
    id: `snippet_edge_${token}_${index}`,
    source: idMap.get(edge.source),
    target: idMap.get(edge.target),
    selected: false
  })).filter((edge) => edge.source && edge.target);
  return { nodes, edges };
};

export default instantiateFlowSnippet;
