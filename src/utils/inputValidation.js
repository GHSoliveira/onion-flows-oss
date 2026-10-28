import vm from 'node:vm';

export const INPUT_VALIDATION_TYPES = new Set([
  'none',
  'email',
  'phone',
  'cpf',
  'cnpj',
  'number',
  'date',
  'regex'
]);

const MAX_REGEX_PATTERN_LENGTH = 200;
const MAX_REGEX_INPUT_LENGTH = 1000;
const REGEX_TIMEOUT_MS = 25;

const onlyDigits = (value) => String(value ?? '').replace(/\D/g, '');

const hasRepeatedDigits = (value) => /^(\d)\1+$/.test(value);

const calculateCheckDigit = (digits, weights) => {
  const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
};

const isValidCpf = (digits) => {
  if (digits.length !== 11 || hasRepeatedDigits(digits)) return false;
  const first = calculateCheckDigit(digits, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calculateCheckDigit(digits, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return Number(digits[9]) === first && Number(digits[10]) === second;
};

const isValidCnpj = (digits) => {
  if (digits.length !== 14 || hasRepeatedDigits(digits)) return false;
  const first = calculateCheckDigit(digits, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const second = calculateCheckDigit(digits, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return Number(digits[12]) === first && Number(digits[13]) === second;
};

const normalizeDate = (value) => {
  const text = String(value ?? '').trim();
  let year;
  let month;
  let day;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const brMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (isoMatch) {
    [, year, month, day] = isoMatch;
  } else if (brMatch) {
    [, day, month, year] = brMatch;
  } else {
    return null;
  }

  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
  ) {
    return null;
  }

  return `${year}-${month}-${day}`;
};

const testRegexWithTimeout = (pattern, input) => {
  if (!pattern || pattern.length > MAX_REGEX_PATTERN_LENGTH || input.length > MAX_REGEX_INPUT_LENGTH) {
    return false;
  }

  try {
    const context = vm.createContext({ input });
    const script = new vm.Script(`new RegExp(${JSON.stringify(pattern)}).test(input)`);
    return script.runInContext(context, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch {
    return false;
  }
};

export const normalizeValidationType = (value) => {
  const normalized = String(value || 'none').trim().toLowerCase();
  return INPUT_VALIDATION_TYPES.has(normalized) ? normalized : 'none';
};

export const validateInputValue = ({ value, validationType, validationPattern } = {}) => {
  const type = normalizeValidationType(validationType);
  if (type === 'none') {
    return { valid: true, value, type };
  }

  const text = String(value ?? '').trim();
  if (type === 'email') {
    const valid = text.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    return { valid, value: text, type };
  }

  if (type === 'phone') {
    const digits = onlyDigits(text);
    return { valid: digits.length >= 10 && digits.length <= 15, value: digits, type };
  }

  if (type === 'cpf') {
    const digits = onlyDigits(text);
    return { valid: isValidCpf(digits), value: digits, type };
  }

  if (type === 'cnpj') {
    const digits = onlyDigits(text);
    return { valid: isValidCnpj(digits), value: digits, type };
  }

  if (type === 'number') {
    const normalized = text.replace(',', '.');
    const valid = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized);
    return { valid, value: valid ? Number(normalized) : text, type };
  }

  if (type === 'date') {
    const normalized = normalizeDate(text);
    return { valid: Boolean(normalized), value: normalized || text, type };
  }

  const pattern = String(validationPattern || '');
  return {
    valid: testRegexWithTimeout(pattern, text),
    value: text,
    type
  };
};

