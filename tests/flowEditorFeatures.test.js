import test from 'node:test';
import assert from 'node:assert/strict';
import { diffFlowSnapshots } from '../client/src/utils/flowDiff.js';
import { instantiateFlowSnippet } from '../client/src/utils/flowSnippet.js';

process.env.JWT_SECRET ||= 'flow-editor-features-test-secret';
const { getDisabledNodeNextId } = await import('../src/services/flowRunner.js');

test('diff identifica alteracao sem comparar valor de secret', () => {
  const published = { nodes: [{ id: 'msg', type: 'messageNode', data: { text: 'A' } }, { id: 'secret', type: 'secretNode', data: { value: '***' } }], edges: [] };
  const draft = { nodes: [{ id: 'msg', type: 'messageNode', data: { text: 'B' } }, { id: 'secret', type: 'secretNode', data: { value: 'novo' } }], edges: [] };
  const diff = diffFlowSnapshots(draft, published);
  assert.equal(diff.summary.nodesChanged, 1);
  assert.equal(diff.nodes[0].id, 'msg');
});

test('node desativado so avanca quando existe uma unica saida', () => {
  const node = { id: 'n1', type: 'messageNode', data: { disabled: true } };
  assert.equal(getDisabledNodeNextId(node, [{ source: 'n1', target: 'n2' }]), 'n2');
  assert.equal(getDisabledNodeNextId(node, [{ source: 'n1', target: 'n2' }, { source: 'n1', target: 'n3' }]), null);
  assert.equal(getDisabledNodeNextId({ ...node, type: 'startNode' }, [{ source: 'n1', target: 'n2' }]), null);
});

test('trecho reescreve ids, ancora, goto e remove secret', () => {
  const snippet = {
    nodes: [
      { id: 'a', type: 'anchorNode', position: { x: 0, y: 0 }, data: { anchorName: 'inicio' } },
      { id: 'g', type: 'gotoNode', position: { x: 100, y: 0 }, data: { targetAnchor: 'inicio' } },
      { id: 's', type: 'secretNode', position: { x: 200, y: 0 }, data: { value: '***' } }
    ],
    edges: [{ id: 'e', source: 'a', target: 'g' }]
  };
  const result = instantiateFlowSnippet(snippet, 'copy', { x: 0, y: 0 });
  assert.equal(new Set(result.nodes.map((node) => node.id)).size, 3);
  assert.equal(result.nodes.find((node) => node.type === 'gotoNode').data.targetAnchor, 'inicio_copy');
  assert.equal(result.nodes.find((node) => node.type === 'secretNode').data.value, '');
  assert.equal(result.edges[0].source, result.nodes.find((node) => node.type === 'anchorNode').id);
});
