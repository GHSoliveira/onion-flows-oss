const DEFAULT_OUTPUTS = Object.freeze({
  itemsVar: 'CARRINHO_ITENS',
  totalVar: 'CARRINHO_TOTAL',
  itemCountVar: 'CARRINHO_QUANTIDADE',
  summaryVar: 'CARRINHO_RESUMO',
  okVar: 'CARRINHO_OK',
  errorVar: 'CARRINHO_ERRO'
});

const cleanName = (value, fallback) => String(value || fallback || '').trim();

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const parseNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const text = String(value ?? '').trim();
  if (!text) return NaN;
  const normalized = text.includes(',')
    ? text.replace(/\./g, '').replace(',', '.')
    : text;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : NaN;
};

const normalizeKey = (value) => String(value ?? '')
  .trim()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const readItems = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeExistingItem = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const quantity = parseNumber(item.quantidade ?? item.quantity ?? item.qtd);
  const unitPrice = parseNumber(item.precoUnitario ?? item.unitPrice ?? item.preco);
  const name = cleanName(item.nome ?? item.name ?? item.pedido ?? item.item);
  const id = cleanName(item.id ?? item.productId ?? item.sku, name);
  if (!name || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice) || unitPrice < 0) return null;
  return {
    id,
    nome: name,
    quantidade: quantity,
    precoUnitario: roundMoney(unitPrice),
    subtotal: roundMoney(quantity * unitPrice),
    ...(cleanName(item.sku) ? { sku: cleanName(item.sku) } : {})
  };
};

const getOutputNames = (data = {}) => Object.fromEntries(
  Object.entries(DEFAULT_OUTPUTS).map(([key, fallback]) => [key, cleanName(data[key], fallback)])
);

const formatCurrency = (value, currency = 'BRL') => {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value);
  } catch {
    return `R$ ${roundMoney(value).toFixed(2).replace('.', ',')}`;
  }
};

export const formatCartSummary = (items, currency = 'BRL') => {
  const safeItems = Array.isArray(items) ? items : [];
  if (!safeItems.length) return '';
  const lines = safeItems.map((item) => (
    `${item.quantidade}x ${item.nome} - ${formatCurrency(item.subtotal, currency)}`
  ));
  const total = safeItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0);
  return `${lines.join('\n')}\nTotal: ${formatCurrency(total, currency)}`;
};

const writeCart = (vars, data, items, ok = true, error = null) => {
  const names = getOutputNames(data);
  const normalizedItems = items.map(normalizeExistingItem).filter(Boolean);
  const total = roundMoney(normalizedItems.reduce((sum, item) => sum + item.subtotal, 0));
  const itemCount = normalizedItems.reduce((sum, item) => sum + item.quantidade, 0);
  return {
    ...vars,
    [names.itemsVar]: normalizedItems,
    [names.totalVar]: total,
    [names.itemCountVar]: itemCount,
    [names.summaryVar]: formatCartSummary(normalizedItems, cleanName(data.currency, 'BRL')),
    [names.okVar]: ok,
    [names.errorVar]: error
  };
};

const resolvePriceEntry = (data, productId, productName) => {
  const entries = Array.isArray(data.priceMap) ? data.priceMap : [];
  const idKey = normalizeKey(productId);
  const nameKey = normalizeKey(productName);
  return entries.find((entry) => idKey && normalizeKey(entry?.id) === idKey)
    || entries.find((entry) => nameKey && normalizeKey(entry?.name) === nameKey)
    || null;
};

export const applyCartOperation = (currentVars = {}, data = {}) => {
  const vars = currentVars && typeof currentVars === 'object' ? currentVars : {};
  const names = getOutputNames(data);
  const operation = cleanName(data.operation, 'add').toLowerCase();
  const currentItems = readItems(vars[names.itemsVar]).map(normalizeExistingItem).filter(Boolean);

  if (operation === 'clear') {
    return writeCart(vars, data, [], true, null);
  }

  if (operation !== 'add') {
    return writeCart(vars, data, currentItems, false, `Operacao de carrinho desconhecida: ${operation}`);
  }

  const productIdVar = cleanName(data.productIdVar, 'PEDIDO_ID');
  const productNameVar = cleanName(data.productNameVar, 'PEDIDO');
  const quantityVar = cleanName(data.quantityVar, 'QUANTIDADE');
  const productId = cleanName(vars[productIdVar]);
  let productName = cleanName(vars[productNameVar]);
  const quantity = parseNumber(vars[quantityVar]);

  if (!productId && !productName) {
    return writeCart(vars, data, currentItems, false, 'Produto nao informado.');
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return writeCart(vars, data, currentItems, false, 'Quantidade deve ser maior que zero.');
  }

  const priceSource = cleanName(data.priceSource, 'map').toLowerCase();
  let entry = null;
  let unitPrice;
  if (priceSource === 'variable') {
    unitPrice = parseNumber(vars[cleanName(data.unitPriceVar, 'PRODUTO_PRECO')]);
  } else {
    entry = resolvePriceEntry(data, productId, productName);
    unitPrice = parseNumber(entry?.unitPrice);
    productName = cleanName(entry?.name, productName || productId);
  }

  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    return writeCart(vars, data, currentItems, false, 'Preco do produto nao encontrado ou invalido.');
  }

  const resolvedId = cleanName(entry?.id, productId || productName);
  const sku = cleanName(entry?.sku);
  const itemKey = normalizeKey(sku || resolvedId || productName);
  const nextItems = currentItems.map((item) => ({ ...item }));
  const existingIndex = data.mergeDuplicates === false
    ? -1
    : nextItems.findIndex((item) => normalizeKey(item.sku || item.id || item.nome) === itemKey);

  if (existingIndex >= 0) {
    const nextQuantity = nextItems[existingIndex].quantidade + quantity;
    nextItems[existingIndex] = {
      ...nextItems[existingIndex],
      nome: productName,
      quantidade: nextQuantity,
      precoUnitario: roundMoney(unitPrice),
      subtotal: roundMoney(nextQuantity * unitPrice),
      ...(sku ? { sku } : {})
    };
  } else {
    nextItems.push({
      id: resolvedId,
      nome: productName || resolvedId,
      quantidade: quantity,
      precoUnitario: roundMoney(unitPrice),
      subtotal: roundMoney(quantity * unitPrice),
      ...(sku ? { sku } : {})
    });
  }

  return writeCart(vars, data, nextItems, true, null);
};

export const CART_DEFAULT_OUTPUTS = DEFAULT_OUTPUTS;
