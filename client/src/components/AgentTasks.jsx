import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, RefreshCw, ClipboardList, Check, Play, Plus } from 'lucide-react';
import CreateTaskModal from './CreateTaskModal';
import { apiRequest } from '../services/api';
import '../styles/agent-tasks.css';

const states = { pending: 'Pendentes', in_progress: 'Em andamento', completed: 'Concluidas', cancelled: 'Canceladas' };
const stateLabel = { pending: 'Pendente', in_progress: 'Em andamento', completed: 'Concluida', cancelled: 'Cancelada' };
const priorities = { low: 'Baixa', normal: 'Normal', high: 'Alta' };
const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '-';
async function taskRequest(path, options) {
  const response = await apiRequest(`/tasks/internal${path}`, options);
  if (!response) throw new Error('Sessao indisponivel.');
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Nao foi possivel carregar as tarefas.'), { status: response.status });
  return data;
}

export default function AgentTasks({ user, tenantId = user.tenantId }) {
  const [creating, setCreating] = useState(false);
  const canCreate = ['ADMIN', 'SUPER_ADMIN'].includes(user.role) && tenantId && tenantId !== 'super_admin';
  const request = (path, options) => taskRequest(`${path}${path.includes('?') ? '&' : '?'}tenantId=${encodeURIComponent(tenantId || '')}`, options);
  const reduced = useReducedMotion();
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState({ items: [], pagination: { total: 0, pages: 0 } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [task, setTask] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [acting, setActing] = useState(false);
  const [notice, setNotice] = useState('');
  const actionLock = useRef(false);
  const selection = useRef(null);
  const detailController = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; detailController.current?.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    request(`?page=${page}&limit=25${status ? `&status=${status}` : ''}`, { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setResult(data); })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, status, reload]);

  async function open(id) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    selection.current = id;
    setSelectedId(id);
    setTask(null);
    setNotice('');
    setDetailError('');
    setDetailLoading(true);
    try {
      const data = await request(`/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!controller.signal.aborted) setTask(data);
    } catch (err) {
      if (!controller.signal.aborted) setDetailError(err.message);
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }

  async function act(action) {
    if (actionLock.current || !task) return;
    actionLock.current = true;
    setActing(true);
    setDetailError('');
    const id = task.id;
    try {
      const updated = await request(`/${encodeURIComponent(id)}/actions`, {
        method: 'POST', body: JSON.stringify({ action, version: task.version })
      });
      if (!mounted.current) return;
      if (selection.current === id) {
        setTask(updated);
        setNotice(action === 'claim' ? 'Tarefa assumida.' : 'Tarefa concluida.');
      }
      setReload((value) => value + 1);
    } catch (err) {
      if (!mounted.current) return;
      if ([404, 409].includes(err.status)) {
        await open(id);
        if (mounted.current) setReload((value) => value + 1);
      }
      if (mounted.current && selection.current === id) setDetailError(err.message);
    } finally {
      actionLock.current = false;
      if (mounted.current) setActing(false);
    }
  }

  const mine = task?.assignedTo === user.id;
  const canClaim = user.role === 'AGENT' && task?.status === 'pending' && (!task.assignedTo || mine);
  const canComplete = task?.status === 'in_progress' && ((user.role === 'AGENT' && mine) || ['ADMIN', 'SUPER_ADMIN'].includes(user.role));
  return (
    <motion.section className={`agent-tasks ${selectedId ? 'has-detail' : ''}`} aria-label="Tarefas internas"
      initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }}>
      <aside className="task-list">
        <header className="task-list-header">
          <h2>Tarefas <span>{result.pagination.total}</span></h2>
          {canCreate && <button type="button" className="task-new" disabled={acting} onClick={() => setCreating(true)}><Plus size={14} />Nova tarefa</button>}
          <button type="button" aria-label="Atualizar tarefas" disabled={loading || acting} onClick={() => { setReload((v) => v + 1); if (selectedId) void open(selectedId); }}><RefreshCw size={16} /></button>
        </header>
        <label className="task-filter">Status
          <select value={status} disabled={acting} onChange={(e) => { setStatus(e.target.value); setPage(1); setResult({ items: [], pagination: { total: 0, pages: 0 } }); }}>
            <option value="">Todas</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {error && <div className="task-feedback" role="alert">{error}<button type="button" onClick={() => setReload((v) => v + 1)}>Tentar novamente</button></div>}
        <div className="task-rows" aria-busy={loading}>
          {loading ? <p className="task-empty" role="status">Carregando tarefas...</p> : result.items.length ? result.items.map((item) => (
            <button key={item.id} type="button" className="task-row" aria-current={selectedId === item.id ? 'true' : undefined} disabled={acting} onClick={() => void open(item.id)}>
              <span className="task-row-state">{stateLabel[item.status]} <span>{priorities[item.priority]}</span></span>
              <strong>{item.title}</strong>
              <span>{item.assignedTo === user.id ? 'Atribuida a voce' : item.assignedTo ? 'Atribuida' : 'Disponivel na fila'}</span>
              {item.dueAt && <time>Prazo: {date(item.dueAt)}</time>}
            </button>
          )) : !error && <p className="task-empty">Nenhuma tarefa neste status.</p>}
        </div>
        <footer className="task-pagination">
          <button disabled={page <= 1 || loading || acting} onClick={() => setPage((v) => v - 1)}>Anterior</button>
          <span>{page} / {Math.max(page, result.pagination.pages)}</span>
          <button disabled={page >= result.pagination.pages || loading || acting} onClick={() => setPage((v) => v + 1)}>Proxima</button>
        </footer>
      </aside>
      <div className="task-detail" aria-busy={detailLoading}>
        {selectedId && <button className="task-back" disabled={acting} onClick={() => { detailController.current?.abort(); selection.current = null; setSelectedId(null); setTask(null); setDetailError(''); }}><ArrowLeft size={16} /> Voltar para tarefas</button>}
        {!selectedId ? <div className="task-placeholder"><ClipboardList size={28} strokeWidth={1.4} /><p>Selecione uma tarefa</p></div> : <>
          {detailLoading && <p className="task-empty" role="status">Carregando detalhe...</p>}
          {detailError && <div className="task-feedback" role="alert">{detailError}<button disabled={acting} onClick={() => void open(selectedId)}>Atualizar detalhe</button></div>}
          {task && <article>
            <header className="task-heading"><span>{stateLabel[task.status]}</span><h2>{task.title}</h2><code>{task.id}</code></header>
            <dl className="task-facts">
              <div><dt>Responsavel</dt><dd>{mine ? 'Voce' : task.assignedTo || 'Aguardando agente'}</dd></div>
              <div><dt>Fila</dt><dd>{task.queueId || '-'}</dd></div>
              <div><dt>Prioridade</dt><dd>{priorities[task.priority]}</dd></div>
              <div><dt>Prazo</dt><dd>{date(task.dueAt)}</dd></div>
              <div><dt>Criada em</dt><dd>{date(task.createdAt)}</dd></div>
              <div><dt>Atualizada em</dt><dd>{date(task.updatedAt)}</dd></div>
              {task.completedAt && <div><dt>Concluida em</dt><dd>{date(task.completedAt)}</dd></div>}
            </dl>
            <section className="task-description"><h3>Descricao</h3><p>{task.description || 'Sem descricao.'}</p></section>
            <footer className="task-actions">
              {notice && <span role="status">{notice}</span>}
              {canClaim && <button className="primary" disabled={acting} onClick={() => void act('claim')}><Play size={15} />{acting ? 'Aguarde...' : 'Assumir tarefa'}</button>}
              {canComplete && <button className="primary" disabled={acting} onClick={() => void act('complete')}><Check size={15} />{acting ? 'Aguarde...' : 'Concluir tarefa'}</button>}
            </footer>
          </article>}
        </>}
      </div>
      {creating && canCreate && <CreateTaskModal tenantId={tenantId} onClose={() => setCreating(false)} onCreated={(created) => {
        setCreating(false); setStatus('pending'); setPage(1); setReload((v) => v + 1); void open(created.id);
      }} />}
    </motion.section>
  );
}
