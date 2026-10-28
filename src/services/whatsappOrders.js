/**
 * Pedidos enviados pelo carrinho nativo do WhatsApp (mensagem `type: "order"`).
 *
 * Antes deste modulo o webhook descartava o pedido em silencio: o parser so
 * conhecia texto, botao, interativo e midia, e todo o resto caia num `return`.
 * O cliente achava que tinha comprado e nada chegava ao atendente.
 *
 * O pedido e gravado no MESMO formato do cartNode (CARRINHO_ITENS, TOTAL,
 * QUANTIDADE, RESUMO...), para o resto do fluxo nao precisar saber se o carrinho
 * foi montado pelo bot ou pelo catalogo do WhatsApp.
 *
 * UNIDADE DO PRECO
 * A referencia da Meta descreve `item_price` sem declarar a unidade. Os exemplos
 * oficiais (30, 25) indicam valor na moeda, nao em centavos, e e assim que ele e
 * lido aqui. O valor cru fica em `precoInformado` para conferir no primeiro
 * pedido real e corrigir sem perder o dado original.
 */
import { CART_DEFAULT_OUTPUTS, formatCartSummary } from './cartRuntime.js';

const texto = (valor) => String(valor ?? '').trim();

const numero = (valor) => {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : NaN;
  const normalizado = texto(valor).replace(',', '.');
  if (!normalizado) return NaN;
  const convertido = Number(normalizado);
  return Number.isFinite(convertido) ? convertido : NaN;
};

const arredondar = (valor) => Math.round((Number(valor) + Number.EPSILON) * 100) / 100;

/**
 * Le o objeto `order` cru do webhook. Devolve null quando nao sobra nenhum item
 * aproveitavel: pedido vazio nao deve virar mensagem no chat.
 */
export const extractWhatsAppOrder = (rawOrder) => {
  if (!rawOrder || typeof rawOrder !== 'object') return null;

  const itens = (Array.isArray(rawOrder.product_items) ? rawOrder.product_items : [])
    .map((item) => {
      const retailerId = texto(item?.product_retailer_id);
      const quantidade = numero(item?.quantity);
      const preco = numero(item?.item_price);
      if (!retailerId || !Number.isFinite(quantidade) || quantidade <= 0) return null;
      return {
        retailerId,
        quantidade,
        precoUnitario: Number.isFinite(preco) && preco >= 0 ? arredondar(preco) : null,
        precoInformado: item?.item_price ?? null,
        moeda: texto(item?.currency).toUpperCase() || null
      };
    })
    .filter(Boolean);

  if (!itens.length) return null;
  return {
    catalogId: texto(rawOrder.catalog_id) || null,
    observacao: texto(rawOrder.text) || null,
    itens
  };
};

/**
 * Indexa o catalogo interno pelas chaves que podem aparecer como retailer_id.
 * Tres passadas em ordem de confianca: primeiro o `metaProductRetailerId` que a
 * sincronizacao gravou, depois sku, depois id. Assim um sku de um item nunca
 * toma o lugar do retailer_id oficial de outro.
 */
const indexarCatalogo = (catalogItems) => {
  const lista = Array.isArray(catalogItems) ? catalogItems : [];
  const indice = new Map();
  for (const campo of ['metaProductRetailerId', 'sku', 'id']) {
    for (const item of lista) {
      const chave = texto(item?.[campo]).toLowerCase();
      if (chave && !indice.has(chave)) indice.set(chave, item);
    }
  }
  return indice;
};

/**
 * Monta o carrinho a partir do pedido. O pedido do WhatsApp e um carrinho
 * completo, entao ele SUBSTITUI o carrinho atual em vez de somar a ele.
 *
 * Item sem correspondencia no catalogo interno (criado direto no Commerce
 * Manager, por exemplo) continua valendo, com o retailer_id como nome.
 * Item sem preco em lugar nenhum sai do total, mas continua no texto da
 * mensagem, para o atendente ver que ele foi pedido.
 */
export const buildOrderCart = (order, catalogItems = [], outputs = CART_DEFAULT_OUTPUTS) => {
  const indice = indexarCatalogo(catalogItems);
  const moeda = order?.itens?.find((item) => item.moeda)?.moeda || 'BRL';
  const itensCarrinho = [];
  const semPreco = [];
  const itensMeta = [];

  for (const item of order?.itens || []) {
    const interno = indice.get(item.retailerId.toLowerCase()) || null;
    const precoCatalogo = numero(interno?.price);
    const preco = item.precoUnitario ?? (Number.isFinite(precoCatalogo) && precoCatalogo >= 0 ? arredondar(precoCatalogo) : null);
    const nome = texto(interno?.name) || item.retailerId;

    itensMeta.push({ ...item, nome, catalogItemId: texto(interno?.id) || null });

    if (preco === null) {
      semPreco.push(`${item.quantidade}x ${nome}`);
      continue;
    }
    itensCarrinho.push({
      id: texto(interno?.id) || item.retailerId,
      nome,
      quantidade: item.quantidade,
      precoUnitario: preco,
      subtotal: arredondar(item.quantidade * preco),
      sku: item.retailerId
    });
  }

  const total = arredondar(itensCarrinho.reduce((soma, item) => soma + item.subtotal, 0));
  const quantidade = itensCarrinho.reduce((soma, item) => soma + item.quantidade, 0);
  const resumo = formatCartSummary(itensCarrinho, moeda);

  const linhas = ['Pedido pelo catálogo do WhatsApp:'];
  if (resumo) linhas.push(resumo);
  if (semPreco.length) linhas.push(`Sem preço informado: ${semPreco.join(', ')}`);
  if (order?.observacao) linhas.push(`Observação: ${order.observacao}`);

  const erro = semPreco.length ? `Itens sem preço: ${semPreco.join(', ')}` : null;

  return {
    texto: linhas.join('\n'),
    total,
    moeda,
    itens: itensCarrinho,
    semPreco,
    vars: {
      [outputs.itemsVar]: itensCarrinho,
      [outputs.totalVar]: total,
      [outputs.itemCountVar]: quantidade,
      [outputs.summaryVar]: resumo,
      [outputs.okVar]: itensCarrinho.length > 0 && semPreco.length === 0,
      [outputs.errorVar]: erro,
      CARRINHO_OBSERVACAO: order?.observacao || null,
      // Permite ao fluxo distinguir carrinho montado no bot de pedido do catalogo.
      CARRINHO_ORIGEM: 'whatsapp_catalogo'
    },
    meta: {
      whatsappOrder: {
        catalogId: order?.catalogId || null,
        observacao: order?.observacao || null,
        moeda,
        total,
        itens: itensMeta
      }
    }
  };
};
