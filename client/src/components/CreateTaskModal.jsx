import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import OperationalModal from './OperationalModal';
import { apiRequest } from '../services/api';

export default function CreateTaskModal({ tenantId, onClose, onCreated }) {
  const [agents, setAgents] = useState([]);
  const [queues, setQueues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [form, setForm] = useState({ title: '', description: '', destination: 'queue', targetId: '', priority: 'normal', dueAt: '' });
  const lock = useRef(false);
  const alive = useRef(true);
  const titleRef = useRef(null);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement;
    titleRef.current?.focus();
    const trapFocus = (event) => {
      if (event.key !== 'Tab') return;
      const dialog = titleRef.current?.closest('[role=dialog]');
      if (!dialog) return;
      const elements = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => { alive.current = false; document.removeEventListener('keydown', trapFocus); previous?.focus?.(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const read = async (endpoint) => {
      const response = await apiRequest(`${endpoint}?tenantId=${encodeURIComponent(tenantId)}`, { signal: controller.signal });
      if (!response?.ok) throw new Error('Nao foi possivel carregar os agentes e filas.');
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error('Resposta invalida ao carregar destinos.');
      return data;
    };
    Promise.all([read('/users'), read('/queues')]).then(([users, queues]) => {
      if (controller.signal.aborted) return;
      setAgents(users.filter((user) => user.role === 'AGENT' && user.tenantId === tenantId));
      setQueues(queues.filter((queue) => queue.active !== false && queue.tenantId === tenantId));
    }).catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [tenantId, attempt]);

  const options = form.destination === 'queue' ? queues : agents;
  const field = (name, value) => setForm((previous) => ({ ...previous, [name]: value }));
  const close = () => { if (!lock.current) onClose(); };
  async function submit(event) {
    event.preventDefault();
    if (lock.current || loading || uncertain) return;
    if (!options.some((option) => option.id === form.targetId)) { setError('Selecione um destino valido.'); return; }
    let dueAt = null;
    if (form.dueAt) {
      const parsed = new Date(form.dueAt);
      if (!Number.isFinite(parsed.getTime())) { setError('Prazo invalido.'); return; }
      dueAt = parsed.toISOString();
    }
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const response = await apiRequest(`/tasks/internal?tenantId=${encodeURIComponent(tenantId)}`, {
        method: 'POST', body: JSON.stringify({
          title: form.title.trim(), description: form.description.trim(), priority: form.priority, dueAt,
          ...(form.destination === 'queue' ? { queueId: form.targetId } : { assignedTo: form.targetId })
        })
      });
      if (!response) throw new Error('Resposta indisponivel.');
      if (response.status >= 500) throw new Error('Resposta indisponivel.');
      const data = await response.json();
      if (!response.ok) {
        if (alive.current) setError(data.error || 'Nao foi possivel criar a tarefa.');
        return;
      }
      if (!data?.id) throw new Error('Resposta invalida.');
      if (alive.current) onCreated(data);
    } catch {
      if (alive.current) {
        setUncertain(true);
        setError('Nao foi possivel confirmar a criacao. Feche esta janela e atualize a lista antes de tentar novamente, para evitar duplicacao.');
      }
    } finally {
      lock.current = false;
      if (alive.current) setSaving(false);
    }
  }

  return createPortal(<OperationalModal open title="Nova tarefa" size="md" onClose={close}
    footer={<div className="task-create-footer"><button type="button" disabled={saving} onClick={close}>Cancelar</button><button className="primary" form="task-create-form" type="submit" disabled={saving || loading || uncertain || !options.length}>{saving ? 'Criando...' : 'Criar tarefa'}</button></div>}>
    <form id="task-create-form" className="task-create-form" onSubmit={submit}>
      {error && <div className="task-create-error" role="alert">{error}{!saving && !uncertain && !agents.length && !queues.length && <button type="button" onClick={() => setAttempt((v) => v + 1)}>Recarregar destinos</button>}</div>}
      <label>Titulo<input ref={titleRef} required maxLength={160} value={form.title} disabled={saving} onChange={(e) => field('title', e.target.value)} /></label>
      <label>Descricao<textarea rows={5} maxLength={12000} value={form.description} disabled={saving} onChange={(e) => field('description', e.target.value)} /></label>
      <div className="task-create-grid">
        <label>Encaminhar para<select value={form.destination} disabled={saving} onChange={(e) => setForm((prev) => ({ ...prev, destination: e.target.value, targetId: '' }))}><option value="queue">Fila</option><option value="agent">Agente</option></select></label>
        <label>{form.destination === 'queue' ? 'Fila' : 'Agente'}<select required value={form.targetId} disabled={saving || loading} onChange={(e) => field('targetId', e.target.value)}><option value="">{loading ? 'Carregando...' : options.length ? 'Selecione' : 'Nenhum destino disponivel'}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.name || option.username || option.id}</option>)}</select></label>
        <label>Prioridade<select value={form.priority} disabled={saving} onChange={(e) => field('priority', e.target.value)}><option value="low">Baixa</option><option value="normal">Normal</option><option value="high">Alta</option></select></label>
        <label>Prazo (opcional, horario local)<input type="datetime-local" value={form.dueAt} disabled={saving} onChange={(e) => field('dueAt', e.target.value)} /></label>
      </div>
    </form>
  </OperationalModal>, document.body);
}
