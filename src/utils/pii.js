/**
 * PII masking utilities.
 *
 * Applied before persisting payloads that may travel outside the request
 * scope — primarily system logs, but reusable for analytics exports and
 * audit trails. The goal is to keep enough signal for debugging (last digits
 * of phone, partial e-mail) while removing identifiable strings.
 *
 * Masking strategy by field type:
 *   - CPF (11 digits, BR): show last 2 → "***.***.***-04"
 *   - Phone (≥10 digits): show last 4 → "+5511*****1234"
 *   - Email: show first char + domain → "j***@example.com"
 *   - Tokens/secrets/passwords: full replacement → "***"
 *   - Free-text names (customerName etc): first char + tail → "J*** A***"
 *
 * Keys are matched case-insensitively against known sensitive names. Unknown
 * keys are left untouched. Object traversal is bounded to depth 8 to refuse
 * pathological nesting.
 */

const TOKEN_FIELDS = new Set([
  'password',
  'token',
  'accesstoken',
  'access_token',
  'bottoken',
  'webhookverifytoken',
  'apikey',
  'api_key',
  'secret',
  'authorization'
]);

const CPF_FIELDS = new Set([
  'cpf',
  'customercpf',
  'document',
  'cpfcnpj'
]);

const PHONE_FIELDS = new Set([
  'phone',
  'customerphone',
  'channeluserid',
  'channelchatid',
  'whatsappphonenumberid',
  'normalizednumber',
  'normalizedprimaryphone',
  'waid',
  'to',
  'from'
]);

const EMAIL_FIELDS = new Set([
  'email',
  'customeremail',
  'representativeemail'
]);

const NAME_FIELDS = new Set([
  'customername',
  'representative',
  'contactname'
]);

const isPlainObject = (value) => (
  typeof value === 'object'
  && value !== null
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const onlyDigits = (value) => String(value).replace(/\D/g, '');

const maskCpf = (value) => {
  const digits = onlyDigits(value);
  if (digits.length < 4) return '***';
  const tail = digits.slice(-2);
  return `***.***.***-${tail}`;
};

const maskPhone = (value) => {
  const raw = String(value);
  const digits = onlyDigits(raw);
  if (digits.length < 4) return '***';
  const tail = digits.slice(-4);
  return `${raw.startsWith('+') ? '+' : ''}*****${tail}`;
};

const maskEmail = (value) => {
  const text = String(value);
  const at = text.indexOf('@');
  if (at <= 0) return '***';
  const head = text.slice(0, at);
  const domain = text.slice(at + 1);
  return `${head[0]}***@${domain}`;
};

const maskToken = () => '***';

const maskName = (value) => {
  const text = String(value).trim();
  if (!text) return '***';
  return text
    .split(/\s+/)
    .map((part) => `${part[0]}***`)
    .join(' ');
};

const pickMasker = (lowerKey) => {
  if (TOKEN_FIELDS.has(lowerKey)) return maskToken;
  if (CPF_FIELDS.has(lowerKey)) return maskCpf;
  if (PHONE_FIELDS.has(lowerKey)) return maskPhone;
  if (EMAIL_FIELDS.has(lowerKey)) return maskEmail;
  if (NAME_FIELDS.has(lowerKey)) return maskName;
  return null;
};

export const maskPII = (input, depth = 0) => {
  if (depth > 8) return '[depth_exceeded]';
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((item) => maskPII(item, depth + 1));
  if (!isPlainObject(input)) return input;

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const masker = pickMasker(String(key).toLowerCase());
    if (masker && (typeof value === 'string' || typeof value === 'number')) {
      out[key] = value === null || value === undefined || value === '' ? value : masker(value);
    } else if (isPlainObject(value) || Array.isArray(value)) {
      out[key] = maskPII(value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
};

// Convenience helpers for ad-hoc masking outside structured payloads.
export const mask = {
  cpf: maskCpf,
  phone: maskPhone,
  email: maskEmail,
  token: maskToken,
  name: maskName
};
