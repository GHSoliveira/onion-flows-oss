// Opcoes do node de menu: de onde vem (fixas ou de uma variavel), como vao
// para o cliente (botoes, lista ou texto numerado) e como a resposta e
// reconhecida. Funcoes puras; o flowRunner faz o envio e guarda o estado.

export const MAX_BUTTONS = 3;
export const MAX_LIST_ROWS = 10;
const BUTTON_TITLE_MAX = 20;
const ROW_TITLE_MAX = 24;
const ROW_DESCRIPTION_MAX = 72;
const BODY_MAX = 1024;

const cortar = (valor, max) => {
  const texto = String(valor ?? '').replace(/\s+/g, ' ').trim();
  return texto.length > max ? `${texto.slice(0, max - 1).trimEnd()}…` : texto;
};

const ler = (objeto, caminho) => {
  if (!caminho) return objeto;
  let valor = objeto;
  for (const chave of String(caminho).split(/[.[\]]/).filter(Boolean)) {
    if (valor === undefined || valor === null) return undefined;
    valor = valor[chave];
  }
  return valor;
};

export const isDynamicMenu = (data = {}) => data?.optionsSource === 'variable';

// Lista de itens guardada numa variavel (array, ou texto JSON de array).
const lerLista = (vars, caminho) => {
  let valor = ler(vars, caminho);
  if (typeof valor === 'string') {
    try {
      valor = JSON.parse(valor);
    } catch {
      return [];
    }
  }
  if (valor && !Array.isArray(valor) && typeof valor === 'object') {
    // Resposta de API costuma vir como { data: [...] } ou { items: [...] }.
    valor = Array.isArray(valor.data) ? valor.data : Array.isArray(valor.items) ? valor.items : [];
  }
  return Array.isArray(valor) ? valor : [];
};

// Opcoes prontas para envio: [{ id, label, value, description }].
export const resolveMenuOptions = (data = {}, vars = {}, parseText = (texto) => texto) => {
  if (isDynamicMenu(data)) {
    const limite = Math.min(Math.max(parseInt(data.maxOptions, 10) || MAX_LIST_ROWS, 1), MAX_LIST_ROWS);
    return lerLista(vars, String(data.optionsVariable || '').trim())
      .slice(0, limite)
      .map((item, indice) => {
        const objeto = item !== null && typeof item === 'object';
        const label = String((objeto ? ler(item, data.optionLabelPath) : item) ?? '').trim();
        const value = objeto && data.optionValuePath ? ler(item, data.optionValuePath) : (objeto ? item : label);
        const description = objeto && data.optionDescriptionPath ? String(ler(item, data.optionDescriptionPath) ?? '').trim() : '';
        return { id: String(indice + 1), label, value: value ?? label, description };
      })
      .filter((opcao) => opcao.label);
  }
  return (Array.isArray(data.options) ? data.options : []).map((opcao, indice) => {
    const label = String(parseText(String(opcao?.label ?? '')) || opcao?.id || indice + 1).trim();
    return {
      id: String(opcao?.id || indice + 1),
      label,
      value: opcao?.value ?? label,
      description: ''
    };
  });
};

// "text" e o comportamento antigo (so o texto do menu). Menu dinamico nunca
// fica so no texto: sem as opcoes o cliente nao teria o que escolher.
export const resolveDisplayMode = (data = {}) => {
  const modo = String(data.optionsDisplay || '').trim();
  if (isDynamicMenu(data)) return modo === 'numbered' ? 'numbered' : 'auto';
  return ['auto', 'numbered'].includes(modo) ? modo : 'text';
};

// Formato final para este envio.
export const chooseMenuFormat = ({ display, options, channel }) => {
  if (display === 'text') return 'text';
  if (display === 'numbered' || channel !== 'whatsapp' || !options.length) return 'numbered';
  if (options.length <= MAX_BUTTONS) return 'buttons';
  if (options.length <= MAX_LIST_ROWS) return 'list';
  return 'numbered';
};

export const buildNumberedText = (bodyText, options) => {
  const linhas = options.map((opcao, indice) => `${indice + 1}. ${opcao.label}`);
  return [String(bodyText || '').trim(), linhas.join('\n')].filter(Boolean).join('\n\n');
};

export const buildMenuInteractive = ({ bodyText, options, format, listButtonText }) => {
  const body = { text: cortar(bodyText || 'Selecione uma opção:', BODY_MAX) };
  if (format === 'buttons') {
    return {
      type: 'button',
      body,
      action: {
        buttons: options.map((opcao) => ({ type: 'reply', reply: { id: opcao.id, title: cortar(opcao.label, BUTTON_TITLE_MAX) } }))
      }
    };
  }
  return {
    type: 'list',
    body,
    action: {
      button: cortar(listButtonText || 'Ver opções', BUTTON_TITLE_MAX),
      sections: [{
        rows: options.map((opcao) => {
          // Titulo longo e cortado; o texto inteiro vai na descricao.
          const descricao = opcao.description || (opcao.label.length > ROW_TITLE_MAX ? opcao.label : '');
          return {
            id: opcao.id,
            title: cortar(opcao.label, ROW_TITLE_MAX),
            ...(descricao ? { description: cortar(descricao, ROW_DESCRIPTION_MAX) } : {})
          };
        })
      }]
    }
  };
};

const normalizar = (valor) => String(valor ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .trim()
  .toLowerCase();

// Resposta do cliente -> opcao. Ordem: codigo do botao/lista, numero da
// posicao, codigo digitado, nome da opcao (sem acento e sem maiuscula).
export const matchMenuOption = ({ options, text, buttonId }) => {
  if (buttonId) {
    const porBotao = options.find((opcao) => opcao.id === String(buttonId));
    if (porBotao) return porBotao;
  }
  const resposta = normalizar(text);
  if (!resposta) return null;
  if (/^\d+$/.test(resposta)) {
    const porPosicao = options[Number(resposta) - 1];
    if (porPosicao) return porPosicao;
  }
  return options.find((opcao) => normalizar(opcao.id) === resposta)
    || options.find((opcao) => normalizar(opcao.label) === resposta)
    || null;
};
