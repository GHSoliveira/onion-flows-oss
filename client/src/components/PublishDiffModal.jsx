import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Rocket, X } from 'lucide-react';

const statusLabel = { added: 'Adicionado', changed: 'Alterado', removed: 'Removido' };

export default function PublishDiffModal({ open, flowName, diff, busy, onClose, onConfirm, onSelectNode }) {
  const [expanded, setExpanded] = useState(true);
  if (!open) return null;
  const summary = diff?.summary || {};
  const totalNodes = (summary.nodesAdded || 0) + (summary.nodesChanged || 0) + (summary.nodesRemoved || 0);
  const totalEdges = (summary.edgesAdded || 0) + (summary.edgesChanged || 0) + (summary.edgesRemoved || 0);

  return (
    <div className="fixed inset-0 z-[9999] grid place-items-center bg-black/55 p-4 backdrop-blur-sm">
      <section className="w-full max-w-xl border border-slate-500 bg-slate-100 shadow-[8px_10px_0_rgba(15,23,42,0.22)] dark:bg-slate-900">
        <header className="flex items-center justify-between border-b border-slate-400 px-5 py-4 dark:border-slate-600">
          <div>
            <p className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Publicacao</p>
            <h2 className="text-base font-semibold text-slate-950 dark:text-white">Revisar alteracoes de {flowName}</h2>
          </div>
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center border border-slate-400"><X size={14} /></button>
        </header>
        <div className="grid grid-cols-3 border-b border-slate-400 dark:border-slate-600">
          <div className="border-r border-slate-400 px-4 py-3"><span className="text-[10px] text-slate-500">Adicionados</span><strong className="block text-xl">{summary.nodesAdded || 0}</strong></div>
          <div className="border-r border-slate-400 px-4 py-3"><span className="text-[10px] text-slate-500">Alterados</span><strong className="block text-xl">{summary.nodesChanged || 0}</strong></div>
          <div className="px-4 py-3"><span className="text-[10px] text-slate-500">Removidos</span><strong className="block text-xl">{summary.nodesRemoved || 0}</strong></div>
        </div>
        <div className="flex items-center justify-between border-b border-slate-300 px-5 py-2 font-mono text-[9px] uppercase text-slate-500 dark:border-slate-700">
          <span>Conexoes ({totalEdges})</span>
          <span>+{summary.edgesAdded || 0} / ~{summary.edgesChanged || 0} / -{summary.edgesRemoved || 0}</span>
        </div>
        <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-center gap-2 border-b border-slate-300 px-5 py-3 text-left text-xs font-semibold dark:border-slate-700">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Detalhes ({totalNodes} nodes)
        </button>
        {expanded && (
          <div className="max-h-72 overflow-y-auto">
            {(diff?.nodes || []).map((item) => (
              <button key={`${item.status}:${item.id}`} type="button" onClick={() => onSelectNode(item)} className="flex w-full items-start justify-between gap-4 border-b border-slate-300 px-5 py-3 text-left hover:bg-slate-200 dark:border-slate-700 dark:hover:bg-slate-800">
                <span className="min-w-0"><strong className="block truncate text-xs text-slate-950 dark:text-white">{item.label}</strong><span className="font-mono text-[9px] text-slate-500">{item.id}{item.fields?.length ? ` · ${item.fields.join(', ')}` : ''}</span></span>
                <span className="font-mono text-[9px] font-bold uppercase text-blue-700 dark:text-blue-300">{statusLabel[item.status]}</span>
              </button>
            ))}
            {totalNodes === 0 && <p className="px-5 py-8 text-center text-sm text-slate-500">Nenhuma alteracao em nodes.</p>}
          </div>
        )}
        <footer className="flex justify-end gap-2 border-t border-slate-400 px-5 py-4 dark:border-slate-600">
          <button type="button" onClick={onClose} className="h-9 border border-slate-400 px-4 text-xs font-semibold">Cancelar</button>
          <button type="button" disabled={busy} onClick={onConfirm} className="flex h-9 items-center gap-2 bg-slate-950 px-4 text-xs font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-950"><Rocket size={14} /> Publicar</button>
        </footer>
      </section>
    </div>
  );
}
