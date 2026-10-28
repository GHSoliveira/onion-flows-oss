export const resolveAllowedMediaUrl = (value, { apiBase = '', backendOrigin = '' } = {}) => {
  const source = String(value || '').trim();
  if (!source) return '';

  if (/^https?:\/\//i.test(source)) {
    try {
      const parsed = new URL(source);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
      return '';
    }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('//')) return '';

  const base = source.startsWith('/uploads/')
    ? (backendOrigin || apiBase)
    : apiBase;
  return `${base}${source.startsWith('/') ? source : `/${source}`}`;
};
