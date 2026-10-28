import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthlyPeriod, monthlyRanges } from '../src/services/monthlyAnalyticsModel.js';

const start = Date.parse('2026-08-01T03:00:00Z');
const end = Date.parse('2026-09-01T03:00:00Z');
const chat = (extra = {}) => ({ id: 'c1', tenantId: 't1', createdAt: '2026-08-01T03:00:00Z', status: 'open', channel: 'whatsapp', channelUserId: '5511999999999', ...extra });
const event = (type, timestamp, extra = {}) => ({ id: `${type}_${timestamp}`, chatId: 'c1', type, timestamp, ...extra });
const report = (chats, events = []) => buildMonthlyPeriod(chats, events, start, end);

test('monthly ranges use Brasilia and half-open month boundaries', () => {
  const range = monthlyRanges('2026-08', new Date('2026-09-05T15:00:00Z'));
  assert.equal(range.start, start);
  assert.equal(range.end, end);
  assert.equal(range.previousEnd, start);
  assert.equal(range.partial, false);
});
test('partial month compares equal elapsed days and clips shorter previous month', () => {
  const range = monthlyRanges('2026-09', new Date('2026-09-05T15:00:00Z'));
  assert.equal(new Date(range.previousEnd).toISOString(), '2026-08-05T15:00:00.000Z');
  const march = monthlyRanges('2024-03', new Date('2024-03-31T15:00:00Z'));
  assert.equal(new Date(march.previousEnd).toISOString(), '2024-03-01T03:00:00.000Z');
});
test('invalid and future months are rejected', () => {
  for (const month of ['2026-13', 'invalid', '2019-12', '2027-01']) assert.throws(() => monthlyRanges(month, new Date('2026-09-05')), { status: 400 });
});
test('carryover closes in current month without becoming a new conversation', () => {
  const result = report([chat({ createdAt: '2026-07-10T10:00:00Z', closedAt: '2026-08-02T10:00:00Z', status: 'closed' })]);
  assert.deepEqual(result.movement, { opening: 1, incoming: 0, reopened: 0, closed: 1, ending: 0 });
  assert.equal(result.quality.legacyClosures, 1);
});
test('reopen cycles balance without duplicate close events or initial open counting twice', () => {
  const events = [event('CHAT_OPENED', '2026-08-01T03:00:01Z'), event('AGENT_CLOSED', '2026-08-02T10:00:00Z'), event('FLOW_STARTED', '2026-08-03T10:00:00Z'), event('AGENT_CLOSED', '2026-08-04T10:00:00Z')];
  const result = report([chat({ status: 'closed', closedAt: '2026-08-04T10:00:00Z' })], [...events, ...events]);
  assert.deepEqual(result.movement, { opening: 0, incoming: 1, reopened: 1, closed: 2, ending: 0 });
  assert.equal(result.quality.legacyClosures, 0);
});
test('future closures do not change a historical month ending', () => {
  const result = report([chat({ status: 'closed', closedAt: '2026-09-02T10:00:00Z' })]);
  assert.equal(result.movement.ending, 1);
  assert.equal(result.movement.closed, 0);
});
test('end boundary belongs to next month and days bucket at Brasilia midnight', () => {
  const result = report([chat({ createdAt: '2026-08-02T02:00:00Z' }), chat({ id: 'next', createdAt: '2026-09-01T03:00:00Z' })]);
  assert.equal(result.summary.incoming, 1);
  assert.equal(result.days[0].incoming, 1);
  assert.equal(result.days.length, 31);
});
test('waiting across month boundary counts on pickup date, not creation date', () => {
  const result = report([chat({ createdAt: '2026-07-31T10:00:00Z' })], [
    event('QUEUE_ENTERED', '2026-08-01T02:55:00Z', { context: { queue: 'A' } }),
    event('AGENT_ASSUMED', '2026-08-01T03:05:00Z', { actor: { id: 'a1', name: 'Agente' } })
  ]);
  assert.equal(result.summary.waitMinutes, 10);
  assert.equal(result.summary.waitSamples, 1);
  assert.equal(result.days[0].waitMinutes, 10);
  assert.equal(result.queues[0].conversations, 1);
});
test('transfer and repeated pickups are independent queue waits, not time in attendance', () => {
  const result = report([chat()], [
    event('QUEUE_ENTERED', '2026-08-01T10:00:00Z', { context: { queue: 'A' } }),
    event('AGENT_ASSUMED', '2026-08-01T10:04:00Z', { actor: { id: 'a1', name: 'Agente' } }),
    event('QUEUE_TRANSFERRED', '2026-08-01T11:00:00Z', { context: { queue: 'B' } }),
    event('AGENT_ASSUMED', '2026-08-01T11:02:00Z', { actor: { id: 'a2', name: 'Outro' } })
  ]);
  assert.equal(result.summary.waitMinutes, 3);
  assert.equal(result.summary.waitSamples, 2);
  assert.equal(result.summary.attended, 1);
  assert.equal(result.queues.length, 2);
});
test('ongoing waiting and missing pickup timestamps do not become zero-minute samples', () => {
  const result = report([chat()], [event('QUEUE_ENTERED', '2026-08-01T10:00:00Z')]);
  assert.equal(result.summary.waitMinutes, null);
  assert.equal(result.summary.waitSamples, 0);
  const missing = report([chat()], [event('AGENT_ASSUMED', '2026-08-01T11:00:00Z')]);
  assert.equal(missing.quality.unmatchedPickups, 1);
  assert.equal(missing.summary.waitMinutes, null);
});
test('ratings show denominator, exclude invalid values, and tolerate closure event timing', () => {
  const result = report([chat({ status: 'closed', closedAt: '2026-08-04T10:00:00.500Z', vars: { nota: '5', SECRET: 'sensitive' }, secureVars: { key: 'secret' }, messages: [{ text: 'private' }] })], [event('AGENT_CLOSED', '2026-08-04T10:00:00Z')]);
  assert.equal(result.summary.rating, 5);
  assert.equal(result.summary.ratingSamples, 1);
  assert.doesNotMatch(JSON.stringify(result), /sensitive|secret|private|5511999999999/);
  assert.equal(report([chat({ closedAt: '2026-08-04T10:00:00Z', vars: { nota: 8 } })]).summary.rating, null);
});
test('contact deduplication does not count conversations as unique customers', () => {
  const result = report([chat(), chat({ id: 'c2' })]);
  assert.equal(result.summary.incoming, 2);
  assert.equal(result.summary.contacts, 1);
});
test('unmatched events and inferred disengagement are not counted as closed conversations', () => {
  const result = report([chat()], [event('ERROR', '2026-08-03T10:00:00Z', { chatId: 'deleted' }), event('CUSTOMER_DISENGAGED', '2026-08-03T11:00:00Z')]);
  assert.equal(result.movement.closed, 0);
  assert.equal(result.incidents.errors, 0);
});
