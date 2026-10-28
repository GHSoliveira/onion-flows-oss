const OMIT_NODE_DATA_KEYS = new Set([
  'availableVars', 'availableTemplates', 'availableSchedules', 'onDelete', 'onConfig', 'onChange'
]);

const safeData = (node) => {
  const data = { ...(node?.data || {}) };
  OMIT_NODE_DATA_KEYS.forEach((key) => delete data[key]);
  if (node?.type === 'secretNode') delete data.value;
  return data;
};

const comparableNode = (node) => ({ type: node?.type, data: safeData(node) });
const comparableEdge = (edge) => ({
  source: edge?.source,
  target: edge?.target,
  sourceHandle: edge?.sourceHandle || null,
  targetHandle: edge?.targetHandle || null,
  type: edge?.type || null
});

const changedFields = (before = {}, after = {}) => {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
};

export const diffFlowSnapshots = (draft = {}, published = {}) => {
  const draftNodes = new Map((draft.nodes || []).map((node) => [node.id, node]));
  const publishedNodes = new Map((published.nodes || []).map((node) => [node.id, node]));
  const draftEdges = new Map((draft.edges || []).map((edge) => [edge.id, edge]));
  const publishedEdges = new Map((published.edges || []).map((edge) => [edge.id, edge]));

  const nodes = [];
  draftNodes.forEach((node, id) => {
    if (!publishedNodes.has(id)) {
      nodes.push({ id, status: 'added', label: node.data?.customName || node.data?.text || node.type, fields: [] });
      return;
    }
    const before = comparableNode(publishedNodes.get(id));
    const after = comparableNode(node);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      nodes.push({
        id,
        status: 'changed',
        label: node.data?.customName || node.data?.text || node.type,
        fields: changedFields(before.data, after.data)
      });
    }
  });
  publishedNodes.forEach((node, id) => {
    if (!draftNodes.has(id)) nodes.push({ id, status: 'removed', label: node.data?.customName || node.data?.text || node.type, fields: [] });
  });

  const edges = [];
  draftEdges.forEach((edge, id) => {
    if (!publishedEdges.has(id)) edges.push({ id, status: 'added' });
    else if (JSON.stringify(comparableEdge(edge)) !== JSON.stringify(comparableEdge(publishedEdges.get(id)))) edges.push({ id, status: 'changed' });
  });
  publishedEdges.forEach((_, id) => {
    if (!draftEdges.has(id)) edges.push({ id, status: 'removed' });
  });

  const count = (items, status) => items.filter((item) => item.status === status).length;
  return {
    nodes,
    edges,
    summary: {
      nodesAdded: count(nodes, 'added'),
      nodesChanged: count(nodes, 'changed'),
      nodesRemoved: count(nodes, 'removed'),
      edgesAdded: count(edges, 'added'),
      edgesChanged: count(edges, 'changed'),
      edgesRemoved: count(edges, 'removed')
    }
  };
};

export default diffFlowSnapshots;
