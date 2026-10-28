/**
 * Helpers para identidades de contato por canal.
 *
 * Suporta múltiplos canais com identificadores heterogêneos: WhatsApp e Phone
 * usam telefone E.164 sem `+`, Telegram usa o user id numérico interno (não
 * o @username, que muda), Instagram usa o scoped ID da página + o handle
 * opcional, Email usa o endereço.
 *
 * Para evitar colisão (ex: número de WhatsApp 5511… vs telegram user id 5511…)
 * o `identifier` canônico SEMPRE carrega um prefixo de canal — exceto
 * WhatsApp/Phone que mantêm formato puro por compatibilidade com o resto
 * do sistema (channelUserId, normalizedNumber etc).
 *
 * Modelo de uma identity:
 *   {
 *     id, channel, identifier (canônico),
 *     normalizedIdentifier (lowercase / digits-only para match),
 *     displayValue (humano), handle (@username quando aplicável),
 *     channelDisplayName (veio do canal), channelDisplayNameAt,
 *     channelMeta (objeto por canal), label, isPrimary,
 *     optedIn, firstSeenAt, lastSeenAt
 *   }
 */
import { generateId } from './helpers.js';

export const SUPPORTED_CHANNELS = ['whatsapp', 'telegram', 'instagram', 'email', 'phone'];

const onlyDigits = (value) => String(value || '').replace(/\D/g, '');
const toLower = (value) => String(value || '').trim().toLowerCase();

const stripPrefix = (value, prefix) => {
  const text = String(value || '');
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
};

/**
 * Normaliza um identificador por canal. Retorna `null` quando inválido.
 *  - whatsapp/phone: dígitos somente (E.164 sem +)
 *  - telegram: `tg:<numeric_user_id>` — aceita já com prefixo ou sem
 *  - instagram: `ig:<scoped_id_or_handle>` — lower, sem @
 *  - email: lower-cased; valida que tem @ e ponto
 */
export const normalizeIdentifier = (channel, raw) => {
  const ch = toLower(channel);
  const value = String(raw || '').trim();
  if (!value) return null;

  if (ch === 'whatsapp' || ch === 'phone') {
    const digits = onlyDigits(value);
    if (digits.length < 6) return null;
    return digits;
  }
  if (ch === 'telegram') {
    const cleaned = stripPrefix(value, 'tg:').replace(/^@/, '');
    const digits = onlyDigits(cleaned);
    if (!digits) return null;
    return `tg:${digits}`;
  }
  if (ch === 'instagram') {
    const cleaned = toLower(stripPrefix(value, 'ig:').replace(/^@/, ''));
    if (!cleaned) return null;
    return `ig:${cleaned}`;
  }
  if (ch === 'email') {
    const lowered = toLower(value);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lowered)) return null;
    return lowered;
  }
  return null;
};

/**
 * Formato humano para exibição na UI.
 */
export const displayIdentifier = (channel, identifier) => {
  const ch = toLower(channel);
  if (!identifier) return '';
  if (ch === 'whatsapp' || ch === 'phone') {
    const digits = onlyDigits(identifier);
    if (digits.length === 13 && digits.startsWith('55')) {
      // +55 11 98765-4321
      return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
    }
    if (digits.length === 12 && digits.startsWith('55')) {
      return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
    }
    return `+${digits}`;
  }
  if (ch === 'telegram') {
    return `@${stripPrefix(identifier, 'tg:')}`;
  }
  if (ch === 'instagram') {
    return `@${stripPrefix(identifier, 'ig:')}`;
  }
  if (ch === 'email') {
    return identifier;
  }
  return identifier;
};

/**
 * Constrói uma identity completa a partir de input bruto. Útil ao receber
 * payload do formulário ou ao gerar identity automática quando o canal
 * envia primeira mensagem.
 */
