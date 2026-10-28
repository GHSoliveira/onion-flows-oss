import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import express from 'express';
import jwt from 'jsonwebtoken';

const dbPath = path.join(os.tmpdir(), `onion-commercial-final-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'commercial-final-test-secret-not-for-production';
process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.OUTREACH_CAMPAIGN_MAX_CONTACTS = '250';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const {
  createTurizmoEvent,
  enqueueTurizmoEvent,
  processNextTurizmoEvent,
  testTurizmoIntegration,
  turizmoEventEnvelopeSchema
} = await import('../src/services/integrationOutbox.js');
const {
  getOutreachCampaignMaxContacts,
  validateOutreachCampaignContactLimit
} = await import('../src/services/outreachCampaignWorker.js');
const { default: outreachRouter } = await import('../src/routes/outreach.js');
const { default: systemRouter } = await import('../src/routes/system.js');

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
};

const listenExpress = async (app) => listen(app);

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('users', {
    id: 'user_admin_test', username: 'admin-test', name: 'Admin Test',
    role: 'ADMIN', tenantId: 'tenant_test', permissions: []
  });
  await adapter.insertOne('users', {
    id: 'user_super_test', username: 'super-test', name: 'Super Test',
    role: 'SUPER_ADMIN', tenantId: null, permissions: ['*']
  });
});

after(async () => {
  await adapter.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

test('campaign limit accepts 200 and 250 contacts and rejects 251', () => {
  const ids = (count) => Array.from({ length: count }, (_, index) => `contact_${index}`);
  assert.equal(getOutreachCampaignMaxContacts(), 250);
  assert.equal(validateOutreachCampaignContactLimit(ids(200)).length, 200);
  assert.equal(validateOutreachCampaignContactLimit(ids(250)).length, 250);
  assert.throws(
    () => validateOutreachCampaignContactLimit(ids(251)),
    (error) => error?.status === 400 && error?.code === 'campaign_contact_limit_exceeded'
  );
});

test('campaign HTTP route returns the structured limit error before processing', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/outreach', outreachRouter);
  const api = await listenExpress(app);
  try {
    const token = jwt.sign({ userId: 'user_admin_test', role: 'ADMIN' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const response = await fetch(`${api.baseUrl}/api/outreach/campaigns`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Limite', channel: 'whatsapp', templateId: 'template_test',
        contactIds: Array.from({ length: 251 }, (_, index) => `contact_${index}`)
      })
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'campaign_contact_limit_exceeded');
  } finally {
    await api.close();
  }
});

test('Turizmo envelope is strict, nested in data and auditable', async () => {
  const event = createTurizmoEvent({
    tenantId: 'tenant_test', type: 'integration.test', aggregateType: 'integration',
    aggregateId: 'tenant_test', idempotencyKey: 'envelope-test', data: { diagnostic: true }
  });
  const { aggregateType: _aggregateType, aggregateId: _aggregateId, ...envelope } = event;
  assert.equal(turizmoEventEnvelopeSchema.parse(envelope).producer, 'onion-flows');
  assert.equal(event.data.diagnostic, true);
  assert.throws(() => createTurizmoEvent({ type: 'integration.test', idempotencyKey: 'invalid', data: {} }));
  await assert.rejects(
    () => enqueueTurizmoEvent({ type: 'integration.test', tenantId: 'tenant_test', idempotencyKey: '', data: {} }),
    (error) => error?.code === 'invalid_turizmo_event'
  );
});

test('disabled Turizmo diagnostic returns not configured without creating commercial data', async () => {
  process.env.TURIZMO_INTEGRATION_ENABLED = 'false';
  delete process.env.TURIZMO_API_KEY;
  const beforeCount = await adapter.countDocuments('integrationOutbox', { tenantId: 'tenant_test', eventType: 'integration.test' });
  await assert.rejects(
    () => testTurizmoIntegration({ tenantId: 'tenant_test' }),
    (error) => error?.status === 503 && error?.code === 'turizmo_not_configured'
  );
  assert.equal(await adapter.countDocuments('integrationOutbox', { tenantId: 'tenant_test', eventType: 'integration.test' }), beforeCount);
});

test('Turizmo diagnostic performs a real authenticated request and persists its outbox event', async () => {
  let received = null;
  const remote = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      apiKey: req.headers['x-api-key'],
      idempotencyKey: req.headers['idempotency-key'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    };
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"accepted":true}');
  });
  try {
    process.env.TURIZMO_INTEGRATION_ENABLED = 'true';
    process.env.TURIZMO_API_KEY = 'turizmo-diagnostic-secret';
    process.env.TURIZMO_BASE_URL = remote.baseUrl;
    const result = await testTurizmoIntegration({ tenantId: 'tenant_test' });
    assert.equal(result.ok, true);
    assert.equal(result.turizmoStatus, 202);
    assert.equal(received.apiKey, 'turizmo-diagnostic-secret');
    assert.equal(received.body.type, 'integration.test');
    assert.deepEqual(received.body.data, { diagnostic: true, message: 'Teste de conectividade Onion para Turizmo' });
    assert.equal(received.idempotencyKey, received.body.idempotencyKey);
    const record = await adapter.findOne('integrationOutbox', { id: result.outboxId });
    assert.equal(record.status, 'delivered');
    assert.equal(record.payload.eventId, result.eventId);
    assert.equal(await adapter.countDocuments('contacts', { tenantId: 'tenant_test' }), 0);
    assert.equal(await adapter.countDocuments('outreachCampaigns', { tenantId: 'tenant_test' }), 0);
  } finally {
    await remote.close();
  }
});

test('Turizmo diagnostic translates authentication and destination failures without exposing key', async () => {
  process.env.TURIZMO_INTEGRATION_ENABLED = 'true';
  process.env.TURIZMO_API_KEY = 'never-expose-this-key';
  for (const [remoteStatus, expectedCode] of [[401, 'turizmo_authentication_failed'], [500, 'turizmo_unreachable']]) {
    const remote = await listen((_req, res) => {
      res.writeHead(remoteStatus, { 'Content-Type': 'application/json' });
      res.end('{"message":"remote diagnostic failure"}');
    });
    try {
      process.env.TURIZMO_BASE_URL = remote.baseUrl;
      await assert.rejects(
        () => testTurizmoIntegration({ tenantId: 'tenant_test' }),
        (error) => {
          assert.equal(error.code, expectedCode);
          assert.equal(error.status, 502);
          assert.equal(JSON.stringify(error).includes(process.env.TURIZMO_API_KEY), false);
          return true;
        }
      );
    } finally {
      await remote.close();
    }
  }
});

test('Turizmo diagnostic aborts on configured timeout', async () => {
  const remote = await listen(() => {});
  try {
    process.env.TURIZMO_INTEGRATION_ENABLED = 'true';
    process.env.TURIZMO_API_KEY = 'timeout-test-key';
    process.env.TURIZMO_BASE_URL = remote.baseUrl;
    process.env.TURIZMO_EVENT_TIMEOUT_MS = '1000';
    await assert.rejects(
      () => testTurizmoIntegration({ tenantId: 'tenant_test' }),
      (error) => error?.status === 504 && error?.code === 'turizmo_timeout'
    );
  } finally {
    await remote.close();
  }
});

test('Turizmo outbox processes only due pending or retry events', async () => {
  let requestCount = 0;
  const remote = await listen((_req, res) => {
    requestCount += 1;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"accepted":true}');
  });
  try {
    process.env.TURIZMO_INTEGRATION_ENABLED = 'true';
    process.env.TURIZMO_API_KEY = 'outbox-state-test-key';
    process.env.TURIZMO_BASE_URL = remote.baseUrl;

    const createRecord = (suffix) => enqueueTurizmoEvent(createTurizmoEvent({
      tenantId: 'tenant_test',
      type: 'integration.test',
      aggregateType: 'integration',
      aggregateId: 'tenant_test',
      idempotencyKey: `outbox-state-${suffix}`,
      data: { diagnostic: true }
    }));

    const delivered = await createRecord('delivered');
    await adapter.updateOne('integrationOutbox', { id: delivered.id }, {
      $set: { status: 'delivered', attemptCount: 1, deliveredAt: new Date().toISOString() }
    });
    assert.deepEqual(await processNextTurizmoEvent({ outboxId: delivered.id }), { idle: true });
    assert.equal((await adapter.findOne('integrationOutbox', { id: delivered.id })).attemptCount, 1);
    assert.equal(requestCount, 0);

    const futureRetry = await createRecord('future-retry');
    await adapter.updateOne('integrationOutbox', { id: futureRetry.id }, {
      $set: { status: 'retry', attemptCount: 2, nextAttemptAt: new Date(Date.now() + 60_000).toISOString() }
    });
    assert.deepEqual(await processNextTurizmoEvent({ outboxId: futureRetry.id }), { idle: true });
    assert.equal((await adapter.findOne('integrationOutbox', { id: futureRetry.id })).attemptCount, 2);
    assert.equal(requestCount, 0);

    const duePending = await createRecord('due-pending');
    await adapter.updateOne('integrationOutbox', { id: duePending.id }, {
      $set: { status: 'pending', nextAttemptAt: new Date(Date.now() - 1_000).toISOString() }
    });
    const processed = await processNextTurizmoEvent({ outboxId: duePending.id });
    assert.equal(processed.ok, true);
    const persisted = await adapter.findOne('integrationOutbox', { id: duePending.id });
    assert.equal(persisted.status, 'delivered');
    assert.equal(persisted.attemptCount, 1);
    assert.equal(requestCount, 1);
  } finally {
    await remote.close();
  }
});

test('commercial health is restricted and contains no configured secrets', async () => {
  process.env.AI_CLASSIFICATION_ENABLED = 'true';
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_MODEL = 'test-model';
  process.env.AI_API_KEY = 'ai-health-secret';
  process.env.TURIZMO_API_KEY = 'turizmo-health-secret';
  const app = express();
  app.use('/api/system', systemRouter);
  const api = await listenExpress(app);
  try {
    const adminToken = jwt.sign({ userId: 'user_admin_test', role: 'ADMIN' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const forbidden = await fetch(`${api.baseUrl}/api/system/commercial-health`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(forbidden.status, 403);
    const superToken = jwt.sign({ userId: 'user_super_test', role: 'SUPER_ADMIN' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const response = await fetch(`${api.baseUrl}/api/system/commercial-health?tenantId=tenant_test`, { headers: { Authorization: `Bearer ${superToken}` } });
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(response.status, 200);
    assert.equal(body.database.adapter, 'json');
    assert.equal(body.campaigns.maxContacts, 250);
    assert.equal(body.metrics.v2Enabled, true);
    assert.equal(text.includes(process.env.AI_API_KEY), false);
    assert.equal(text.includes(process.env.TURIZMO_API_KEY), false);
  } finally {
    await api.close();
  }
});
