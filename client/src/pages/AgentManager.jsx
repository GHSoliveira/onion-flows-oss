import { useState, useEffect } from 'react';
import { apiRequest } from '../services/api';
import { useTenant } from '../context/TenantContext';
import { useDialog } from '../context/DialogContext';
import { useAuth } from '../context/AuthContext';
import { hasManagerPermission } from '../utils/managerPermissions';
import { Users, UserPlus, Trash2, Shield, Briefcase, Headset, Star, MessageSquareText, X, Edit, Power, PowerOff, Save, PanelRight, ChevronRight, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import OperationalModal from '../components/OperationalModal';
import { TableSkeleton } from '../components/LoadingSkeleton';

import TablePagination, { usePagination } from '../components/TablePagination';
const WEEKDAYS = [
  { value: 1, label: 'Seg' }, { value: 2, label: 'Ter' }, { value: 3, label: 'Qua' },
  { value: 4, label: 'Qui' }, { value: 5, label: 'Sex' }, { value: 6, label: 'Sab' },
  { value: 0, label: 'Dom' },
];

const AgentManager = () => {
  const emptyQueueForm = {
    name: '',
    color: '#3b82f6',
    description: '',
    entryMessage: '',
    waitingMessage: '',
    active: true
  };
  const emptyUserForm = {
    name: '', username: '', password: '', role: 'AGENT', queues: [], cargoNivel: 'A4', adicionadas: [], removidas: [],
    email: '', phone: '', avatarUrl: '', availabilityMode: 'auto', maxConcurrentChats: '',
    workSchedule: { timezone: 'America/Sao_Paulo', weekdays: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' },
    notificationPreferences: { browser: true, sound: true, email: false },
  };
  const [users, setUsers] = useState([]);
  const usersPage = usePagination(users);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyUserForm);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState(null);
  const [queues, setQueues] = useState([]);
  const [queueForm, setQueueForm] = useState(emptyQueueForm);
  const [queueModalOpen, setQueueModalOpen] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState(null);
  const [queueAgentModal, setQueueAgentModal] = useState(null);
  const [queueAgentIds, setQueueAgentIds] = useState([]);
  const [savingQueueAgents, setSavingQueueAgents] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentChats, setAgentChats] = useState([]);
  const agentChatsPage = usePagination(agentChats);
  const [agentStats, setAgentStats] = useState({ total: 0, uniqueCustomers: 0 });
  const [loadingAgentChats, setLoadingAgentChats] = useState(false);
  const [agentViewVars, setAgentViewVars] = useState([]);
  const [agentViewVarDraft, setAgentViewVarDraft] = useState('');
  const [agentViewModalOpen, setAgentViewModalOpen] = useState(false);
  const [savingAgentView, setSavingAgentView] = useState(false);
  const [quickReplies, setQuickReplies] = useState([]);
  const [quickReplyModalOpen, setQuickReplyModalOpen] = useState(false);
  const [quickReplyForm, setQuickReplyForm] = useState({ name: '', message: '', shortcut: '' });
  const { tenant } = useTenant();
  const { confirm } = useDialog();
  const { user: currentUser } = useAuth();
  const [permissionsModalOpen, setPermissionsModalOpen] = useState(false);
  // Catalogo de cargos (GET /cargos): niveis A/B/C com os nomes da empresa e o
  // que quem esta logado pode atribuir. A regra de verdade e do backend.
  const [catalogo, setCatalogo] = useState(null);
  const isManagerActor = currentUser?.role === 'MANAGER';
  const canManageTeam = hasManagerPermission(currentUser, 'equipe');
  const canManageReplies = hasManagerPermission(currentUser, 'respostas');
  const gerencia = catalogo?.ator?.gerencia || (canManageTeam ? (isManagerActor ? ['A'] : ['A', 'B', 'C']) : []);
  const nivelInfo = (codigo) => catalogo?.niveis?.find((nivel) => nivel.codigo === codigo) || null;
  const familiaDe = (target) => String(target?.cargoEfetivo?.codigo || ({ AGENT: 'A', MANAGER: 'B', ADMIN: 'C' })[target?.role] || '').charAt(0);
  const canEditUser = (target) => canManageTeam && gerencia.includes(familiaDe(target));
  const permissoesDoForm = () => {
    const base = nivelInfo(form.cargoNivel)?.permissoes || [];
    return [...new Set([...base, ...form.adicionadas])].filter((p) => !form.removidas.includes(p));
  };
  // Caixas que o ator pode marcar: tudo, se ele tem tudo; em cargo C so o que
  // ele tem; em A e B, o que os niveis da familia dao mais o que ele tem.
  const podeConceder = (permissao) => {
    const doAtor = catalogo?.ator?.permissoes || [];
    if (doAtor.includes('*') || doAtor.includes(permissao)) return true;
    const familia = form.cargoNivel.charAt(0);
    if (familia === 'C') return false;
    return (catalogo?.niveis || []).some((nivel) => nivel.familia === familia && nivel.permissoes.includes(permissao));
  };
  const alternarPermissao = (permissao) => setForm((atual) => {
    const base = nivelInfo(atual.cargoNivel)?.permissoes || [];
    if (base.includes(permissao)) {
      const removidas = atual.removidas.includes(permissao) ? atual.removidas.filter((p) => p !== permissao) : [...atual.removidas, permissao];
      return { ...atual, removidas };
    }
    const adicionadas = atual.adicionadas.includes(permissao) ? atual.adicionadas.filter((p) => p !== permissao) : [...atual.adicionadas, permissao];
    return { ...atual, adicionadas };
  });
  const escolherNivel = (codigo) => setForm((atual) => {
    const role = ({ A: 'AGENT', B: 'MANAGER', C: 'ADMIN' })[codigo.charAt(0)] || 'AGENT';
    return { ...atual, cargoNivel: codigo, role, adicionadas: [], removidas: [], queues: role === 'AGENT' ? atual.queues : [] };
  });

  useEffect(() => {
    fetchUsers();
    fetchQueues();
    fetchQuickReplies();
    (async () => {
      try {
        const res = await apiRequest('/cargos');
        if (res?.ok) setCatalogo(await res.json());
      } catch { /* sem catalogo a tela usa o papel */ }
    })();
  }, []);

  const fetchQuickReplies = async () => {
    try {
      const res = await apiRequest('/cannedResponses');
      if (res?.ok) {
        const data = await res.json();
        setQuickReplies(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      console.error('Erro ao carregar respostas rapidas:', error);
    }
  };

  const saveQuickReply = async () => {
    if (!quickReplyForm.name.trim() || !quickReplyForm.message.trim()) return toast.error('Preencha o nome e a mensagem');
    try {
      const res = await apiRequest('/cannedResponses', {
        method: 'POST',
        body: JSON.stringify({ ...quickReplyForm, name: quickReplyForm.name.trim(), message: quickReplyForm.message.trim(), shortcut: quickReplyForm.shortcut.trim() || undefined, tenantId: tenant && tenant.id !== 'super_admin' ? tenant.id : undefined }),
      });
      if (!res?.ok) throw new Error('Falha ao salvar resposta rapida');
      setQuickReplyForm({ name: '', message: '', shortcut: '' });
      setQuickReplyModalOpen(false);
      await fetchQuickReplies();
      toast.success('Resposta rapida salva');
    } catch (error) {
      toast.error(error.message || 'Falha ao salvar resposta rapida');
    }
  };

  const deleteQuickReply = async (reply) => {
    const ok = await confirm({ title: 'Excluir resposta rapida', message: `Excluir "${reply.name}" do atendimento?`, confirmText: 'Excluir', type: 'danger' });
    if (!ok) return;
    try {
      const res = await apiRequest(`/cannedResponses/${reply.id}`, { method: 'DELETE' });
      if (!res?.ok) throw new Error('Falha ao excluir resposta rapida');
      setQuickReplies((current) => current.filter((item) => item.id !== reply.id));
      toast.success('Resposta rapida removida');
    } catch (error) {
      toast.error(error.message || 'Falha ao excluir resposta rapida');
    }
  };

  useEffect(() => {
    if (!tenant?.id || tenant.id === 'super_admin') return;
    const fetchAgentViewSettings = async () => {
      const res = await apiRequest(`/tenants/${tenant.id}/settings`);
      if (!res?.ok) return;
      const settings = await res.json();
      setAgentViewVars(Array.isArray(settings.agentViewVars) ? settings.agentViewVars : []);
    };
    fetchAgentViewSettings().catch((error) => console.error('Erro ao carregar interface do atendimento:', error));
  }, [tenant?.id]);

  const addAgentViewVar = () => {
    const value = agentViewVarDraft.trim();
    if (!value || agentViewVars.includes(value)) return;
    setAgentViewVars((current) => [...current, value]);
    setAgentViewVarDraft('');
  };

  const saveAgentViewSettings = async () => {
    if (!tenant?.id || tenant.id === 'super_admin') return toast.error('Selecione um tenant');
    setSavingAgentView(true);
    try {
      const res = await apiRequest(`/tenants/${tenant.id}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ agentViewVars })
      });
      if (!res?.ok) throw new Error('Falha ao salvar');
      const settings = await res.json();
      setAgentViewVars(Array.isArray(settings.agentViewVars) ? settings.agentViewVars : []);
      setAgentViewModalOpen(false);
      toast.success('Interface do atendimento atualizada');
    } catch (error) {
      toast.error(error.message || 'Falha ao salvar');
    } finally {
      setSavingAgentView(false);
    }
  };

  const fetchQueues = async () => {
    const res = await apiRequest('/queues');
    if (res) setQueues(await res.json());
  };

  const openQueueModal = (queue = null) => {
    if (queue) {
      setEditingQueueId(queue.id);
      setQueueForm({
        name: queue.name || '',
        color: queue.color || '#3b82f6',
        description: queue.description || '',
        entryMessage: queue.entryMessage || '',
        waitingMessage: queue.waitingMessage || '',
        active: queue.active !== false
      });
    } else {
      setEditingQueueId(null);
      setQueueForm(emptyQueueForm);
    }
    setQueueModalOpen(true);
  };

  const closeQueueModal = () => {
    setQueueModalOpen(false);
    setEditingQueueId(null);
    setQueueForm(emptyQueueForm);
  };

  const handleSaveQueue = async () => {
    if (!queueForm.name.trim()) return toast.error('Informe o nome da fila');
    const wasEditing = Boolean(editingQueueId);
    const endpoint = editingQueueId ? `/queues/${editingQueueId}` : '/queues';
    const method = editingQueueId ? 'PUT' : 'POST';
    const res = await apiRequest(endpoint, {
      method,
      body: JSON.stringify(queueForm)
    });
    if (res?.ok) {
      closeQueueModal();
      await fetchQueues();
      await fetchUsers();
      toast.success(wasEditing ? 'Fila atualizada!' : 'Fila criada!');
    } else {
      const data = await res?.json().catch(() => null);
      toast.error(data?.error || 'Erro ao salvar fila');
    }
  };

  const handleEditQueue = (queue) => {
    openQueueModal(queue);
  };

  const cancelQueueEdit = () => {
    closeQueueModal();
  };

  const handleToggleQueueActive = async (queue) => {
    const res = await apiRequest(`/queues/${queue.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...queue, active: queue.active === false })
    });
    if (res?.ok) {
      await fetchQueues();
      toast.success(queue.active === false ? 'Fila ativada' : 'Fila desativada');
    } else {
      toast.error('Erro ao atualizar fila');
    }
  };

  const openQueueAgentsModal = (queue) => {
    setQueueAgentModal(queue);
    setQueueAgentIds(
      users
        .filter((user) => user.role === 'AGENT' && Array.isArray(user.queues) && user.queues.includes(queue.name))
        .map((user) => user.id)
    );
  };

  const toggleQueueAgent = (agentId) => {
    setQueueAgentIds((current) => (
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId]
    ));
  };

  const selectAllQueueAgents = () => {
    setQueueAgentIds(users.filter((user) => user.role === 'AGENT').map((user) => user.id));
  };

  const clearQueueAgents = () => {
    setQueueAgentIds([]);
  };

  const saveQueueAgents = async () => {
    if (!queueAgentModal?.id) return;
    setSavingQueueAgents(true);
    try {
      const res = await apiRequest(`/queues/${queueAgentModal.id}/agents`, {
        method: 'PUT',
        body: JSON.stringify({ agentIds: queueAgentIds })
      });
      if (!res?.ok) {
        const data = await res?.json().catch(() => null);
        throw new Error(data?.error || 'Erro ao vincular agentes');
      }
      await fetchUsers();
      setQueueAgentModal(null);
      toast.success('Agentes vinculados');
    } catch (error) {
      toast.error(error.message || 'Erro ao vincular agentes');
    } finally {
      setSavingQueueAgents(false);
    }
  };

  const handleDeleteQueue = async (id) => {
    const ok = await confirm({
      title: 'Excluir fila',
      message: 'Tem certeza? Agentes vinculados a esta fila perderão o acesso a ela.',
      confirmText: 'Excluir fila',
      type: 'danger',
    });
    if (!ok) return;

    const previousQueues = queues;
    setQueues(prev => prev.filter(q => q.id !== id));

    try {
      const res = await apiRequest(`/queues/${id}`, { method: 'DELETE' });
      if (!res || !res.ok) {
        setQueues(previousQueues);
        toast.error("Erro ao excluir fila");
      }
    } catch (error) {
      setQueues(previousQueues);
      toast.error("Erro ao excluir fila");
    }
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const res = await apiRequest('/users?limit=200&page=1');
      if (res) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data?.items || []);
        setUsers(list);

      }
    } catch (error) {
      toast.error('Erro ao carregar Usuários');
    } finally {
      setLoading(false);
    }
  };

  const openUserModal = (user = null) => {
    if (user) {
      setEditingUserId(user.id);
      setForm({
        name: user.name || '',
        username: user.username || '',
        password: '',
        role: user.role || 'AGENT',
        queues: Array.isArray(user.queues) ? user.queues : [],
        ...(() => {
          if (user.cargo?.nivel) return { cargoNivel: user.cargo.nivel, adicionadas: user.cargo.adicionadas || [], removidas: user.cargo.removidas || [] };
          // Sem nivel gravado: o equivalente ao papel. Gestor "personalizado"
          // vira B1 com as caixas que ele tem a mais.
          const codigo = user.cargoEfetivo?.codigo;
          const nivel = codigo && codigo.length === 2 ? codigo : ({ AGENT: 'A4', MANAGER: 'B1', ADMIN: 'C6' })[user.role] || 'A4';
          const base = nivelInfo(nivel)?.permissoes;
          if (!base) return { cargoNivel: nivel, adicionadas: [], removidas: [] };
          const efetivas = user.cargoEfetivo?.permissoes || base;
          return { cargoNivel: nivel, adicionadas: efetivas.filter((p) => !base.includes(p) && p !== '*'), removidas: [] };
        })(),
        email: user.email || '',
        phone: user.phone || '',
        avatarUrl: user.avatarUrl || '',
        availabilityMode: user.availabilityMode || 'auto',
        maxConcurrentChats: user.maxConcurrentChats || '',
        workSchedule: {
          timezone: user.workSchedule?.timezone || 'America/Sao_Paulo',
          weekdays: Array.isArray(user.workSchedule?.weekdays) ? user.workSchedule.weekdays : [1, 2, 3, 4, 5],
          start: user.workSchedule?.start || '08:00',
          end: user.workSchedule?.end || '18:00',
        },
        notificationPreferences: {
          browser: user.notificationPreferences?.browser !== false,
          sound: user.notificationPreferences?.sound !== false,
          email: user.notificationPreferences?.email === true,
        },
      });
    } else {
      setEditingUserId(null);
      setForm(emptyUserForm);
    }
    setUserModalOpen(true);
  };

  const closeUserModal = () => {
    setUserModalOpen(false);
    setEditingUserId(null);
    setForm(emptyUserForm);
  };

  const toggleQueue = (q) => {


    const newQueues = form.queues.includes(q.name)
      ? form.queues.filter(name => name !== q.name)
      : [...form.queues, q.name];

    setForm({ ...form, queues: newQueues });
  };

  const handleSave = async (e) => {
    e?.preventDefault();
    if (!form.name || !form.username || (!editingUserId && !form.password)) return toast.error("Preencha nome, usuario e senha.");
    if (form.password && form.password.length < 6) return toast.error("A senha deve ter pelo menos 6 caracteres.");

    try {
      let effectiveTenantId = tenant?.id && tenant.id !== 'super_admin' ? tenant.id : null;
      if (!effectiveTenantId) {
        try {
          const saved = localStorage.getItem('selectedTenant');
          const parsed = saved ? JSON.parse(saved) : null;
          if (parsed?.id && parsed.id !== 'super_admin') {
            effectiveTenantId = parsed.id;
          }
        } catch (err) { }
      }
      if (!effectiveTenantId) {
        return toast.error("Selecione um tenant antes de criar o agente.");
      }

      const userData = {
        ...form,
        maxConcurrentChats: form.maxConcurrentChats ? Number(form.maxConcurrentChats) : undefined,
        tenantId: effectiveTenantId
      };
      if (editingUserId && !userData.password) {
        delete userData.password;
      }
      delete userData.cargoNivel;
      delete userData.adicionadas;
      delete userData.removidas;
      // O cargo proprio nao muda por aqui (o backend recusa).
      if (editingUserId !== currentUser?.id) {
        userData.cargo = { nivel: form.cargoNivel, adicionadas: form.adicionadas, removidas: form.removidas };
      }

      const res = await apiRequest(editingUserId ? `/users/${editingUserId}` : '/users', {
        method: editingUserId ? 'PUT' : 'POST',
        body: JSON.stringify(userData)
      });

      if (res?.ok) {
        toast.success(editingUserId ? 'Usuario atualizado!' : 'Usuario criado com sucesso!');
        closeUserModal();
        await fetchUsers();
      } else {
        const data = await res?.json().catch(() => null);
        toast.error(data?.error || 'Erro ao salvar usuario');
      }
    } catch (error) {
      toast.error(error.message || "Erro ao salvar");
    }
  };

  const handleDelete = async (id) => {
    const ok = await confirm({
      title: 'Remover usuário',
      message: 'Tem certeza que deseja remover este usuário?',
      confirmText: 'Remover',
      type: 'danger',
    });
    if (!ok) return;

    const previousUsers = users;
    setUsers(prev => prev.filter(u => u.id !== id));

    try {
      const res = await apiRequest(`/users/${id}`, { method: 'DELETE' });
      if (res && res.ok) {
        toast.success("Usuário removido");
      } else {
        setUsers(previousUsers);
        toast.error("Erro ao excluir Usuário");
      }
    } catch (error) {
      setUsers(previousUsers);
      toast.error("Erro ao excluir");
    }
  };

  const openAgentModal = async (agent) => {
    setSelectedAgent(agent);
    setAgentChats([]);
    setAgentStats({ total: 0, uniqueCustomers: 0 });
    setLoadingAgentChats(true);
    try {
      const res = await apiRequest(`/chats/agent/${agent.id}?limit=100`);
      if (res && res.ok) {
        const data = await res.json();
        setAgentChats(Array.isArray(data.chats) ? data.chats : []);
        setAgentStats({
          total: Number(data.total || 0),
          uniqueCustomers: Number(data.uniqueCustomers || 0)
        });
      }
    } catch (error) {
      toast.error('Erro ao carregar Histórico do Agente');
    } finally {
      setLoadingAgentChats(false);
    }
  };

  const closeAgentModal = () => {
    setSelectedAgent(null);
  };

  const roleBadge = (role) => {
    const Icon = role === 'ADMIN' ? Shield : role === 'MANAGER' ? Briefcase : Headset;

    return (
      <span className="inline-flex items-center gap-1.5 border-l border-blue-400 px-2 text-xs font-medium text-gray-600 dark:border-blue-700 dark:text-gray-300">
        <Icon size={12} /> {role}
      </span>
    );
  };

  const renderStars = (avg) => {
    const value = Number(avg || 0);
    return (
      <div className="flex items-center gap-0.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            size={14}
            className={i < Math.round(value) ? 'text-yellow-500' : 'text-gray-300 dark:text-gray-600'}
            fill={i < Math.round(value) ? 'currentColor' : 'none'}
          />
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="p-3 sm:p-4 lg:p-6 max-w-7xl mx-auto space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Equipe</h1>
          </div>
          {canManageTeam && (
            <button
              onClick={() => openUserModal()}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors shadow-sm"
            >
              <UserPlus size={16} />
              Novo usuario
            </button>
          )}
        </div>

        <section className="border-y border-gray-200 dark:border-gray-800">
          <div className="grid grid-cols-2 divide-x divide-gray-200 dark:divide-gray-800 lg:grid-cols-5">
            {[
              ['Usuarios', users.length],
              ['Agentes', users.filter((user) => user.role === 'AGENT').length],
              ['Gestores', users.filter((user) => user.role === 'MANAGER' || user.role === 'ADMIN').length],
              ['Filas ativas', queues.filter((queue) => queue.active !== false).length],
              ['Respostas rapidas', quickReplies.length],
            ].map(([label, value]) => <div key={label} className="px-4 py-4 first:pl-0 lg:py-5"><div className="text-xs text-gray-500 dark:text-gray-400">{label}</div><div className="mt-2 text-xl font-semibold text-gray-950 dark:text-white">{value}</div></div>)}
          </div>
        </section>

        <div>
          { }
          <div className="hidden">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-blue-500" /> Novo Usuário
            </h2>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome</label>
                <input
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  placeholder=""
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Usuário</label>
                  <input
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                    value={form.username}
                    onChange={e => setForm({ ...form, username: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Senha</label>
                  <input
                    type="password"
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                    value={form.password}
                    onChange={e => setForm({ ...form, password: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cargo</label>
                <select
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  value={form.role}
                  onChange={e => setForm({ ...form, role: e.target.value })}
                >
                  <option value="AGENT">Atendente</option>
                  <option value="MANAGER">Gestor</option>
                  <option value="ADMIN">Administrador</option>
                </select>
              </div>

              {form.role === 'AGENT' && (
                <div className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg border border-gray-200 dark:border-gray-600">
                  <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Filas de Atendimento</label>
                  <div className="space-y-2 flex flex-col">
                    {queues.map(q => (
                      <label key={q.id} className="">
                        <input
                          type="checkbox"
                          checked={form.queues.includes(q.name)}
                          onChange={() => toggleQueue(q)}
                          className="mr-2"
                        />
                        <span>{q.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <button type="submit" className="w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors shadow-sm">
                Criar Acesso
              </button>
            </form>
          </div>

          { }
          <div className="overflow-hidden border-y border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            {loading ? (
              <TableSkeleton rows={6} cols={4} />
            ) : users.length === 0 ? (
              <div className="p-8 text-center text-gray-500">Nenhum Usuário encontrado.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left min-w-[720px]">

                  <thead className="bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 uppercase font-medium">
                    <tr>
                      <th className="px-6 py-3">Nome</th>
                      <th className="px-6 py-3">Acesso e contato</th>
                      <th className="px-6 py-3">Cargo</th>
                      <th className="px-6 py-3">Filas</th>
                      <th className="px-6 py-3">Avaliação</th>
                      <th className="px-6 py-3 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {usersPage.pageItems.map(u => (
                      <tr
                        key={u.id}
                        className="h-16 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <td className="px-6 py-4 font-medium text-gray-900 dark:text-white flex items-center gap-3">
                          {u.avatarUrl ? <img src={u.avatarUrl} alt="" className="h-8 w-8 min-w-8 object-cover" /> : <div className="flex h-8 w-8 min-w-8 items-center justify-center bg-blue-100 text-xs font-bold text-blue-600">{u.name.charAt(0)}</div>}
                          {u.name}
                        </td>

                        <td className="px-6 py-4 text-gray-600 dark:text-gray-300">
                          <div className="font-mono text-xs">{u.username}</div>
                          <div className="mt-1 max-w-[220px] truncate text-xs text-gray-400">{u.email || u.phone || 'Sem contato informado'}</div>
                        </td>

                        <td className="px-6 py-4">
                          {roleBadge(u.role)}
                          {u.cargoEfetivo?.codigo && (
                            <div className="mt-1 px-2 text-[10px] text-gray-400">
                              <span className="font-mono">{u.cargoEfetivo.codigo}</span>
                              {nivelInfo(u.cargoEfetivo.codigo) ? ` · ${nivelInfo(u.cargoEfetivo.codigo).nome}` : ''}
                              {u.cargoEfetivo.personalizado ? ' · personalizado' : ''}
                            </div>
                          )}
                        </td>

                        <td className="px-6 py-4 text-gray-500 dark:text-gray-400">
                          <div
                            title={u.role === 'AGENT' ? u.queues.join(', ') : '-'}
                            className="max-w-xs overflow-hidden whitespace-nowrap truncate"
                          >
                            {u.role === 'AGENT'
                              ? (u.queues.length ? u.queues.join(', ') : 'Nenhuma')
                              : '-'}
                          </div>
                          {u.role === 'AGENT' && <div className="mt-1 text-[10px] uppercase text-gray-400">{u.availabilityMode || 'auto'}{u.maxConcurrentChats ? ` · limite ${u.maxConcurrentChats}` : ' · sem limite'}</div>}
                        </td>

                        <td className="px-6 py-4">
                          {u.role === 'AGENT' ? (
                            <div className="flex items-center gap-2">
                              {renderStars(u.ratingAvg)}
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {Number(u.ratingAvg || 0).toFixed(1)} ({u.ratingCount || 0})
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">-</span>
                          )}
                        </td>


                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {u.role === 'AGENT' && (
                              <button
                                onClick={() => openAgentModal(u)}
                                className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                title="Ver atendimentos"
                              >
                                <MessageSquareText size={16} />
                              </button>
                            )}
                            {canEditUser(u) && (
                              <>
                                <button
                                  onClick={() => openUserModal(u)}
                                  className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                  title="Editar usuario"
                                >
                                  <Edit size={16} />
                                </button>
                                <button
                                  onClick={() => handleDelete(u.id)}
                                  className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                  title="Excluir"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}

                  </tbody>
                </table>
                <TablePagination {...usersPage} label="usuarios" />

              </div>
            )}

          </div>
        </div>
        <div className="mt-10">
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Filas</h2>
            {canManageTeam && (
              <button
                onClick={() => openQueueModal()}
                className="inline-flex items-center justify-center gap-2 border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-600 transition-colors hover:border-blue-500 hover:text-blue-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
              >
                <Users size={16} />
                Nova fila
              </button>
            )}
          </div>

          <div>
            <div className="hidden">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                    {editingQueueId ? 'Editar fila' : 'Nova fila'}
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    Defina aparencia, status e mensagens operacionais.
                  </p>
                </div>
                {editingQueueId && (
                  <button
                    onClick={cancelQueueEdit}
                    className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700"
                    title="Cancelar edicao"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome da fila</label>
                  <input
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500"
                    placeholder="Ex: VENDAS"
                    value={queueForm.name}
                    onChange={e => setQueueForm({ ...queueForm, name: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-[64px_1fr] gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cor</label>
                    <input
                      type="color"
                      className="h-10 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 p-1"
                      value={queueForm.color}
                      onChange={e => setQueueForm({ ...queueForm, color: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
                    <button
                      type="button"
                      onClick={() => setQueueForm({ ...queueForm, active: !queueForm.active })}
                      className={`h-10 w-full rounded-lg border px-3 text-sm font-medium transition-colors ${
                        queueForm.active
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300'
                          : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {queueForm.active ? 'Ativa' : 'Inativa'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Descricao interna</label>
                  <textarea
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 resize-none"
                    placeholder="Quando essa fila deve ser usada?"
                    value={queueForm.description}
                    onChange={e => setQueueForm({ ...queueForm, description: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Mensagem ao entrar na fila</label>
                  <textarea
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 resize-none"
                    placeholder="Ex: Aguarde, um atendente vai te responder."
                    value={queueForm.entryMessage}
                    onChange={e => setQueueForm({ ...queueForm, entryMessage: e.target.value })}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Mensagem de espera</label>
                  <textarea
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 resize-none"
                    placeholder="Opcional: aviso caso o cliente fique aguardando."
                    value={queueForm.waitingMessage}
                    onChange={e => setQueueForm({ ...queueForm, waitingMessage: e.target.value })}
                  />
                </div>

                <button onClick={handleSaveQueue} className="w-full inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors">
                  {editingQueueId ? <Save size={16} /> : <Users size={16} />}
                  {editingQueueId ? 'Salvar fila' : 'Criar fila'}
                </button>
              </div>
            </div>

            <div className="divide-y divide-gray-200 border-y border-gray-200 dark:divide-gray-800 dark:border-gray-800">
              {queues.length === 0 ? (
                <div className="py-10 text-sm text-gray-500">
                  Nenhuma fila criada ainda.
                </div>
              ) : queues.map(q => {
                const linkedAgents = users.filter((user) => user.role === 'AGENT' && Array.isArray(user.queues) && user.queues.includes(q.name));
                const isActive = q.active !== false;
                return (
                  <div
                    key={q.id}
                    className={`grid gap-4 bg-white px-1 py-5 transition-colors hover:bg-gray-50 dark:bg-gray-900 dark:hover:bg-gray-800/40 sm:px-3 lg:grid-cols-[minmax(180px,0.7fr)_minmax(240px,1fr)_auto] ${isActive ? '' : 'opacity-60'}`}
                  >
                    <div className="space-y-3 lg:col-span-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="h-2 w-2 shrink-0 bg-blue-500" />
                            <h3 className="font-bold text-gray-900 dark:text-white truncate">{q.name}</h3>
                            <span className={`border-l px-2 text-[10px] font-semibold ${isActive ? 'border-blue-400 text-blue-600 dark:border-blue-700 dark:text-blue-300' : 'border-gray-300 text-gray-400 dark:border-gray-700'}`}>
                              {isActive ? 'ATIVA' : 'INATIVA'}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                            {q.description || 'Sem descricao interna.'}
                          </p>
                        </div>
                        {canManageTeam && <div className="flex items-center gap-1 shrink-0">
                          <button onClick={() => handleEditQueue(q)} className="p-2 text-gray-400 transition-colors hover:text-blue-600" title="Editar">
                            <Edit size={16} />
                          </button>
                          <button onClick={() => handleToggleQueueActive(q)} className="p-2 text-gray-400 transition-colors hover:text-blue-600" title={isActive ? 'Desativar' : 'Ativar'}>
                            {isActive ? <PowerOff size={16} /> : <Power size={16} />}
                          </button>
                          <button onClick={() => handleDeleteQueue(q.id)} className="p-2 text-gray-400 transition-colors hover:text-blue-600" title="Excluir">
                            <Trash2 size={16} />
                          </button>
                        </div>}
                      </div>

                      <div className="flex items-center justify-between gap-3 border-y border-gray-200 px-3 py-2 dark:border-gray-800">
                        <div className="min-w-0 flex items-center gap-2 text-xs">
                          <span className="font-semibold text-gray-500 dark:text-gray-400">Agentes:</span>
                          <span className="truncate text-gray-700 dark:text-gray-300">
                            {linkedAgents.length === 0
                              ? 'nenhum'
                              : linkedAgents.slice(0, 3).map((agent) => agent.name || agent.username).join(', ')}
                            {linkedAgents.length > 3 ? ` +${linkedAgents.length - 3}` : ''}
                          </span>
                        </div>
                        {canManageTeam && <button
                          onClick={() => openQueueAgentsModal(q)}
                          className="inline-flex h-7 w-8 shrink-0 items-center justify-center text-gray-400 transition-colors hover:text-blue-600"
                          title="Alocar agentes"
                          aria-label="Alocar agentes"
                        >
                          ...
                        </button>}
                      </div>

                      <div className="border-b border-gray-200 p-3 dark:border-gray-800">
                        <p className="text-[10px] uppercase font-bold text-gray-400">Criada em</p>
                        <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
                          {q.createdAt ? new Date(q.createdAt).toLocaleDateString() : '-'}
                        </p>
                      </div>

                      <div className="space-y-2 text-xs">
                        <div className="border-l border-gray-300 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/40">
                          <p className="font-semibold text-gray-500 dark:text-gray-300 mb-1">Mensagem de entrada</p>
                          <p className="text-gray-600 dark:text-gray-300 line-clamp-2">{q.entryMessage || 'Nao configurada.'}</p>
                        </div>
                        <div className="border-l border-gray-300 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/40">
                          <p className="font-semibold text-gray-500 dark:text-gray-300 mb-1">Mensagem de espera</p>
                          <p className="text-gray-600 dark:text-gray-300 line-clamp-2">{q.waitingMessage || 'Nao configurada.'}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <section className="mt-10">
          <div className="mb-4"><h2 className="text-base font-semibold text-gray-900 dark:text-white">Configuracoes do atendimento</h2></div>
          <div className="border-y border-gray-200 dark:border-gray-800">
            {!isManagerActor && <button type="button" onClick={() => setAgentViewModalOpen(true)} className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-gray-200 px-1 py-4 text-left transition hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/40 sm:px-3">
              <PanelRight size={18} className="text-blue-500" />
              <span className="min-w-0"><strong className="block text-sm font-semibold text-gray-900 dark:text-white">Informacoes exibidas no atendimento</strong><span className="mt-1 block truncate text-xs text-gray-500 dark:text-gray-400">{agentViewVars.length ? `${agentViewVars.length} variavel(is) disponivel(is)` : 'Nenhuma variavel adicional'}</span></span>
              <span className="flex items-center gap-2 text-xs font-semibold text-gray-400 transition group-hover:text-gray-700 dark:group-hover:text-gray-200">Configurar <ChevronRight size={15} /></span>
            </button>}
            <button type="button" onClick={() => setQuickReplyModalOpen(true)} className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 px-1 py-4 text-left transition hover:bg-gray-50 dark:hover:bg-gray-800/40 sm:px-3">
              <MessageSquareText size={18} className="text-blue-500" />
              <span className="min-w-0"><strong className="block text-sm font-semibold text-gray-900 dark:text-white">Respostas rapidas</strong><span className="mt-1 block truncate text-xs text-gray-500 dark:text-gray-400">{quickReplies.length ? `${quickReplies.length} resposta(s) disponivel(is)` : 'Nenhuma resposta configurada'}</span></span>
              <span className="flex items-center gap-2 text-xs font-semibold text-gray-400 transition group-hover:text-gray-700 dark:group-hover:text-gray-200">Configurar <ChevronRight size={15} /></span>
            </button>
          </div>
        </section>
      </div>

      <OperationalModal open={quickReplyModalOpen} onClose={() => setQuickReplyModalOpen(false)} size="lg" title="Respostas rapidas">
        <div className="grid min-h-[430px] md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="border-b border-gray-200 p-5 dark:border-gray-800 md:border-b-0 md:border-r">
            <div className="flex items-center justify-between border-b border-gray-200 pb-3 dark:border-gray-800"><span className="text-xs font-semibold uppercase text-gray-500">Respostas disponiveis</span><span className="text-xs text-gray-400">{quickReplies.length}</span></div>
            {quickReplies.length === 0 ? <div className="py-12 text-sm text-gray-500">Nenhuma resposta configurada.</div> : <div className="divide-y divide-gray-200 dark:divide-gray-800">{quickReplies.map((reply) => <div key={reply.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-4"><div className="min-w-0"><div className="flex items-center gap-3"><strong className="truncate text-sm font-semibold text-gray-900 dark:text-white">{reply.name}</strong>{reply.shortcut ? <span className="font-mono text-xs text-blue-600 dark:text-blue-400">{reply.shortcut}</span> : null}</div><p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500 dark:text-gray-400">{reply.message}</p></div>{canManageReplies && <button type="button" onClick={() => deleteQuickReply(reply)} className="grid h-8 w-8 place-items-center border border-gray-300 text-gray-500 transition hover:border-blue-500 hover:text-blue-700 dark:border-gray-700" aria-label={`Excluir ${reply.name}`}><Trash2 size={14} /></button>}</div>)}</div>}
          </div>
          {canManageReplies && <div className="space-y-4 bg-gray-50 p-5 dark:bg-gray-950/40">
            <div><label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500">Nome</label><input value={quickReplyForm.name} onChange={(event) => setQuickReplyForm((current) => ({ ...current, name: event.target.value }))} className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" placeholder="Saudacao inicial" /></div>
            <div><label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500">Mensagem</label><textarea value={quickReplyForm.message} onChange={(event) => setQuickReplyForm((current) => ({ ...current, message: event.target.value }))} className="h-36 w-full resize-none border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" placeholder="Boa tarde, tudo bem?" /></div>
            <div><label className="mb-1.5 block text-xs font-semibold uppercase text-gray-500">Atalho opcional</label><input value={quickReplyForm.shortcut} onChange={(event) => setQuickReplyForm((current) => ({ ...current, shortcut: event.target.value }))} className="h-10 w-full border border-gray-300 bg-white px-3 font-mono text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" placeholder="/boatarde" /></div>
            <button type="button" onClick={saveQuickReply} className="inline-flex h-10 w-full items-center justify-center gap-2 bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700"><Save size={15} /> Adicionar resposta</button>
          </div>}
        </div>
      </OperationalModal>

      <OperationalModal open={agentViewModalOpen} onClose={() => setAgentViewModalOpen(false)} size="md" title="Informacoes do atendimento">
            <div className="max-h-[65vh] overflow-y-auto p-5">
              <div className="flex gap-2">
                <input className="h-10 min-w-0 flex-1 border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" value={agentViewVarDraft} onChange={(event) => setAgentViewVarDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addAgentViewVar(); } }} placeholder="Ex: nome_cliente, pedido, plano" />
                <button type="button" onClick={addAgentViewVar} className="h-10 bg-blue-600 px-4 text-xs font-semibold text-white transition hover:bg-blue-700">Adicionar</button>
              </div>

              <div className="mt-5 border-y border-gray-200 dark:border-gray-800">
                {agentViewVars.length === 0 ? (
                  <div className="px-4 py-8 text-center text-xs text-gray-400">Nenhuma variavel adicional sera exibida.</div>
                ) : agentViewVars.map((value, index) => (
                  <div key={value} className={`flex items-center justify-between gap-3 px-4 py-3 ${index ? 'border-t border-gray-100 dark:border-gray-700' : ''}`}>
                    <span className="truncate font-mono text-xs text-gray-700 dark:text-gray-200">{value}</span>
                    <button type="button" onClick={() => setAgentViewVars((current) => current.filter((item) => item !== value))} className="text-xs font-semibold text-gray-400 transition hover:text-blue-600">Remover</button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-4 dark:border-gray-700">
              <button type="button" onClick={() => setAgentViewModalOpen(false)} className="h-9 border border-gray-300 px-4 text-sm text-gray-600 transition hover:border-blue-500 dark:border-gray-700 dark:text-gray-300">Cancelar</button>
              <button type="button" onClick={saveAgentViewSettings} disabled={savingAgentView} className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"><Save size={15} /> {savingAgentView ? 'Salvando...' : 'Salvar'}</button>
            </div>
      </OperationalModal>
      <OperationalModal open={userModalOpen} onClose={closeUserModal} size="lg" title={editingUserId ? 'Editar usuario' : 'Novo usuario'}>
            <form onSubmit={handleSave}>
              <div className="p-4 sm:p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                <div className="border-b border-gray-200 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800">Identidade e acesso</div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome</label>
                  <input
                    className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Usuario</label>
                    <input
                      className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      value={form.username}
                      onChange={e => setForm({ ...form, username: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Senha {editingUserId && <span className="text-xs text-gray-400">(deixe vazio para manter)</span>}
                    </label>
                    <input
                      type="password"
                      className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                      value={form.password}
                      onChange={e => setForm({ ...form, password: e.target.value })}
                    />
                  </div>
                </div>

                <div className="border-b border-gray-200 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800">Contato</div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div><label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">E-mail opcional</label><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" placeholder="agente@empresa.com" /></div>
                  <div><label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Telefone opcional</label><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" placeholder="(11) 99999-9999" /></div>
                </div>
                <div><label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">URL da foto opcional</label><input value={form.avatarUrl} onChange={(event) => setForm({ ...form, avatarUrl: event.target.value })} className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" placeholder="https://..." /></div>

                <div className="border-b border-gray-200 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800">Operacao do atendimento</div>
                <div>
                  <label htmlFor="usuario-cargo" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cargo</label>
                  <select
                    id="usuario-cargo"
                    className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                    value={form.cargoNivel}
                    disabled={editingUserId === currentUser?.id || !catalogo}
                    onChange={(e) => escolherNivel(e.target.value)}
                  >
                    {(catalogo ? ['A', 'B', 'C'] : []).filter((familia) => gerencia.includes(familia) || form.cargoNivel.charAt(0) === familia).map((familia) => (
                      <optgroup key={familia} label={catalogo.familias[familia]}>
                        {catalogo.niveis.filter((nivel) => nivel.familia === familia).map((nivel) => (
                          <option key={nivel.codigo} value={nivel.codigo} disabled={!gerencia.includes(familia)}>{nivel.codigo} · {nivel.nome}</option>
                        ))}
                      </optgroup>
                    ))}
                    {!catalogo && <option value={form.cargoNivel}>{form.cargoNivel}</option>}
                  </select>
                  {editingUserId === currentUser?.id && <p className="mt-1 text-xs text-gray-400">O seu próprio cargo é alterado por outra pessoa.</p>}
                </div>

                {catalogo && (
                  <button
                    type="button"
                    onClick={() => setPermissionsModalOpen(true)}
                    className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 border-y border-gray-200 px-1 py-3 text-left transition hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/40"
                  >
                    <ShieldCheck size={18} className="text-blue-500" />
                    <span className="min-w-0">
                      <strong className="block text-sm font-semibold text-gray-900 dark:text-white">Permissões</strong>
                      <span className="mt-0.5 block truncate text-xs text-gray-500 dark:text-gray-400">
                        {permissoesDoForm().length} de {Object.keys(catalogo.permissoes).length}
                        {form.adicionadas.length || form.removidas.length ? ` · ajustado (+${form.adicionadas.length} −${form.removidas.length})` : ' · padrão do nível'}
                      </span>
                    </span>
                    <ChevronRight size={16} className="text-gray-400 transition group-hover:text-gray-700 dark:group-hover:text-gray-200" />
                  </button>
                )}

                {form.role === 'AGENT' && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div><label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Disponibilidade</label><select value={form.availabilityMode} onChange={(event) => setForm({ ...form, availabilityMode: event.target.value })} className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"><option value="auto">Automatica</option><option value="available">Disponivel</option><option value="away">Ausente</option><option value="offline">Indisponivel</option></select></div>
                  <div><label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Limite simultaneo</label><input type="number" min="1" max="100" value={form.maxConcurrentChats} onChange={(event) => setForm({ ...form, maxConcurrentChats: event.target.value })} className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" placeholder="Sem limite" /></div>
                </div>}

                {form.role === 'AGENT' && (
                  <div className="border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950/40">
                    <label className="block text-xs font-semibold text-gray-500 uppercase mb-2">Filas de atendimento</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {queues.length === 0 ? (
                        <span className="text-sm text-gray-500">Nenhuma fila criada.</span>
                      ) : queues.map(q => (
                        <label key={q.id} className="flex cursor-pointer items-center gap-2 border-b border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 last:border-b-0 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-200">
                          <input
                            type="checkbox"
                            checked={form.queues.includes(q.name)}
                            onChange={() => toggleQueue(q)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          />
                          <span className="truncate">{q.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {form.role === 'AGENT' && <>
                  <div className="border-b border-gray-200 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800">Jornada</div>
                  <div><label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">Dias de trabalho</label><div className="grid grid-cols-4 border border-gray-200 dark:border-gray-800 sm:grid-cols-7">{WEEKDAYS.map((day) => { const selected = form.workSchedule.weekdays.includes(day.value); return <button key={day.value} type="button" onClick={() => setForm({ ...form, workSchedule: { ...form.workSchedule, weekdays: selected ? form.workSchedule.weekdays.filter((value) => value !== day.value) : [...form.workSchedule.weekdays, day.value] } })} className={`h-10 border-r border-gray-200 text-xs font-semibold last:border-r-0 dark:border-gray-800 ${selected ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 dark:bg-gray-950 dark:text-gray-400'}`}>{day.label}</button>; })}</div></div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div><label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Inicio</label><input type="time" value={form.workSchedule.start} onChange={(event) => setForm({ ...form, workSchedule: { ...form.workSchedule, start: event.target.value } })} className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" /></div>
                    <div><label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Fim</label><input type="time" value={form.workSchedule.end} onChange={(event) => setForm({ ...form, workSchedule: { ...form.workSchedule, end: event.target.value } })} className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" /></div>
                    <div><label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Fuso horario</label><input value={form.workSchedule.timezone} onChange={(event) => setForm({ ...form, workSchedule: { ...form.workSchedule, timezone: event.target.value } })} className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white" /></div>
                  </div>

                  <div className="border-b border-gray-200 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-800">Notificacoes</div>
                  <div className="divide-y divide-gray-200 border-y border-gray-200 dark:divide-gray-800 dark:border-gray-800">{[
                    ['browser', 'Notificacoes no navegador'], ['sound', 'Som para novas mensagens'], ['email', 'Avisos por e-mail']
                  ].map(([key, label]) => <label key={key} className="flex cursor-pointer items-center justify-between py-3 text-sm text-gray-700 dark:text-gray-300"><span>{label}</span><input type="checkbox" checked={form.notificationPreferences[key]} onChange={(event) => setForm({ ...form, notificationPreferences: { ...form.notificationPreferences, [key]: event.target.checked } })} className="border-gray-300 text-blue-600 focus:ring-blue-500" /></label>)}</div>
                </>}
              </div>

              <div className="px-4 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeUserModal}
                  className="h-9 border border-gray-300 px-4 text-sm text-gray-600 hover:border-blue-500 dark:border-gray-700 dark:text-gray-300"
                >
                  Cancelar
                </button>
                <button type="submit" className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700">
                  <Save size={16} />
                  {editingUserId ? 'Salvar usuario' : 'Criar usuario'}
                </button>
              </div>
            </form>
      </OperationalModal>

      <OperationalModal open={permissionsModalOpen} onClose={() => setPermissionsModalOpen(false)} size="md" title={`Permissões · ${form.cargoNivel}`}>
        <div className="max-h-[65vh] overflow-y-auto p-5">
          <p className="text-xs text-gray-500 dark:text-gray-400">Começa com o padrão do nível {nivelInfo(form.cargoNivel)?.nome || form.cargoNivel}. Marque ou desmarque para ajustar só esta pessoa.</p>
          {catalogo && [
            ['Atendimento', ['atendimento.']],
            ['Operação', ['operacao.']],
            ['Conteúdo', ['fluxos.', 'respostas.', 'templates.', 'catalogo.']],
            ['Relacionamento', ['contatos.', 'campanhas.']],
            ['Equipe', ['equipe.']],
            ['Configuração', ['config.', 'dados.']]
          ].map(([titulo, prefixos]) => {
            const chaves = Object.keys(catalogo.permissoes).filter((chave) => prefixos.some((prefixo) => chave.startsWith(prefixo)));
            const marcadas = permissoesDoForm();
            const base = nivelInfo(form.cargoNivel)?.permissoes || [];
            return (
              <div key={titulo} className="mt-4">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">{titulo}</p>
                <div className="divide-y divide-gray-100 border-y border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                  {chaves.map((chave) => {
                    const marcada = marcadas.includes(chave);
                    const ajustada = base.includes(chave) !== marcada;
                    const travada = !podeConceder(chave) && !marcada;
                    return (
                      <label key={chave} className={`flex items-center gap-3 py-2 ${travada ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`} title={travada ? 'Seu cargo não permite dar esta permissão' : undefined}>
                        <input type="checkbox" checked={marcada} disabled={travada} onChange={() => alternarPermissao(chave)} className="border-gray-300 text-blue-600 focus:ring-blue-500" />
                        <span className="min-w-0 flex-1 text-sm text-gray-800 dark:text-gray-100">{catalogo.permissoes[chave]}</span>
                        {ajustada && <span className="text-[10px] font-semibold uppercase text-blue-600">ajustada</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex justify-between border-t border-gray-200 px-5 py-4 dark:border-gray-700">
          <button type="button" onClick={() => setForm((atual) => ({ ...atual, adicionadas: [], removidas: [] }))} className="h-9 px-2 text-sm font-medium text-gray-500 hover:text-gray-800 dark:hover:text-gray-200">Voltar ao padrão do nível</button>
          <button type="button" onClick={() => setPermissionsModalOpen(false)} className="h-9 bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700">Concluir</button>
        </div>
      </OperationalModal>

      <OperationalModal open={queueModalOpen} onClose={closeQueueModal} size="lg" title={editingQueueId ? 'Editar fila' : 'Nova fila'}>
            <div className="p-4 sm:p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome da fila</label>
                <input
                  className="h-11 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  placeholder="Ex: VENDAS"
                  value={queueForm.name}
                  onChange={e => setQueueForm({ ...queueForm, name: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-[72px_1fr] gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Cor</label>
                  <input
                    type="color"
                    className="h-11 w-full border border-gray-300 bg-white p-1 dark:border-gray-700 dark:bg-gray-950"
                    value={queueForm.color}
                    onChange={e => setQueueForm({ ...queueForm, color: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
                  <button
                    type="button"
                    onClick={() => setQueueForm({ ...queueForm, active: !queueForm.active })}
                    className={`h-11 w-full border px-3 text-sm font-medium transition-colors ${
                      queueForm.active
                        ? 'border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/30 dark:text-blue-300'
                        : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {queueForm.active ? 'Ativa' : 'Inativa'}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Descricao interna</label>
                <textarea
                  rows={2}
                  className="w-full resize-none border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  placeholder="Quando essa fila deve ser usada?"
                  value={queueForm.description}
                  onChange={e => setQueueForm({ ...queueForm, description: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Mensagem ao entrar na fila</label>
                <textarea
                  rows={2}
                  className="w-full resize-none border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  placeholder="Ex: Aguarde, um atendente vai te responder."
                  value={queueForm.entryMessage}
                  onChange={e => setQueueForm({ ...queueForm, entryMessage: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Mensagem de espera</label>
                <textarea
                  rows={2}
                  className="w-full resize-none border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  placeholder="Opcional: aviso caso o cliente fique aguardando."
                  value={queueForm.waitingMessage}
                  onChange={e => setQueueForm({ ...queueForm, waitingMessage: e.target.value })}
                />
              </div>
            </div>

            <div className="px-4 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
              <button
                onClick={closeQueueModal}
                className="h-9 border border-gray-300 px-4 text-sm text-gray-600 hover:border-blue-500 dark:border-gray-700 dark:text-gray-300"
              >
                Cancelar
              </button>
              <button onClick={handleSaveQueue} className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700">
                <Save size={16} />
                {editingQueueId ? 'Salvar fila' : 'Criar fila'}
              </button>
            </div>
      </OperationalModal>

      {queueAgentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 sm:p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-200 dark:border-gray-700">
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">Alocar agentes</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {queueAgentModal.name} • {queueAgentIds.length} selecionado(s)
                </p>
              </div>
              <button
                onClick={() => setQueueAgentModal(null)}
                className="p-2 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800"
                aria-label="Fechar"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-4 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-700 flex flex-wrap items-center gap-2">
              <button
                onClick={selectAllQueueAgents}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/30"
              >
                Selecionar todos
              </button>
              <button
                onClick={clearQueueAgents}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Limpar alocacao
              </button>
            </div>

            <div className="p-4 sm:p-6 space-y-3 max-h-[60vh] overflow-y-auto">
              {users.filter((user) => user.role === 'AGENT').length === 0 ? (
                <div className="text-center text-sm text-gray-500 py-6">
                  Nenhum atendente cadastrado.
                </div>
              ) : users.filter((user) => user.role === 'AGENT').map((agent) => (
                <label
                  key={agent.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <input
                      type="checkbox"
                      checked={queueAgentIds.includes(agent.id)}
                      onChange={() => toggleQueueAgent(agent.id)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-gray-900 dark:text-white truncate">{agent.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{agent.username}</p>
                    </div>
                  </div>
                  <span className="text-[10px] uppercase font-bold text-gray-400">
                    {Array.isArray(agent.queues) ? agent.queues.length : 0} filas
                  </span>
                </label>
              ))}
            </div>

            <div className="px-4 sm:px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
              <button
                onClick={() => setQueueAgentModal(null)}
                className="px-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancelar
              </button>
              <button
                onClick={saveQueueAgents}
                disabled={savingQueueAgents}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
              >
                {savingQueueAgents ? 'Salvando...' : 'Salvar agentes'}
              </button>
            </div>
          </div>
        </div>
      )}
      <OperationalModal open={Boolean(selectedAgent)} onClose={closeAgentModal} size="xl" title="Historico do agente">
        {selectedAgent && <div className="flex max-h-[78vh] flex-col">
            <div className="border-b border-gray-200 px-5 py-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400"><span className="font-semibold text-gray-800 dark:text-gray-200">{selectedAgent.name}</span><span className="mx-2">/</span><span className="font-mono">{selectedAgent.username}</span></div>
            <div className="grid grid-cols-1 divide-y divide-gray-200 border-b border-gray-200 dark:divide-gray-800 dark:border-gray-800 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <div className="px-5 py-4"><p className="text-xs text-gray-500 dark:text-gray-400">Chats atribuidos</p><p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{agentStats.total}</p></div>
              <div className="px-5 py-4"><p className="text-xs text-gray-500 dark:text-gray-400">Clientes unicos</p><p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{agentStats.uniqueCustomers}</p></div>
              <div className="px-5 py-4"><p className="text-xs text-gray-500 dark:text-gray-400">Media de avaliacao</p><p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{Number(selectedAgent.ratingAvg || 0).toFixed(1)} <span className="text-xs font-normal text-gray-400">{selectedAgent.ratingCount || 0} avaliacoes</span></p></div>
            </div>

            <div className="px-4 sm:px-6 pb-6 flex-1 overflow-hidden">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Últimos atendimentos</h4>
                <span className="text-xs text-gray-500 dark:text-gray-400">Mostrando até 100 registros</span>
              </div>
              <div className="max-h-[420px] overflow-y-auto border-y border-gray-200 dark:border-gray-800">
                {loadingAgentChats ? (
                  <div className="p-6 text-center text-gray-500">Carregando histórico...</div>
                ) : agentChats.length === 0 ? (
                  <div className="p-6 text-center text-gray-500">Nenhum atendimento encontrado.</div>
                ) : (
                  <table className="w-full text-sm text-left min-w-[720px]">
                    <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                      <tr>
                        <th className="px-4 py-3">Data</th>
                        <th className="px-4 py-3">Cliente</th>
                        <th className="px-4 py-3">Canal</th>
                        <th className="px-4 py-3">Fila</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Última mensagem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {agentChatsPage.pageItems.map((chat) => {
                        const lastMessage = Array.isArray(chat.messages) && chat.messages.length
                          ? chat.messages[chat.messages.length - 1]
                          : null;
                        return (
                          <tr key={chat.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/60">
                            <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                              {chat.updatedAt ? new Date(chat.updatedAt).toLocaleString() : 'N/A'}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
                              {chat.customerCpf || chat.channelUserId || chat.channelChatId || 'N/A'}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                              {chat.channel || 'web'}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                              {chat.queue || chat.transferredTo || '-'}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                              {chat.status || '-'}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300 truncate max-w-[220px]">
                              {lastMessage?.text || '-'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <TablePagination {...agentChatsPage} label="atendimentos" />
              </div>
            </div>
          </div>}
      </OperationalModal>

    </>
  );
};

export default AgentManager;