export const buildIdentity = ({
  channel,
  rawIdentifier,
  handle = null,
  displayName = null,
  channelMeta = {},
  label = null,
  isPrimary = false,
  optedIn = true,
  existing = null
}) => {
  const normalized = normalizeIdentifier(channel, rawIdentifier);
  if (!normalized) return null;
  const now = new Date().toISOString();
  const display = displayIdentifier(channel, normalized);
  return {
    id: existing?.id || generateId('cid'),
    channel: toLower(channel),
    identifier: normalized,
    normalizedIdentifier: normalized,
    displayValue: display,
    handle: handle ? String(handle).trim() : null,
    channelDisplayName: displayName || existing?.channelDisplayName || null,
    channelDisplayNameAt: displayName ? now : (existing?.channelDisplayNameAt || null),
    channelMeta: { ...(existing?.channelMeta || {}), ...(channelMeta || {}) },
    label: label || existing?.label || null,
    isPrimary: Boolean(isPrimary || existing?.isPrimary),
    optedIn: optedIn !== false && existing?.optedIn !== false,
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now
  };
};

/**
 * Garante invariantes em uma lista de identities:
 *  - filtra entradas inválidas (sem normalizedIdentifier)
 *  - deduplica por (channel, normalizedIdentifier)
 *  - garante exatamente uma primária (a primeira marcada ou a primeira da lista)
 */
export const normalizeIdentities = (input = []) => {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (!item) continue;
    const normalized = normalizeIdentifier(item.channel, item.identifier || item.normalizedIdentifier);
    if (!normalized) continue;
    const key = `${toLower(item.channel)}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...item,
      channel: toLower(item.channel),
      identifier: normalized,
      normalizedIdentifier: normalized,
      displayValue: item.displayValue || displayIdentifier(item.channel, normalized),
      channelMeta: item.channelMeta || {},
      isPrimary: Boolean(item.isPrimary),
      optedIn: item.optedIn !== false
    });
  }
  if (!out.length) return out;
  const primaryIndex = out.findIndex((entry) => entry.isPrimary);
  const target = primaryIndex >= 0 ? primaryIndex : 0;
  out.forEach((entry, index) => {
    entry.isPrimary = index === target;
  });
  return out;
};

/**
 * Converte um array legacy `contact.phones[]` em `channelIdentities[]`.
 * Usado na migração on-read: contatos antigos ganham identities derivadas
 * automaticamente quando lidos.
 */
export const identitiesFromLegacyPhones = (phones = []) => {
  if (!Array.isArray(phones)) return [];
  return phones
    .map((phone) => {
      const channel = toLower(phone?.channel || 'whatsapp');
      const raw = phone?.normalizedNumber || phone?.number || '';
      const identity = buildIdentity({
        channel: channel === 'telegram' ? 'whatsapp' : channel, // legacy telegram salvava número
        rawIdentifier: raw,
        label: phone?.label || null,
        isPrimary: Boolean(phone?.isPrimary),
        channelMeta: phone?.waId ? { waId: phone.waId } : {}
      });
      if (!identity) return null;
      identity.id = phone?.id || identity.id;
      return identity;
    })
    .filter(Boolean);
};

/**
 * Espelho reverso: a partir das `channelIdentities`, regenera o array
 * `phones[]` legacy para clientes antigos não quebrarem. Filtra apenas
 * canais "telefônicos" (whatsapp e phone).
 */
export const phonesFromIdentities = (identities = []) => {
  if (!Array.isArray(identities)) return [];
  return identities
    .filter((id) => id?.channel === 'whatsapp' || id?.channel === 'phone')
    .map((id, index) => ({
      id: id.id,
      label: id.label || null,
      channel: id.channel,
      number: id.displayValue || `+${id.identifier}`,
      normalizedNumber: id.identifier,
      waId: id.channelMeta?.waId || null,
      isPrimary: index === 0 ? true : Boolean(id.isPrimary)
    }));
};

/**
 * Fallback chain para nome exibido. Sempre prefere o que o agente definiu;
 * se vazio, usa o display name do canal primário; depois o próprio
 * identificador; por último "Visitante".
 */
export const getContactDisplayName = (contact) => {
  if (!contact) return 'Visitante';
  const agent = String(contact.agentDefinedName || contact.name || '').trim();
  if (agent) return agent;
  const identities = Array.isArray(contact.channelIdentities) ? contact.channelIdentities : [];
  const primary = identities.find((id) => id?.isPrimary) || identities[0];
  if (primary?.channelDisplayName) return primary.channelDisplayName.trim();
  if (primary?.displayValue) return primary.displayValue;
  return 'Visitante';
};
