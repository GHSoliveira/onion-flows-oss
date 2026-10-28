import { useState } from 'react';
import { ChevronDown, FileText, Image as ImageIcon, List as ListIcon, Music, Video } from 'lucide-react';

// Previa de como a mensagem do node chega no WhatsApp do cliente. Segue o que
// o motor de fluxo envia de verdade: menu, nota, entrada e fila mandam so
// texto (as opcoes do menu nao viram botoes), midia vai com legenda e o
// catalogo vira uma lista numerada.

const DEFAULTS = {
  inputNode: 'Digite uma informacao:',
  menuNode: 'Selecione uma opção:',
  ratingNode: 'Avalie este atendimento de 1 a 5.',
  finalNode: 'Atendimento finalizado. Obrigado!',
  endNode: 'Atendimento finalizado. Obrigado!',
  queueNode: 'Aguarde, em alguns instantes um especialista deve te atender.',
  catalogNode: 'Selecione um item:'
};

const preco = (valor) => {
  if (valor === null || valor === undefined || valor === '') return '';
  const numero = Number(String(valor).replace(/[^\d,.-]/g, '').replace(',', '.'));
  return Number.isFinite(numero) ? ` - R$ ${numero.toFixed(2).replace('.', ',')}` : '';
};

const cortarTitulo = (valor, max) => {
  const texto = String(valor || '').trim();
  return texto.length > max ? `${texto.slice(0, max - 1).trimEnd()}…` : texto;
};

const textoOu = (valor, padrao = '') => (typeof valor === 'string' && valor.trim() ? valor : padrao);

// Monta as mensagens do node; null quando o tipo nao manda nada ao cliente.
export const buildWhatsAppPreview = (type, data = {}, { templates = [], catalogItems = [] } = {}) => {
  switch (type) {
    case 'messageNode':
      // Texto vazio: o motor nao manda nada.
      return textoOu(data.text) ? { messages: [{ kind: 'text', text: data.text }] } : { messages: [], note: 'Sem texto, este node não envia nada.' };
    case 'inputNode':
    case 'ratingNode':
    case 'finalNode':
    case 'endNode':
      return { messages: [{ kind: 'text', text: textoOu(data.text, DEFAULTS[type]) }] };
    case 'menuNode': {
      const texto = textoOu(data.text, DEFAULTS.menuNode);
      const dinamico = data.optionsSource === 'variable';
      const modo = dinamico
        ? (data.optionsDisplay === 'numbered' ? 'numbered' : 'auto')
        : (['auto', 'numbered'].includes(data.optionsDisplay) ? data.optionsDisplay : 'text');
      if (modo === 'text') {
        return {
          messages: [{ kind: 'text', text: texto }],
          note: 'Só a mensagem vai; as opções não aparecem para o cliente. Troque "Como as opções aparecem" para botões/lista, ou escreva as opções no texto.'
        };
      }
      const rotulos = dinamico
        ? ['Primeiro item', 'Segundo item', 'Terceiro item', 'Quarto item']
        : (Array.isArray(data.options) ? data.options : []).map((opcao, indice) => String(opcao?.label || opcao?.id || indice + 1));
      const nota = dinamico ? `Exemplo: as opções reais vêm de ${data.optionsVariable || 'uma variável'} na hora da conversa (até 10).` : null;
      if (modo === 'numbered' || rotulos.length > 10 || !rotulos.length) {
        return { messages: [{ kind: 'text', text: [texto, rotulos.map((r, i) => `${i + 1}. ${r}`).join('\n')].filter(Boolean).join('\n\n') }], note: nota };
      }
      if (rotulos.length <= 3) {
        return { messages: [{ kind: 'text', text: texto, buttons: rotulos.map((r) => cortarTitulo(r, 20)) }], note: nota };
      }
      return { messages: [{ kind: 'text', text: texto, list: { button: cortarTitulo(data.listButtonText || 'Ver opções', 20), rows: rotulos.map((r) => cortarTitulo(r, 24)) } }], note: nota };
    }
    case 'holderNode':
      return textoOu(data.text) ? { messages: [{ kind: 'text', text: data.text }] } : { messages: [], note: 'Sem texto, este node só espera as mensagens do cliente.' };
    case 'queueNode':
      if (data.sendQueueMessage === false) return { messages: [], note: 'Este node transfere sem mandar mensagem.' };
      return { messages: [{ kind: 'text', text: textoOu(data.queueMessage, DEFAULTS.queueNode) }] };
    case 'mediaNode':
      return {
        messages: [{
          kind: 'media',
          mediaType: String(data.mediaType || 'document').toLowerCase(),
          mediaUrl: data.mediaUrl || '',
          fileName: data.fileName || '',
          text: data.caption || ''
        }]
      };
    case 'templateNode': {
      const template = templates.find((item) => String(item.id) === String(data.templateId));
      if (!template) return { messages: [], note: 'Escolha um template para ver a prévia.' };
      return {
        messages: [{ kind: 'text', text: template.text || '' }],
        note: Array.isArray(template.buttons) && template.buttons.length ? 'Os botões do template não são enviados no WhatsApp; só o texto.' : null
      };
    }
    case 'catalogNode': {
      const limite = Math.min(Math.max(parseInt(data.limit || '5', 10) || 5, 1), 20);
      const manual = String(data.sourceType || 'catalog').toLowerCase() === 'manual';
      const ids = Array.isArray(data.itemIds) ? data.itemIds.map(String) : [];
      const itens = manual
        ? (Array.isArray(data.items) ? data.items : [])
        : (ids.length ? catalogItems.filter((item) => ids.includes(String(item.id))) : catalogItems);
      const linhas = itens.slice(0, limite).filter((item) => item?.name).map((item, index) => `${index + 1}. ${item.name}${preco(item.price)}`);
      return {
        messages: [{ kind: 'text', text: [textoOu(data.title || data.message, DEFAULTS.catalogNode), ...linhas].join('\n') }],
        note: manual || ids.length ? null : 'Sem itens escolhidos, entram os primeiros do catálogo, que podem mudar.'
      };
    }
    default:
      return null;
  }
};

