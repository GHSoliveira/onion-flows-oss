import React, { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';

const severityStyles = {
  error: {
    marker: 'bg-red-500',
    label: 'Erro',
    labelClass: 'text-red-700 dark:text-red-300'
  },
  warning: {
    marker: 'bg-amber-500',
    label: 'Aviso',
    labelClass: 'text-amber-700 dark:text-amber-300'
  }
};

export default function FlowProblemsPanel({ open, problems = [], onClose, onSelect }) {
  const counts = useMemo(() => problems.reduce((summary, problem) => {
    if (problem?.severity === 'error') summary.errors += 1;
    if (problem?.severity === 'warning') summary.warnings += 1;
    return summary;
  }, { errors: 0, warnings: 0 }), [problems]);

  if (!open) return null;

  return (
    <aside className="absolute bottom-4 right-4 top-4 z-[70] flex w-[min(380px,calc(100%-32px))] flex-col border border-slate-400 bg-slate-100 shadow-[8px_10px_0_rgba(15,23,42,0.16)] dark:border-slate-600 dark:bg-slate-900">
      <header className="flex min-h-14 items-center justify-between border-b border-slate-400 px-4 dark:border-slate-600">
        <div>
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
            Validacao estrutural
          </p>
          <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">
            Problemas do fluxo ({problems.length})
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center border border-slate-400 text-slate-600 transition-colors hover:border-slate-950 hover:bg-slate-200 hover:text-slate-950 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
          aria-label="Fechar problemas do fluxo"
        >
          <X size={14} />
        </button>
      </header>

      <div className="grid grid-cols-2 border-b border-slate-400 dark:border-slate-600">
        <div className="border-r border-slate-400 px-4 py-3 dark:border-slate-600">
          <p className="font-mono text-[9px] font-bold uppercase text-red-700 dark:text-red-300">Erros</p>
          <p className="mt-1 text-xl font-semibold text-slate-950 dark:text-slate-100">{counts.errors}</p>
        </div>
        <div className="px-4 py-3">
          <p className="font-mono text-[9px] font-bold uppercase text-amber-700 dark:text-amber-300">Avisos</p>
          <p className="mt-1 text-xl font-semibold text-slate-950 dark:text-slate-100">{counts.warnings}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {problems.length === 0 ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center px-8 text-center">
            <CheckCircle2 size={28} className="text-blue-600 dark:text-blue-400" />
            <p className="mt-3 text-sm font-semibold text-slate-950 dark:text-slate-100">Fluxo sem problemas detectados</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              A validacao do backend ainda sera executada ao salvar ou publicar.
            </p>
          </div>
        ) : problems.map((problem, index) => {
          const style = severityStyles[problem.severity] || severityStyles.warning;
          return (
            <button
              key={`${problem.code || 'problem'}:${problem.nodeId || 'flow'}:${index}`}
              type="button"
              onClick={() => onSelect?.(problem)}
              className="grid w-full grid-cols-[8px_minmax(0,1fr)] gap-3 border-b border-slate-300 px-4 py-3 text-left transition-colors hover:bg-slate-200 focus:bg-slate-200 focus:outline-none dark:border-slate-700 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
            >
              <span className={`mt-1.5 h-2 w-2 ${style.marker}`} />
              <span className="min-w-0">
                <span className="flex items-center justify-between gap-3">
                  <span className={`font-mono text-[9px] font-bold uppercase tracking-[0.08em] ${style.labelClass}`}>
                    {style.label}
                  </span>
                  <span className="truncate font-mono text-[8px] uppercase text-slate-400">
                    {problem.code || 'validacao'}
                  </span>
                </span>
                <span className="mt-1 block truncate text-xs font-semibold text-slate-950 dark:text-slate-100">
                  {problem.nodeLabel || problem.nodeId || 'Fluxo'}
                </span>
                <span className="mt-1 block text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
                  {problem.message}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {counts.errors > 0 && (
        <footer className="flex items-start gap-2 border-t border-slate-400 bg-red-50 px-4 py-3 text-[11px] leading-relaxed text-red-800 dark:border-slate-600 dark:bg-red-950/30 dark:text-red-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          A publicacao fica bloqueada ate que todos os erros sejam corrigidos. Avisos nao impedem a publicacao.
        </footer>
      )}
    </aside>
  );
}
