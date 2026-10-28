import test from 'node:test';
import assert from 'node:assert/strict';
import { isIncidentLog, paginationFromQuery } from '../src/services/tenantModules.js';
import { classifyTenantActivity } from '../src/services/tenantActivity.js';
import { sanitizeLibraryPayload, validateFlowStructure } from '../src/services/automationLibrary.js';

test('tenant module pagination applies safe defaults and limits', () => {
  assert.deepEqual(paginationFromQuery({}), { page: 1, limit: 25, skip: 0 });
  assert.deepEqual(paginationFromQuery({ page: '3', limit: '50' }), { page: 3, limit: 50, skip: 100 });
  assert.deepEqual(paginationFromQuery({ page: '-2', limit: '9999' }), { page: 1, limit: 100, skip: 0 });
});

test('incident detection recognizes integration failures without reading message bodies', () => {
  assert.equal(isIncidentLog({ type: 'WHATSAPP_ERROR' }), true);
  assert.equal(isIncidentLog({ type: 'CAMPAIGN_FAILED' }), true);
  assert.equal(isIncidentLog({ type: 'QUEUE_CREATE' }), false);
  assert.equal(isIncidentLog({ type: 'HTTP_TIMEOUT' }), true);
});

test('tenant activity classifier separates incidents, audit events and noise', () => {
  assert.equal(classifyTenantActivity('WHATSAPP_ERROR'), 'incident');
  assert.equal(classifyTenantActivity('QUEUE_UPDATE'), 'audit');
  assert.equal(classifyTenantActivity('FLOW_PUBLISH'), 'audit');
  assert.equal(classifyTenantActivity('WHATSAPP_STATUS'), null);
});

test('library sanitizer removes secret nodes and authorization values recursively', () => {
  const result = sanitizeLibraryPayload({
    nodes: [
      { id: 'secret', type: 'secretNode', data: { name: 'API_TOKEN', value: 'super-secret' } },
      { id: 'http', type: 'httpNode', data: { headers: '{"authorization":"Bearer abc.def"}' } }
    ]
  });
  assert.equal(result.nodes[0].data.value, '***');
  assert.equal(result.nodes[0].data.name, 'API_TOKEN');
  assert.equal(JSON.parse(result.nodes[1].data.headers).authorization, 'Bearer ***');
});

test('flow validator identifies duplicate nodes, dangling edges and unreachable nodes', () => {
  const report = validateFlowStructure({
    nodes: [
      { id: 'start', type: 'startNode', data: {} },
      { id: 'message', type: 'messageNode', data: {} },
      { id: 'message', type: 'messageNode', data: {} },
      { id: 'orphan', type: 'messageNode', data: {} }
    ],
    edges: [{ id: 'edge-1', source: 'start', target: 'missing' }]
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((entry) => entry.code === 'DUPLICATE_NODE_ID'));
  assert.ok(report.errors.some((entry) => entry.code === 'EDGE_TARGET_MISSING'));
  assert.ok(report.warnings.some((entry) => entry.code === 'UNREACHABLE_NODE'));
});
