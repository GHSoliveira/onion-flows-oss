import { useCallback, useEffect, useState } from 'react';
import { Bell, LayoutDashboard, MessageCircle, Phone, PlugZap, RefreshCcw, UserRound } from 'lucide-react';
import { useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { socketService } from '../services/socket';
import { useAuth } from '../context/AuthContext';
import { SkeletonBox } from '../components/LoadingSkeleton';
import EmbeddedSignupButton from '../components/EmbeddedSignupButton';
import WhatsAppOverview from '../components/whatsapp/WhatsAppOverview';
import WhatsAppAlerts from '../components/whatsapp/WhatsAppAlerts';
import WhatsAppSetupSteps from '../components/whatsapp/WhatsAppSetupSteps';
import WhatsAppProfileIdentity from '../components/whatsapp/WhatsAppProfileIdentity';
import WhatsAppDisconnect from '../components/whatsapp/WhatsAppDisconnect';
import WhatsAppCalls from '../components/whatsapp/WhatsAppCalls';
import { Chip, formatRelative } from '../components/whatsapp/whatsappLabels';
import { useBrand } from '../context/BrandingContext';

// Central do WhatsApp (antiga "Integracao com a Meta"). A rota continua
// /meta-setup para nao quebrar links e dicas ja existentes.

const TABS = [
  { key: 'overview', label: 'Visão geral', icon: LayoutDashboard },
  { key: 'alerts', label: 'Alertas', icon: Bell },
  { key: 'profile', label: 'Nome e foto', icon: UserRound },
  { key: 'calls', label: 'Chamadas', icon: Phone },
  { key: 'setup', label: 'Conexão', icon: PlugZap }
];

const withQuery = (path, params) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== '')).toString();
  return qs ? `${path}?${qs}` : path;
};

const OverviewSkeleton = () => (
  <div className="space-y-3" aria-busy="true">
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={`tile_${index}`} className="space-y-3 border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <SkeletonBox className="h-3 w-24" />
          <SkeletonBox className="h-7 w-20" />
          <SkeletonBox className="h-3 w-32" />
        </div>
      ))}
    </div>
    <div className="grid gap-3 lg:grid-cols-3">
      <div className="h-80 border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 lg:col-span-2"><SkeletonBox className="h-full w-full" /></div>
      <div className="h-80 border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"><SkeletonBox className="h-full w-full" /></div>
    </div>
  </div>
);

