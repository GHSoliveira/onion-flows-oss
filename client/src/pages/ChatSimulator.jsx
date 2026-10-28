import React, { useEffect, useState } from 'react';
import { Play, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { deleteJSON, getJSON, postJSON } from '../services/api';

// Compatibilidade da rota antiga: a execucao local foi removida para que editor e
// simulador usem exatamente a mesma maquina de estados do backend.
export default function ChatSimulator() {
  const [flows, setFlows] = useState([]);
  const [flowId, setFlowId] = useState('');
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    getJSON('/flows?limit=200&page=1').then((data) => setFlows(data?.items || [])).catch(() => {});
  }, []);

  const start = async () => {
    if (!flowId) return;
    setBusy(true);
    try {
      if (session?.id) await deleteJSON(`/flows/${flowId}/test-sessions/${session.id}`);
      const flow = await getJSON(`/flows/${flowId}?view=editor`);
      const snapshot = flow.editorSnapshot || { nodes: [], edges: [] };
      setSession(await postJSON(`/flows/${flowId}/test-sessions`, snapshot));
    } catch (error) {
      toast.error(error.message || 'Falha ao iniciar teste');
    } finally {
      setBusy(false);
    }
  };

  const send = async (event) => {
    event.preventDefault();
    if (!text.trim() || !session?.id) return;
    setBusy(true);
    try {
      setSession(await postJSON(`/flows/${flowId}/test-sessions/${session.id}/input`, { text }));
      setText('');
    } catch (error) {
      toast.error(error.message || 'Falha no teste');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl p-6">
      <header className="border-b border-slate-300 pb-5 dark:border-slate-700"><h1 className="text-2xl font-semibold">Teste de fluxo</h1><p className="mt-1 text-sm text-slate-500">Sandbox executado pelo motor real do backend.</p></header>
      <div className="mt-5 flex gap-2"><select value={flowId} onChange={(event) => { setFlowId(event.target.value); setSession(null); }} className="h-10 flex-1 border border-slate-300 bg-white px-3 dark:border-slate-700 dark:bg-slate-900"><option value="">Selecione um fluxo</option>{flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}</select><button type="button" onClick={start} disabled={!flowId || busy} className="flex h-10 items-center gap-2 bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-40"><Play size={15} /> Testar draft</button></div>
      <section className="mt-5 min-h-[420px] border border-slate-300 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950">{(session?.messages || []).map((message) => <div key={message.id} className={`mb-2 max-w-[75%] border px-3 py-2 text-sm ${message.sender === 'user' ? 'ml-auto border-blue-300 bg-blue-50 dark:bg-blue-950/30' : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900'}`}><span className="whitespace-pre-wrap">{message.text}</span></div>)}</section>
      <form onSubmit={send} className="mt-3 flex gap-2"><textarea value={text} onChange={(event) => setText(event.target.value)} className="min-h-11 flex-1 border border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-900" /><button disabled={!session || busy} className="grid w-12 place-items-center bg-blue-600 text-white disabled:opacity-40"><Send size={16} /></button></form>
      {session && <details className="mt-4"><summary className="cursor-pointer text-xs font-semibold">Variaveis seguras para exibicao</summary><pre className="mt-2 overflow-auto bg-slate-950 p-3 text-xs text-slate-200">{JSON.stringify(session.vars || {}, null, 2)}</pre></details>}
    </main>
  );
}
