import { useState, useEffect, useMemo } from 'react';
import { apiRequest } from '../services/api';
import { useTenant } from '../context/TenantContext';
import { Building2, Users, Workflow, MessageSquare, Activity, ArrowRight, Smartphone, KeyRound, Copy, Gauge, FlaskConical, Rocket, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { SkeletonBox, TableSkeleton } from '../components/LoadingSkeleton';

import TablePagination, { usePagination } from '../components/TablePagination';
import SentryIssuesCard from '../components/SentryIssuesCard';
import { Chip, CountUp, Freshness, Meter, SegmentBar } from '../components/admin/OpsKit';
import { PAYMENT_TONE, PLAN_LABEL, TENANT_STATUS_TONE, reveal } from '../components/admin/opsTones';

// Limites do Google para Web Vitals (valor no P75): bom ate o 1o, ruim depois do 2o.
const VITALS = {
  LCP: { limits: [2500, 4000], unit: 'ms', hint: 'Maior elemento visível' },
  FCP: { limits: [1800, 3000], unit: 'ms', hint: 'Primeiro conteúdo na tela' },
  INP: { limits: [200, 500], unit: 'ms', hint: 'Resposta a cliques' },
  TTFB: { limits: [800, 1800], unit: 'ms', hint: 'Resposta do servidor' },
  CLS: { limits: [0.1, 0.25], unit: '', hint: 'Estabilidade do layout' }
};

const formatVital = (name, value) => {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (name === 'CLS') return number.toFixed(2);
  return `${Math.round(number).toLocaleString('pt-BR')} ms`;
};

const vitalTone = (name, p75) => {
  const meta = VITALS[name];
  const number = Number(p75);
  if (!meta || !Number.isFinite(number)) return null;
  if (number <= meta.limits[0]) return { tone: 'ok', label: 'Bom' };
  if (number <= meta.limits[1]) return { tone: 'warn', label: 'Atenção' };
  return { tone: 'bad', label: 'Ruim' };
};

const CHANNEL_STATUS = {
  ok: { tone: 'ok', label: 'OK' },
  misconfigured: { tone: 'warn', label: 'Config. incompleta' },
  error: { tone: 'bad', label: 'Erro' },
  disabled: { tone: 'neutral', label: 'Desligado' }
};

const formatUptime = (seconds) => {
  if (!seconds && seconds !== 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hrs}h` : `${hrs}h ${mins}m`;
};

export default function SuperAdminDashboard() {
  const [metrics, setMetrics] = useState(null);
  const [allTenants, setAllTenants] = useState([]);
  const [environmentBusy, setEnvironmentBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [monitoring, setMonitoring] = useState(null);
  const [monitoringLoading, setMonitoringLoading] = useState(true);
  const [vitals, setVitals] = useState(null);
  const [vitalsLoading, setVitalsLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [externalTokenLoading, setExternalTokenLoading] = useState(false);
  const [externalTokenResult, setExternalTokenResult] = useState(null);
  const [tokenUsers, setTokenUsers] = useState([]);
  const [tokenUsersLoading, setTokenUsersLoading] = useState(false);
  const [tokenForm, setTokenForm] = useState({
    tenantId: '',
    role: 'ADMIN',
    expiresIn: '30d',
    targetUserId: ''
  });
  const { switchTenant } = useTenant();
  const navigate = useNavigate();

  // Uma linha por empresa: uso e cobranca (dashboard) + ambiente (lista completa,
  // que tambem traz as empresas de desenvolvimento fora das metricas).
  const tenantRows = useMemo(() => {
    const billing = metrics?.billing || [];
    const byId = new Map(billing.map((item) => [item.tenantId, item]));
    const base = allTenants.length ? allTenants : billing.map((item) => ({ id: item.tenantId, name: item.name }));
    return base
      .map((tenant) => {
        const id = tenant.id || tenant.tenantId;
        const metric = byId.get(id) || {};
        return {
          ...metric,
          tenantId: id,
          name: tenant.name || metric.name,
          // O dashboard nao traz cobranca: pagamento, plano e estado vem do cadastro.
          plan: tenant.plan || metric.plan,
          status: tenant.status || metric.status,
          billing: tenant.billing || metric.billing,
          isDev: String(tenant.environment || 'production').toLowerCase() === 'development'
        };
      })
      .sort((a, b) => Number(a.isDev) - Number(b.isDev) || String(a.name).localeCompare(String(b.name), 'pt-BR'));
  }, [metrics, allTenants]);
  const tenantsPage = usePagination(tenantRows, 10);
  const whatsappByTenant = useMemo(
    () => new Map((monitoring?.channels?.tenants || []).map((item) => [item.tenantId, item.whatsapp?.status])),
    [monitoring]
  );
  const channelsPage = usePagination(monitoring?.channels?.tenants);

  useEffect(() => {
    fetchDashboard();
    fetchAllTenants();

    const scheduleSecondaryLoad = () => {
      fetchMonitoring();
      fetchVitals();
    };

    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(scheduleSecondaryLoad, { timeout: 2500 });
      return () => window.cancelIdleCallback(idleId);
    }

    const timer = setTimeout(scheduleSecondaryLoad, 1200);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (tokenForm.tenantId) return;
    const firstTenantId = metrics?.billing?.[0]?.tenantId;
    if (firstTenantId) {
      setTokenForm((prev) => ({ ...prev, tenantId: firstTenantId }));
    }
  }, [metrics, tokenForm.tenantId]);

  useEffect(() => {
    let cancelled = false;

    const loadTokenUsers = async () => {
      if (!tokenForm.tenantId || !tokenForm.role) {
        setTokenUsers([]);
        setTokenUsersLoading(false);
        return;
      }

      setTokenUsersLoading(true);

      try {
        const params = new URLSearchParams({
          tenantId: tokenForm.tenantId,
          role: tokenForm.role
        });
        const res = await apiRequest(`/super-admin/external-token/users?${params.toString()}`);
        if (!res) return;

        const data = await res.json();
        if (!res.ok) {
          if (!cancelled) {
            setTokenUsers([]);
            toast.error(data?.error || 'Falha ao carregar usuarios para token');
          }
          return;
        }

        const users = Array.isArray(data?.items) ? data.items : [];
        if (cancelled) return;
        setTokenUsers(users);
        setTokenForm((prev) => {
          if (!prev.targetUserId) return prev;
          const stillExists = users.some((user) => user.id === prev.targetUserId);
          return stillExists ? prev : { ...prev, targetUserId: '' };
        });
      } catch (error) {
        if (!cancelled) {
          setTokenUsers([]);
          toast.error(error?.message || 'Falha ao carregar usuarios para token');
        }
      } finally {
        if (!cancelled) setTokenUsersLoading(false);
      }
    };

    loadTokenUsers();

    return () => {
      cancelled = true;
    };
  }, [tokenForm.tenantId, tokenForm.role]);

  const fetchAllTenants = async () => {
    try {
      const res = await apiRequest('/tenants');
      if (res && res.ok) setAllTenants(await res.json());
    } catch {
      // a lista de acesso e secundaria: falhar aqui nao derruba o dashboard
    }
  };

  const changeEnvironment = async (tenantId, environment) => {
    try {
      setEnvironmentBusy(tenantId);
      const res = await apiRequest(`/tenants/${tenantId}/environment`, {
        method: 'PATCH', body: JSON.stringify({ environment })
      });
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha ao alterar ambiente');
      toast.success(environment === 'development' ? 'Empresa marcada como desenvolvimento' : 'Empresa marcada como producao');
      await Promise.all([fetchAllTenants(), fetchDashboard()]);
    } catch (error) {
      toast.error(error.message || 'Falha ao alterar ambiente');
    } finally {
      setEnvironmentBusy('');
    }
  };

  const fetchDashboard = async () => {
    try {
      const res = await apiRequest('/super-admin/dashboard');
      if (res && res.ok) {
        const data = await res.json();
        setMetrics(data);
        setRefreshedAt(Date.now());
      } else {
        toast.error('Erro ao carregar dashboard');
      }
    } catch (error) {
      toast.error('Erro ao carregar dashboard');
    } finally {
      setLoading(false);
    }
  };

  const fetchMonitoring = async () => {
    try {
      const res = await apiRequest('/super-admin/monitoring');
      if (res && res.ok) {
        const data = await res.json();
        setMonitoring(data);
      } else {
        toast.error('Erro ao carregar monitoramento global');
      }
    } catch (error) {
      toast.error('Erro ao carregar monitoramento global');
    } finally {
      setMonitoringLoading(false);
    }
  };

  const fetchVitals = async () => {
    try {
      const res = await apiRequest('/super-admin/web-vitals?days=7');
      if (res && res.ok) {
        const data = await res.json();
        setVitals(data);
      } else {
        toast.error('Erro ao carregar Web Vitals');
      }
    } catch (error) {
      toast.error('Erro ao carregar Web Vitals');
    } finally {
      setVitalsLoading(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all([fetchDashboard(), fetchAllTenants(), fetchMonitoring()]);
    setRefreshing(false);
  };

  const handleAccessTenant = async (tenantId) => {
    await switchTenant(tenantId);
    navigate(`/tenant/${tenantId}/monitor`);
  };

  const handleGenerateExternalToken = async () => {
    if (!tokenForm.tenantId) {
      toast.error('Selecione um tenant');
      return;
    }

    setExternalTokenLoading(true);
    setExternalTokenResult(null);

    try {
      const res = await apiRequest('/super-admin/external-token', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: tokenForm.tenantId,
          role: tokenForm.role,
          expiresIn: tokenForm.expiresIn,
          targetUserId: tokenForm.targetUserId || undefined
        })
      });

      if (!res) return;
      const data = await res.json();

      if (!res.ok) {
        toast.error(data?.error || 'Falha ao gerar token');
        return;
      }

      setExternalTokenResult(data);
      toast.success('Token gerado com sucesso');
    } catch (error) {
      toast.error(error?.message || 'Falha ao gerar token');
    } finally {
      setExternalTokenLoading(false);
    }
  };

  const handleCopyExternalToken = async () => {
    if (!externalTokenResult?.token) return;
    try {
      await navigator.clipboard.writeText(externalTokenResult.token);
      toast.success('Token copiado');
    } catch (error) {
      toast.error('Nao foi possivel copiar o token');
    }
  };

  if (loading) {
    return (
      <div className="super-admin-operational p-3 sm:p-4 lg:p-6 space-y-6">
        <div className="space-y-2">
          <SkeletonBox className="h-6 w-48" />
          <SkeletonBox className="h-4 w-64" />
        </div>
        <div className="sa-metric-strip grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={`metric_${index}`} className="p-4 sm:p-6 space-y-3">
              <SkeletonBox className="h-9 w-9" />
              <SkeletonBox className="h-7 w-16" />
              <SkeletonBox className="h-3 w-24" />
            </div>
          ))}
        </div>
        <div className="sa-metric-strip grid-cols-1 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <div key={`carteira_${index}`} className="p-4 space-y-3">
              <SkeletonBox className="h-3 w-32" />
              <SkeletonBox className="h-1.5 w-full" />
              <SkeletonBox className="h-3 w-48" />
            </div>
          ))}
        </div>
        <TableSkeleton rows={4} cols={6} />
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="super-admin-operational p-6">
        <div className="sa-card border border-slate-200 p-4 text-sm dark:border-slate-700" data-tone="bad">
          Erro ao carregar dashboard do super admin. Verifique se o endpoint está funcionando.
        </div>
      </div>
    );
  }

  const production = tenantRows.filter((row) => !row.isDev);
  const paymentCount = (status) => production.filter((row) => row.billing?.paymentStatus === status).length;
  const hiddenDev = metrics.scope?.developmentTenantsHidden || 0;

  return (
    <div className="super-admin-operational p-3 sm:p-4 lg:p-6 dark:bg-slate-900">
      <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Dashboard Geral</h1>
          <p className="mt-1 text-slate-600 dark:text-slate-400">Visão geral de todos os tenants</p>
        </div>
        <Freshness at={refreshedAt} busy={refreshing} onRefresh={refreshAll} />
      </div>

      <div className="sa-metric-strip grid-cols-2 lg:grid-cols-4 mb-6">
        <MetricCard index={0} icon={Building2} label="Tenants" value={metrics.tenants?.total || 0} subtext={`${metrics.tenants?.ativos || 0} ativos`} />
        <MetricCard index={1} icon={Users} label="Usuários" value={metrics.usuarios?.total || 0} subtext="Em todos os tenants" />
        <MetricCard index={2} icon={Workflow} label="Flows" value={metrics.flows?.total || 0} subtext="Fluxos criados" />
        <MetricCard index={3} icon={MessageSquare} label="Chats ativos" value={metrics.chats?.total || 0} subtext="Conversas em andamento" />
      </div>

      <div className="sa-metric-strip grid-cols-1 md:grid-cols-2 mb-8">
        <div className="sa-reveal p-4 sm:px-6" style={reveal(4)}>
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Carteira por estado</div>
          <SegmentBar
            segments={[
              { label: 'ativos', value: metrics.tenants?.ativos || 0, tone: 'ok' },
              { label: 'em trial', value: metrics.tenants?.trial || 0, tone: 'warn' },
              { label: 'suspensos', value: metrics.tenants?.suspensos || 0, tone: 'bad' }
            ]}
          />
        </div>
        <div className="sa-reveal p-4 sm:px-6" style={reveal(5)}>
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Pagamentos</div>
          <SegmentBar
            segments={[
              { label: 'em dia', value: paymentCount('paid'), tone: 'ok' },
              { label: 'em aberto', value: paymentCount('open'), tone: 'warn' },
              { label: 'vencidos', value: paymentCount('overdue'), tone: 'bad' }
            ]}
          />
        </div>
      </div>

      <SentryIssuesCard />

      <section className="border-y border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-2 px-0 py-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-800 dark:text-white">
            <Building2 size={20} /> Tenants
          </h2>
          {hiddenDev > 0 && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {hiddenDev} empresa(s) de desenvolvimento ficam fora dos números acima, mas seguem acessíveis aqui.
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left">
            <thead>
              <tr className="border-y border-slate-200 dark:border-slate-800">
                {['Tenant', 'Plano', 'Pagamento', 'Usuários', 'Flows', 'Chats hoje', 'WhatsApp', ''].map((label, index) => (
                  <th key={label || index} className="px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 first:pl-3">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {tenantsPage.pageItems.map((row, index) => {
                const payment = PAYMENT_TONE[row.billing?.paymentStatus];
                const status = TENANT_STATUS_TONE[row.status];
                const hasUsage = Boolean(row.usage);
                return (
                  <tr key={row.tenantId} className="sa-row sa-reveal" style={reveal(index)}>
                    <td className="py-3 pl-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900 dark:text-white">{row.name}</span>
                        {status && row.status !== 'active' && <Chip tone={status.tone}>{status.label}</Chip>}
                        {row.isDev && <Chip tone="warn" icon={FlaskConical}>Desenvolvimento</Chip>}
                      </div>
                      {row.isDev && <div className="mt-1 text-[11px] text-slate-400">fora das métricas e da cobrança</div>}
                    </td>
                    <td className="px-4 py-3">{row.plan ? <Chip>{PLAN_LABEL[row.plan] || row.plan}</Chip> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="px-4 py-3">
                      {payment ? <Chip tone={payment.tone}>{payment.label}</Chip> : <span className="text-xs text-slate-400">—</span>}
                      {row.billing?.dueDay && <div className="mt-1 text-[11px] text-slate-400">vence dia {row.billing.dueDay}</div>}
                    </td>
                    <td className="w-[120px] px-4 py-3">{hasUsage ? <Meter value={row.usage.users || 0} max={row.limits?.maxUsers} /> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="w-[120px] px-4 py-3">{hasUsage ? <Meter value={row.usage.flows || 0} max={row.limits?.maxFlows} /> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="w-[130px] px-4 py-3">{hasUsage ? <Meter value={row.usage.chatsToday || 0} max={row.limits?.maxChatsPerDay} /> : <span className="text-xs text-slate-400">—</span>}</td>
                    <td className="px-4 py-3">
                      {whatsappByTenant.has(row.tenantId)
                        ? <Chip tone={(CHANNEL_STATUS[whatsappByTenant.get(row.tenantId)] || CHANNEL_STATUS.disabled).tone} icon={Smartphone}>{(CHANNEL_STATUS[whatsappByTenant.get(row.tenantId)] || CHANNEL_STATUS.disabled).label}</Chip>
                        : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => changeEnvironment(row.tenantId, row.isDev ? 'production' : 'development')}
                          disabled={environmentBusy === row.tenantId}
                          title={row.isDev ? 'Passar a contar nas métricas' : 'Tirar das métricas e da cobrança'}
                          aria-label={row.isDev ? `Marcar ${row.name} como produção` : `Marcar ${row.name} como teste`}
                          className="sa-icon-btn"
                          data-tone={row.isDev ? 'ok' : 'warn'}
                        >
                          {row.isDev ? <Rocket size={14} /> : <FlaskConical size={14} />}
                        </button>
                        <button type="button" onClick={() => handleAccessTenant(row.tenantId)} className="sa-btn sa-press sa-nudge" data-tone="info" data-solid="">
                          Acessar <ArrowRight size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <TablePagination {...tenantsPage} label="tenants" />
      </section>

      <details className="group mt-8 border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-4 text-xs font-semibold uppercase tracking-[0.12em] text-slate-600 transition-colors hover:text-blue-600 dark:text-slate-300"><span className="inline-flex items-center gap-2"><KeyRound size={15} /> Tokens externos</span><span className="text-lg font-normal text-slate-400 transition-transform group-open:rotate-45">+</span></summary>
      <div className="border-t border-slate-200 p-4 dark:border-slate-800 sm:p-6">
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          Gera token para uso externo em API, com role e tenant definidos.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
            Tenant
            <select
              value={tokenForm.tenantId}
              onChange={(e) => setTokenForm((prev) => ({ ...prev, tenantId: e.target.value, targetUserId: '' }))}
              className="px-3 py-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
            >
              <option value="">Selecione</option>
              {(metrics.billing || []).map((tenant) => (
                <option key={tenant.tenantId} value={tenant.tenantId}>
                  {tenant.name} ({tenant.tenantId})
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
            Role
            <select
              value={tokenForm.role}
              onChange={(e) => setTokenForm((prev) => ({ ...prev, role: e.target.value, targetUserId: '' }))}
              className="px-3 py-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
            >
              <option value="ADMIN">ADMIN</option>
              <option value="MANAGER">MANAGER</option>
              <option value="AGENT">AGENT</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
            Expira em
            <select
              value={tokenForm.expiresIn}
              onChange={(e) => setTokenForm((prev) => ({ ...prev, expiresIn: e.target.value }))}
              className="px-3 py-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
            >
              <option value="8h">8h</option>
              <option value="24h">24h</option>
              <option value="7d">7d</option>
              <option value="30d">30d</option>
              <option value="90d">90d</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">
            Usuario especifico (opcional)
            <select
              value={tokenForm.targetUserId}
              onChange={(e) => setTokenForm((prev) => ({ ...prev, targetUserId: e.target.value }))}
              disabled={!tokenForm.tenantId || tokenUsersLoading}
              className="px-3 py-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 disabled:opacity-60"
            >
              <option value="">Automatico (primeiro {tokenForm.role})</option>
              {tokenUsersLoading && <option value="">Carregando usuarios...</option>}
              {!tokenUsersLoading && tokenUsers.map((user) => {
                const displayName = user.name || user.username || user.id;
                return (
                  <option key={user.id} value={user.id}>
                    {displayName} ({user.role}) [{user.id}]
                  </option>
                );
              })}
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={handleGenerateExternalToken}
            disabled={externalTokenLoading}
            className="sa-btn sa-press"
            data-tone="info"
            data-solid=""
          >
            <KeyRound size={13} /> {externalTokenLoading ? 'Gerando...' : 'Gerar token'}
          </button>
          {externalTokenResult?.token && (
            <button onClick={handleCopyExternalToken} className="sa-btn sa-press">
              <Copy size={13} /> Copiar token
            </button>
          )}
        </div>

        {externalTokenResult?.token && (
          <div className="sa-reveal mt-4 border border-slate-200 dark:border-slate-700 p-3 bg-slate-50 dark:bg-slate-900/40">
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-2">
              Usuario: {externalTokenResult?.user?.name || '-'} ({externalTokenResult?.user?.role || '-'}) · Expira em {externalTokenResult?.expiresIn || '-'}
            </div>
            <code className="block text-[11px] break-all text-slate-700 dark:text-slate-200">
              {externalTokenResult.token}
            </code>
          </div>
        )}
      </div>
      </details>

      <div className="mt-8 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
          <Activity size={20} />
          Monitoramento Global
        </h2>
        {monitoringLoading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : !monitoring ? (
          <div className="text-sm text-slate-500">Falha ao carregar monitoramento.</div>
        ) : (
          <>
            {/* Se a pagina carregou, servidor e banco estao de pe: "Online"/"Conectado"
                nao diria nada. O banco so aparece quando falha. */}
            {monitoring.database?.ok === false && (
              <div className="sa-note mb-4" data-tone="bad">
                <AlertTriangle size={13} />
                Banco de dados com erro: {monitoring.database?.error || 'falha de conexão'}
              </div>
            )}
            <div className="sa-metric-strip grid-cols-1 md:grid-cols-2">
              <HealthTile
                index={0}
                label="Aguardando atendimento"
                tone={(monitoring.queues?.waitingChats || 0) > 0 ? 'warn' : undefined}
                value={<CountUp value={monitoring.queues?.waitingChats || 0} />}
                detail={`em ${monitoring.queues?.totalQueues || 0} filas`}
              />
              <HealthTile
                index={1}
                label="Último reinício do servidor"
                value={`há ${formatUptime(monitoring.server?.uptimeSec)}`}
                detail="zera a cada deploy"
              />
            </div>

            <div className="mt-6">
              <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Saúde dos canais</div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 border-b border-slate-200 dark:border-slate-700">
                      <th className="pb-3 pl-3">Tenant</th>
                      <th className="pb-3">Telegram</th>
                      <th className="pb-3">WhatsApp</th>
                      <th className="pb-3">Alertas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                    {channelsPage.pageItems.map((tenant, index) => {
                      const telegram = CHANNEL_STATUS[tenant.telegram?.status] || CHANNEL_STATUS.disabled;
                      const whatsapp = CHANNEL_STATUS[tenant.whatsapp?.status] || CHANNEL_STATUS.disabled;
                      return (
                        <tr key={tenant.tenantId} className="sa-row sa-reveal" style={reveal(index)}>
                          <td className="py-3 pl-3 text-sm font-medium text-slate-800 dark:text-white">{tenant.name}</td>
                          <td className="py-3"><Chip tone={telegram.tone}>{telegram.label}</Chip></td>
                          <td className="py-3"><Chip tone={whatsapp.tone}>{whatsapp.label}</Chip></td>
                          <td className="py-3 text-xs">
                            {tenant.alerts?.length
                              ? <Chip tone="warn" icon={AlertTriangle}>{tenant.alerts.join(' · ')}</Chip>
                              : <span className="text-slate-400">Sem alertas</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <TablePagination {...channelsPage} label="tenants" />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="mt-8 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Gauge size={20} />
            Web Vitals (7 dias)
          </h2>
          <button
            onClick={() => window.open('/api/super-admin/web-vitals/export?days=7', '_blank')}
            className="sa-btn sa-press"
          >
            Exportar CSV
          </button>
        </div>
        {vitalsLoading ? (
          <TableSkeleton rows={6} cols={4} />
        ) : !vitals ? (
          <div className="text-sm text-slate-500">Falha ao carregar Web Vitals.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 border-b border-slate-200 dark:border-slate-700">
                  <th className="pb-3 pl-3">Métrica</th>
                  <th className="pb-3">P75</th>
                  <th className="pb-3">Média</th>
                  <th className="pb-3">P95</th>
                  <th className="pb-3">Amostras</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {Object.entries(vitals.summary || {}).map(([name, stats], index) => {
                  const grade = vitalTone(name, stats.p75);
                  return (
                    <tr key={name} className="sa-row sa-reveal" style={reveal(index)}>
                      <td className="py-3 pl-3">
                        <div className="text-sm font-semibold text-slate-800 dark:text-white">{name}</div>
                        {VITALS[name] && <div className="text-[11px] text-slate-400">{VITALS[name].hint}</div>}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold tabular-nums text-slate-800 dark:text-white">{formatVital(name, stats.p75)}</span>
                          {grade && <Chip tone={grade.tone}>{grade.label}</Chip>}
                        </div>
                      </td>
                      <td className="py-3 text-sm tabular-nums text-slate-600 dark:text-slate-300">{formatVital(name, stats.avg)}</td>
                      <td className="py-3 text-sm tabular-nums text-slate-600 dark:text-slate-300">{formatVital(name, stats.p95)}</td>
                      <td className="py-3 text-sm tabular-nums text-slate-600 dark:text-slate-300">{stats.count ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, subtext, index }) {
  return (
    <div className="sa-reveal group p-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 sm:p-6" style={reveal(index)}>
      <div className="mb-4 grid h-9 w-9 place-items-center border border-slate-200 text-slate-500 transition-colors group-hover:border-blue-500 group-hover:text-blue-600 dark:border-slate-700 dark:text-slate-400 dark:group-hover:text-blue-400">
        <Icon size={18} />
      </div>
      <div className="text-3xl font-bold text-slate-800 dark:text-white"><CountUp value={value} /></div>
      <div className="text-sm font-medium text-slate-600 dark:text-slate-300">{label}</div>
      {subtext && <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{subtext}</div>}
    </div>
  );
}

function HealthTile({ label, value, detail, tone, index }) {
  const problem = tone === 'bad' || tone === 'warn';
  return (
    <div className="sa-reveal p-4" style={reveal(index)} data-tone={problem ? tone : undefined}>
      <div className="text-sm text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-800 dark:text-white" style={problem ? { color: 'var(--tone)' } : undefined}>{value}</div>
      <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{detail}</div>
    </div>
  );
}
