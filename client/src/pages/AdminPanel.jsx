import { useState, useEffect } from 'react';
import { apiRequest } from '../services/api';
import { Plus, Building2, Trash2, Edit, ArrowRight, Check } from 'lucide-react';
import { Chip, CopyId, CountUp, Meter } from '../components/admin/OpsKit';
import { PAYMENT_TONE, TENANT_STATUS_TONE, reveal } from '../components/admin/opsTones';
import toast from 'react-hot-toast';
import { SkeletonBox } from '../components/LoadingSkeleton';
import { useTenant } from '../context/TenantContext';
import { useDialog } from '../context/DialogContext';
import { useNavigate } from 'react-router-dom';
import OperationalModal from '../components/OperationalModal';

import TablePagination, { usePagination } from '../components/TablePagination';
const PLAN_LABELS = {
  basic: 'Basic',
  pro: 'PRO',
  premium: 'Premium',
};

export default function AdminPanel() {
  const [tenants, setTenants] = useState([]);
  const tenantsPage = usePagination(tenants);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTenant, setEditingTenant] = useState(null);
  const [accessingTenantId, setAccessingTenantId] = useState(null);
  // Uso atual (usuarios, fluxos, chats hoje) vem do dashboard; so empresas de producao.
  const [usageByTenant, setUsageByTenant] = useState(new Map());
  const { switchTenant } = useTenant();
  const { confirm, prompt } = useDialog();
  const navigate = useNavigate();
  const emptyBilling = { cpfCnpj: '', phone: '', email: '', representative: '', dueDay: 10, paymentStatus: 'open' };
  const [form, setForm] = useState({
    name: '',
    slug: '',
    plan: 'basic',
    status: 'active',
    settings: { maxUsers: 5, maxFlows: 10, maxChatsPerDay: 100 },
    billing: emptyBilling,
  });

  useEffect(() => {
    fetchTenants();
    fetchUsage();
  }, []);

  const fetchUsage = async () => {
    try {
      const res = await apiRequest('/super-admin/dashboard');
      if (!res || !res.ok) return;
      const data = await res.json();
      setUsageByTenant(new Map((data.billing || []).map((item) => [item.tenantId, item])));
    } catch {
      // uso e complemento: sem ele a tabela mostra so os limites
    }
  };

  const fetchTenants = async () => {
    try {
      const res = await apiRequest('/tenants');
      if (res && res.ok) {
        const data = await res.json();
        setTenants(data);
      }
    } catch (error) {
      toast.error('Erro ao carregar tenants');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const method = editingTenant ? 'PUT' : 'POST';
      const url = editingTenant ? `/tenants/${editingTenant.id}` : '/tenants';

      const res = await apiRequest(url, {
        method,
        body: JSON.stringify(form)
      });

      if (res && res.ok) {
        toast.success(editingTenant ? 'Tenant atualizado!' : 'Tenant criado!');
        fetchTenants();
        closeModal();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Erro ao salvar');
      }
    } catch (error) {
      toast.error('Erro ao salvar tenant');
    }
  };

  const handleDelete = async (id) => {
    const tenant = tenants.find(t => t.id === id);
    const ok = await confirm({
      title: 'Excluir tenant',
      message: `Isso excluirá TODOS os dados do tenant "${tenant?.name || id}". Esta ação não pode ser desfeita.`,
      confirmText: 'Excluir tudo',
      type: 'danger',
    });
    if (!ok) return;
    const reason = await prompt({
      title: 'Motivo da remoção',
      message: `Informe o motivo da remoção do tenant "${tenant?.name || id}" (mín. 3 caracteres).`,
      placeholder: 'Ex.: Cancelamento solicitado pelo cliente',
      confirmText: 'Confirmar remoção',
      type: 'danger',
    });
    if (!reason || reason.trim().length < 3) {
      toast.error('Motivo obrigatório para remover tenant.');
      return;
    }

    const previousTenants = tenants;
    setTenants(prev => prev.filter(t => t.id !== id));

    try {
      const res = await apiRequest(`/tenants/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true, reason: reason.trim() })
      });
      if (res && res.ok) {
        toast.success('Tenant removido!');
      } else {
        setTenants(previousTenants);
        toast.error('Erro ao remover');
      }
    } catch (error) {
      setTenants(previousTenants);
      toast.error('Erro ao remover tenant');
    }
  };

  const openModal = (tenant = null) => {
    if (tenant) {
      setEditingTenant(tenant);
      setForm({
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan || 'basic',
        status: tenant.status,
        settings: tenant.settings || { maxUsers: 5, maxFlows: 10, maxChatsPerDay: 100 },
        billing: tenant.billing || emptyBilling,
      });
    } else {
      setEditingTenant(null);
      setForm({
        name: '',
        slug: '',
        plan: 'basic',
        status: 'active',
        settings: { maxUsers: 5, maxFlows: 10, maxChatsPerDay: 100 },
        billing: emptyBilling,
      });
    }
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingTenant(null);
  };

  const handleAccessTenant = async (tenant) => {
    if (!tenant?.id) return;
    try {
      setAccessingTenantId(tenant.id);
      await switchTenant(tenant.id);
      navigate(`/tenant/${tenant.id}/monitor`);
    } catch (error) {
      toast.error('Erro ao acessar tenant');
    } finally {
      setAccessingTenantId(null);
    }
  };

  if (loading) {
    return (
      <div className="super-admin-operational p-3 sm:p-4 lg:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div className="space-y-2">
            <SkeletonBox className="h-6 w-52" />
            <SkeletonBox className="h-4 w-64" />
          </div>
          <SkeletonBox className="h-9 w-full sm:w-36" />
        </div>
        <div className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={`tenant_skel_${index}`} className="grid grid-cols-[2fr_1fr_1fr_2fr_1fr] items-center gap-4 py-4">
              <div className="space-y-2"><SkeletonBox className="h-4 w-40" /><SkeletonBox className="h-3 w-28" /></div>
              <SkeletonBox className="h-4 w-16" />
              <SkeletonBox className="h-5 w-16" />
              <SkeletonBox className="h-2 w-full" />
              <SkeletonBox className="h-8 w-24" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const activeCount = tenants.filter((tenant) => tenant.status === 'active').length;

  return (
    <div className="super-admin-operational p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">
            Gerenciamento de Tenants
          </h1>
          <p className="mt-1 text-slate-500 dark:text-slate-400">
            <strong className="font-semibold text-slate-700 dark:text-slate-200"><CountUp value={tenants.length} /></strong> tenants
            {' · '}
            <strong className="font-semibold text-slate-700 dark:text-slate-200"><CountUp value={activeCount} /></strong> ativos
          </p>
        </div>
        <button
          onClick={() => openModal()}
          className="sa-btn sa-press w-full sm:w-auto"
          data-tone="info"
          data-solid=""
        >
          <Plus size={15} />
          Novo tenant
        </button>
      </div>

      {tenants.length > 0 && (
        <div className="overflow-x-auto border-y border-slate-200 dark:border-slate-800">
          <table className="w-full min-w-[1040px] text-left">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                {['Tenant', 'Estado', 'Plano', 'Pagamento', 'Uso do plano', 'Criado em', ''].map((label, index) => (
                  <th key={label || index} className="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 first:pl-3">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {tenantsPage.pageItems.map((tenant, index) => {
                const status = TENANT_STATUS_TONE[tenant.status] || { tone: 'neutral', label: tenant.status || '—' };
                const payment = PAYMENT_TONE[tenant.billing?.paymentStatus];
                const metric = usageByTenant.get(tenant.id);
                const limits = { ...(metric?.limits || {}), ...(tenant.settings || {}) };
                const isDev = String(tenant.environment || 'production').toLowerCase() === 'development';
                return (
                  <tr key={`row_${tenant.id}`} className="sa-row sa-reveal" style={reveal(index)}>
                    <td className="py-4 pl-3 pr-4">
                      <div className="flex items-center gap-2">
                        <strong className="text-sm text-slate-900 dark:text-white">{tenant.name}</strong>
                        {isDev && <Chip tone="warn">Dev</Chip>}
                      </div>
                      <CopyId value={tenant.id} className="mt-1" />
                    </td>
                    <td className="px-4 py-4">{tenant.status === 'active' ? <span className="text-xs text-slate-600 dark:text-slate-300">Ativo</span> : <Chip tone={status.tone}>{status.label}</Chip>}</td>
                    <td className="px-4 py-4"><Chip>{PLAN_LABELS[tenant.plan] || tenant.plan || 'Basic'}</Chip></td>
                    <td className="px-4 py-4">
                      {payment ? <Chip tone={payment.tone}>{payment.label}</Chip> : <span className="text-xs text-slate-400">—</span>}
                      {tenant.billing?.dueDay && <div className="mt-1 text-[11px] text-slate-400">vence dia {tenant.billing.dueDay}</div>}
                    </td>
                    <td className="px-4 py-4">
                      {metric?.usage ? (
                        <div className="grid w-[300px] grid-cols-3 gap-3">
                          <Meter label="Usuários" value={metric.usage.users || 0} max={limits.maxUsers} />
                          <Meter label="Fluxos" value={metric.usage.flows || 0} max={limits.maxFlows} />
                          <Meter label="Chats/dia" value={metric.usage.chatsToday || 0} max={limits.maxChatsPerDay} />
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">
                          {limits.maxUsers || '—'} usuários · {limits.maxFlows || '—'} fluxos · {limits.maxChatsPerDay || '—'} chats/dia
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-xs text-slate-500">{tenant.createdAt ? new Date(tenant.createdAt).toLocaleDateString('pt-BR') : '—'}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center justify-end gap-1.5">
                        <button type="button" onClick={() => handleAccessTenant(tenant)} disabled={accessingTenantId === tenant.id} className="sa-btn sa-press sa-nudge" data-tone="info" data-solid="">
                          {accessingTenantId === tenant.id ? 'Acessando…' : 'Acessar'} <ArrowRight size={13} />
                        </button>
                        <button type="button" onClick={() => openModal(tenant)} className="sa-icon-btn" aria-label={`Editar ${tenant.name}`} title="Editar"><Edit size={14} /></button>
                        <button type="button" onClick={() => handleDelete(tenant.id)} className="sa-icon-btn" data-tone="bad" aria-label={`Excluir ${tenant.name}`} title="Excluir"><Trash2 size={14} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <TablePagination {...tenantsPage} label="tenants" />
        </div>
      )}

      {tenants.length === 0 && (
        <div className="text-center py-10">
          <Building2 className="mx-auto h-12 w-12 text-slate-300" />
          <h3 className="mt-2 text-sm font-medium text-slate-900 dark:text-white">
            Nenhum tenant
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Comece criando um novo tenant
          </p>
        </div>
      )}

      {showModal && (
        <OperationalModal open={showModal} onClose={closeModal} size="md" context="Administracao" title={editingTenant ? 'Editar tenant' : 'Novo tenant'}>
            <form onSubmit={handleSubmit} className="space-y-4 p-5 sm:p-6">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Nome
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700"
                  placeholder="Minha Empresa"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Slug
                </label>
                <input
                  type="text"
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700"
                  placeholder="minha-empresa"
                  pattern="[a-z0-9-]+"
                  required
                />
                <p className="text-xs text-slate-400 mt-1">
                  Identificador único (letras minúsculas, números e hífens)
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Plano
                  </label>
                  <select
                    value={form.plan}
                    onChange={(e) => setForm({ ...form, plan: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700"
                  >
                    <option value="basic">Basic</option>
                    <option value="pro">PRO</option>
                    <option value="premium">Premium</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Status
                  </label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700"
                  >
                    <option value="active">Ativo</option>
                    <option value="suspended">Suspenso</option>
                    <option value="trial">Trial</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Max Users
                  </label>
                  <input
                    type="number"
                    value={form.settings.maxUsers}
                    onChange={(e) => setForm({ ...form, settings: { ...form.settings, maxUsers: parseInt(e.target.value) } })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700"
                    min="1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Max Flows
                  </label>
                  <input
                    type="number"
                    value={form.settings.maxFlows}
                    onChange={(e) => setForm({ ...form, settings: { ...form.settings, maxFlows: parseInt(e.target.value) } })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700"
                    min="1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Max Chats/dia
                  </label>
                  <input
                    type="number"
                    value={form.settings.maxChatsPerDay}
                    onChange={(e) => setForm({ ...form, settings: { ...form.settings, maxChatsPerDay: parseInt(e.target.value) } })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700"
                    min="1"
                  />
                </div>
              </div>

              {/* Recurso pago: atendimento ativo (outreach via template) */}
              <label className="flex items-center gap-3 rounded-lg border border-slate-200 dark:border-slate-600 px-3 py-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.settings.activeOutreachEnabled === true}
                  onChange={(e) => setForm({ ...form, settings: { ...form.settings, activeOutreachEnabled: e.target.checked } })}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                />
                <span className="text-sm text-slate-700 dark:text-slate-300">
                  <span className="font-medium">Atendimento ativo</span> — permite disparar templates de WhatsApp para clientes (recurso pago)
                </span>
              </label>

              {/* Billing section */}
              <div className="border-t border-slate-200 dark:border-slate-600 pt-4 space-y-3">
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase">Dados de Cobrança</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Representante</label>
                    <input
                      type="text"
                      value={form.billing.representative}
                      onChange={(e) => setForm({ ...form, billing: { ...form.billing, representative: e.target.value } })}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700 text-sm"
                      placeholder="Nome completo"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">CPF / CNPJ</label>
                    <input
                      type="text"
                      value={form.billing.cpfCnpj}
                      onChange={(e) => setForm({ ...form, billing: { ...form.billing, cpfCnpj: e.target.value } })}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700 text-sm"
                      placeholder="000.000.000-00"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Telefone de contato</label>
                    <input
                      type="text"
                      value={form.billing.phone}
                      onChange={(e) => setForm({ ...form, billing: { ...form.billing, phone: e.target.value } })}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700 text-sm"
                      placeholder="(11) 99999-0000"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">E-mail de contato</label>
                    <input
                      type="email"
                      value={form.billing.email}
                      onChange={(e) => setForm({ ...form, billing: { ...form.billing, email: e.target.value } })}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700 text-sm"
                      placeholder="financeiro@empresa.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Dia de vencimento</label>
                    <input
                      type="number"
                      min="1"
                      max="28"
                      value={form.billing.dueDay}
                      onChange={(e) => setForm({ ...form, billing: { ...form.billing, dueDay: parseInt(e.target.value) || 10 } })}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">Status do pagamento</label>
                    <select
                      value={form.billing.paymentStatus}
                      onChange={(e) => setForm({ ...form, billing: { ...form.billing, paymentStatus: e.target.value } })}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg dark:bg-slate-700 text-sm"
                    >
                      <option value="paid">Pago</option>
                      <option value="open">Em aberto</option>
                      <option value="overdue">Vencido</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
                >
                  <Check size={18} />
                  Salvar
                </button>
              </div>
            </form>
        </OperationalModal>
      )}
    </div>
  );
}

