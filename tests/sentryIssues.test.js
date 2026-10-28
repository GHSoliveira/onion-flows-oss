import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSentryIssues, resetSentryIssuesCache } from '../src/services/sentryIssues.js';

// Card de erros do super admin: le do Sentry pelo servidor, com cache, e
// nunca derruba o dashboard.

const resposta = (status, body) => ({ ok: status < 400, status, json: async () => body });
const issue = {
  id: '1', shortId: 'ONION-API-1', title: 'Error: falhou', culprit: 'src/x.js', level: 'error',
  project: { slug: 'onion-api' }, count: '3', userCount: 0,
  firstSeen: '2026-09-18T20:00:00Z', lastSeen: '2026-09-18T22:00:00Z', permalink: 'https://sentry/x'
};

beforeEach(() => { resetSentryIssuesCache(); delete process.env.SENTRY_ORG; process.env.SENTRY_API_TOKEN = 'tok_teste_123456'; });

test('sem token o card diz que nao esta configurado e nao chama ninguem', async () => {
  delete process.env.SENTRY_API_TOKEN;
  const r = await getSentryIssues({ fetchImpl: () => assert.fail('nao devia chamar') });
  assert.deepEqual(r, { configured: false, issues: [] });
});

test('descobre a organizacao, lista os abertos e guarda por 60 s', async () => {
  const chamadas = [];
  const fetchImpl = async (url, opts) => {
    chamadas.push(url);
    assert.equal(opts.headers.Authorization, 'Bearer tok_teste_123456');
    return url.endsWith('/organizations/') ? resposta(200, [{ slug: 'onion' }]) : resposta(200, [issue]);
  };
  const r = await getSentryIssues({ fetchImpl, now: 1000 });
  assert.equal(r.org, 'onion');
  assert.deepEqual(r.issues[0], {
    id: '1', shortId: 'ONION-API-1', title: 'Error: falhou', culprit: 'src/x.js', level: 'error', project: 'onion-api',
    count: 3, users: 0, firstSeen: issue.firstSeen, lastSeen: issue.lastSeen, link: 'https://sentry/x'
  });
  assert.match(chamadas[1], /organizations\/onion\/issues\/\?query=is%3Aunresolved/);
  await getSentryIssues({ fetchImpl, now: 30000 });
  assert.equal(chamadas.length, 2, 'dentro de 60 s usa o cache');
  await getSentryIssues({ fetchImpl, now: 70000 });
  assert.equal(chamadas.length, 3, 'depois de 60 s busca de novo (org ja conhecida)');
});

test('token sem org:read descobre a organizacao pela lista de projetos', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/organizations/')) return resposta(403, {});
    if (url.endsWith('/projects/')) return resposta(200, [{ slug: 'onion-painel', organization: { slug: 'onion-web-solutions' } }]);
    return resposta(200, [issue]);
  };
  const r = await getSentryIssues({ fetchImpl });
  assert.equal(r.org, 'onion-web-solutions');
  assert.equal(r.issues.length, 1);
});

test('token recusado vira aviso no card, sem erro para o dashboard', async () => {
  const r = await getSentryIssues({ fetchImpl: async () => resposta(401, {}) });
  assert.equal(r.error, 'token_invalido');
  assert.deepEqual(r.issues, []);
});
