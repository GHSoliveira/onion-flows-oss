import test from 'node:test';
import assert from 'node:assert/strict';
import { lintFlow } from '../client/src/utils/flowLint.js';

const byCode = (problems, code) => problems.filter((problem) => problem.code === code);

test('flow lint encontra goto orfao, input sem variavel e node sem saida', () => {
  const problems = lintFlow({
    nodes: [
      { id: 'start', type: 'startNode', data: {} },
      { id: 'goto_1', type: 'gotoNode', data: { targetAnchor: 'inexistente' } },
      { id: 'input_1', type: 'inputNode', data: {} }
    ],
    edges: [
      { source: 'start', target: 'goto_1' },
      { source: 'input_1', target: 'goto_1' }
    ]
  });

  assert.equal(byCode(problems, 'goto_missing_anchor').length, 1);
  assert.equal(byCode(problems, 'input_missing_variable').length, 1);
  assert.equal(byCode(problems, 'node_without_output').length, 0);
  assert.equal(problems.some((problem) => problem.severity === 'error'), true);
});

test('flow lint valida destino real das rotas de menu e erro HTTP', () => {
  const problems = lintFlow({
    nodes: [
      { id: 'start', type: 'startNode', data: {} },
      { id: 'menu', type: 'menuNode', data: { createBranches: true, options: [{ id: '1', label: 'Continuar' }] } },
      { id: 'menu_case', type: 'caseNode', data: {} },
      { id: 'http', type: 'httpRequestNode', data: {} },
      { id: 'http_success', type: 'caseNode', data: {} },
      { id: 'http_error', type: 'caseNode', data: {} },
      { id: 'end', type: 'finalNode', data: {} }
    ],
    edges: [
      { source: 'start', target: 'menu' },
      { source: 'menu', sourceHandle: '1', target: 'menu_case' },
      { source: 'menu_case', target: 'http' },
      { source: 'http', sourceHandle: 'success', target: 'http_success' },
      { source: 'http_success', target: 'end' },
      { source: 'http', sourceHandle: 'error', target: 'http_error' }
    ]
  });

  assert.equal(byCode(problems, 'menu_option_disconnected').length, 0);
  assert.equal(byCode(problems, 'http_error_disconnected').length, 1);
  assert.equal(byCode(problems, 'node_without_output').some((item) => item.nodeId === 'http_error'), true);
});

test('flow lint respeita variaveis root, sistema, aliases e atribuicoes em script', () => {
  const problems = lintFlow({
    variables: [{ name: 'ROOT_NAME' }],
    nodes: [
      { id: 'start', type: 'startNode', data: {} },
      { id: 'script', type: 'scriptNode', data: { script: 'vars.GERADA = 1;' } },
      {
        id: 'message',
        type: 'messageNode',
        data: {
          text: '{ROOT_NAME} {WA_ID} {GERADA} {ALIAS_LOCAL} {DESCONHECIDA}',
          varMap: [{ global: 'ROOT_NAME', local: 'ALIAS_LOCAL' }]
        }
      },
      { id: 'end', type: 'finalNode', data: {} }
    ],
    edges: [
      { source: 'start', target: 'script' },
      { source: 'script', target: 'message' },
      { source: 'message', target: 'end' }
    ]
  });

  const undefinedProblems = byCode(problems, 'undefined_variable');
  assert.equal(undefinedProblems.length, 1);
  assert.match(undefinedProblems[0].message, /DESCONHECIDA/);
});

test('command node funciona como raiz sem gerar falso positivo de alcance', () => {
  const problems = lintFlow({
    nodes: [
      { id: 'start', type: 'startNode', data: {} },
      { id: 'end', type: 'finalNode', data: {} },
      { id: 'command', type: 'commandNode', data: {} },
      { id: 'command_end', type: 'finalNode', data: {} }
    ],
    edges: [
      { source: 'start', target: 'end' },
      { source: 'command', target: 'command_end' }
    ]
  });

  assert.equal(byCode(problems, 'node_unreachable').length, 0);
});

test('fila sem continuidade pode encerrar o caminho sem saida conectada', () => {
  const problems = lintFlow({
    nodes: [
      { id: 'start', type: 'startNode', data: {} },
      {
        id: 'queue',
        type: 'queueNode',
        data: { queueName: 'ATENDIMENTO', continueFlowAfterQueue: false }
      }
    ],
    edges: [{ source: 'start', target: 'queue' }]
  });

  assert.equal(byCode(problems, 'node_without_output').some((item) => item.nodeId === 'queue'), false);
});

test('fila que continua o fluxo ainda exige saida conectada', () => {
  const explicitContinue = lintFlow({
    nodes: [
      { id: 'start', type: 'startNode', data: {} },
      { id: 'queue', type: 'queueNode', data: { continueFlowAfterQueue: true } }
    ],
    edges: [{ source: 'start', target: 'queue' }]
  });
  const legacyDefault = lintFlow({
    nodes: [
      { id: 'start', type: 'startNode', data: {} },
      { id: 'queue', type: 'queueNode', data: {} }
    ],
    edges: [{ source: 'start', target: 'queue' }]
  });

  assert.equal(byCode(explicitContinue, 'node_without_output').some((item) => item.nodeId === 'queue'), true);
  assert.equal(byCode(legacyDefault, 'node_without_output').some((item) => item.nodeId === 'queue'), true);
});
