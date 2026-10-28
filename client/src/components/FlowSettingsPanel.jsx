import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Clock, Copy, X } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import useEditorPanelTop from '../hooks/useEditorPanelTop';

// Barra lateral do fluxo em si (nao de um node): nome, descricao, situacao da
// publicacao e configuracoes que valem para o fluxo. Mesmo visual da
// configuracao do node.
const labelClass = 'font-mono text-[10px] font-bold uppercase tracking-[0.08em] text-slate-600 dark:text-slate-400';
const fieldClass = 'mt-1 w-full rounded-[2px] border border-slate-400 bg-white p-2 text-sm text-slate-900 outline-none focus:border-slate-950 disabled:opacity-60 dark:border-slate-500 dark:bg-slate-950 dark:text-slate-100 dark:focus:border-slate-300';
const sectionTitle = 'mb-3 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400';
const botaoSecundario = 'rounded-[2px] border border-slate-500 bg-slate-100 px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-slate-700 transition-colors hover:bg-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800';

const dataHora = (iso) => {
  if (!iso) return null;
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return null;
  return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const Linha = ({ rotulo, children }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-slate-300 py-2 last:border-b-0 dark:border-slate-700">
    <dt className="text-xs text-slate-500 dark:text-slate-400">{rotulo}</dt>
    <dd className="min-w-0 text-right text-xs font-semibold text-slate-900 dark:text-slate-100">{children}</dd>
  </div>
);

const FlowSettingsPanel = ({ open, onClose, readOnly, isSubflow, flowId, name, meta, stats, isDirty, onSave, onOpenInactivity }) => {
  const reduceMotion = useReducedMotion();
  const topo = useEditorPanelTop(open);
  const [nome, setNome] = useState('');
  const [descricao, setDescricao] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    setNome(name || '');
    setDescricao(meta?.description || '');
    const tecla = (event) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', tecla, true);
    return () => window.removeEventListener('keydown', tecla, true);
  }, [open]);

  if (!open) return null;

  const mudou = nome.trim() !== String(name || '').trim() || descricao !== String(meta?.description || '');
  const salvar = async () => {
    if (!nome.trim() || !mudou) return;
    setSalvando(true);
    const ok = await onSave({ name: nome.trim(), description: descricao });
    setSalvando(false);
    if (ok) onClose();
  };

  const copiarId = async () => {
    try {
      await navigator.clipboard.writeText(flowId);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      // Sem permissao de area de transferencia: o id continua visivel para copiar a mao.
    }
  };

  const publicadoEm = dataHora(meta?.publishedAt);
  const alteradoEm = dataHora(meta?.updatedAt);
  const criadoEm = dataHora(meta?.createdAt);

  return (
    <motion.aside
      className="fixed bottom-0 right-0 z-[9999] flex w-[440px] max-w-full flex-col border-l border-slate-500 bg-slate-100 shadow-[-8px_0_24px_rgba(15,23,42,0.14)] dark:border-slate-600 dark:bg-slate-900"
      style={{ top: topo }}
      initial={reduceMotion ? false : { x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      aria-label={isSubflow ? 'Configuração do subfluxo' : 'Configuração do fluxo'}
    >
      <div className="flex min-h-12 items-center justify-between border-b border-slate-500 bg-slate-300 px-3 dark:bg-slate-800">
        <div className="min-w-0">
          <p className="font-mono text-[8px] font-bold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-400">{isSubflow ? 'Configuração do subfluxo' : 'Configuração do fluxo'}</p>
          <h3 className="truncate font-mono text-xs font-bold uppercase text-slate-950 dark:text-white">{name || 'Fluxo sem nome'}</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Fechar" title="Fechar (Esc)" className="ml-3 grid h-7 w-7 shrink-0 place-items-center rounded-[2px] border border-slate-500 bg-slate-100 text-slate-800 transition-colors hover:bg-slate-950 hover:text-white dark:bg-slate-900 dark:text-slate-100"><X size={15} /></button>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
        <section>
          <h4 className={sectionTitle}>Identificação</h4>
          <label className="block">
            <span className={labelClass}>Nome</span>
            <input value={nome} onChange={(e) => setNome(e.target.value)} disabled={readOnly} maxLength={120} className={fieldClass} />
          </label>
          <label className="mt-4 block">
            <span className={labelClass}>Descrição</span>
            <textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} disabled={readOnly} rows={4} maxLength={600}
              placeholder={readOnly ? '' : 'Para que serve este fluxo, em que canal roda, quem mantém...'} className={`${fieldClass} resize-y`} />
          </label>
        </section>

        <section>
          <h4 className={sectionTitle}>Situação</h4>
          <dl className="border-y border-slate-300 dark:border-slate-700">
            <Linha rotulo="Produção">{publicadoEm ? `Publicado em ${publicadoEm}` : 'Nunca publicado'}</Linha>
            {meta?.version ? <Linha rotulo="Versão do rascunho">{meta.version}</Linha> : null}
            <Linha rotulo="Rascunho">{isDirty ? 'Com alterações não salvas' : alteradoEm ? `Salvo em ${alteradoEm}` : 'Salvo'}</Linha>
            <Linha rotulo="Nodes e conexões">{stats.nodes} nodes · {stats.edges} conexões</Linha>
            {criadoEm ? <Linha rotulo="Criado em">{criadoEm}</Linha> : null}
            <Linha rotulo="Identificador">
              <button type="button" onClick={copiarId} title="Copiar identificador" className="inline-flex max-w-full items-center gap-1.5 font-mono text-[11px] font-normal text-slate-600 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white">
                <span className="truncate">{flowId}</span>
                {copiado ? <Check size={12} className="shrink-0" /> : <Copy size={12} className="shrink-0" />}
              </button>
            </Linha>
          </dl>
        </section>

        {!isSubflow && onOpenInactivity && (
          <section>
            <h4 className={sectionTitle}>Comportamento</h4>
            <button type="button" onClick={onOpenInactivity} className="grid w-full grid-cols-[34px_minmax(0,1fr)_20px] items-center border border-slate-400 bg-slate-100 text-left transition-colors hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-900 dark:hover:bg-slate-800">
              <span className="grid h-full min-h-[54px] place-items-center border-r border-slate-300 bg-slate-200/70 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"><Clock size={14} /></span>
              <span className="min-w-0 px-3 py-2">
                <span className="block font-mono text-[10px] font-bold uppercase text-slate-950 dark:text-slate-100">Inatividade</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">Tempo limite e mensagem de encerramento. Vale para todos os fluxos da empresa.</span>
              </span>
              <ChevronRight size={14} className="text-slate-400" />
            </button>
          </section>
        )}
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-slate-500 bg-slate-200 p-2.5 dark:bg-slate-800">
        {readOnly ? (
          <>
            <span className="mr-auto self-center font-mono text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400">Somente visualização</span>
            <button type="button" onClick={onClose} className={botaoSecundario}>Fechar</button>
          </>
        ) : (
          <>
            <button type="button" onClick={onClose} className={botaoSecundario}>Cancelar</button>
            <button type="button" onClick={salvar} disabled={!mudou || !nome.trim() || salvando}
              className="rounded-[2px] border border-slate-950 bg-slate-950 px-3 py-1.5 font-mono text-[10px] font-bold uppercase text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-200 dark:bg-slate-100 dark:text-slate-950">
              {salvando ? 'Salvando...' : 'Salvar'}
            </button>
          </>
        )}
      </div>
    </motion.aside>
  );
};

export default FlowSettingsPanel;
