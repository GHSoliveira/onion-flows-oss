import adapter from '../../db/DatabaseAdapter.js';
import { ensureTenantLimit } from './tenantLimits.js';
import { sanitizeChatState } from './chatStateGuard.js';
import { generateId } from '../utils/helpers.js';
import { appendChatMessage } from './chatMessages.js';

const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');

// Celular brasileiro no formato antigo (8 digitos, comecando com 6-9) ganha o
// nono digito. Fixo (comeca com 2-5) nao tem nono digito: acrescentar quebra.
const withBrazilianNinthDigit = (digits) => (
  digits.length === 12 && digits.startsWith('55') && /[6-9]/.test(digits[4])
    ? `${digits.slice(0, 4)}9${digits.slice(4)}`
    : digits
);

// Numero que veio da Meta (msg.from, wa_id) ou foi salvo a partir dele. Ja traz
// o codigo do pais, entao nunca acrescenta 55: um +1 dos EUA e um celular
// brasileiro sem DDI podem ter os mesmos 11 digitos, e so a origem desempata.
export const normalizeWhatsappWaId = (value) => {
  const digits = normalizeDigits(value);
  return digits ? withBrazilianNinthDigit(digits) : '';
};

// Numero digitado por uma pessoa (contato, campanha). Com "+" na frente e
// internacional. Sem "+", 10 ou 11 digitos sao tratados como brasileiro sem DDI;
// com 11 digitos isso so vale se o terceiro for 9, como em todo celular do
// Brasil. Um +1 dos EUA nunca tem 9 nessa posicao.
export const normalizeWhatsappNumber = (value) => {
  const digits = normalizeDigits(value);
  if (!digits) return '';
  if (String(value).trim().startsWith('+')) return withBrazilianNinthDigit(digits);
  if (digits.length === 10) return withBrazilianNinthDigit(`55${digits}`);
  if (digits.length === 11) return digits[2] === '9' ? `55${digits}` : digits;
  return withBrazilianNinthDigit(digits);
};

const buildContactVars = (contact, phoneNumber) => ({
  nome_cliente: contact?.name || null,
  contato_nome: contact?.name || null,
  contato_empresa: contact?.company || null,
  contato_email: contact?.email || null,
  contato_id: contact?.id || null,
  contato_telefone: phoneNumber || null
});

const createChatMessage = ({ sender, text, meta = null }) => ({
  id: generateId('msg'),
  sender,
  text,
  meta,
  providerMessageId: meta?.providerMessageId || null,
  deliveryStatus: meta?.deliveryStatus || null,
  deliveryStatusAt: meta?.deliveryStatusAt || null,
  timestamp: new Date().toISOString()
});

