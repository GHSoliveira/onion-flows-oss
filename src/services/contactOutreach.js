import adapter from '../../db/DatabaseAdapter.js';
import { createLog } from './logs.js';
import { getIo } from './logs.js';
import { getWhatsAppConfig, resolveWhatsAppSender } from './channelConfig.js';
import { appendAgentOutreachMessage, ensureAgentWhatsAppChat, normalizeWhatsappNumber } from './activeOutreach.js';
import { buildChatSummary } from './chatSummaries.js';
import { buildWhatsAppTemplateComponents, buildWhatsAppTemplatePreview, describeWhatsAppTemplateInputs } from './whatsappTemplateCatalog.js';
import { sendWhatsAppTemplate } from './whatsappApi.js';
import { createOutreachRecord } from './outreachHistory.js';

const getDb = async () => {
  if (!adapter.db) {
    await adapter.init();
  }
  return adapter.db;
};

const normalizeActor = (actor) => ({
  id: actor?.id || 'system',
  name: actor?.name || 'Sistema'
});

export const resolveContactWhatsAppPhone = (contact, preferredPhoneEntryId = null) => {
  const phones = Array.isArray(contact?.phones) ? contact.phones : [];
  if (!phones.length) return null;

  if (preferredPhoneEntryId) {
    const exact = phones.find((phone) => String(phone.id || '') === String(preferredPhoneEntryId));
    if (exact?.number) return exact;
  }

  const primaryWhatsApp = phones.find((phone) => phone.channel === 'whatsapp' && phone.isPrimary);
  if (primaryWhatsApp?.number) return primaryWhatsApp;

  const firstWhatsApp = phones.find((phone) => phone.channel === 'whatsapp');
  if (firstWhatsApp?.number) return firstWhatsApp;

  return null;
};

export const performWhatsAppContactOutreach = async ({
  tenantId,
  contact,
  contactId = null,
  phoneEntryId = null,
  templateId,
  senderPhoneNumberId = null,
  values = {},
  actor = null,
  deferHumanAttendance = false
}) => {
  const db = await getDb();
  const contactsCollection = db.collection('contacts');
  const templatesCollection = db.collection('whatsappTemplates');
  const safeActor = normalizeActor(actor);

  if (!tenantId) {
    const error = new Error('tenantId obrigatorio para outreach');
    error.status = 400;
    throw error;
  }
  const resolvedContact = contact?.id
    ? contact
    : (contactId ? await contactsCollection.findOne({ id: contactId }) : null);

  if (!resolvedContact?.id) {
    const error = new Error('Contato nao encontrado');
    error.status = 404;
    throw error;
  }
  if (String(resolvedContact.tenantId || '') !== String(tenantId)) {
    const error = new Error('Contato nao pertence ao tenant informado.');
    error.status = 403;
    throw error;
  }
  if (!templateId) {
    const error = new Error('Template WhatsApp nao informado');
    error.status = 400;
    throw error;
  }

  const phoneEntry = resolveContactWhatsAppPhone(resolvedContact, phoneEntryId);
  if (!phoneEntry?.number) {
    const error = new Error('Contato sem numero valido de WhatsApp.');
    error.status = 400;
    throw error;
  }

  const config = await getWhatsAppConfig(tenantId);
  const sender = resolveWhatsAppSender(config, senderPhoneNumberId || null);
  if (senderPhoneNumberId && !sender) {
    const error = new Error('Numero remetente invalido para este tenant.');
    error.status = 400;
    throw error;
  }
  if (!config?.enabled || !config?.accessToken || !sender?.phoneNumberId) {
    const error = new Error('Canal WhatsApp nao esta configurado para este tenant.');
    error.status = 400;
    throw error;
  }

  const template = await templatesCollection.findOne({ id: templateId, tenantId });
  if (!template) {
    const error = new Error('Template WhatsApp nao encontrado.');
    error.status = 404;
    throw error;
  }

  const status = String(template.status || '').toUpperCase();
  if (!['APPROVED', 'ACTIVE'].includes(status)) {
    const error = new Error('Somente templates aprovados podem ser enviados.');
    error.status = 400;
    throw error;
  }

  const inputDef = describeWhatsAppTemplateInputs(template);
  const components = buildWhatsAppTemplateComponents(template, values);
  const to = normalizeWhatsappNumber(phoneEntry.number);
  if (!to) {
    const error = new Error('Numero do contato invalido para WhatsApp.');
    error.status = 400;
    throw error;
  }

  const result = await sendWhatsAppTemplate({
    accessToken: config.accessToken,
    phoneNumberId: sender.phoneNumberId,
    to,
    templateName: template.name,
    languageCode: template.language,
    components,
    debugContext: {
      tenantId,
      templateId: template.id,
      inputDef,
      values
    }
  });

  const chat = await ensureAgentWhatsAppChat({
    tenantId,
    contact: resolvedContact,
    phoneNumber: to,
    agent: safeActor,
    senderPhoneNumberId: sender.phoneNumberId,
    senderLabel: sender.label || sender.displayNumber || null,
    deferHumanAttendance
  });

  const previewText = buildWhatsAppTemplatePreview(template, values);
  const outreach = await createOutreachRecord({
    tenantId,
    contactId: resolvedContact.id,
    chatId: chat.id,
    templateId: template.id,
    templateName: template.name,
    senderPhoneNumberId: sender.phoneNumberId,
    senderLabel: sender.label || sender.displayNumber || null,
    to,
    previewText,
    providerMessageId: result?.messages?.[0]?.id || null,
    createdBy: safeActor.id
  });

  const outreachMessageResult = await appendAgentOutreachMessage({
    chatId: chat.id,
    templateName: template.name,
    previewText,
    meta: {
      contactId: resolvedContact.id,
      templateId: template.id,
      channel: 'whatsapp',
      inputDef,
      outreachId: outreach.id,
      providerMessageId: result?.messages?.[0]?.id || null,
      senderPhoneNumberId: sender.phoneNumberId
    },
    deferHumanAttendance
  });
  const updatedChat = outreachMessageResult.chat;
  const io = getIo();
  if (io) {
    if (!deferHumanAttendance || ['open', 'waiting'].includes(updatedChat.status)) {
      io.to(`tenant:${tenantId}`).emit('agent_assigned', { chat: buildChatSummary(updatedChat) });
    }
    io.emit('new_message', { chatId: updatedChat.id, message: outreachMessageResult.message });
  }

  await contactsCollection.updateOne(
    { id: resolvedContact.id },
    {
      $set: {
        lastContactAt: new Date().toISOString(),
        lastContactChannel: 'whatsapp',
        lastTemplateId: template.id,
        lastTemplateName: template.name,
        lastPhoneUsed: to,
        lastOutreachId: outreach.id,
        lastOutreachStatus: 'sent',
        lastOutreachStatusAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    }
  );

  createLog('CONTACT_OUTREACH', {
    tenantId,
    contactId: resolvedContact.id,
    channel: 'whatsapp',
    phoneNumberId: sender.phoneNumberId,
    to,
    templateId: template.id,
    templateName: template.name,
    chatId: chat.id,
    providerMessageId: result?.messages?.[0]?.id || null
  }, safeActor.id).catch(() => {});

  return {
    ok: true,
    channel: 'whatsapp',
    contact: resolvedContact,
    chat: updatedChat,
    outreach,
    providerMessageId: result?.messages?.[0]?.id || null,
    sender,
    template,
    to,
    phoneEntry
  };
};
