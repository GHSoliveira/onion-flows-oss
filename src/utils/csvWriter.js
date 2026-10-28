const normalizeCell = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

const escapeCell = (value) => {
  const text = normalizeCell(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

export const toCsv = (columns = [], rows = []) => {
  const safeColumns = Array.isArray(columns) ? columns : [];
  const header = safeColumns.map((column) => escapeCell(column.label || column.key)).join(',');
  const body = (Array.isArray(rows) ? rows : []).map((row) => (
    safeColumns.map((column) => escapeCell(row?.[column.key])).join(',')
  ));
  return `\uFEFF${[header, ...body].join('\r\n')}\r\n`;
};

export const rowsFromObjects = (rows = []) => {
  const keys = [...new Set((Array.isArray(rows) ? rows : []).flatMap((row) => Object.keys(row || {})))];
  return {
    columns: keys.map((key) => ({ key, label: key })),
    rows
  };
};
