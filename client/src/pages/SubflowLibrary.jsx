import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Boxes, Loader2, Maximize2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { apiRequest } from '../services/api';

const FlowEditor = lazy(() => import('./FlowEditor'));
import OperationalModal from '../components/OperationalModal';
import { useDialog } from '../context/DialogContext';
import toast from 'react-hot-toast';
import { SkeletonBox } from '../components/LoadingSkeleton';

const formatDate = (iso) => {
  if (!iso) return 'nunca';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'nunca';
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export default function SubflowLibrary() {
  const { tenantId: routeTenantId } = useParams();
  const navigate = useNavigate();
  const { confirm } = useDialog();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '' });
  const [detail, setDetail] = useState(null);
  const [usage, setUsage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editorDirty, setEditorDirty] = useState(false);

  const editorPath = (id) => (routeTenantId ? `/tenant/${routeTenantId}/subflows/${id}/editor` : `/subflows/${id}/editor`);

  const load = useCallback(async () => {
    try {
      const res = await apiRequest('/subflows');
      setItems(res && res.ok ? await res.json() : []);
    } catch {
      toast.error('Falha ao carregar subfluxos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (item) => {
    setDetail(item);
    setUsage(null);
    try {
      const res = await apiRequest(`/subflows/${item.id}/usage`);
      const data = res && res.ok ? await res.json() : { usage: [] };
      setUsage(Array.isArray(data.usage) ? data.usage : []);
    } catch {
      setUsage([]);
    }
  };

  const create = async () => {
    if (!draft.name.trim()) { toast.error('Informe um nome.'); return; }
    try {
      setBusy(true);
      const res = await apiRequest('/subflows', { method: 'POST', body: JSON.stringify(draft) });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao criar');
      toast.success('Subfluxo criado');
      setCreating(false);
      setDraft({ name: '', description: '' });
      await load();
      setEditing(data);
    } catch (error) {
      toast.error(error.message || 'Falha ao criar subfluxo');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item) => {
    const ok = await confirm({
      title: 'Excluir subfluxo',
      message: `Remover "${item.name}" definitivamente?`,
      confirmText: 'Excluir',
      type: 'danger'
    });
    if (!ok) return;
    try {
      setBusy(true);
      const res = await apiRequest(`/subflows/${item.id}`, { method: 'DELETE' });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao excluir');
      toast.success('Subfluxo removido');
      setDetail(null);
      await load();
    } catch (error) {
      toast.error(error.message || 'Falha ao excluir');
    } finally {
      setBusy(false);
    }
  };

  const emUso = (usage || []).length;

  return (
    <div className="mx-auto w-full max-w-4xl py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">Automacao</p>
          <h1 className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">Biblioteca de subfluxos</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Trechos de atendimento com uma entrada e uma saida, reutilizados por varios fluxos.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-xs font-semibold text-white transition-colors hover:bg-blue-700"
        >
          <Plus size={14} /> Novo subfluxo
        </button>
      </div>

      {loading ? (
        <div className="divide-y divide-gray-200 border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={`subflow_skel_${index}`} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <SkeletonBox className="h-4 w-40" />
                  <SkeletonBox className="h-3 w-16" />
                </div>
                <SkeletonBox className="h-3 w-64" />
              </div>
              <SkeletonBox className="h-3 w-20" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="border border-dashed border-gray-300 py-16 text-center dark:border-gray-700">
          <Boxes size={30} className="mx-auto text-gray-400" />
          <p className="mt-3 text-sm font-semibold text-gray-800 dark:text-gray-100">Nenhum subfluxo ainda</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-gray-500 dark:text-gray-400">
            Crie um subfluxo para reaproveitar em varios fluxos. Editar o subfluxo altera todos que o usam.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-gray-200 border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openDetail(item)}
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">{item.name}</span>
                  <span className={`shrink-0 border px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase ${
                    item.status === 'published'
                      ? 'border-emerald-500 text-emerald-700 dark:text-emerald-300'
                      : 'border-amber-500 text-amber-700 dark:text-amber-300'
                  }`}>
                    {item.status === 'published' ? 'Publicado' : 'Rascunho'}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                  {item.description || 'Sem descricao'}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[10px] text-gray-400">
                {item.nodeCount} nodes · {formatDate(item.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}

      <OperationalModal open={creating} onClose={() => setCreating(false)} size="sm" title="Novo subfluxo">
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500">Nome</label>
            <input
              className="h-11 w-full border border-gray-300 bg-white px-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Ex: Triagem inicial"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500">Descricao</label>
            <input
              className="h-11 w-full border border-gray-300 bg-white px-4 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="O que este subfluxo faz"
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
            <button type="button" onClick={() => setCreating(false)} className="h-9 border border-gray-300 px-4 text-xs font-semibold text-gray-600 dark:border-gray-700 dark:text-gray-300">Cancelar</button>
            <button type="button" onClick={create} disabled={busy} className="h-9 bg-blue-600 px-4 text-xs font-semibold text-white disabled:opacity-60">
              {busy ? 'Criando...' : 'Criar e editar'}
            </button>
          </div>
        </div>
      </OperationalModal>

      {/* Edicao na propria pagina: o editor roda embutido, sem trocar de rota.
          Quem precisar de mais espaco usa o botao Tela cheia. */}
      {editing && (
        <div className="pointer-events-none fixed inset-0 z-[9000] flex items-end justify-center p-3 sm:items-center sm:p-6">
          <div className="pointer-events-auto flex h-[82vh] w-full max-w-[1180px] flex-col border border-slate-400 bg-white shadow-[0_24px_60px_rgba(2,6,23,0.35)] dark:border-slate-600 dark:bg-slate-900">
            <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-300 bg-slate-100 px-4 dark:border-slate-700 dark:bg-slate-800">
              <div className="min-w-0">
                <p className="font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Subfluxo</p>
                <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">{editing.name}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => navigate(editorPath(editing.id))}
                  title="Abrir em tela cheia"
                  className="grid h-8 w-8 place-items-center border border-slate-300 text-slate-600 transition-colors hover:border-blue-500 hover:text-blue-600 dark:border-slate-600 dark:text-slate-300"
                >
                  <Maximize2 size={14} />
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (editorDirty) {
                      const ok = await confirm({
                        title: 'Fechar editor',
                        message: 'Ha alteracoes ainda nao salvas neste subfluxo. Fechar mesmo assim?',
                        confirmText: 'Fechar',
                        type: 'warning'
                      });
                      if (!ok) return;
                    }
                    setEditing(null);
                    setEditorDirty(false);
                    await load();
                  }}
                  title="Fechar"
                  className="grid h-8 w-8 place-items-center border border-slate-300 text-slate-600 transition-colors hover:border-slate-900 hover:text-slate-900 dark:border-slate-600 dark:text-slate-300"
                >
                  <X size={14} />
                </button>
              </div>
            </header>
            <div className="min-h-0 flex-1">
              <Suspense fallback={<div className="grid h-full place-items-center"><Loader2 className="animate-spin text-blue-500" /></div>}>
                <FlowEditor mode="subflow" embedded subflowId={editing.id} onDirtyChange={setEditorDirty} />
              </Suspense>
            </div>
          </div>
        </div>
      )}

      <OperationalModal open={Boolean(detail)} onClose={() => setDetail(null)} size="md" title={detail?.name || 'Subfluxo'}>
        {detail && (
          <div className="space-y-4 p-5">
            <p className="text-sm text-gray-600 dark:text-gray-300">{detail.description || 'Sem descricao'}</p>

            <div className="grid grid-cols-3 gap-3">
              {[
                ['Situacao', detail.status === 'published' ? 'Publicado' : 'Rascunho'],
                ['Nodes', detail.nodeCount],
                ['Alterado', formatDate(detail.updatedAt)]
              ].map(([label, value]) => (
                <div key={label} className="border border-gray-200 px-3 py-2 dark:border-gray-800">
                  <p className="font-mono text-[9px] font-bold uppercase text-gray-500">{label}</p>
                  <p className="mt-1 truncate text-xs font-semibold text-gray-900 dark:text-white">{value}</p>
                </div>
              ))}
            </div>

            {/* Saber onde e usado antes de editar e o que evita alterar sete
                atendimentos achando que se mexe em um. */}
            <div className="border border-gray-200 dark:border-gray-800">
              <div className="border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-800 dark:bg-gray-900/40">
                <p className="font-mono text-[9px] font-bold uppercase tracking-wide text-gray-600 dark:text-gray-300">
                  Usado em {usage === null ? '...' : emUso} fluxo(s)
                </p>
              </div>
              {usage === null ? (
                <p className="px-3 py-3 text-xs text-gray-400">Verificando...</p>
              ) : emUso === 0 ? (
                <p className="px-3 py-3 text-xs text-gray-500">Nenhum fluxo usa este subfluxo ainda.</p>
              ) : (
                <ul className="divide-y divide-gray-200 dark:divide-gray-800">
                  {usage.map((item) => (
                    <li key={item.flowId} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="truncate text-xs text-gray-800 dark:text-gray-200">{item.name}</span>
                      <span className="shrink-0 font-mono text-[9px] uppercase text-gray-400">
                        {item.inPublished ? 'publicado' : 'rascunho'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {emUso > 0 && (
              <div className="flex items-start gap-2 border border-amber-400 bg-amber-50 px-3 py-2.5 dark:border-amber-700 dark:bg-amber-950/30">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="m-0 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                  Ao publicar uma alteracao, ela vale imediatamente para todos os fluxos acima.
                </p>
              </div>
            )}

            <div className="flex justify-between gap-2 border-t border-gray-200 pt-4 dark:border-gray-800">
              <button
                type="button"
                onClick={() => remove(detail)}
                disabled={busy || emUso > 0}
                title={emUso > 0 ? 'Remova as referencias antes de excluir' : 'Excluir subfluxo'}
                className="inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-xs font-semibold text-red-600 disabled:opacity-40 dark:border-gray-700"
              >
                <Trash2 size={14} /> Excluir
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => navigate(editorPath(detail.id))}
                  title="Abrir em tela cheia"
                  className="inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-xs font-semibold text-gray-600 dark:border-gray-700 dark:text-gray-300"
                >
                  <Maximize2 size={14} /> Tela cheia
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(detail); setDetail(null); }}
                  className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  <Pencil size={14} /> Editar subfluxo
                </button>
              </div>
            </div>
          </div>
        )}
      </OperationalModal>
    </div>
  );
}
