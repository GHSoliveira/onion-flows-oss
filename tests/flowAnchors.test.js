import test from 'node:test';
import assert from 'node:assert/strict';
import { dockedAnchors, nextAnchorName, ANCHOR_DOCK_OFFSET } from '../client/src/utils/flowAnchors.js';
import { computeFlowLayout } from '../client/src/utils/flowLayout.js';
import { lintFlow } from '../client/src/utils/flowLint.js';

// Ancora presa: anchorNode sem entrada e com uma saida so. O motor nao muda;
// o editor a tira da corrente e desenha em cima do node.

const fluxo = () => ({
  nodes: [
    { id: 'start', type: 'startNode', position: { x: 0, y: 0 }, data: {} },
    { id: 'msg', type: 'messageNode', position: { x: 0, y: 0 }, data: { text: 'Oi' } },
    { id: 'fim', type: 'finalNode', position: { x: 0, y: 0 }, data: {} },
    { id: 'anc', type: 'anchorNode', position: { x: 0, y: 0 }, data: { anchorName: 'fim' } }
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'msg' },
    { id: 'e2', source: 'msg', target: 'fim' },
    { id: 'e3', source: 'anc', target: 'fim' }
  ]
});

test('ancora sem entrada e com uma saida fica presa no node', () => {
  const { nodes, edges } = fluxo();
  assert.deepEqual([...dockedAnchors(nodes, edges)], [['anc', 'fim']]);
});

test('ancora no meio da corrente continua como node comum', () => {
  const { nodes } = fluxo();
  const edges = [
    { id: 'e1', source: 'start', target: 'anc' },
    { id: 'e2', source: 'anc', target: 'msg' },
    { id: 'e3', source: 'msg', target: 'fim' }
  ];
  assert.equal(dockedAnchors(nodes, edges).size, 0);
});

test('layout poe a ancora presa em cima do node, sem abrir faixa nova', () => {
  const { nodes, edges } = fluxo();
  const posicoes = computeFlowLayout(nodes, edges);
  const fim = posicoes.get('fim');
  assert.deepEqual(posicoes.get('anc'), { x: fim.x, y: fim.y - ANCHOR_DOCK_OFFSET });
  // O resto fica igual ao fluxo sem a ancora.
  const sem = computeFlowLayout(nodes.filter((node) => node.id !== 'anc'), edges.filter((edge) => edge.source !== 'anc'));
  for (const id of ['start', 'msg', 'fim']) assert.deepEqual(posicoes.get(id), sem.get(id), id);
});

test('ancora presa sem salto apontando nao vira aviso de inalcancavel', () => {
  const { nodes, edges } = fluxo();
  const problemas = lintFlow({ nodes, edges }).filter((problem) => problem.code === 'node_unreachable');
  assert.deepEqual(problemas, []);
});

test('nome da ancora nova pula os que ja existem', () => {
  const nodes = [
    { id: 'a', type: 'anchorNode', data: { anchorName: 'ancora_1' } },
    { id: 'b', type: 'anchorNode', data: { anchorName: 'Ancora_2' } }
  ];
  assert.equal(nextAnchorName(nodes), 'ancora_3');
});