export default function MetaSetup() {
  const brand = useBrand();
  const { tenantId: routeTenantId } = useParams();
  const { tenant, user } = useAuth();
  // A aba Conexao (token, ids e desconectar) e configuracao tecnica: so o super
  // admin ve. O cliente conecta pelo botao da Meta e acompanha o resto.
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const tabs = isSuperAdmin ? TABS : TABS.filter(({ key }) => key !== 'setup');
  const tenantId = routeTenantId || (tenant && tenant.id !== 'super_admin' ? tenant.id : null);

  const q = tenantId ? `?tenantId=${tenantId}` : '';
  const channelsPath = tenantId ? `/tenant/${tenantId}/channels` : '/channels';
  const templatesPath = tenantId ? `/tenant/${tenantId}/templates` : '/templates';

  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState({ hasToken: false, wabaId: '', phoneNumberId: '', verifyToken: '' });
  const [tab, setTab] = useState('overview');
  const [snapshot, setSnapshot] = useState(null);
  const [snapshotError, setSnapshotError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [alerts, setAlerts] = useState({ items: [], unread: 0 });
  const [marking, setMarking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // "Atualizado ha X min" anda sozinho.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await apiRequest(`/channels${q}`);
      const data = res && res.ok ? await res.json() : {};
      const wa = data?.whatsapp || {};
      const next = {
        hasToken: Boolean(wa.accessToken),
        wabaId: wa.wabaId || '',
        phoneNumberId: wa.phoneNumberId || '',
        verifyToken: wa.webhookVerifyToken || ''
      };
      setConfig(next);
      if (!next.hasToken && isSuperAdmin) setTab('setup');
      return next;
    } catch {
      toast.error('Falha ao carregar a configuração do canal');
      return null;
    } finally {
      setLoading(false);
    }
  }, [q, isSuperAdmin]);

  const loadAlerts = useCallback(async () => {
    try {
      // Ate 200 (o maximo da API); a lista pagina na tela.
      const res = await apiRequest(`/channels/whatsapp/alerts${q ? `${q}&` : '?'}limit=200`);
      if (!res || !res.ok) return;
      const data = await res.json();
      setAlerts({ items: data.alerts || [], unread: data.unread || 0 });
    } catch {
      // A lista de alertas e secundaria: o dashboard segue sem ela.
    }
  }, [q]);

  const loadSnapshot = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const res = await apiRequest(withQuery('/channels/whatsapp/insights', { tenantId, refresh: refresh ? '1' : null }));
      if (!res) return;
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || 'Não foi possível carregar os dados da conta.');
      setSnapshot(data);
      setSnapshotError('');
      if (data?.newAlerts) loadAlerts();
    } catch (error) {
      setSnapshotError(error.message);
      if (refresh) toast.error(error.message);
    } finally {
      if (refresh) setRefreshing(false);
    }
  }, [tenantId, loadAlerts]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  useEffect(() => {
    if (!config.hasToken) return;
    loadSnapshot(false);
    loadAlerts();
  }, [config.hasToken, config.phoneNumberId, loadSnapshot, loadAlerts]);

  useEffect(() => {
    const onAlert = (alert) => {
      if (tenantId && alert?.tenantId && alert.tenantId !== tenantId) return;
      setAlerts((prev) => (prev.items.some((item) => item.id === alert.id)
        ? prev
        : { items: [alert, ...prev.items].slice(0, 200), unread: prev.unread + 1 }));
    };
    socketService.on('whatsapp_account_alert', onAlert);
    return () => socketService.off('whatsapp_account_alert', onAlert);
  }, [tenantId]);

  const markAllRead = async () => {
    setMarking(true);
    try {
      const res = await apiRequest(`/channels/whatsapp/alerts/read${q}`, { method: 'POST', body: JSON.stringify({}) });
      if (!res || !res.ok) throw new Error('Não foi possível marcar os alertas como lidos.');
      const readAt = new Date().toISOString();
      setAlerts((prev) => ({ items: prev.items.map((alert) => (alert.readAt ? alert : { ...alert, readAt })), unread: 0 }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setMarking(false);
    }
  };

  const handleDisconnected = async () => {
    setSnapshot(null);
    setSnapshotError('');
    await loadConfig();
    setTab(isSuperAdmin ? 'setup' : 'overview');
  };

  const handleConnected = async () => {
    const next = await loadConfig();
    if (next?.hasToken) {
      setTab('overview');
      loadSnapshot(true);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-4 py-6">
        <div className="space-y-2">
          <SkeletonBox className="h-3 w-32" />
          <SkeletonBox className="h-7 w-64" />
          <SkeletonBox className="h-4 w-80" />
        </div>
        <OverviewSkeleton />
      </div>
    );
  }

  const connected = config.hasToken;
  const insights = snapshot?.insights || null;
  const phone = insights?.phone || null;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-gray-500 dark:text-gray-400">WhatsApp Business</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">Central do WhatsApp</h1>
          {connected && phone ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-gray-600 dark:text-gray-300">
              <span className="inline-flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-600 text-white" aria-hidden="true">
                  <MessageCircle size={13} />
                </span>
                <span className="font-medium text-gray-900 dark:text-white">{phone.verifiedName || 'Número conectado'}</span>
              </span>
              {phone.displayPhoneNumber ? <span>{phone.displayPhoneNumber}</span> : null}
              {phone.status === 'CONNECTED'
                ? <Chip tone="good">Conectado</Chip>
                : phone.status ? <Chip tone="warning">Status: {phone.status}</Chip> : null}
              {snapshot?.fetchedAt ? (
                <span className="text-xs text-gray-400">Atualizado {formatRelative(snapshot.fetchedAt, now)}</span>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {connected
                ? 'Saúde do número, envios, custo e alertas da conta.'
                : 'Conecte o WhatsApp da empresa para acompanhar a saúde do número, os envios e os alertas.'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {connected ? (
            <button
              type="button"
              onClick={() => loadSnapshot(true)}
              disabled={refreshing}
              className="inline-flex h-9 items-center gap-2 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
            >
              <RefreshCcw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
              {refreshing ? 'Atualizando...' : 'Atualizar'}
            </button>
          ) : null}
          <EmbeddedSignupButton className="!h-9 !text-xs" substituiCanal={config.hasToken} query={q} onSuccess={handleConnected} />
        </div>
      </header>

      <nav role="tablist" aria-label="Seções da Central do WhatsApp" className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-gray-800">
        {tabs.map(({ key, label, icon: Icon }) => {
          const active = tab === key;
          const disabled = key !== 'setup' && !connected;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={disabled}
              onClick={() => setTab(key)}
              className={`-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${active
                ? 'border-gray-900 text-gray-900 dark:border-white dark:text-white'
                : 'border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'}`}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
              {key === 'alerts' && alerts.unread ? (
                <span className="min-w-5 rounded-full bg-red-600 px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-white">
                  {alerts.unread > 99 ? '99+' : alerts.unread}
                  <span className="sr-only"> não lidos</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div role="tabpanel">
        {tab === 'overview' && connected ? (
          snapshotError && !snapshot ? (
            <div className="border border-gray-200 bg-white px-6 py-10 text-center dark:border-gray-800 dark:bg-gray-900">
              <p className="text-sm font-medium text-gray-900 dark:text-white">Não deu para carregar os dados da conta</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{snapshotError}</p>
              <button
                type="button"
                onClick={() => loadSnapshot(true)}
                className="mt-4 inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-xs font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200"
              >
                <RefreshCcw size={14} aria-hidden="true" /> Tentar de novo
              </button>
            </div>
          ) : !snapshot ? (
            <OverviewSkeleton />
          ) : snapshot.connected === false ? (
            <div className="border border-gray-200 bg-white px-6 py-10 text-center dark:border-gray-800 dark:bg-gray-900">
              <p className="text-sm font-medium text-gray-900 dark:text-white">Falta pouco para ver o dashboard</p>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">O canal tem token, mas ainda não tem a conta do WhatsApp (WABA ID) configurada.</p>
              {isSuperAdmin ? (
                <button type="button" onClick={() => setTab('setup')} className="mt-4 text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400">
                  Completar na aba Conexão
                </button>
              ) : null}
            </div>
          ) : (
            <div className={`transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
              <WhatsAppOverview
                insights={insights}
                alerts={alerts.items}
                onOpenAlerts={() => setTab('alerts')}
                templatesPath={templatesPath}
                now={now}
              />
            </div>
          )
        ) : null}

        {tab === 'alerts' ? (
          <WhatsAppAlerts alerts={alerts.items} unread={alerts.unread} onMarkAllRead={markAllRead} marking={marking} now={now} />
        ) : null}

        {tab === 'profile' && connected ? <WhatsAppProfileIdentity q={q} /> : null}

        {tab === 'calls' && connected ? <WhatsAppCalls q={q} /> : null}

        {!connected && !isSuperAdmin ? (
          <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-4 border border-emerald-200 bg-emerald-50 px-4 py-4 dark:border-emerald-900/60 dark:bg-emerald-950/30">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">Conecte o WhatsApp da empresa</p>
              <p className="mt-0.5 text-xs text-emerald-800/80 dark:text-emerald-200/80">
                Em poucos cliques você autoriza o {brand.productName} pela Meta e o número já fica pronto.
              </p>
            </div>
            <EmbeddedSignupButton className="!h-9 !text-xs" query={q} onSuccess={handleConnected} />
          </div>
        ) : null}

        {tab === 'setup' && isSuperAdmin ? (
          <div className="space-y-3">
            {!connected ? (
              <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-4 border border-emerald-200 bg-emerald-50 px-4 py-4 dark:border-emerald-900/60 dark:bg-emerald-950/30">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">Jeito mais rápido: conectar pela Meta</p>
                  <p className="mt-0.5 text-xs text-emerald-800/80 dark:text-emerald-200/80">
                    Em poucos cliques você autoriza o {brand.productName} e o número já fica pronto. O passo a passo manual continua abaixo.
                  </p>
                </div>
                <EmbeddedSignupButton className="!h-9 !text-xs" query={q} onSuccess={handleConnected} />
              </div>
            ) : null}
            <WhatsAppSetupSteps tenantId={tenantId} q={q} channelsPath={channelsPath} config={config} onConfigChanged={loadConfig} />
            {connected ? <WhatsAppDisconnect q={q} phone={phone} onDisconnected={handleDisconnected} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
