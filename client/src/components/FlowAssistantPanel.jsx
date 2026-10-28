import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Loader2, Sparkles, X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import useEditorPanelTop from '../hooks/useEditorPanelTop';

// Assistente de IA do editor: a pessoa pede em portugues, a IA propoe as
// mudancas e nada muda no fluxo ate clicar em Aplicar (e Ctrl+Z desfaz).
const EXEMPLOS = [
  'Depois da mensagem selecionada, pergunte o CPF e guarde em cpf_cliente',
  'Crie um menu com Agendar banho e Falar com atendente; a segunda opção vai para a fila',
  'Mande "Recebemos seu pedido, {nome}!" depois da última mensagem'
];

const MARCA = { novo: '+', alterar: '~', ligar: '→', variavel: '$', outro: '·' };

const FlowAssistantPanel = ({ open, onClose, onAsk, onApply, describe }) => {
  const reduceMotion = useReducedMotion();
  const topo = useEditorPanelTop(open);
  const [pedido, setPedido] = useState('');
  const [conversa, setConversa] = useState([]);
  const [pensando, setPensando] = useState(false);
  const fimRef = useRef(null);
  const campoRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    window.setTimeout(() => campoRef.current?.focus(), 50);
    const tecla = (event) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', tecla, true);
    return () => window.removeEventListener('keydown', tecla, true);
  }, [open]);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: 'end', behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [conversa, pensando, reduceMotion]);

  if (!open) return null;

  const enviar = async (textoPedido = pedido) => {
    const instrucao = String(textoPedido || '').trim();
    if (!instrucao || pensando) return;
    setPedido('');
    setConversa((atual) => [...atual, { autor: 'pessoa', texto: instrucao }]);
    setPensando(true);
    try {
      const resposta = await onAsk(instrucao);
      setConversa((atual) => [...atual, { autor: 'ia', resposta, estado: resposta.operations?.length ? 'proposta' : 'so-texto' }]);
    } catch (error) {
      // Sem resposta nenhuma (conexao caiu, servidor reiniciando): o navegador
      // so diz "Failed to fetch", que nao ajuda ninguem.
      const semResposta = error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(String(error?.message));
      const mensagem = semResposta ? 'Não consegui falar com o servidor. Confira a conexão e tente de novo.' : (error.message || 'Falha no assistente');
      setConversa((atual) => [...atual, { autor: 'ia', erro: mensagem }]);
    } finally {
      setPensando(false);
    }
  };

  const decidir = async (indice, aplicar) => {
    const item = conversa[indice];
    if (!item || item.estado !== 'proposta') return;
    if (!aplicar) {
      setConversa((atual) => atual.map((x, i) => (i === indice ? { ...x, estado: 'descartada' } : x)));
      return;
    }
    setConversa((atual) => atual.map((x, i) => (i === indice ? { ...x, estado: 'aplicando' } : x)));
    const resultado = await onApply(item.resposta);
    setConversa((atual) => atual.map((x, i) => (i === indice
      ? { ...x, estado: resultado?.ok === false ? 'proposta' : 'aplicada', avisos: resultado?.warnings || [] }
      : x)));
  };

  return (
    <motion.aside
      className="fixed bottom-0 right-0 z-[9999] flex w-[440px] max-w-full flex-col border-l border-slate-500 bg-slate-100 shadow-[-8px_0_24px_rgba(15,23,42,0.14)] dark:border-slate-600 dark:bg-slate-900"
      style={{ top: topo }}
      initial={reduceMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      aria-label="Assistente do fluxo"
    >
      <div className="flex min-h-12 items-center justify-between border-b border-slate-500 bg-slate-300 px-3 dark:bg-slate-800">
        <div className="min-w-0">
          <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">Assistente de IA</p>
          <h3 className="truncate font-mono text-xs font-bold uppercase text-slate-950 dark:text-white">Editar o fluxo pedindo</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Fechar" title="Fechar (Esc)" className="ml-3 grid h-7 w-7 shrink-0 place-items-center rounded-[2px] border border-slate-500 bg-slate-100 text-slate-800 transition-colors hover:bg-slate-950 hover:text-white dark:bg-slate-900 dark:text-slate-100"><X size={15} /></button>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {conversa.length === 0 && (
          <div className="space-y-3">
            <p className="text-[12px] leading-relaxed text-slate-600 dark:text-slate-300">
              Diga o que quer no fluxo. A IA entende o que já existe (nodes, variáveis, filas e integrações), monta as mudanças e mostra antes de aplicar.
            </p>
            <div className="space-y-1.5">
              {EXEMPLOS.map((exemplo) => (
                <button key={exemplo} type="button" onClick={() => enviar(exemplo)}
                  className="block w-full border border-slate-400 bg-white px-3 py-2 text-left text-[12px] text-slate-700 transition-colors hover:border-slate-950 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800">
                  {exemplo}
                </button>
              ))}
            </div>
          </div>
        )}

        {conversa.map((item, indice) => (item.autor === 'pessoa' ? (
          <div key={indice} className="ml-8 border border-slate-950 bg-slate-950 px-3 py-2 text-[12px] text-white dark:border-slate-200 dark:bg-slate-100 dark:text-slate-950">{item.texto}</div>
        ) : item.erro ? (
          <div key={indice} className="mr-8 border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{item.erro}</div>
        ) : (
          <div key={indice} className="mr-4 border border-slate-400 bg-white dark:border-slate-600 dark:bg-slate-950">
            <p className="px-3 py-2 text-[12px] leading-relaxed text-slate-800 dark:text-slate-100">{item.resposta.reply}</p>
            {item.resposta.operations?.length > 0 && (
              <>
                <ul className="border-t border-slate-300 px-3 py-2 dark:border-slate-700">
                  {describe(item.resposta.operations).map((linha, i) => (
                    <li key={i} className="flex gap-2 py-0.5 text-[11px] leading-snug text-slate-600 dark:text-slate-300">
                      <span className="w-3 shrink-0 font-mono font-bold text-slate-900 dark:text-slate-100">{MARCA[linha.kind] || '·'}</span>
                      <span>{linha.text}</span>
                    </li>
                  ))}
                </ul>
                {item.resposta.warnings?.length > 0 && (
                  <ul className="border-t border-slate-300 px-3 py-1.5 text-[11px] text-amber-700 dark:border-slate-700 dark:text-amber-300">
                    {item.resposta.warnings.map((aviso, i) => <li key={i}>{aviso}</li>)}
                  </ul>
                )}
                {item.resposta.discarded > 0 && (
                  <p className="border-t border-slate-300 px-3 py-1.5 text-[11px] text-amber-700 dark:border-slate-700 dark:text-amber-300">{item.resposta.discarded} sugestão(ões) da IA foram ignoradas por não fecharem com o fluxo.</p>
                )}
                <div className="flex items-center justify-end gap-2 border-t border-slate-300 bg-slate-100 px-2.5 py-2 dark:border-slate-700 dark:bg-slate-900">
                  {item.estado === 'proposta' || item.estado === 'aplicando' ? (
                    <>
                      <button type="button" onClick={() => decidir(indice, false)} disabled={item.estado === 'aplicando'} className="h-8 rounded-[2px] border border-slate-500 bg-slate-100 px-3 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:bg-slate-300 disabled:opacity-50 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800">Descartar</button>
                      <button type="button" onClick={() => decidir(indice, true)} disabled={item.estado === 'aplicando'} className="flex h-8 items-center gap-1.5 rounded-[2px] border border-slate-950 bg-slate-950 px-3 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 disabled:opacity-50 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950">
                        {item.estado === 'aplicando' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Aplicar
                      </button>
                    </>
                  ) : (
                    <span className="mr-auto font-mono text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400">
                      {item.estado === 'aplicada' ? 'Aplicado · Ctrl+Z desfaz' : 'Descartado'}
                    </span>
                  )}
                </div>
                {item.avisos?.length > 0 && (
                  <ul className="border-t border-slate-300 px-3 py-2 text-[11px] text-amber-700 dark:border-slate-700 dark:text-amber-300">
                    {item.avisos.map((aviso, i) => <li key={i}>{aviso}</li>)}
                  </ul>
                )}
              </>
            )}
          </div>
        )))}

        {pensando && (
          <div className="mr-8 flex items-center gap-2 border border-slate-400 bg-white px-3 py-2 text-[12px] text-slate-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-400">
            <Sparkles size={13} className={reduceMotion ? '' : 'animate-pulse'} /> Montando as mudanças...
          </div>
        )}
        <div ref={fimRef} />
      </div>

      <form onSubmit={(event) => { event.preventDefault(); enviar(); }} className="shrink-0 border-t border-slate-500 bg-slate-200 p-2.5 dark:bg-slate-800">
        <div className="flex items-end gap-2">
          <textarea
            ref={campoRef}
            value={pedido}
            onChange={(event) => setPedido(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                enviar();
              }
            }}
            rows={2}
            maxLength={1500}
            placeholder="Ex.: depois da boas-vindas, pergunte o e-mail e guarde em email_cliente"
            className="min-h-[44px] flex-1 resize-none rounded-[2px] border border-slate-400 bg-white px-2.5 py-2 text-[13px] text-slate-900 outline-none focus:border-slate-950 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300"
          />
          <button type="submit" disabled={!pedido.trim() || pensando} aria-label="Enviar pedido"
            className="grid h-[44px] w-[44px] shrink-0 place-items-center rounded-[2px] border border-slate-950 bg-slate-950 text-white transition-colors hover:bg-slate-700 disabled:opacity-40 dark:border-slate-100 dark:bg-slate-100 dark:text-slate-950">
            {pensando ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} />}
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">Enter envia · Shift+Enter quebra linha · nada muda até você aplicar</p>
      </form>
    </motion.aside>
  );
};

export default FlowAssistantPanel;
