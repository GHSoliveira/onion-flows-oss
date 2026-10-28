import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `monthly-storage-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { getMonthlyAnalytics, monthlyPostgresPage } = await import('../src/services/monthlyAnalytics.js');
after(async () => { await adapter.close(); fs.rmSync(dbPath, { force: true }); });

test('monthly storage isolates tenants, applies channel filter and coalesces cached reads', async () => {
  await adapter.init();
  for (const [id, tenantId, channel] of [['a', 'tenant_a', 'whatsapp'], ['b', 'tenant_b', 'whatsapp'], ['c', 'tenant_a', 'telegram']]) {
    await adapter.saveDocument('activeChats', { id, tenantId, channel, createdAt: '2026-08-01T10:00:00.000Z', status: 'open', secureVars: { apiKey: 'SECRET_VALUE' }, messages: [{ text: 'PRIVATE_TEXT' }] });
  }
  const [a, again] = await Promise.all([getMonthlyAnalytics({ tenantId: 'tenant_a', month: '2026-08', channel: 'whatsapp' }), getMonthlyAnalytics({ tenantId: 'tenant_a', month: '2026-08', channel: 'whatsapp' })]);
  assert.equal(a.summary.incoming, 1);
  assert.equal(a, again);
  const all = await getMonthlyAnalytics({ tenantId: 'tenant_a', month: '2026-08' });
  assert.equal(all.summary.incoming, 2);
  assert.doesNotMatch(JSON.stringify(all), /SECRET_VALUE|PRIVATE_TEXT/);
  await assert.rejects(() => getMonthlyAnalytics({ tenantId: null, month: '2026-08' }), { status: 400 });
  await assert.rejects(() => getMonthlyAnalytics({ tenantId: 'tenant_a', month: '2026-08', channel: 'invalid' }), { status: 400 });
});

test('PostgreSQL query projects only selected values and binds all tenant/channel/cursor input', () => {
  const tenantId = "tenant' OR true --";
  const query = monthlyPostgresPage('app_documents', 'activeChats', { tenantId, createdAt: { $lt: '2026-09-01T03:00:00Z' }, channel: 'whatsapp' }, 'cursor', { id: 1, 'vars.nota': 1, _id: 0 });
  assert.ok(query.text.includes('jsonb_build_object'));
  assert.ok(query.text.includes('tenant_id = $2'));
  assert.ok(query.text.includes('order by id limit 1000'));
  assert.doesNotMatch(query.text, /select doc |messages|secureVars/);
  assert.ok(!query.text.includes(tenantId));
  assert.equal(query.values[1], tenantId);
  assert.throws(() => monthlyPostgresPage('table;drop', 'activeChats', {}, null, {}));
});