// Formatacao do WhatsApp (*negrito*, _italico_, ~riscado~, ```mono```) e as
// variaveis {nome} destacadas, porque o valor so existe na conversa.
const formatar = (texto) => {
  const partes = [];
  const regex = /(```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|\{[\w.[\]]+\})/g;
  let ultimo = 0;
  let match;
  let chave = 0;
  while ((match = regex.exec(texto))) {
    if (match.index > ultimo) partes.push(texto.slice(ultimo, match.index));
    const pedaco = match[0];
    const k = `f${chave++}`;
    if (pedaco.startsWith('```')) partes.push(<code key={k} className="font-mono text-[12px]">{pedaco.slice(3, -3)}</code>);
    else if (pedaco.startsWith('*')) partes.push(<strong key={k}>{pedaco.slice(1, -1)}</strong>);
    else if (pedaco.startsWith('_')) partes.push(<em key={k}>{pedaco.slice(1, -1)}</em>);
    else if (pedaco.startsWith('~')) partes.push(<s key={k}>{pedaco.slice(1, -1)}</s>);
    else partes.push(<span key={k} className="rounded-[3px] bg-emerald-100 px-1 font-mono text-[11px] text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100" title="Variável: o valor entra na conversa">{pedaco}</span>);
    ultimo = match.index + pedaco.length;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes;
};

const MIDIA = { image: ['Imagem', ImageIcon], video: ['Vídeo', Video], audio: ['Áudio', Music], document: ['Documento', FileText] };

const Balao = ({ message }) => {
  const hora = '12:00';
  const vazio = message.kind === 'text' && !String(message.text || '').trim();
  const [rotulo, Icone] = MIDIA[message.mediaType] || MIDIA.document;
  return (
    <div className="relative max-w-[88%] self-start rounded-[8px] rounded-tl-none bg-white px-2 pb-1.5 pt-1.5 text-[13px] leading-[1.35] text-[#111b21] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] dark:bg-[#202c33] dark:text-[#e9edef]">
      <span className="absolute -left-[7px] top-0 h-0 w-0 border-r-[8px] border-t-[8px] border-r-white border-t-transparent dark:border-r-[#202c33]" style={{ borderTopColor: 'transparent' }} aria-hidden="true" />
      {message.kind === 'media' && (
        message.mediaType === 'image' && message.mediaUrl ? (
          <img src={message.mediaUrl} alt="" className="mb-1 max-h-48 w-full rounded-[6px] object-cover" />
        ) : (
          <div className="mb-1 flex items-center gap-2 rounded-[6px] bg-[#f0f2f5] px-2.5 py-2 dark:bg-[#111b21]">
            <Icone size={18} className="shrink-0 text-[#54656f] dark:text-[#aebac1]" />
            <span className="truncate text-[12px]">{message.fileName || rotulo}</span>
          </div>
        )
      )}
      {vazio ? (
        <span className="italic text-[#667781] dark:text-[#8696a0]">Mensagem vazia</span>
      ) : message.text ? (
        <span className="whitespace-pre-wrap break-words">{formatar(String(message.text))}</span>
      ) : null}
      <span className="float-right ml-2 mt-1 translate-y-0.5 text-[10px] text-[#667781] dark:text-[#8696a0]">{hora}</span>
      {message.list && (
        <div className="-mx-2 -mb-1.5 mt-2 flex items-center justify-center gap-1.5 border-t border-[#e9edef] py-2 text-[13px] font-medium text-[#008069] dark:border-[#2a3942] dark:text-[#00a884]">
          <ListIcon size={14} /> {message.list.button}
        </div>
      )}
    </div>
  );
};

// Botoes de resposta: blocos separados embaixo do balao, como no app.
const Botoes = ({ titulos }) => (
  <div className="flex max-w-[88%] flex-col gap-1 self-start" style={{ width: 'min(88%, 260px)' }}>
    {titulos.map((titulo, indice) => (
      <div key={indice} className="rounded-[8px] bg-white py-2 text-center text-[13px] font-medium text-[#008069] shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] dark:bg-[#202c33] dark:text-[#00a884]">{titulo}</div>
    ))}
  </div>
);

// O que abre ao tocar em "Ver opcoes".
const Lista = ({ lista }) => (
  <div className="max-w-[88%] self-start rounded-[8px] border border-dashed border-[#c7c2b8] bg-white/70 px-2.5 py-1.5 text-[11px] text-[#54656f] dark:border-[#2a3942] dark:bg-[#111b21]/70 dark:text-[#aebac1]">
    <div className="mb-0.5 text-[10px] uppercase tracking-wide opacity-70">Ao tocar abre</div>
    {lista.rows.map((linha, indice) => <div key={indice} className="py-0.5">○ {linha}</div>)}
  </div>
);

const LEMBRAR = 'onion:previa-whatsapp';

const WhatsAppPreview = ({ preview }) => {
  const [aberta, setAberta] = useState(() => {
    try { return localStorage.getItem(LEMBRAR) !== 'fechada'; } catch { return true; }
  });
  if (!preview) return null;

  const alternar = () => {
    setAberta((atual) => {
      try { localStorage.setItem(LEMBRAR, atual ? 'fechada' : 'aberta'); } catch { /* sem armazenamento */ }
      return !atual;
    });
  };

  return (
    <section className="mb-5 border border-slate-400 dark:border-slate-600">
      <button type="button" onClick={alternar} aria-expanded={aberta}
        className="flex w-full items-center justify-between bg-slate-200 px-3 py-2 text-left font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
        Prévia no WhatsApp
        <ChevronDown size={14} className={`transition-transform ${aberta ? 'rotate-180' : ''}`} />
      </button>
      {aberta && (
        <>
          <div className="flex min-h-[72px] flex-col gap-1.5 bg-[#efeae2] px-4 py-3 dark:bg-[#0b141a]">
            {preview.messages.length
              ? preview.messages.map((message, index) => (
                <div key={index} className="flex flex-col gap-1">
                  <Balao message={message} />
                  {message.buttons?.length > 0 && <Botoes titulos={message.buttons} />}
                  {message.list && <Lista lista={message.list} />}
                </div>
              ))
              : <span className="self-center py-3 text-[11px] text-[#667781] dark:text-[#8696a0]">Nada é enviado ao cliente.</span>}
          </div>
          {preview.note && (
            <p className="border-t border-slate-300 bg-slate-100 px-3 py-2 text-[11px] leading-snug text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">{preview.note}</p>
          )}
        </>
      )}
    </section>
  );
};

export default WhatsAppPreview;
