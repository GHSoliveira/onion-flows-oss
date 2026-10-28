import 'dotenv/config';
import adapter from '../db/DatabaseAdapter.js';
import { normalizeChatMessage } from '../src/services/chatMessages.js';

const parseArgs = () => {
  const args = new Map();
  for (const raw of process.argv.slice(2)) {
    const [key, value = 'true'] = raw.replace(/^--/, '').split('=');
    args.set(key, value);
  }
  return {
    dryRun: args.get('dry-run') === 'true',
    limit: Math.min(Math.max(Number.parseInt(args.get('limit') || '50', 10) || 50, 1), 500),
    tenantId: args.get('tenantId') || null
  };
};

const run = async () => {
  const options = parseArgs();
  await adapter.init();

  const query = {
    messages: { $exists: true },
    ...(options.tenantId ? { tenantId: options.tenantId } : {})
  };

  const chats = await adapter.findMany('activeChats', {
    query,
    projection: { _id: 0 },
    sort: { updatedAt: 1, createdAt: 1 },
    limit: options.limit
  });

  let migratedChats = 0;
  let migratedMessages = 0;

  const compactLastMessage = (message) => {
    if (!message) return null;
    return {
      id: message.id || message.messageId || null,
      messageId: message.messageId || message.id || null,
      sender: message.sender || null,
      text: message.text || '',
      media: message.media || null,
      buttons: message.buttons || null,
      meta: message.meta || null,
      timestamp: message.timestamp || message.createdAt || null,
      providerMessageId: message.providerMessageId || message.meta?.providerMessageId || null,
      deliveryStatus: message.deliveryStatus || message.meta?.deliveryStatus || null,
      deliveryStatusAt: message.deliveryStatusAt || message.meta?.deliveryStatusAt || null
    };
  };

  for (const chat of chats) {
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    if (!messages.length) continue;

    if (options.dryRun) {
      migratedChats += 1;
      migratedMessages += messages.length;
      continue;
    }

    const normalizedMessages = messages.map((message) => normalizeChatMessage(chat, message));
    if (normalizedMessages.length) {
      const collection = adapter.db.collection('chatMessages');
      await collection.bulkWrite(normalizedMessages.map((message) => ({
        updateOne: {
          filter: {
            tenantId: message.tenantId,
            chatId: message.chatId,
            messageId: message.messageId
          },
          update: { $setOnInsert: message },
          upsert: true
        }
      })), { ordered: false });
      migratedMessages += normalizedMessages.length;
    }

    const lastUserFacing = [...messages].reverse()
      .find((message) => String(message?.sender || '').toLowerCase() !== 'system') || null;
    const lastAny = messages[messages.length - 1] || null;
    const messageCount = Math.max(Number(chat.messageCount || 0), messages.length);
    await adapter.updateOne('activeChats', { id: chat.id }, {
      $set: {
        lastMessage: compactLastMessage(lastUserFacing),
        lastMessageAt: lastAny?.timestamp || lastAny?.createdAt || chat.updatedAt || chat.createdAt || null,
        messageCount,
        updatedAt: new Date().toISOString()
      },
      $unset: { messages: '' }
    });
    migratedChats += 1;
  }

  console.log(JSON.stringify({
    dryRun: options.dryRun,
    limit: options.limit,
    tenantId: options.tenantId,
    scanned: chats.length,
    migratedChats,
    migratedMessages
  }, null, 2));

  await adapter.close();
};

run().catch(async (error) => {
  console.error('[MIGRATE_CHAT_MESSAGES] falha:', error?.message || error);
  try {
    await adapter.close();
  } catch {}
  process.exit(1);
});
