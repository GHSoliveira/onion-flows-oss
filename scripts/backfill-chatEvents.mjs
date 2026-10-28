#!/usr/bin/env node
/**
 * Backfill chatEvents collection from existing systemLogs (CHAT_* types).
 *
 * Usage:
 *   node scripts/backfill-chatEvents.mjs --dry-run
 *   node scripts/backfill-chatEvents.mjs                  # actually writes
 *   node scripts/backfill-chatEvents.mjs --tenant <id>    # restrict to one tenant
 *   node scripts/backfill-chatEvents.mjs --inactivity     # also synthesize CLOSED_BY_INACTIVITY from chat flags
 *
 * Idempotent: each event id is derived from the source log id, so re-runs are safe.
 */

import '../src/config/env.js';
import adapter from '../db/DatabaseAdapter.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const includeInactivity = args.has('--inactivity');
let tenantFilter = null;
const tenantIdx = process.argv.indexOf('--tenant');
if (tenantIdx !== -1) tenantFilter = process.argv[tenantIdx + 1] || null;

const TYPE_MAP = {
  CHAT_START: 'CHAT_OPENED',
  CHAT_PICKUP: 'AGENT_ASSUMED',
  CHAT_PICKUP_ALL_ITEM: 'AGENT_ASSUMED',
  CHAT_TRANSFER: 'QUEUE_ENTERED',
  CHAT_CLOSE: 'AGENT_CLOSED'
};

const parseLogMessage = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return { raw: String(raw) };
  }
};

const mapLogToEvent = (log) => {
  const payload = parseLogMessage(log.message);
  const tenantId = payload.tenantId || null;
  const chatId = payload.chatId || null;
  if (!tenantId || !chatId) return null;
  if (tenantFilter && tenantId !== tenantFilter) return null;

  let type = TYPE_MAP[log.type];
  if (!type) return null;

  if (log.type === 'CHAT_CLOSE' && payload.continueFlow) {
    type = 'RESUME_TO_FLOW';
  }

  const actor = (() => {
    if (log.type === 'CHAT_START') return { kind: 'customer', id: payload.customerCpf || null };
    if (log.type === 'CHAT_PICKUP' || log.type === 'CHAT_PICKUP_ALL_ITEM') {
      return { kind: 'agent', id: payload.agentId || log.userId || null };
    }
    if (log.type === 'CHAT_TRANSFER') return { kind: 'flow', id: log.userId || null };
    if (log.type === 'CHAT_CLOSE') return { kind: 'agent', id: log.userId || null };
    return { kind: 'system' };
  })();

  const context = (() => {
    const ctx = { ...payload };
    delete ctx.tenantId;
    delete ctx.chatId;
    return ctx;
  })();

  return {
    id: `evt_log_${log.id}`,
    tenantId,
    chatId,
    type,
    timestamp: log.timestamp || new Date().toISOString(),
    actor,
    context
  };
};

const main = async () => {
  await adapter.init();

  console.log(`[BACKFILL] dryRun=${dryRun} tenant=${tenantFilter || 'all'} inactivity=${includeInactivity}`);

  const logQuery = { type: { $in: Object.keys(TYPE_MAP) } };
  if (tenantFilter) logQuery.tenantId = tenantFilter;

  const logs = await adapter.findMany('systemLogs', {
    query: logQuery,
    sort: { timestamp: 1 },
    limit: 0
  });

  console.log(`[BACKFILL] systemLogs candidatos: ${logs.length}`);

  const events = [];
  for (const log of logs) {
    const event = mapLogToEvent(log);
    if (event) events.push(event);
  }

  if (includeInactivity) {
    const chatQuery = {
      $or: [{ closedByInactivity: true }, { inactivityClosed: true }],
      status: 'closed'
    };
    if (tenantFilter) chatQuery.tenantId = tenantFilter;
    const inactiveChats = await adapter.findMany('activeChats', {
      query: chatQuery,
      sort: { closedAt: 1 },
      limit: 0
    });
    console.log(`[BACKFILL] chats fechados por inatividade: ${inactiveChats.length}`);
    for (const chat of inactiveChats) {
      events.push({
        id: `evt_inact_${chat.id}`,
        tenantId: chat.tenantId,
        chatId: chat.id,
        type: 'CLOSED_BY_INACTIVITY',
        timestamp: chat.closedAt || chat.updatedAt || new Date().toISOString(),
        actor: { kind: 'system' },
        context: { backfilled: true, queue: chat.queue || null, agentId: chat.agentId || null }
      });
    }
  }

  console.log(`[BACKFILL] eventos a gravar: ${events.length}`);

  if (dryRun) {
    console.log('[BACKFILL] DRY RUN — primeiros 5 exemplos:');
    events.slice(0, 5).forEach((event) => console.log(JSON.stringify(event)));
    await adapter.close();
    return;
  }

  const collection = await adapter.collection('chatEvents');
  let inserted = 0;
  let skipped = 0;
  for (const event of events) {
    try {
      const existing = await collection.findOne({ id: event.id });
      if (existing) {
        skipped += 1;
        continue;
      }
      await collection.insertOne(event);
      inserted += 1;
      if (inserted % 500 === 0) console.log(`[BACKFILL] ...${inserted} inseridos`);
    } catch (error) {
      console.warn(`[BACKFILL] Falha em ${event.id}: ${error?.message || error}`);
    }
  }

  console.log(`[BACKFILL] concluido. inseridos=${inserted} skipped=${skipped}`);
  await adapter.close();
};

main().catch((err) => {
  console.error('[BACKFILL] erro fatal:', err?.stack || err);
  process.exit(1);
});
