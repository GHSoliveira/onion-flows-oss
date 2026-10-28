export const envFlag = (name, defaultValue = false) => {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
};

export const envInt = (name, defaultValue, { min = null, max = null } = {}) => {
  const parsed = Number.parseInt(String(process.env[name] || '').trim(), 10);
  let value = Number.isFinite(parsed) ? parsed : defaultValue;
  if (Number.isFinite(min)) value = Math.max(value, min);
  if (Number.isFinite(max)) value = Math.min(value, max);
  return value;
};
