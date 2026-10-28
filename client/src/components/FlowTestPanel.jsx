import React, { Component, useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, Send, X } from 'lucide-react';

const safeDisplayText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === 'string' ? serialized : String(value);
  } catch (_) {
    return '[Conteudo nao exibivel]';
  }
};

const safeJson = (value) => {
  try {
    return JSON.stringify(value && typeof value === 'object' ? value : {}, null, 2);
  } catch (_) {
    return '{\n  "erro": "Variaveis nao puderam ser exibidas"\n}';
  }
};

class FlowTestErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('[FLOW_TEST] Falha isolada na interface do testador:', error);
    this.setState({ errorMessage: safeDisplayText(error?.message || error) });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <aside className="absolute bottom-4 right-4 top-4 z-[75] flex w-[min(390px,calc(100%-32px))] flex-col border border-red-500 bg-slate-100 p-5 shadow-[8px_10px_0_rgba(15,23,42,0.18)] dark:bg-slate-900">
        <p className="text-sm font-semibold text-red-700 dark:text-red-300">Falha ao exibir o teste</p>
        <p className="mt-2 text-xs text-slate-500">O editor continua seguro. Reinicie a sessao para tentar novamente.</p>
        {this.state.errorMessage && <code className="mt-3 break-words border border-red-200 bg-red-50 p-2 text-[10px] text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{this.state.errorMessage}</code>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => { this.setState({ failed: false }); this.props.onStart?.(); }} className="h-9 bg-blue-600 px-3 text-xs font-semibold text-white">Reiniciar</button>
          <button type="button" onClick={this.props.onClose} className="h-9 border border-slate-400 px-3 text-xs">Fechar</button>
        </div>
      </aside>
    );
  }
}

function FlowTestPanelContent({ open, session, busy, onStart, onSend, onClose }) {
  const [text, setText] = useState('');
  const endRef = useRef(null);
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const vars = session?.vars && typeof session.vars === 'object' && !Array.isArray(session.vars) ? session.vars : {};
  useEffect(() => {
    try {
      if (typeof endRef.current?.scrollIntoView === 'function') {
        endRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (_) {
      // O auto-scroll e apenas cosmético e nunca deve interromper o editor.
    }
  }, [messages.length]);
  if (!open) return null;

  return (
    <aside className="absolute bottom-4 right-4 top-4 z-[75] flex w-[min(390px,calc(100%-32px))] flex-col border border-slate-500 bg-slate-100 shadow-[8px_10px_0_rgba(15,23,42,0.18)] dark:bg-slate-900">
      <header className="flex h-14 items-center justify-between border-b border-slate-400 px-4 dark:border-slate-600"><div><p className="font-mono text-[9px] font-bold uppercase text-blue-700">Sandbox</p><h2 className="text-sm font-semibold">Teste com motor real</h2></div><button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center border border-slate-400"><X size={14} /></button></header>
      {!session ? (
        <div className="grid flex-1 place-items-center p-8 text-center"><div><p className="text-sm font-semibold">Execute o rascunho atual sem enviar mensagens reais.</p><p className="mt-2 text-xs text-slate-500">Filas, metricas e provedores externos ficam isolados.</p><button type="button" disabled={busy} onClick={onStart} className="mx-auto mt-5 flex h-10 items-center gap-2 bg-blue-600 px-4 text-xs font-semibold text-white disabled:opacity-50"><Play size={14} /> Iniciar teste</button></div></div>
      ) : (
        <>
          <div className="border-b border-slate-400 px-4 py-2 font-mono text-[9px] text-slate-500 dark:border-slate-600">Node ativo: {safeDisplayText(session?.currentNodeId || 'nenhum')}</div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
            {messages.map((message, index) => <div key={`test_message_${index}_${safeDisplayText(message?.id).slice(0, 80)}`} className={`max-w-[88%] border px-3 py-2 text-xs ${message?.sender === 'user' ? 'ml-auto border-blue-300 bg-blue-50 dark:bg-blue-950/30' : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-800'}`}><span className="mb-1 block font-mono text-[8px] uppercase text-slate-400">{safeDisplayText(message?.sender || 'sistema')}</span><span className="whitespace-pre-wrap break-words">{safeDisplayText(message?.text)}</span></div>)}
            <div ref={endRef} />
          </div>
          <details className="border-t border-slate-400 px-4 py-2 dark:border-slate-600"><summary className="cursor-pointer font-mono text-[9px] font-bold uppercase text-slate-500">Variaveis ({Object.keys(vars).length})</summary><pre className="mt-2 max-h-32 overflow-auto bg-slate-950 p-2 text-[9px] text-slate-200">{safeJson(vars)}</pre></details>
          <form onSubmit={(event) => { event.preventDefault(); if (text.trim()) { onSend(text); setText(''); } }} className="flex border-t border-slate-400 p-3 dark:border-slate-600"><textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-10 flex-1 resize-none border border-slate-400 bg-white p-2 text-xs outline-none dark:bg-slate-950" placeholder="Responder no fluxo..." /><button type="submit" disabled={busy || !text.trim()} className="ml-2 grid w-10 place-items-center bg-blue-600 text-white disabled:opacity-40"><Send size={14} /></button><button type="button" onClick={onStart} title="Reiniciar" className="ml-2 grid w-10 place-items-center border border-slate-400"><RotateCcw size={14} /></button></form>
        </>
      )}
    </aside>
  );
}

export default function FlowTestPanel(props) {
  const sessionKey = `${props.session?.id || 'empty'}:${Array.isArray(props.session?.messages) ? props.session.messages.length : 0}`;
  return (
    <FlowTestErrorBoundary key={sessionKey} onStart={props.onStart} onClose={props.onClose}>
      <FlowTestPanelContent {...props} />
    </FlowTestErrorBoundary>
  );
}