export const ensureAgentWhatsAppChat = async ({
  tenantId,
  contact,
  phoneNumber,
  agent,
  senderPhoneNumberId = null,
  senderLabel = null,
  deferHumanAttendance = false
}) => {
  const normalizedPhone = normalizeWhatsappNumber(phoneNumber);
  const existing = await adapter.findOne('activeChats', {
    tenantId,
    channel: 'whatsapp',
    channelUserId: normalizedPhone,
    status: { $ne: 'closed' }
  });

  if (!deferHumanAttendance && existing?.agentId && existing.agentId !== agent.id) {
    const ownerName = existing.agentName || 'outro agente';
    const error = new Error(`Este contato ja esta em atendimento com ${ownerName}.`);
    error.status = 409;
    throw error;
  }

  const now = new Date().toISOString();
  const contactVars = buildContactVars(contact, normalizedPhone);

  if (existing) {
    const preserveHumanAttendance = deferHumanAttendance && ['open', 'waiting'].includes(existing.status);
    const nextChat = {
      ...existing,
      status: preserveHumanAttendance ? existing.status : (deferHumanAttendance ? 'bot' : 'open'),
      agentId: preserveHumanAttendance ? existing.agentId : (deferHumanAttendance ? null : agent.id),
      agentName: preserveHumanAttendance ? existing.agentName : (deferHumanAttendance ? null : agent.name),
      activeOutreach: true,
      attendanceDeferred: deferHumanAttendance && !preserveHumanAttendance,
      queue: preserveHumanAttendance ? existing.queue : (deferHumanAttendance ? null : 'ATIVO'),
      queueId: preserveHumanAttendance ? existing.queueId : (deferHumanAttendance ? null : existing.queueId || null),
      waitingSince: null,
      currentNodeId: null,
      flowStarted: false,
      resumeNodeId: null,
      resumePending: false,
      continueFlowAfterQueue: false,
      catalogContext: null,
      transferredTo: null,
      transferReason: null,
      closedAt: null,
      secureVars: deferHumanAttendance ? (existing.secureVars || {}) : {},
      secureVarNames: deferHumanAttendance ? (existing.secureVarNames || []) : [],
      outreachPendingReply: false,
      customerName: contact?.name || existing.customerName || null,
      contactId: contact?.id || existing.contactId || null,
      channelUserId: normalizedPhone,
      channelChatId: normalizedPhone,
      whatsappPhoneNumberId: senderPhoneNumberId || existing.whatsappPhoneNumberId || null,
      whatsappSenderLabel: senderLabel || existing.whatsappSenderLabel || null,
      vars: {
        ...(existing.vars || {}),
        ...contactVars
      },
      updatedAt: now
    };
    const sanitized = sanitizeChatState(nextChat);
    await adapter.updateOne('activeChats', { id: existing.id }, { $set: sanitized.chat });
    return sanitized.chat;
  }

  await ensureTenantLimit(tenantId, 'chats');
  const chat = {
    id: generateId('chat'),
    customerCpf: `wa_${normalizedPhone}`,
    customerName: contact?.name || null,
    contactId: contact?.id || null,
    status: deferHumanAttendance ? 'bot' : 'open',
    queue: deferHumanAttendance ? null : 'ATIVO',
    messages: [],
    lastMessage: null,
    lastMessageAt: null,
    messageCount: 0,
    unreadByAgentCount: 0,
    vars: contactVars,
    tenantId,
    channel: 'whatsapp',
    channelUserId: normalizedPhone,
    channelChatId: normalizedPhone,
    whatsappPhoneNumberId: senderPhoneNumberId || null,
    whatsappSenderLabel: senderLabel || null,
    activeOutreach: true,
    attendanceDeferred: deferHumanAttendance,
    currentNodeId: null,
    processedMessageIds: [],
    agentId: deferHumanAttendance ? null : agent.id,
    agentName: deferHumanAttendance ? null : agent.name,
    flowStarted: false,
    createdAt: now,
    updatedAt: now
  };

  const sanitized = sanitizeChatState(chat);
  await adapter.insertOne('activeChats', sanitized.chat);
  return sanitized.chat;
};

export const appendAgentOutreachMessage = async ({
  chatId,
  templateName,
  previewText,
  meta = null,
  deferHumanAttendance = false
}) => {
  const existing = await adapter.findOne('activeChats', { id: chatId });
  if (!existing) {
    throw new Error('Chat nao encontrado');
  }

  const now = new Date().toISOString();
  const message = createChatMessage({
    sender: 'agent',
    text: previewText || `Template enviado: ${templateName}`,
    meta: {
      type: 'whatsapp_template',
      templateName,
      deliveryStatus: 'sent',
      deliveryStatusAt: now,
      ...meta
    }
  });

  const nextChat = sanitizeChatState({
    ...existing,
    activeOutreach: true,
    attendanceDeferred: deferHumanAttendance && !['open', 'waiting'].includes(existing.status),
    outreachPendingReply: true,
    outreachLastSentAt: now,
    updatedAt: now
  }).chat;

  await adapter.updateOne('activeChats', { id: chatId }, {
    $set: {
      activeOutreach: true,
      attendanceDeferred: deferHumanAttendance && !['open', 'waiting'].includes(existing.status),
      outreachPendingReply: true,
      outreachLastSentAt: now,
      updatedAt: now
    }
  });
  const appended = await appendChatMessage(nextChat, message, { incrementUnread: false });

  return { message: appended.message || message, chat: appended.chat || nextChat };
};
