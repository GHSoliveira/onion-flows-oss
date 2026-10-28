import 'dotenv/config';

const readArg = (name) => {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : '';
};

const classificationId = readArg('classification-id');
const expectedChatId = readArg('chat-id');
const reprocessRequestId = readArg('request-id');

if (!classificationId || !reprocessRequestId) {
  console.error('Uso: node scripts/reprocess-classification.js --classification-id=... --chat-id=... --request-id=...');
  process.exit(1);
}

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { classifyMessage } = await import('../src/services/aiClassification.js');

try {
  await adapter.init();
  const existing = await adapter.findOne('messageClassifications', { id: classificationId });
  if (!existing) throw new Error('classification_not_found');
  if (expectedChatId && existing.chatId !== expectedChatId) throw new Error('classification_chat_mismatch');

  const previousRevision = Math.max(1, Number(existing.classificationRevision || 1));
  const result = await classifyMessage({
    tenantId: existing.tenantId,
    messageId: existing.messageId,
    classificationId: existing.id,
    force: true,
    reprocessRequestId
  });
  const outbox = result.classificationIdempotencyKey
    ? await adapter.findOne('integrationOutbox', {
      tenantId: existing.tenantId,
      destination: 'turizmo',
      idempotencyKey: result.classificationIdempotencyKey
    })
    : null;

  console.log(JSON.stringify({
    ok: true,
    classificationId: result.id,
    chatId: result.chatId,
    messageId: result.messageId,
    previousRevision,
    classificationRevision: result.classificationRevision,
    conversationContextHash: result.conversationContextHash,
    idempotencyKey: result.classificationIdempotencyKey || outbox?.idempotencyKey || null,
    outboxId: outbox?.id || result.classificationEventId || null,
    outboxStatus: outbox?.status || null,
    duplicate: Boolean(result.duplicate),
    currentMessageIncluded: Boolean(result.currentMessage),
    recentMessageCount: Array.isArray(result.recentMessages) ? result.recentMessages.length : 0
  }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error?.code || error?.message || 'reprocess_failed' }));
  process.exitCode = 1;
} finally {
  await adapter.close().catch(() => {});
}
