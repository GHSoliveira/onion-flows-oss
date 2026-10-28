/**
 * Upsert silencioso de identidade de contato a partir de webhook de canal.
 *
 * Chamado pelos handlers de WhatsApp/Telegram/Instagram quando uma mensagem
 * chega. Procura um contato existente naquele tenant que já tenha a identity
 * `(channel, normalizedIdentifier)`. Se achar, atualiza `channelDisplayName`
 * com o nome novo (se diferente) e `lastSeenAt`. Se não achar, cria um
 * contato mínimo com a identity como primária e `channelDisplayName` já
 * preenchido.
 *
 * Política: agentDefinedName nunca é tocado pelo provedor. Mudança de nome
 * no canal só atualiza channelDisplayName + timestamp. Falhas são best-effort
 * (log no console) — nunca propagam para o handler que está processando a
 * mensagem do cliente.
 */
import adapter from '../../db/DatabaseAdapter.js';
import {
  buildIdentity,
  normalizeIdentifier,
  normalizeIdentities,
  identitiesFromLegacyPhones,
  phonesFromIdentities,
  getContactDisplayName
} from '../utils/channelIdentity.js';
import { generateId } from '../utils/helpers.js';
import { contactMatchesPhone } from '../utils/phoneVariants.js';

const nowIso = () => new Date().toISOString();

const ensureCollection = async () => {
  if (!adapter.db) await adapter.init();
  return adapter.db.collection('contacts');
};

/**
 * Procura contato pelo identifier canônico. Retorna `null` quando não existe.
 */
const isPhoneChannel = (channel) => ['whatsapp', 'phone'].includes(String(channel || '').toLowerCase());

export const findContactByIdentity = async ({ tenantId, channel, identifier }) => {
  if (!tenantId || !channel || !identifier) return null;
  const normalized = normalizeIdentifier(channel, identifier);
  if (!normalized) return null;
  const collection = await ensureCollection();

  const exato = await collection.findOne(
    {
      tenantId,
      channelIdentities: {
        $elemMatch: { channel: String(channel).toLowerCase(), normalizedIdentifier: normalized }
      }
    },
    { projection: { _id: 0 } }
  );
  if (exato || !isPhoneChannel(channel)) return exato || null;

  // O wa_id da Meta costuma vir sem o nono digito e o contato foi salvo com ele
  // (ou o contrario). Antes de dizer que o contato nao existe, compara todas as
  // formas do numero.
  const contatos = await adapter.findDocuments('contacts', { tenantId });
  return contatos.find((contato) => contactMatchesPhone(contato, normalized)) || null;
};

/**
 * Preenche `customerName` nas conversas a partir do contato salvo, para as
 * telas nao mostrarem "Cliente nao identificado" quando o contato existe.
 */
export const attachContactNames = async (tenantId, chats) => {
  const lista = Array.isArray(chats) ? chats : [chats];
  const semNome = lista.filter((chat) => chat && chat.channelUserId && !String(chat.customerName || '').trim());
  if (!tenantId || !semNome.length) return chats;

  const contatos = await adapter.findDocuments('contacts', { tenantId });
  if (!contatos.length) return chats;

  for (const chat of semNome) {
    const contato = contatos.find((item) => contactMatchesPhone(item, chat.channelUserId));
    if (!contato) continue;
    const nome = getContactDisplayName(contato);
    if (!nome || nome === 'Visitante') continue;
    chat.customerName = nome;
    if (!chat.contactId) chat.contactId = contato.id;
  }
  return chats;
};

/**
 * Upsert silencioso. Cria contato se não existir, atualiza display name e
 * lastSeenAt se já existir. Retorna `{ contact, created, displayNameChanged }`.
 */
export const upsertContactFromChannel = async ({
  tenantId,
  channel,
  rawIdentifier,
  channelDisplayName = null,
  handle = null,
  channelMeta = {}
}) => {
  if (!tenantId) return null;
  const normalized = normalizeIdentifier(channel, rawIdentifier);
  if (!normalized) return null;

  try {
    const collection = await ensureCollection();
    const existing = await findContactByIdentity({ tenantId, channel, identifier: rawIdentifier });

    if (existing) {
      const identities = Array.isArray(existing.channelIdentities) && existing.channelIdentities.length
        ? existing.channelIdentities
        : identitiesFromLegacyPhones(existing.phones || []);
      let target = identities.find(
        (entry) => entry.channel === String(channel).toLowerCase()
          && entry.normalizedIdentifier === normalized
      );
      // Contato encontrado por variacao do numero: guarda tambem a forma que o
      // canal usa, para a proxima busca bater direto.
      if (!target) {
        const novaIdentidade = buildIdentity({
          channel,
          rawIdentifier,
          handle,
          displayName: channelDisplayName,
          channelMeta,
          isPrimary: false
        });
        if (novaIdentidade) {
          identities.push(novaIdentidade);
          target = novaIdentidade;
        }
      }
      let displayNameChanged = false;
      if (target) {
        target.lastSeenAt = nowIso();
        if (handle && !target.handle) target.handle = handle;
        if (channelMeta) target.channelMeta = { ...(target.channelMeta || {}), ...channelMeta };
        if (channelDisplayName && channelDisplayName !== target.channelDisplayName) {
          target.channelDisplayName = channelDisplayName;
          target.channelDisplayNameAt = nowIso();
          displayNameChanged = true;
        }
      }
      const normalizedList = normalizeIdentities(identities);
      const phones = phonesFromIdentities(normalizedList);
      const update = {
        channelIdentities: normalizedList,
        phones,
        updatedAt: nowIso()
      };
      if (!existing.agentDefinedName && existing.name) {
        update.agentDefinedName = existing.name;
      }
      await collection.updateOne({ id: existing.id }, { $set: update });
      return { contact: { ...existing, ...update }, created: false, displayNameChanged };
    }

    // Cria contato mínimo
    const identity = buildIdentity({
      channel,
      rawIdentifier,
      handle,
      displayName: channelDisplayName,
      channelMeta,
      isPrimary: true
    });
    if (!identity) return null;
    const identities = [identity];
    const phones = phonesFromIdentities(identities);
    const stub = {
      id: generateId('contact'),
      tenantId,
      agentDefinedName: null,
      name: getContactDisplayName({ channelIdentities: identities }),
      company: null,
      email: null,
      notes: null,
      tags: [],
      phones,
      channelIdentities: identities,
      primaryChannel: identity.channel,
      primaryIdentifier: identity.identifier,
      primaryPhone: phones[0]?.number || null,
      normalizedPrimaryPhone: phones[0]?.normalizedNumber || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      createdBy: 'channel',
      autoCreated: true
    };
    await collection.insertOne(stub);
    return { contact: stub, created: true, displayNameChanged: false };
  } catch (error) {
    console.warn('[CONTACT_IDENTITY] Upsert falhou:', error?.message || error);
    return null;
  }
};
