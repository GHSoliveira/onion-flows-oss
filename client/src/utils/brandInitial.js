// Marca de agencia sem logo: a inicial do nome num quadrado na cor da marca,
// no lugar da cebola da Onion (logo do menu e icone da aba).

export const brandInitial = (name) => {
  const letra = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[A-Za-z0-9]/);
  return letra ? letra[0].toUpperCase() : '•';
};

// Clara demais para letra branca? (luminancia relativa simples)
export const isLightColor = (hex) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const seis = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const n = parseInt(seis, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.7;
};

export const initialColors = (fundo, destaque) => {
  const bg = fundo || destaque || '#155DFC';
  return { bg, fg: isLightColor(bg) ? (destaque && !isLightColor(destaque) ? destaque : '#0F172A') : '#FFFFFF' };
};

// SVG em data URL para o icone da aba.
export const initialFaviconUrl = (name, color) => {
  const { bg, fg } = initialColors(color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bg}"/><text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="700" fill="${fg}">${brandInitial(name)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
