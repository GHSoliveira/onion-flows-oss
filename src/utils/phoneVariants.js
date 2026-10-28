/**
 * Formas equivalentes de um mesmo telefone.
 *
 * O mesmo numero aparece gravado de jeitos diferentes: a Meta manda o wa_id
 * (que no Brasil costuma vir sem o nono digito), o contato foi salvo como a
 * pessoa digitou, e o titular informa de outra forma ainda. Comparar por
 * igualdade exata faz o contato salvo nunca casar com a conversa.
 *
 * Vive em utils porque e usado tanto pela identificacao de contato quanto pela
 * busca de titular da LGPD.
 */

export const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

const addBrazilianForms = (set, withCountry) => {
  set.add(withCountry);
  // Com e sem o nono digito de celular. Fixo (comeca com 2-5) nao tem nono digito.
  if (withCountry.length === 13 && withCountry[4] === '9') {
    set.add(`${withCountry.slice(0, 4)}${withCountry.slice(5)}`);
  }
  if (withCountry.length === 12 && /[6-9]/.test(withCountry[4])) {
    set.add(`${withCountry.slice(0, 4)}9${withCountry.slice(4)}`);
  }
};

export const buildPhoneVariants = (rawPhone) => {
  const digits = digitsOf(rawPhone);
  if (digits.length < 8) return [];
  const variants = new Set([digits]);

  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    addBrazilianForms(variants, digits);
  }
  // Brasileiro sem DDI: 10 digitos, ou 11 com o 9 de celular na terceira posicao.
  if (digits.length === 10 || (digits.length === 11 && digits[2] === '9')) {
    addBrazilianForms(variants, `55${digits}`);
  }
  // Numero estrangeiro de 11 digitos (ex.: +1) que a regra antiga gravou como
  // 55+numero. Um numero brasileiro valido nunca fica com essa forma.
  if (digits.length === 11 && digits[2] !== '9') {
    variants.add(`55${digits}`);
  }
  if (digits.length === 13 && digits.startsWith('55') && digits[4] !== '9') {
    variants.add(digits.slice(2));
  }
  // Formas locais (sem 55) dos numeros brasileiros encontrados.
  for (const value of [...variants]) {
    if (value.startsWith('55') && (value.length === 12 || (value.length === 13 && value[4] === '9'))) {
      variants.add(value.slice(2));
    }
  }
  return [...variants];
};

// Todos os digitos de telefone que um contato carrega, em qualquer campo.
export const contactPhoneDigits = (contact) => [
  contact?.normalizedPrimaryPhone,
  contact?.primaryPhone,
  contact?.primaryIdentifier,
  ...(Array.isArray(contact?.phones) ? contact.phones : [])
    .flatMap((phone) => [phone?.normalizedNumber, phone?.number, phone?.waId]),
  ...(Array.isArray(contact?.channelIdentities) ? contact.channelIdentities : [])
    .filter((identity) => !identity?.channel || identity.channel === 'whatsapp')
    .flatMap((identity) => [identity?.normalizedIdentifier, identity?.identifier, identity?.channelMeta?.waId])
].map(digitsOf).filter(Boolean);

// Um telefone bate com o contato quando algum telefone do contato aparece entre
// as formas do numero procurado. Nao precisa expandir os dois lados: a lista de
// variacoes ja cobre os dois sentidos.
export const contactMatchesPhone = (contact, rawPhone) => {
  const procurado = new Set(buildPhoneVariants(rawPhone));
  if (!procurado.size) return false;
  return contactPhoneDigits(contact).some((digits) => procurado.has(digits));
};
