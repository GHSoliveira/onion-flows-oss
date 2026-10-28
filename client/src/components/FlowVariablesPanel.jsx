import React from 'react';
import { Braces, X } from 'lucide-react';

const KIND_LABEL = {
  write: 'grava',
  read: 'le',
  both: 'grava e le'
};

export default function FlowVariablesPanel({ open, usage, onClose, onSelectNode }) {
  if (!open) return null;

  const used = usage?.used || [];
  const unused = usage?.unused || [];

  return (
    <aside className="absolute bottom-4 right-4 top-4 z-[70] flex w-[min(380px,calc(100%-32px))] flex-col border border-slate-400 bg-slate-100 shadow-[8px_10px_0_rgba(15,23,42,0.16)] dark:border-slate-600 dark:bg-slate-900">
      <header className="flex min-h-14 items-center justify-between border-b border-slate-400 px-4 dark:border-slate-600">
        <div>
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
            Contexto do fluxo
          </p>
          <h2 className="text-sm font-semibold text-slate-950 dark:text-slate-100">
            Variaveis ({usage?.total || 0})
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center border border-slate-400 text-slate-600 transition-colors hover:border-slate-950 hover:bg-slate-200 hover:text-slate-950 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-200 dark:hover:bg-slate-800 dark:hover:text-white"
          aria-label="Fechar variaveis do fluxo"
        >
          <X size={14} />
        </button>
      </header>

      <div className="grid grid-cols-2 border-b border-slate-400 dark:border-slate-600">
        <div className="border-r border-slate-400 px-4 py-3 dark:border-slate-600">
          <p className="font-mono text-[9px] font-bold uppercase text-blue-700 dark:text-blue-300">Utilizadas</p>
          <p className="mt-1 text-xl font-semibold text-slate-950 dark:text-slate-100">{used.length}</p>
        </div>
        <div className="px-4 py-3">
          <p className="font-mono text-[9px] font-bold uppercase text-slate-500 dark:text-slate-400">Nao utilizadas</p>
          <p className="mt-1 text-xl font-semibold text-slate-950 dark:text-slate-100">{unused.length}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {usage?.total === 0 ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center px-8 text-center">
            <Braces size={28} className="text-slate-400 dark:text-slate-500" />
            <p className="mt-3 text-sm font-semibold text-slate-950 dark:text-slate-100">Nenhuma variavel cadastrada</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Cadastre variaveis no gerenciador para acompanhar o uso delas neste fluxo.
            </p>
          </div>
        ) : (
          <>
            {used.length > 0 && (
              <div className="border-b border-slate-300 bg-slate-200/60 px-4 py-2 dark:border-slate-700 dark:bg-slate-800/50">
                <p className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-300">
                  Utilizadas neste fluxo
                </p>
              </div>
            )}

            {used.map((variable) => (
              <div key={`used_${variable.name}`} className="border-b border-slate-300 dark:border-slate-700">
                <div className="flex items-center justify-between gap-3 px-4 pt-3">
                  <span className="truncate font-mono text-xs font-bold text-slate-950 dark:text-slate-100">
                    {variable.name}
                  </span>
                  <span className="shrink-0 font-mono text-[8px] uppercase text-slate-400">
                    {variable.nodes.length} {variable.nodes.length === 1 ? 'node' : 'nodes'}
                  </span>
                </div>
                <div className="px-2 pb-2 pt-1">
                  {variable.nodes.map((entry, index) => (
                    <button
                      key={`${variable.name}_${entry.nodeId}_${index}`}
                      type="button"
                      onClick={() => onSelectNode?.(entry)}
                      title={`Centralizar em ${entry.nodeLabel}`}
                      className="grid w-full grid-cols-[8px_minmax(0,1fr)] items-start gap-2.5 px-2 py-2 text-left transition-colors hover:bg-slate-200 focus:bg-slate-200 focus:outline-none dark:hover:bg-slate-800 dark:focus:bg-slate-800"
                    >
                      <span className={`mt-1.5 h-2 w-2 ${entry.kind === 'read' ? 'bg-slate-400' : 'bg-blue-600'}`} />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-slate-950 dark:text-slate-100">
                          {entry.nodeLabel}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2">
                          <span className="font-mono text-[8px] uppercase tracking-[0.08em] text-blue-700 dark:text-blue-300">
                            {KIND_LABEL[entry.kind] || 'usa'}
                          </span>
                          <span className="truncate font-mono text-[8px] uppercase text-slate-400">
                            {entry.nodeType}
                          </span>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}

            {unused.length > 0 && (
              <div className="border-b border-slate-300 bg-slate-200/60 px-4 py-2 dark:border-slate-700 dark:bg-slate-800/50">
                <p className="font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-slate-600 dark:text-slate-300">
                  Nao utilizadas
                </p>
              </div>
            )}

            {unused.map((variable) => (
              <div
                key={`unused_${variable.name}`}
                className="flex items-center gap-2.5 border-b border-slate-300 px-4 py-2.5 dark:border-slate-700"
              >
                <span className="h-2 w-2 shrink-0 border border-slate-400 dark:border-slate-600" />
                <span className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">{variable.name}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
