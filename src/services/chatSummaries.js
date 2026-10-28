const extractLastUserFacingMessage = (messages) => {
  if (!Array.isArray(messages) || !messages.length) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.sender === 'system') continue;
    return message;
  }
  return null;
};

const buildLastMessagePreview = (message) => {
  if (!message) return '';
  if (typeof message.text === 'string' && message.text.trim()) {
    return message.text.trim().slice(0, 140);
  }
  if (message.mediaType) {
    return `[${String(message.mediaType).toUpperCase()}]`;
  }
  return '';
};

export const buildChatSummary = (chat) => {
  const lastMessage = chat?.lastMessage || extractLastUserFacingMessage(chat?.messages);

  return {
    id: chat?.id || null,
    tenantId: chat?.tenantId || null,
    status: chat?.status || null,
    queue: chat?.queue || null,
    queueId: chat?.queueId || null,
    agentId: chat?.agentId || null,
    agentName: chat?.agentName || null,
    customerCpf: chat?.customerCpf || null,
    customerPhone: chat?.customerPhone || null,
    channel: chat?.channel || null,
    channelUserId: chat?.channelUserId || null,
    channelChatId: chat?.channelChatId || null,
    createdAt: chat?.createdAt || null,
    updatedAt: chat?.updatedAt || null,
    waitingSince: chat?.waitingSince || null,
    vars: chat?.vars || {},
    variables: chat?.variables || {},
    lastMessageAt: chat?.lastMessageAt || lastMessage?.timestamp || lastMessage?.createdAt || chat?.updatedAt || chat?.createdAt || null,
    lastMessagePreview: buildLastMessagePreview(lastMessage),
    messageCount: Number(chat?.messageCount || 0) || (Array.isArray(chat?.messages) ? chat.messages.length : 0),
    unreadByAgentCount: Number(chat?.unreadByAgentCount || 0) || 0
  };
};

export const buildChatSummaryCollection = (chats) => (
  Array.isArray(chats) ? chats.map(buildChatSummary) : []
);
