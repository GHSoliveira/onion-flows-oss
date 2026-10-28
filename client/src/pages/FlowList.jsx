import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiRequest, getJSON, postJSON, putJSON } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { hasManagerPermission } from '../utils/managerPermissions';
import { useDialog } from '../context/DialogContext';
import {
  Activity,
  AlertCircle,
  Boxes,
  Calendar,
  CheckCircle2,
  ChevronRight,
  GitBranch,
  Download,
  Edit3,
  History,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Trash2,
  Upload,
  Workflow,
  X
} from 'lucide-react';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { SkeletonBox } from '../components/LoadingSkeleton';
import OperationalModal from '../components/OperationalModal';
import { flowChannelLabels } from '../services/flowChannelLabels';
import { clearForeignSenders, remapInteractiveRefs } from '../utils/flowImport';

const formatDate = (value) => {
  if (!value) return 'Sem data';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sem data';
  return date.toLocaleString('pt-BR');
};

const readErrorMessage = async (response, fallback) => {
  const payload = await response.json().catch(() => ({}));
  if (Array.isArray(payload?.error)) return payload.error[0]?.message || fallback;
  return payload?.error || fallback;
};

const PasswordConfirmModal = ({ state, onClose, onChangePassword, onConfirm }) => {
  if (!state.open) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-black/55 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">{state.title}</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{state.subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            {state.message}
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1.5">
              Senha
            </label>
            <input
              type="password"
              value={state.password}
              onChange={(event) => onChangePassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !state.busy && state.password.trim()) {
                  onConfirm();
                }
              }}
              className="w-full px-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Digite sua senha para confirmar"
              autoFocus
            />
          </div>
        </div>

        <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={state.busy || !state.password.trim()}
            className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white inline-flex items-center gap-2"
          >
            {state.busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {state.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

const LegacyPublishHistoryModal = ({ state, canRollback, onClose, onRestore }) => {
  if (!state.open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-4xl rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-2xl overflow-hidden max-h-[88vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              Histórico de publicações
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {state.flow?.name || 'Fluxo'} · {state.items.length} publicação(ões)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto custom-scrollbar flex-1">
          {state.loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => (
                <div key={`pub_skel_${index}`} className="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                  <SkeletonBox className="h-4 w-48" />
                  <SkeletonBox className="h-4 w-full mt-3" />
                </div>
              ))}
            </div>
          ) : state.items.length === 0 ? (
            <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-gray-400 gap-3">
              <History size={46} />
              <p>Nenhuma publicação encontrada para este fluxo.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {!canRollback && (
                <div className="rounded-xl border border-blue-200 bg-blue-50 dark:border-blue-900/40 dark:bg-blue-900/10 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
                  Somente Admin e Super Admin podem restaurar publicações antigas.
                </div>
              )}

              {state.items.map((item) => {
                const isCurrent = state.currentPublishedVersion && item.version === state.currentPublishedVersion;
                return (
                  <div key={item.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/20 p-4">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                      <div className="space-y-2 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex items-center gap-1 rounded-full bg-gray-900 text-white dark:bg-white dark:text-gray-900 px-2.5 py-1 text-xs font-semibold">
                            v{item.version}
                          </span>
                          {isCurrent && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 px-2.5 py-1 text-xs font-semibold">
                              <CheckCircle2 size={12} />
                              Atual
                            </span>
                          )}
                          {item.restoredFromVersion ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 px-2.5 py-1 text-xs font-semibold">
                              Restaurado da v{item.restoredFromVersion}
                            </span>
                          ) : null}
                        </div>

                        <div className="text-sm font-semibold text-gray-900 dark:text-white break-words">
                          {item.name || state.flow?.name || 'Fluxo sem nome'}
                        </div>

                        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                          <span className="inline-flex items-center gap-1">
                            <Calendar size={12} />
                            {formatDate(item.publishedAt)}
                          </span>
                          <span>Publicado por: {item.publishedBy || 'sistema'}</span>
                        </div>

                        {item.description ? (
                          <p className="text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words">
                            {item.description}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onRestore(item)}
                          disabled={!canRollback}
                          className="px-3 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white inline-flex items-center gap-2"
                        >
                          <RotateCcw size={15} />
                          Restaurar
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const PublishHistoryModal = ({ state, canRollback, onClose, onRestore }) => (
  <OperationalModal open={state.open} onClose={onClose} size="xl" title="Historico de publicacoes" bodyClassName="bg-slate-100 dark:bg-slate-950">
    <div className="mx-auto max-w-5xl px-4 py-7 sm:px-6 sm:py-9">
      <header className="border-b border-gray-200 pb-7 dark:border-gray-800">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Controle de versoes</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-gray-950 dark:text-white">{state.flow?.name || 'Fluxo'}</h2>
        <p className="mt-2 text-sm text-gray-500">{state.items.length} publicacao(oes) registrada(s)</p>
      </header>

      <div className="py-7">
        {state.loading ? (
          <div className="space-y-4">{Array.from({ length: 4 }).map((_, index) => <div key={`history_loading_${index}`} className="border-b border-gray-200 py-4 dark:border-gray-800"><SkeletonBox className="h-4 w-56" /><SkeletonBox className="mt-3 h-4 w-full" /></div>)}</div>
        ) : state.items.length === 0 ? (
          <div className="flex min-h-[240px] items-center justify-center border-y border-gray-200 text-sm text-gray-400 dark:border-gray-800">Nenhuma publicacao encontrada para este fluxo.</div>
        ) : (
          <div>
            {!canRollback && <div className="mb-5 border-l-2 border-blue-600 bg-white px-4 py-3 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300">Seu nivel de acesso permite consultar, mas nao restaurar versoes.</div>}
            <div className="border-y border-gray-200 dark:border-gray-800">
              {state.items.map((item, index) => {
                const isCurrent = state.currentPublishedVersion && item.version === state.currentPublishedVersion;
                return (
                  <div key={item.id} className={`grid gap-4 py-4 sm:grid-cols-[90px_minmax(220px,1fr)_minmax(180px,0.8fr)_auto] sm:items-center ${index ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}>
                    <div><strong className="text-lg font-semibold text-gray-950 dark:text-white">v{item.version}</strong><div className="mt-1 flex items-center gap-2 text-[11px] text-gray-400"><span className={`h-1.5 w-1.5 ${isCurrent ? 'bg-blue-600' : 'bg-gray-300'}`} />{isCurrent ? 'Atual' : 'Anterior'}</div></div>
                    <div className="min-w-0"><p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{item.name || state.flow?.name || 'Fluxo sem nome'}</p><p className="mt-1 truncate text-xs text-gray-500">{item.description || 'Sem descricao registrada'}</p>{item.changeSummary && <><p className="mt-1 font-mono text-[10px] text-blue-700 dark:text-blue-300">Nodes: +{item.changeSummary.nodesAdded || 0} / ~{item.changeSummary.nodesChanged || 0} / -{item.changeSummary.nodesRemoved || 0}</p><p className="mt-0.5 font-mono text-[10px] text-gray-400">Conexoes: +{item.changeSummary.edgesAdded || 0} / ~{item.changeSummary.edgesChanged || 0} / -{item.changeSummary.edgesRemoved || 0}</p></>}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400"><p>{formatDate(item.publishedAt)}</p><p className="mt-1">Por {item.publishedBy || 'sistema'}{item.restoredFromVersion ? ` / restaurada da v${item.restoredFromVersion}` : ''}</p></div>
                    <button type="button" onClick={() => onRestore(item)} disabled={!canRollback || isCurrent} className="inline-flex h-9 items-center gap-2 justify-self-start border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 sm:justify-self-end"><RotateCcw size={14} /> Restaurar</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  </OperationalModal>
);

const NODE_LABELS = {
  startNode: 'Inicio', finalNode: 'Finalizacao', messageNode: 'Mensagem', inputNode: 'Entrada',
      holderNode: 'Holder', menuNode: 'Menu', mediaNode: 'Midia', catalogNode: 'Catalogo', cartNode: 'Carrinho',
  ratingNode: 'Avaliacao', templateNode: 'Template', whatsappTemplateNode: 'WhatsApp template',
  conditionNode: 'Condicional', caseNode: 'Case', delayNode: 'Delay', scheduleNode: 'Horario',
  sequentialNode: 'Sequencial', setValueNode: 'Definir variavel', secretNode: 'Secret',
  scriptNode: 'Script', commandNode: 'Comando', httpRequestNode: 'API HTTP', queueNode: 'Fila',
  anchorNode: 'Ancora', gotoNode: 'Ir para'
};

const FlowDetailSurface = ({ state, onClose, onEdit, onHistory, onRename, onExport, onDelete, readOnly = false }) => {
  const flow = state.flow;
  const snapshot = flow?.editorSnapshot || flow?.draft || flow?.published || { nodes: [], edges: [], visualBlocks: [] };
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  const visualBlocks = Array.isArray(snapshot.visualBlocks) ? snapshot.visualBlocks : [];
  const typeCounts = nodes.reduce((counts, node) => ({ ...counts, [node.type]: (counts[node.type] || 0) + 1 }), {});
  const nodeIds = new Set(nodes.map((node) => node.id));
  const connectedIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const disconnected = nodes.filter((node) => node.type !== 'startNode' && !connectedIds.has(node.id)).length;
  const brokenEdges = edges.filter((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target)).length;
  const finalCount = Number(typeCounts.finalNode || 0) + Number(typeCounts.endNode || 0);
  const branchCount = ['conditionNode', 'menuNode', 'scheduleNode', 'httpRequestNode'].reduce((total, type) => total + Number(typeCounts[type] || 0), 0);
  const integrationCount = ['httpRequestNode', 'whatsappTemplateNode', 'templateNode', 'mediaNode', 'catalogNode'].reduce((total, type) => total + Number(typeCounts[type] || 0), 0);
  const diagnostics = [
    !typeCounts.startNode ? 'Fluxo sem node inicial.' : null,
    !finalCount ? 'Fluxo sem finalizacao explicita.' : null,
    disconnected ? `${disconnected} node(s) sem conexao.` : null,
    brokenEdges ? `${brokenEdges} conexao(oes) com referencia invalida.` : null
  ].filter(Boolean);

  return (
    <OperationalModal open={state.open} onClose={onClose} size="xl" title="Detalhes do fluxo" bodyClassName="bg-slate-100 dark:bg-slate-950">
      {state.loading ? (
        <div className="space-y-4 p-6 sm:p-8"><SkeletonBox className="h-10 w-72" /><SkeletonBox className="h-28 w-full" /><SkeletonBox className="h-64 w-full" /></div>
      ) : flow ? (
        <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-9">
          <header className="flex flex-col gap-5 border-b border-gray-200 pb-7 dark:border-gray-800 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-gray-400"><span className={`h-2 w-2 ${flow.published ? 'bg-blue-600' : 'bg-gray-300'}`} />{flow.published ? 'Publicado' : 'Rascunho'}</div>
              <h2 className="mt-3 truncate text-3xl font-semibold tracking-tight text-gray-950 dark:text-white">{flow.name || 'Fluxo sem nome'}</h2>
              <p className="mt-2 font-mono text-xs text-gray-400">{flow.id}</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {!readOnly && <button type="button" onClick={onRename} className="h-9 border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">Renomear</button>}
              <button type="button" onClick={onExport} className="h-9 border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">Exportar</button>
              <button type="button" onClick={onHistory} className="h-9 border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-600 transition hover:border-blue-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">Publicacoes</button>
              {!readOnly && <button type="button" onClick={onDelete} className="h-9 border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-500 transition hover:border-blue-400 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400 dark:hover:text-white">Excluir</button>}
              <button type="button" onClick={onEdit} className="h-9 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700">{readOnly ? 'Ver fluxo' : 'Abrir editor'}</button>
            </div>
          </header>

          <section className="grid grid-cols-2 divide-x divide-y divide-gray-200 border-b border-gray-200 dark:divide-gray-800 dark:border-gray-800 lg:grid-cols-5 lg:divide-y-0">
            {[
              ['Nodes', nodes.length], ['Conexoes', edges.length], ['Ramificacoes', branchCount], ['Integracoes', integrationCount], ['Blocos visuais', visualBlocks.length]
            ].map(([label, value]) => <div key={label} className="px-4 py-5 first:pl-0"><span className="text-xs text-gray-500 dark:text-gray-400">{label}</span><strong className="mt-2 block text-2xl font-semibold text-gray-950 dark:text-white">{value}</strong></div>)}
          </section>

          <div className="grid gap-10 py-8 lg:grid-cols-[1.35fr_0.8fr]">
            <div className="space-y-9">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Composicao</h3>
                <div className="mt-4 border-y border-gray-200 dark:border-gray-800">
                  {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count], index) => (
                    <div key={type} className={`flex items-center justify-between py-3 text-sm ${index ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}>
                      <span className="text-gray-700 dark:text-gray-200">{NODE_LABELS[type] || type}</span><strong className="font-mono text-xs text-gray-500">{count}</strong>
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Execucao</h3>
                <div className="mt-4 border border-gray-200 bg-white px-5 py-6 dark:border-gray-800 dark:bg-gray-900">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-100">Telemetria por fluxo em preparacao</p>
                  <p className="mt-2 text-sm leading-6 text-gray-500">Volume, conclusao, abandono, caminhos e erros serao carregados nesta area sem aumentar o peso da listagem.</p>
                </div>
              </section>
            </div>

            <aside className="space-y-8">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Publicacao</h3>
                <dl className="mt-4 divide-y divide-gray-200 border-y border-gray-200 text-sm dark:divide-gray-800 dark:border-gray-800">
                  {[
                    ['Versao do editor', `v${flow.version || 1}`],
                    ['Versao publicada', flow.published?.version ? `v${flow.published.version}` : 'Nao publicada'],
                    ['Ultima publicacao', formatDate(flow.published?.publishedAt)],
                    ['Ultima alteracao', formatDate(flow.updatedAt)]
                  ].map(([label, value]) => <div key={label} className="flex justify-between gap-4 py-3"><dt className="text-gray-500">{label}</dt><dd className="text-right font-medium text-gray-800 dark:text-gray-200">{value}</dd></div>)}
                </dl>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-400">Diagnostico estrutural</h3>
                <div className="mt-4 border-y border-gray-200 dark:border-gray-800">
                  {diagnostics.length ? diagnostics.map((message, index) => <div key={message} className={`flex gap-3 py-3 text-sm text-gray-600 dark:text-gray-300 ${index ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}><AlertCircle size={16} className="mt-0.5 shrink-0 text-blue-600" />{message}</div>) : <div className="flex gap-3 py-4 text-sm text-gray-700 dark:text-gray-200"><CheckCircle2 size={17} className="text-blue-600" />Estrutura basica consistente.</div>}
                </div>
              </section>
            </aside>
          </div>
        </div>
      ) : <div className="p-8 text-sm text-gray-500">Nao foi possivel carregar o fluxo.</div>}
    </OperationalModal>
  );
};

const FlowList = () => {
  const { prompt } = useDialog();
  const [flows, setFlows] = useState([]);
  const [channelLabels, setChannelLabels] = useState(new Map());
  const [routingError, setRoutingError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [flowDetail, setFlowDetail] = useState({ open: false, loading: false, flow: null });
  const [renamingFlowId, setRenamingFlowId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [historyModal, setHistoryModal] = useState({
    open: false,
    flow: null,
    items: [],
    loading: false,
    currentPublishedVersion: null
  });
  const [passwordModal, setPasswordModal] = useState({
    open: false,
    mode: null,
    flow: null,
    historyItem: null,
    password: '',
    busy: false,
    title: '',
    subtitle: '',
    message: '',
    confirmLabel: ''
  });
  const fileInputRef = useRef(null);
  const navigate = useNavigate();
  const { user } = useAuth();
  const canRollback = ['ADMIN', 'SUPER_ADMIN'].includes(user?.role);
  // Gestor sem a permissao "fluxos" so consulta: ve a lista, os detalhes e o
  // editor, sem criar, renomear, excluir nem restaurar.
  const canEditFlows = hasManagerPermission(user, 'fluxos');

  useEffect(() => {
    if (!canRollback) return undefined;
    let controller;
    const loadRoutes = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      try {
        const response = await apiRequest('/channels', { signal });
        if (!response?.ok) throw new Error('routing_unavailable');
        const config = await response.json();
        if (!signal.aborted) { setChannelLabels(flowChannelLabels(config)); setRoutingError(false); }
      } catch {
        if (!signal.aborted) { setChannelLabels(new Map()); setRoutingError(true); }
      }
    };
    void loadRoutes();
    window.addEventListener('focus', loadRoutes);
    return () => { controller?.abort(); window.removeEventListener('focus', loadRoutes); };
  }, [canRollback]);

  const fetchFlows = async () => {
    try {
      setLoading(true);
      const data = await getJSON('/flows?limit=200&page=1');
      const list = Array.isArray(data) ? data : (data?.items || []);
      setFlows(list);
    } catch (error) {
      console.error('Erro ao buscar fluxos:', error);
      toast.error('Erro ao carregar fluxos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFlows();
  }, []);

  const filteredFlows = useMemo(() => (
    flows.filter((flow) => {
      const flowName = String(flow?.name || '').toLowerCase();
      const flowId = String(flow?.id || '');
      const query = searchTerm.toLowerCase();
      const matchesSearch = flowName.includes(query) || flowId.includes(query);
      const matchesStatus = statusFilter === 'all'
        || (statusFilter === 'published' && Boolean(flow.published))
        || (statusFilter === 'draft' && !flow.published)
        || (statusFilter === 'pending' && Boolean(flow.hasDraftChanges));
      return matchesSearch && matchesStatus;
    })
  ), [flows, searchTerm, statusFilter]);

  const flowSummary = useMemo(() => flows.reduce((summary, flow) => ({
    total: summary.total + 1,
    published: summary.published + (flow.published ? 1 : 0),
    pending: summary.pending + (flow.hasDraftChanges ? 1 : 0),
    nodes: summary.nodes + Number(flow.nodeCount || 0),
    integrations: summary.integrations + Number(flow.integrationNodeCount || 0)
  }), { total: 0, published: 0, pending: 0, nodes: 0, integrations: 0 }), [flows]);

  const closePasswordModal = (force = false) => {
    if (!force && passwordModal.busy) return;
    setPasswordModal({
      open: false,
      mode: null,
      flow: null,
      historyItem: null,
      password: '',
      busy: false,
      title: '',
      subtitle: '',
      message: '',
      confirmLabel: ''
    });
  };

  const openDeleteModal = (flow) => {
    setPasswordModal({
      open: true,
      mode: 'delete',
      flow,
      historyItem: null,
      password: '',
      busy: false,
      title: 'Excluir fluxo',
      subtitle: flow?.name || 'Fluxo sem nome',
      message: `Digite sua senha para excluir permanentemente o fluxo "${flow?.name || flow?.id}".`,
      confirmLabel: 'Excluir fluxo'
    });
  };

  const openRollbackModal = (flow, historyItem) => {
    setPasswordModal({
      open: true,
      mode: 'rollback',
      flow,
      historyItem,
      password: '',
      busy: false,
      title: 'Restaurar publicação',
      subtitle: `${flow?.name || 'Fluxo'} · v${historyItem?.version || '?'}`,
      message: `Digite sua senha para restaurar a publicação v${historyItem?.version || '?'} deste fluxo.`,
      confirmLabel: 'Restaurar versão'
    });
  };

  const handleCreateFlow = async () => {
    const name = await prompt({
      title: 'Novo fluxo',
      message: 'Informe um nome para o novo fluxo.',
      placeholder: 'Ex: Atendimento Inicial',
      confirmText: 'Criar fluxo',
      type: 'info',
    });
    if (!name || name.trim() === '') return;

    try {
      const newFlow = await postJSON('/flows', { name: name.trim() });
      if (newFlow?.id) {
        toast.success('Fluxo criado!');
        navigate(`/editor/${newFlow.id}`);
      }
    } catch (error) {
      toast.error('Erro ao criar fluxo.');
    }
  };

  const openFlowDetail = async (flow) => {
    setFlowDetail({ open: true, loading: true, flow });
    try {
      const full = await getJSON(`/flows/${flow.id}`);
      setFlowDetail({ open: true, loading: false, flow: { ...flow, ...full } });
    } catch (error) {
      setFlowDetail({ open: true, loading: false, flow });
      toast.error('Nao foi possivel carregar todos os detalhes do fluxo');
    }
  };

  const startRename = (flow) => {
    setRenamingFlowId(flow.id);
    setRenameValue(flow.name || '');
  };

  const cancelRename = () => {
    if (renameSaving) return;
    setRenamingFlowId(null);
    setRenameValue('');
  };

  const submitRename = async (flow) => {
    const trimmedName = renameValue.trim();
    if (!trimmedName) {
      toast.error('Informe um nome valido para o fluxo.');
      return;
    }

    if (trimmedName === flow.name) {
      cancelRename();
      return;
    }

    try {
      setRenameSaving(true);
      const response = await apiRequest(`/flows/${flow.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: trimmedName })
      });
      if (!response?.ok) {
        throw new Error(await readErrorMessage(response, 'Erro ao atualizar nome do fluxo'));
      }
      const updated = await response.json();
      setFlows((current) => current.map((item) => (
        item.id === flow.id
          ? { ...item, ...updated, name: updated?.name || trimmedName }
          : item
      )));
      toast.success('Nome do fluxo atualizado');
      setRenamingFlowId(null);
      setRenameValue('');
    } catch (error) {
      toast.error(error.message || 'Erro ao atualizar nome do fluxo');
    } finally {
      setRenameSaving(false);
    }
  };

  const renameFromDetail = async () => {
    const flow = flowDetail.flow;
    if (!flow) return;
    const name = await prompt({
      title: 'Renomear fluxo',
      message: 'Informe o novo nome do fluxo.',
      placeholder: flow.name || 'Nome do fluxo',
      defaultValue: flow.name || '',
      confirmText: 'Salvar nome',
      type: 'info'
    });
    const trimmedName = String(name || '').trim();
    if (!trimmedName || trimmedName === flow.name) return;
    try {
      const response = await apiRequest(`/flows/${flow.id}`, { method: 'PUT', body: JSON.stringify({ name: trimmedName }) });
      if (!response?.ok) throw new Error(await readErrorMessage(response, 'Erro ao atualizar nome do fluxo'));
      const updated = await response.json();
      setFlows((current) => current.map((item) => item.id === flow.id ? { ...item, ...updated, name: trimmedName } : item));
      setFlowDetail((current) => ({ ...current, flow: { ...current.flow, ...updated, name: trimmedName } }));
      toast.success('Nome do fluxo atualizado');
    } catch (error) {
      toast.error(error.message || 'Erro ao atualizar nome do fluxo');
    }
  };

  const handleExportFlow = async (flow) => {
    try {
      const full = await getJSON(`/flows/${flow.id}?export=1`);
      const payload = {
        name: full.name,
        description: full.description || '',
        draft: full.draft || null,
        published: full.published || null
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${flow.name || flow.id}.onionflow.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Fluxo exportado');
    } catch (error) {
      toast.error('Erro ao exportar fluxo');
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  // Fluxo exportado de outro tenant traz ids que so valem la: interactive (que
  // ganha id novo ao ser importado) e remetente fixado no no.
  const adaptImportedNodes = async (nodes) => {
    let next = nodes;
    if (next.some((node) => node?.data?.interactiveTemplateId)) {
      try {
        const data = await getJSON('/templates/whatsapp/interactive');
        if (Array.isArray(data?.items)) next = remapInteractiveRefs(next, data.items);
      } catch {
        // Sem a lista, as referencias ficam como vieram.
      }
    }
    if (next.some((node) => node?.data?.senderPhoneNumberId)) {
      try {
        const data = await getJSON('/templates/whatsapp');
        const channel = data?.channelConfig;
        if (channel) {
          const senderIds = [channel.phoneNumberId, ...(Array.isArray(channel.senderNumbers) ? channel.senderNumbers : []).map((sender) => sender?.phoneNumberId)];
          next = clearForeignSenders(next, senderIds);
        }
      } catch {
        // Sem a lista, o envio cai no remetente da conversa.
      }
    }
    return next;
  };

  const handleImportFlow = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const data = JSON.parse(raw);
      const baseName = String(data?.name || 'Fluxo Importado').trim() || 'Fluxo Importado';
      const name = `${baseName} (importado)`;
      const snapshot = data?.draft || data?.published || null;
      const rawNodes = snapshot?.nodes || data?.nodes || [];
      const edges = snapshot?.edges || data?.edges || [];

      if (!Array.isArray(rawNodes) || !Array.isArray(edges)) {
        throw new Error('Arquivo invalido');
      }
      const nodes = await adaptImportedNodes(rawNodes);

      const newFlow = await postJSON('/flows', { name, description: data?.description || '' });
      if (!newFlow?.id) throw new Error('Falha ao criar fluxo');

      await putJSON(`/flows/${newFlow.id}`, {
        name,
        description: data?.description || '',
        nodes,
        edges,
        status: 'draft',
        published: null
      });

      toast.success('Fluxo importado');
      navigate(`/editor/${newFlow.id}`);
    } catch (error) {
      toast.error(error.message || 'Erro ao importar fluxo');
    } finally {
      event.target.value = '';
    }
  };

  const openPublishHistory = async (flow) => {
    setHistoryModal({
      open: true,
      flow,
      items: [],
      loading: true,
      currentPublishedVersion: flow?.published?.version || null
    });

    try {
      const response = await apiRequest(`/flows/${flow.id}/publish-history`);
      if (!response?.ok) {
        throw new Error(await readErrorMessage(response, 'Erro ao carregar histórico de publicações'));
      }
      const data = await response.json();
      setHistoryModal({
        open: true,
        flow,
        items: Array.isArray(data?.items) ? data.items : [],
        loading: false,
        currentPublishedVersion: data?.currentPublishedVersion || null
      });
    } catch (error) {
      setHistoryModal({
        open: true,
        flow,
        items: [],
        loading: false,
        currentPublishedVersion: flow?.published?.version || null
      });
      toast.error('Erro ao carregar histórico de publicações');
    }
  };

  const handlePasswordConfirm = async () => {
    if (!passwordModal.password.trim() || passwordModal.busy) return;

    try {
      setPasswordModal((current) => ({ ...current, busy: true }));

      if (passwordModal.mode === 'delete') {
        const response = await apiRequest(`/flows/${passwordModal.flow.id}`, {
          method: 'DELETE',
          body: JSON.stringify({ password: passwordModal.password })
        });
        if (!response?.ok) {
          throw new Error(await readErrorMessage(response, 'Nao foi possivel excluir o fluxo'));
        }
        setFlows((current) => current.filter((item) => item.id !== passwordModal.flow.id));
        toast.success('Fluxo excluido');
        closePasswordModal(true);
        return;
      }

      if (passwordModal.mode === 'rollback') {
        const response = await apiRequest(`/flows/${passwordModal.flow.id}/rollback`, {
          method: 'POST',
          body: JSON.stringify({
            historyId: passwordModal.historyItem.id,
            password: passwordModal.password
          })
        });
        if (!response?.ok) {
          throw new Error(await readErrorMessage(response, 'Nao foi possivel restaurar a publicação'));
        }
        toast.success(`Fluxo restaurado para a versão v${passwordModal.historyItem.version}`);
        closePasswordModal(true);
        setHistoryModal((current) => ({ ...current, open: false }));
        await fetchFlows();
      }
    } catch (error) {
      toast.error(error.message || 'Nao foi possivel concluir a acao');
      setPasswordModal((current) => ({ ...current, busy: false }));
    }
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl space-y-6 p-3 sm:p-4 lg:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="space-y-2">
            <SkeletonBox className="h-6 w-56" />
            <SkeletonBox className="h-4 w-72" />
          </div>
          <SkeletonBox className="h-10 w-full sm:w-40" />
        </div>

        <SkeletonBox className="h-12 w-full" />

        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="p-4 space-y-3">
            <SkeletonBox className="h-4 w-64" />
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={`flow_row_${index}`} className="grid grid-cols-4 gap-4">
                <SkeletonBox className="h-4 col-span-2" />
                <SkeletonBox className="h-4" />
                <SkeletonBox className="h-4" />
              </div>
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <>
      <main className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">
              Fluxos de conversa
            </h1>
          </div>
          {canEditFlows && <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <button
              onClick={handleImportClick}
              className="flex h-10 w-full items-center justify-center gap-2 border border-gray-200 bg-white px-4 text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-950 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300 dark:hover:text-white sm:w-auto"
            >
              <Upload size={18} /> Importar
            </button>
            <button
              onClick={handleCreateFlow}
              className="flex h-10 w-full items-center justify-center gap-2 bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 sm:w-auto"
            >
              <Plus size={18} /> Novo Fluxo
            </button>
          </div>}
        </div>

        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
          className="border-y border-gray-200 dark:border-gray-700 grid grid-cols-2 lg:grid-cols-5"
        >
          {[
            { label: 'Fluxos', value: flowSummary.total, icon: Workflow },
            { label: 'Publicados', value: flowSummary.published, icon: CheckCircle2 },
            { label: 'Com pendencias', value: flowSummary.pending, icon: AlertCircle },
            { label: 'Nodes mapeados', value: flowSummary.nodes, icon: Boxes },
            { label: 'Integracoes', value: flowSummary.integrations, icon: Activity }
          ].map((item, index) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className={`px-4 py-4 ${index > 0 ? 'border-l border-gray-200 dark:border-gray-700' : ''}`}>
                <div className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                  <Icon size={14} className="text-blue-600" />
                  {item.label}
                </div>
                <strong className="mt-2 block text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">{item.value}</strong>
              </div>
            );
          })}
        </motion.section>

        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar fluxo por nome ou ID..."
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              className="h-11 w-full border border-gray-200 bg-white pl-10 pr-4 text-sm outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
          </div>
          <div className="flex items-center overflow-x-auto border border-gray-200 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-900/30">
            {[
              ['all', 'Todos'],
              ['published', 'Publicados'],
              ['pending', 'Pendentes'],
              ['draft', 'Rascunhos']
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatusFilter(value)}
                className={`px-3 py-2 text-xs font-semibold whitespace-nowrap transition-colors ${statusFilter === value ? 'bg-white text-blue-700 shadow-sm dark:bg-gray-700 dark:text-blue-300' : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <section>
          <div className="mb-3 flex items-end justify-between gap-4">
            <h2 className="text-sm font-semibold text-gray-950 dark:text-white">Fluxos configurados</h2>
            <span className="text-xs text-gray-400">{filteredFlows.length} resultado(s)</span>
          </div>
          {routingError && <p role="status" className="mb-3 text-xs text-gray-500">Nao foi possivel consultar o roteamento dos canais.</p>}
          <div className="overflow-hidden border-y border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/20">
            {filteredFlows.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-gray-500">Nenhum fluxo encontrado.</div>
            ) : filteredFlows.map((flow, index) => (
              <div key={`operational_${flow.id}`} className={`grid gap-4 px-1 py-4 transition-colors hover:bg-gray-50 dark:hover:bg-gray-900/40 sm:grid-cols-[minmax(240px,1fr)_160px_minmax(220px,0.8fr)_auto] sm:items-center sm:px-4 ${index ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{flow.name}</p>
                  {channelLabels.get(flow.id)?.map((label) => <p key={label} className="mt-1 text-xs text-slate-500 dark:text-slate-400 break-words">Roteado para canal {label}</p>)}
                  <p className="mt-1 truncate font-mono text-[11px] text-gray-400 sm:hidden">{flow.id}</p>
                </div>
                <div className="flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-200">
                  <span className={`h-2 w-2 ${flow.published ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`} />
                  {flow.published ? 'Publicado' : 'Rascunho'}
                </div>
                <p className="hidden truncate font-mono text-[11px] text-gray-400 sm:block">{flow.id}</p>
                <button type="button" onClick={() => openFlowDetail(flow)} className="inline-flex h-8 items-center justify-center gap-1.5 justify-self-start border border-gray-200 px-3 text-xs font-semibold text-gray-500 transition hover:border-blue-400 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:text-white sm:justify-self-end">
                  Detalhes <ChevronRight size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <div className="hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left min-w-[1120px]">
              <thead className="bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 uppercase font-medium">
                <tr>
                  <th className="px-6 py-3">Nome</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Estrutura</th>
                  <th className="px-6 py-3">Operacao</th>
                  <th className="px-6 py-3">Versao</th>
                  <th className="px-6 py-3">Atualizacao</th>
                  <th className="px-6 py-3">ID</th>
                  <th className="px-6 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {filteredFlows.length === 0 ? (
                  <tr>
                    <td colSpan="8" className="px-6 py-12 text-center text-gray-500 dark:text-gray-400">
                      Nenhum fluxo encontrado.
                    </td>
                  </tr>
                ) : (
                  filteredFlows.map((flow) => {
                    const isRenaming = renamingFlowId === flow.id;
                    return (
                      <tr key={flow.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                        <td className="px-6 py-4 font-medium text-gray-900 dark:text-white">
                          {isRenaming ? (
                            <div className="flex items-center gap-2 max-w-md">
                              <input
                                type="text"
                                value={renameValue}
                                onChange={(event) => setRenameValue(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    submitRename(flow);
                                  }
                                  if (event.key === 'Escape') {
                                    cancelRename();
                                  }
                                }}
                                className="flex-1 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
                                autoFocus
                              />
                              <button
                                type="button"
                                onClick={() => submitRename(flow)}
                                disabled={renameSaving}
                                className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                                title="Salvar nome"
                              >
                                {renameSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                              </button>
                              <button
                                type="button"
                                onClick={cancelRename}
                                disabled={renameSaving}
                                className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                                title="Cancelar"
                              >
                                <X size={16} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="break-words">{flow.name}</span>
                              <button
                                type="button"
                                onClick={() => startRename(flow)}
                                className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                                title="Renomear fluxo"
                              >
                                <Pencil size={14} />
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center gap-2 text-xs font-medium text-gray-700 dark:text-gray-200">
                            <span className={`h-2 w-2 ${flow.published ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`} />
                            {flow.published ? 'Publicado' : 'Rascunho'}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-4 text-xs text-gray-600 dark:text-gray-300">
                            <span className="inline-flex items-center gap-1.5" title="Nodes"><Boxes size={14} /> {flow.nodeCount || 0}</span>
                            <span className="inline-flex items-center gap-1.5" title="Conexoes"><GitBranch size={14} /> {flow.edgeCount || 0}</span>
                          </div>
                          <div className="mt-1.5 text-[11px] text-gray-400">{flow.branchNodeCount || 0} ramificacoes</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-xs font-medium text-gray-700 dark:text-gray-200">{flow.integrationNodeCount || 0} integracoes</div>
                          <div className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-gray-400"><Send size={12} /> {flow.humanHandoffNodeCount || 0} handoffs</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-xs font-semibold text-gray-800 dark:text-gray-200">v{flow.published?.version || flow.version || 1}</div>
                          <div className={`mt-1.5 text-[11px] ${flow.hasDraftChanges ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400'}`}>
                            {flow.hasDraftChanges ? 'Alteracoes pendentes' : `${flow.publishHistoryCount || 0} publicacoes`}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-xs text-gray-500 dark:text-gray-400">
                          {formatDate(flow.updatedAt)}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-gray-500 dark:text-gray-400">
                          {flow.id}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => openFlowDetail(flow)}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-xs font-semibold text-gray-500 transition hover:border-gray-300 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:text-white"
                            >
                              Detalhes <ChevronRight size={13} />
                            </button>
                            <button
                              onClick={() => handleExportFlow(flow)}
                              className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-colors"
                              title="Exportar"
                            >
                              <Download size={16} />
                            </button>
                            <button
                              onClick={() => openPublishHistory(flow)}
                              className="p-2 text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-colors"
                              title="Histórico de publicações"
                            >
                              <History size={16} />
                            </button>
                            <button
                              onClick={() => navigate(`/editor/${flow.id}`)}
                              className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                              title={canEditFlows ? 'Abrir editor' : 'Ver fluxo'}
                            >
                              <Edit3 size={16} />
                            </button>
                            {canEditFlows && <button
                              onClick={() => openDeleteModal(flow)}
                              className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                              title="Excluir"
                            >
                              <Trash2 size={16} />
                            </button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={handleImportFlow}
        />
      </main>

      <FlowDetailSurface
        state={flowDetail}
        onClose={() => setFlowDetail({ open: false, loading: false, flow: null })}
        onEdit={() => {
          if (flowDetail.flow?.id) navigate(`/editor/${flowDetail.flow.id}`);
        }}
        onRename={renameFromDetail}
        readOnly={!canEditFlows}
        onExport={() => {
          if (flowDetail.flow) handleExportFlow(flowDetail.flow);
        }}
        onDelete={() => {
          if (!flowDetail.flow) return;
          const selected = flowDetail.flow;
          setFlowDetail({ open: false, loading: false, flow: null });
          openDeleteModal(selected);
        }}
        onHistory={() => {
          if (!flowDetail.flow) return;
          const selected = flowDetail.flow;
          setFlowDetail({ open: false, loading: false, flow: null });
          openPublishHistory(selected);
        }}
      />

      <PublishHistoryModal
        state={historyModal}
        canRollback={canEditFlows}
        onClose={() => setHistoryModal((current) => ({ ...current, open: false }))}
        onRestore={(historyItem) => {
          if (!canEditFlows) {
            toast.error('Somente Admin e Super Admin podem restaurar publicações.');
            return;
          }
          openRollbackModal(historyModal.flow, historyItem);
        }}
      />

      <PasswordConfirmModal
        state={passwordModal}
        onClose={closePasswordModal}
        onChangePassword={(password) => setPasswordModal((current) => ({ ...current, password }))}
        onConfirm={handlePasswordConfirm}
      />
    </>
  );
};

export default FlowList;
