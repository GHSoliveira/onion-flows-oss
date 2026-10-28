import test from 'node:test';
import assert from 'node:assert/strict';
import { getDocumentationPagesForRole } from '../src/services/documentationContent.js';
import { docsPages } from '../client/src/docs/content.js';

const slugsFor = (role) => getDocumentationPagesForRole(role).map((page) => page.slug);

test('anonymous users receive no protected documentation', () => {
  assert.deepEqual(slugsFor(null), []);
});

test('tenant roles receive operational pages but not internal pages', () => {
  for (const role of ['AGENT', 'MANAGER', 'ADMIN']) {
    const slugs = slugsFor(role);
    assert.ok(slugs.includes('guia-agente'));
    assert.ok(slugs.includes('api-tenant'));
    assert.ok(!slugs.includes('api-interna'));
    assert.ok(!slugs.includes('infraestrutura-interna'));
  }
});

test('super-admin receives tenant and internal documentation', () => {
  const slugs = slugsFor('SUPER_ADMIN');
  assert.ok(slugs.includes('guia-agente'));
  assert.ok(slugs.includes('api-interna'));
  assert.ok(slugs.includes('infraestrutura-interna'));
  assert.ok(slugs.includes('runbook-incidentes'));
});

// A documentacao publica (/docs, sem login) vai no pacote do front: como a
// plataforma e hospedada, pecas internas do codigo e regras internas de
// cobranca ficam so nas paginas de super admin.
// ("sandbox" continua permitido: e o sandbox de scripts do editor.)
test('public documentation does not expose internal details', () => {
  const publicText = JSON.stringify(docsPages);
  const internal = /quick tunnel|cloudflared|trycloudflare|túnel|VPS|Vercel|MongoDB|Redis|BullMQ|requireTenant|processedMessageIds|currentNodeId|de confiança|allowlist|super-admin|SEU_BACKEND|Helmet/i;
  assert.doesNotMatch(publicText, internal);
  assert.ok(!docsPages.some((page) => page.slug === 'arquitetura'));
});

test('architecture and tunnel notes are super-admin only', () => {
  const superAdmin = getDocumentationPagesForRole('SUPER_ADMIN');
  const arquitetura = superAdmin.find((page) => page.slug === 'arquitetura');
  assert.ok(arquitetura, 'super admin ve a arquitetura');
  assert.match(JSON.stringify(arquitetura), /PostgreSQL/);
  assert.match(JSON.stringify(superAdmin.find((page) => page.slug === 'infraestrutura-interna')), /Quick Tunnel/);
  for (const role of ['AGENT', 'MANAGER', 'ADMIN']) {
    assert.ok(!getDocumentationPagesForRole(role).some((page) => page.slug === 'arquitetura'));
  }
});
