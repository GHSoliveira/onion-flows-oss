import adapter from '../../db/DatabaseAdapter.js';
import { buildPhoneVariants, contactPhoneDigits, digitsOf } from '../utils/phoneVariants.js';

export { buildPhoneVariants };

/**
 * Localizacao e eliminacao dos dados de um titular (LGPD, Art. 18, V e VI).
 *
 * O mesmo telefone fica gravado de jeitos diferentes: a conversa guarda o
 * numero da Meta com nono digito, o contato guarda os digitos como chegaram, e
 * o titular informa o numero de qualquer forma. Por isso a busca compara todas
 * as variacoes do numero contra todos os campos de telefone, em vez de uma
 * consulta de igualdade exata (que alem disso nao enxergava telefone dentro de
 * listas no adaptador Postgres).
 */

export const findDataSubjectRecords = async ({ tenantId, cpf = '', phone = '' }) => {
  if (!tenantId) throw new Error('tenantId obrigatorio');
  if (!adapter.db) await adapter.init();

  const rawCpf = String(cpf || '').trim();
  const cpfDigits = digitsOf(rawCpf);
  const variants = new Set(buildPhoneVariants(phone));

  const chatMatches = (chat) => {
    const customerCpf = String(chat?.customerCpf || '');
    const whatsappCpf = customerCpf.startsWith('wa_');
    if (cpfDigits && !whatsappCpf && (customerCpf === rawCpf || digitsOf(customerCpf) === cpfDigits)) return true;
    if (!variants.size) return false;
    if (chat?.channel === 'whatsapp' && variants.has(digitsOf(chat.channelUserId))) return true;
    if (whatsappCpf && variants.has(digitsOf(customerCpf))) return true;
    return Boolean(chat?.customerPhone) && variants.has(digitsOf(chat.customerPhone));
  };

  const chats = (await adapter.findDocuments('activeChats', { tenantId })).filter(chatMatches);
  const contacts = variants.size
    ? (await adapter.findDocuments('contacts', { tenantId }))
      .filter((contact) => contactPhoneDigits(contact).some((value) => variants.has(value)))
    : [];

  return {
    variants: [...variants],
    chats,
    chatIds: chats.map((chat) => chat.id).filter(Boolean),
    contacts,
    contactIds: contacts.map((contact) => contact.id).filter(Boolean)
  };
};

const countByChatIds = async (collection, tenantId, chatIds) => (chatIds.length
  ? (await adapter.findDocuments(collection, { tenantId, chatId: { $in: chatIds } })).length
  : 0);

export const previewDataSubject = async ({ tenantId, cpf = '', phone = '' }) => {
  const records = await findDataSubjectRecords({ tenantId, cpf, phone });
  return {
    contacts: records.contacts.map((contact) => ({ id: contact.id, name: contact.name || null })),
    counts: {
      contacts: records.contactIds.length,
      chats: records.chatIds.length,
      chatMessages: await countByChatIds('chatMessages', tenantId, records.chatIds),
      chatEvents: await countByChatIds('chatEvents', tenantId, records.chatIds)
    }
  };
};

export const eraseDataSubject = async ({ tenantId, cpf = '', phone = '' }) => {
  const { chatIds, contactIds } = await findDataSubjectRecords({ tenantId, cpf, phone });
  const collection = (name) => adapter.db.collection(name);
  const removed = async (name, filter) => ((await collection(name).deleteMany(filter)).deletedCount || 0);

  const deleted = { chats: 0, chatEvents: 0, chatMessages: 0, messageClassifications: 0, outreachCampaignItems: 0, outreachHistory: 0, suppressions: 0, contacts: 0 };

  if (chatIds.length) {
    deleted.chatEvents = await removed('chatEvents', { tenantId, chatId: { $in: chatIds } });
    deleted.chatMessages = await removed('chatMessages', { tenantId, chatId: { $in: chatIds } });
    deleted.chats = await removed('activeChats', { tenantId, id: { $in: chatIds } });
  }

  const related = [
    ...(chatIds.length ? [{ chatId: { $in: chatIds } }] : []),
    ...(contactIds.length ? [{ contactId: { $in: contactIds } }] : [])
  ];
  if (related.length) {
    const relatedQuery = { tenantId, $or: related };
    deleted.messageClassifications = await removed('messageClassifications', relatedQuery);
    deleted.outreachCampaignItems = await removed('outreachCampaignItems', relatedQuery);
    deleted.outreachHistory = await removed('contactOutreachHistory', relatedQuery);
  }
  if (contactIds.length) {
    deleted.suppressions = await removed('contactSuppression', { tenantId, contactId: { $in: contactIds } });
    deleted.contacts = await removed('contacts', { tenantId, id: { $in: contactIds } });
  }

  return deleted;
};
