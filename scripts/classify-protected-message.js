import 'dotenv/config';

const readArg = (name) => {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : '';
};

const messageId = readArg('message-id');
const expectedChatId = readArg('chat-id');
const expectedCampaignId = readArg('campaign-id');

if (!messageId || !expectedChatId) {
  console.error('Uso: node scripts/classify-protected-message.js --message-id=... --chat-id=... [--campaign-id=...]');
  process.exit(1);
}

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { classifyMessage } = await import('../src/services/aiClassification.js');
const { notifyProtectedAttendanceInbound } = await import('../src/services/protectedAttendance.js');

try {
  await adapter.init();
  const message = await adapter.findOne('chatMessages', { messageId, chatId: expectedChatId });
  if (!message) throw new Error('message_not_found');
  const tenantId = message.tenantId;
  const chat = await adapter.findOne('activeChats', { tenantId, id: expectedChatId });
  if (!chat) throw new Error('chat_not_found');

  const replayChat = {
    ...chat,
    campaignId: expectedCampaignId || chat.campaignId || null
  };
  const notification = await notifyProtectedAttendanceInbound({
    chat: replayChat,
    message: {
      ...message,
      id: message.messageId || message.id,
      campaignId: expectedCampaignId || message.campaignId || chat.campaignId || null
    },
    direction: 'inbound',
    queueClassification: false
  });
  if (!notification.handled) throw new Error('chat_not_protected');

  const classification = await classifyMessage({ tenantId, messageId });
  const outbox = classification.classificationIdempotencyKey
    ? await adapter.findOne('integrationOutbox', {
      tenantId,
      destination: 'turizmo',
      idempotencyKey: classification.classificationIdempotencyKey
    })
    : await adapter.findOne('integrationOutbox', {
      tenantId,
      destination: 'turizmo',
      eventType: 'lead.classified',
      'payload.data.messageId': messageId
    });

  console.log(JSON.stringify({
    ok: true,
    tenantId,
    chatId: expectedChatId,
    messageId,
    campaignId: classification.campaignId || expectedCampaignId || null,
    classificationId: classification.id || null,
    classificationRevision: classification.classificationRevision || null,
    conversationContextHash: classification.conversationContextHash || null,
    recentMessageCount: Array.isArray(classification.recentMessages) ? classification.recentMessages.length : 0,
    duplicate: Boolean(classification.duplicate),
    notificationEventId: notification.eventId || null,
    classificationEventId: outbox?.id || classification.classificationEventId || null,
    classificationEventStatus: outbox?.status || null
  }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error?.code || error?.message || 'protected_classification_failed' }));
  process.exitCode = 1;
} finally {
  await adapter.close().catch(() => {});
}
