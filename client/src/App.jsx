import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import './styles/super-admin-operational.css';
import './styles/agent-operational.css';
import { Routes, Route, NavLink, Navigate, useParams, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from './context/AuthContext';
import { can, hasManagerPermission } from './utils/managerPermissions';
import { TenantProvider, useTenant } from './context/TenantContext';
import { apiRequest } from './services/api';
import { socketService } from './services/socket';
import Login from './pages/Login';
import BrandMark from './components/BrandMark';
import { useBrand } from './context/BrandingContext';
import BillingPausedBanner from './components/BillingPausedBanner';
import OnionAssistant from './components/OnionAssistant';
import {
  LayoutDashboard, Workflow, Users, FileText, Database,
  CalendarClock, MessageSquare, MessageCircle, Headset, Bot, PlugZap, Boxes,
  Activity, ScrollText, Moon, Sun, Bell, Menu, X, Building2, Box, PhoneCall, CreditCard, BarChart3,
  Shield, Settings, ChevronDown, Inbox, Megaphone, TriangleAlert, Library,
  SlidersHorizontal, FlaskConical, Gauge, KeyRound, CalendarRange, Palette,
  Webhook, Archive, ClipboardList, CircleDollarSign, ContactRound, Handshake
} from 'lucide-react';


const FlowList = lazy(() => import('./pages/FlowList'));
const FlowEditor = lazy(() => import('./pages/FlowEditor'));
const VariableManager = lazy(() => import('./pages/VariableManager'));
const TemplateManager = lazy(() => import('./pages/TemplateManager'));
const AgentManager = lazy(() => import('./pages/AgentManager'));
const AgentWorkspace = lazy(() => import('./pages/AgentWorkspace'));
const InternalTasks = lazy(() => import('./pages/InternalTasks'));
const AgentDashboard = lazy(() => import('./pages/AgentDashboard'));
const ActiveContacts = lazy(() => import('./pages/ActiveContacts'));
const ScheduleManager = lazy(() => import('./pages/ScheduleManager'));
const MonitoringDashboard = lazy(() => import('./pages/MonitoringDashboard'));
const SystemLogs = lazy(() => import('./pages/SystemLogs'));
const ChatHistory = lazy(() => import('./pages/ChatHistory'));
const AnalyticsDashboard = lazy(() => import('./pages/AnalyticsDashboard'));
const Catalog = lazy(() => import('./pages/Catalog'));
const AdminPanel = lazy(() => import('./pages/AdminPanel'));
const PartnerClients = lazy(() => import('./pages/PartnerClients'));
const PartnerBrand = lazy(() => import('./pages/PartnerBrand'));
const PartnerBilling = lazy(() => import('./pages/PartnerBilling'));
const PartnersAdmin = lazy(() => import('./pages/PartnersAdmin'));
const SuperAdminDashboard = lazy(() => import('./pages/SuperAdminDashboard'));
const BillingManager = lazy(() => import('./pages/BillingManager'));
const Channels = lazy(() => import('./pages/Channels'));
const MetaSetup = lazy(() => import('./pages/MetaSetup'));
const SubflowLibrary = lazy(() => import('./pages/SubflowLibrary'));
const SubflowEditor = lazy(() => import('./pages/SubflowEditor'));
import AppSettingsMenu from './components/AppSettingsMenu';
import VoiceCallDock from './components/voice/VoiceCallDock';
const SecurityCenter = lazy(() => import('./pages/SecurityCenter'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./pages/TermsOfService'));
const ReportsCenter = lazy(() => import('./pages/ReportsCenter'));
const TenantModulePage = lazy(() => import('./pages/TenantModulePage'));
const Documentation = lazy(() => import('./pages/Documentation'));
const Help = lazy(() => import('./pages/Help'));
const CommercialOperations = lazy(() => import('./pages/CommercialOperations'));

const LoadingSpinner = () => (
  <div className="flex items-center justify-center h-full">
    <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
  </div>
);


const TenantIndexRedirect = () => {
  const { tenantId } = useParams();
  return <Navigate to={`/tenant/${tenantId}/monitor`} replace />;
};

// Grupos abertos por padrao para todas as opcoes aparecerem de cara; quem
// quiser pode recolher clicando no titulo.
const NavGroup = ({ icon: Icon, label, children }) => (
  <details className="group/nav" open>
    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2 text-[11px] font-semibold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white [&::-webkit-details-marker]:hidden">
      <Icon size={15} className="shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      <ChevronDown size={13} className="shrink-0 transition-transform duration-200 group-open/nav:rotate-180" />
    </summary>
    <div className="ml-[15px] space-y-0.5 border-l border-slate-200 py-1 pl-2 dark:border-slate-800">
      {children}
    </div>
  </details>
);

const normalizePathname = (pathname) => {
  if (!pathname) return '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
};

const isEditorPath = (pathname) => /\/editor\/[^/]+$/.test(normalizePathname(pathname));

const isAdminGlobalPath = (pathname) => {
  const normalized = normalizePathname(pathname);
  return normalized === '/super-admin' || normalized === '/admin' || normalized === '/system-logs';
};

const getPageLabel = (pathname) => {
  const normalized = normalizePathname(pathname);

  if (normalized === '/login') return 'Login';
  if (normalized === '/super-admin') return 'Dashboard';
  if (normalized === '/admin') return 'Tenants';
  if (normalized === '/system-logs') return 'Logs';
  if (/\/monitor$/.test(normalized)) return 'Monitoramento';
  if (/\/analytics$/.test(normalized)) return 'Analytics';
  if (/\/history$/.test(normalized)) return 'Historico';
  if (/\/catalog$/.test(normalized)) return 'Catalogo';
  if (/\/flows$/.test(normalized)) return 'Fluxos';
  if (/\/users$/.test(normalized)) return 'Equipe';
  if (/\/tasks$/.test(normalized)) return 'Tarefas';
  if (/\/templates$/.test(normalized)) return 'Templates';
  if (/\/variables$/.test(normalized)) return 'Variaveis';
  if (/\/schedules$/.test(normalized)) return 'Expediente';
  if (/\/meta-setup$/.test(normalized)) return 'Central do WhatsApp';
  if (/\/channels$/.test(normalized)) return 'Canais';
  if (/\/contacts$/.test(normalized)) return 'Contatos';
  const moduleLabels = {
    inbox: 'Caixa de entrada', campaigns: 'Campanhas', incidents: 'Ocorrencias',
    library: 'Biblioteca', rules: 'Regras globais', tests: 'Testes',
    performance: 'Desempenho', permissions: 'Cargos', shifts: 'Escalas',
    identity: 'Identidade', integrations: 'Webhooks e API', retention: 'Retencao',
    audit: 'Auditoria', usage: 'Cobranca e uso',
  };
  const modulePath = normalized.split('/').filter(Boolean).at(-1);
  if (moduleLabels[modulePath]) return moduleLabels[modulePath];
  if (normalized === '/agent') return 'Meu Atendimento';
  if (normalized === '/agent-dashboard') return 'Meu Dashboard';
  if (normalized === '/agent-active') return 'Atendimento Ativo';
  if (isEditorPath(normalized)) return 'Editor de Fluxo';
  return 'Painel';
};

const AppContent = () => {
  const { user, logout } = useAuth();
  const { tenant } = useTenant();
  const brand = useBrand();
  const navigate = useNavigate();
  const location = useLocation();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('theme') === 'dark');
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const notifRef = useRef(null);
  const lastQueueCountRef = useRef(0);
  const isAgentWorkspace = normalizePathname(location.pathname) === '/agent';

  useEffect(() => {
    const pathname = normalizePathname(location.pathname);
    if (!user) {
      document.title = pathname === '/login' ? `Login - ${brand.productName}` : brand.productName;
      return;
    }

    if (isEditorPath(pathname)) return;

    const pageLabel = getPageLabel(pathname);
    const tenantName = tenant?.name ? String(tenant.name).trim() : '';

    if (isAdminGlobalPath(pathname)) {
      document.title = `${pageLabel} - adm`;
      return;
    }

    if (tenantName) {
      document.title = `${tenantName} - ${pageLabel}`;
      return;
    }

    if (user.role === 'SUPER_ADMIN') {
      document.title = `${pageLabel} - adm`;
      return;
    }

    document.title = `${pageLabel} - ${brand.productName}`;
  }, [brand.productName, location.pathname, tenant?.name, user]);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [darkMode]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notifRef.current && !notifRef.current.contains(event.target)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addNotification = (data) => {
    const entry = {
      id: `n_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      title: data.title,
      message: data.message,
      type: data.type,
      action: data.action || null,
      createdAt: new Date().toISOString(),
      read: false
    };
    setNotifications(prev => [entry, ...prev].slice(0, 50));
  };

  const markAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem('token');
    if (token) socketService.connect(token);

    const onQueueUpdate = (payload) => {
      if (user.role !== 'AGENT') return;
      const chat = payload?.chat || payload;
      const queueName = chat?.queue || chat?.transferredTo || 'Fila';
      addNotification({
        type: 'queue',
        title: 'Novo cliente na fila',
        message: `Chegou um cliente na fila ${queueName}.`,
        action: '/agent'
      });
    };

    const onNewLog = (payload) => {
      if (user.role === 'AGENT') return;
      const log = payload?.log || payload;
      const type = String(log?.type || '');
      if (type !== 'ERROR') return;
      addNotification({
        type: 'error',
        title: 'Erro crítico detectado',
        message: log?.message ? String(log.message).slice(0, 140) : 'Verifique os logs do sistema.',
        action: '/system-logs'
      });
    };

    const onWhatsAppError = (alert) => {
      if (!['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(user.role)) return;
      const title = alert?.title || 'Erro WhatsApp';
      const message = alert?.message || 'O WhatsApp retornou um erro.';
      addNotification({
        type: 'whatsapp_error',
        title,
        message,
        action: '/system-logs'
      });
      toast.error(`${title}: ${message}`, { duration: 7000 });
    };

    // Alertas da conta WhatsApp (qualidade, limite, nome, templates). A lista
    // completa fica na Central do WhatsApp; aqui so avisa quem administra.
    const onWhatsAppAccountAlert = (alert) => {
      if (!['SUPER_ADMIN', 'ADMIN'].includes(user.role)) return;
      const title = alert?.title || 'Aviso da conta WhatsApp';
      const severity = alert?.severity || 'info';
      addNotification({
        type: severity === 'critical' || severity === 'warning' ? 'whatsapp_error' : 'whatsapp_account',
        title,
        message: alert?.message || '',
        action: '/meta-setup'
      });
      if (severity === 'critical') toast.error(title, { duration: 7000 });
      else if (severity === 'warning') toast(title, { duration: 6000 });
      else if (severity === 'success') toast.success(title);
    };

    socketService.on('queue_update', onQueueUpdate);
    socketService.on('new_log', onNewLog);
    socketService.on('whatsapp_error', onWhatsAppError);
    socketService.on('whatsapp_account_alert', onWhatsAppAccountAlert);

    return () => {
      socketService.off('queue_update', onQueueUpdate);
      socketService.off('new_log', onNewLog);
      socketService.off('whatsapp_error', onWhatsAppError);
      socketService.off('whatsapp_account_alert', onWhatsAppAccountAlert);
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (isEditorPath(location.pathname)) return;
    if (window.innerWidth <= 768 || window.navigator?.connection?.saveData) return;
    const prefetches = [];

    if (user.role === 'SUPER_ADMIN') {
      return;
    } else if (user.role === 'ADMIN' || user.role === 'MANAGER') {
      prefetches.push(
        () => import('./pages/MonitoringDashboard'),
        () => import('./pages/ChatHistory'),
        () => import('./pages/Catalog'),
        () => import('./pages/FlowList'),
        () => import('./pages/TemplateManager'),
        () => import('./pages/VariableManager'),
        () => import('./pages/Channels'),
        () => import('./pages/AgentManager'),
        () => import('./pages/ScheduleManager')
      );
    } else if (user.role === 'AGENT') {
      prefetches.push(
        () => import('./pages/AgentWorkspace'),
        () => import('./pages/ActiveContacts')
      );
    }

    const run = () => {
      prefetches.forEach((fn) => {
        try {
          fn();
        } catch (e) {
          // ignore prefetch errors
        }
      });
    };

    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(run, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }

    const timer = setTimeout(run, 1500);
    return () => clearTimeout(timer);
  }, [location.pathname, user]);

  useEffect(() => {
    if (!user) return;
    if (user.role === 'SUPER_ADMIN') return;

    let active = true;
    const checkQueues = async () => {
      try {
        if (user.role === 'AGENT') {
          // Na tela do atendente a propria tela ja busca a fila e avisa.
          if (/^\/agent\/?$/.test(window.location.pathname)) return;
          const res = await apiRequest('/chats/my-queues');
          if (res && res.ok && active) {
            const data = await res.json();
            const waiting = Array.isArray(data?.waiting) ? data.waiting.length : 0;
            if (waiting > lastQueueCountRef.current) {
              addNotification({
                type: 'queue',
                title: 'Clientes aguardando',
                message: `${waiting} cliente(s) aguardando na fila.`,
                action: '/agent'
              });
            }
            lastQueueCountRef.current = waiting;
          }
          return;
        }

        const res = await apiRequest('/chats?limit=200&page=1&summary=1');
        if (res && res.ok && active) {
          const chatPayload = await res.json();
          const chatList = Array.isArray(chatPayload) ? chatPayload : (chatPayload?.items || []);
          const waiting = Array.isArray(chatList) ? chatList.filter(c => c.status === 'waiting').length : 0;
          if (waiting > lastQueueCountRef.current) {
            addNotification({
              type: 'queue',
              title: 'Fila com pendências',
              message: `${waiting} atendimento(s) aguardando agente.`,
              action: '/monitor'
            });
          }
          lastQueueCountRef.current = waiting;
        }
      } catch (e) {}
    };

    checkQueues();
    const interval = setInterval(checkQueues, 20000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [user, tenant]);

  // Ajuda e documentacao abrem com ou sem sessao: quem trava no login precisa
  // conseguir ler.
  if (normalizePathname(location.pathname) === '/docs' || normalizePathname(location.pathname).startsWith('/docs/')) {
    return (
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route path="/docs/*" element={<Documentation />} />
        </Routes>
      </Suspense>
    );
  }

  if (normalizePathname(location.pathname) === '/ajuda') {
    return (
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route path="/ajuda" element={<Help />} />
        </Routes>
      </Suspense>
    );
  }

  if (!user) {
    return (
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/privacidade" element={<PrivacyPolicy />} />
          <Route path="/termos" element={<TermsOfService />} />
          <Route path="*" element={<Navigate to="/login" />} />
        </Routes>
      </Suspense>
    );
  }

  const NavItem = ({ to, icon: Icon, label, onClick, end = false }) => (
    <NavLink
      to={to}
      end={end}
      onClick={() => {
        setSidebarOpen(false);
        onClick?.();
      }}
      className={({ isActive }) => `
        flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-medium transition-all duration-200
        ${isActive
          ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
          : 'text-slate-400 hover:bg-slate-800 hover:text-white'}
      `}
    >
      <Icon size={15} className="shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );

  const NavSection = ({ children }) => (
    <div className="px-2 mt-3 mb-1 text-[9px] font-bold text-slate-500 uppercase tracking-wider">
      {children}
    </div>
  );

  const renderTenantNavigation = (basePath = '', includeSecurity = false) => {
    const route = (path) => `${basePath}/${path}`;

    return (
      <div className="space-y-1">
        <NavGroup icon={Activity} label="Operacao">
          <NavItem to={route('inbox')} icon={Inbox} label="Caixa de entrada" />
          <NavItem to={route('monitor')} icon={Activity} label="Monitoramento" />
          <NavItem to={route('analytics')} icon={BarChart3} label="Analiticas" />
          <NavItem to={route('history')} icon={MessageSquare} label="Historico" />
          <NavItem to={route('campaigns')} icon={Megaphone} label="Campanhas" />
          <NavItem to={route('incidents')} icon={TriangleAlert} label="Ocorrencias" />
          {!basePath && <NavItem to="/reports" icon={ScrollText} label="Relatorios" />}
        </NavGroup>

        <NavGroup icon={Handshake} label="Relacionamento">
          <NavItem to={route('contacts')} icon={ContactRound} label="Contatos" />
          {/* Admin e manager tambem atendem em operacao pequena. Caminho fixo, e
              nao route('agent'), porque /agent nao existe sob /tenant/:tenantId:
              com basePath preenchido o link cairia numa rota inexistente. */}
          {!basePath && <NavItem to="/agent" icon={Headset} label="Meu Atendimento" />}
        </NavGroup>

        <NavGroup icon={Workflow} label="Automacao">
          <NavItem to={route('flows')} icon={Workflow} label="Fluxos" />
          <NavItem to={route('subflows')} icon={Boxes} label="Subfluxos" />
          <NavItem to={route('templates')} icon={FileText} label="Templates" />
          <NavItem to={route('variables')} icon={Database} label="Variaveis" />
          <NavItem to={route('catalog')} icon={Box} label="Catalogo" />
          <NavItem to={route('library')} icon={Library} label="Biblioteca" />
          <NavItem to={route('rules')} icon={SlidersHorizontal} label="Regras globais" />
          <NavItem to={route('tests')} icon={FlaskConical} label="Testes" />
        </NavGroup>

        <NavGroup icon={Users} label="Equipe">
          <NavItem to={route('users')} icon={Users} label="Usuarios e filas" />
          <NavItem to={route('tasks')} icon={ClipboardList} label="Tarefas" />
          <NavItem to={route('schedules')} icon={CalendarClock} label="Expediente" />
          <NavItem to={route('performance')} icon={Gauge} label="Desempenho" />
          <NavItem to={route('permissions')} icon={KeyRound} label="Cargos" />
          <NavItem to={route('shifts')} icon={CalendarRange} label="Escalas" />
        </NavGroup>

        <NavGroup icon={Settings} label="Configuracao">
          {can(user, 'config.whatsapp') && <NavItem to={route('meta-setup')} icon={MessageCircle} label="Central do WhatsApp" />}
          {can(user, 'config.whatsapp') && <NavItem to={route('channels')} icon={Bot} label="Canais e roteamento" />}
          <NavItem to={route('identity')} icon={Palette} label="Identidade" />
          <NavItem to={route('integrations')} icon={Webhook} label="Webhooks e API" />
          <NavItem to={route('retention')} icon={Archive} label="Retencao de dados" />
          <NavItem to={route('audit')} icon={ClipboardList} label="Auditoria" />
          <NavItem to={route('usage')} icon={CircleDollarSign} label="Cobranca e uso" />
          {includeSecurity && <NavItem to="/security" icon={Shield} label="Seguranca" />}
        </NavGroup>
      </div>
    );
  };

  return (
    <div className={`flex h-screen w-full bg-gray-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 transition-colors duration-300`}>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`
  fixed lg:static inset-y-0 left-0 z-50 w-52
  bg-white dark:bg-slate-900
  border-r border-gray-200 dark:border-slate-800
  flex flex-col transition-transform duration-300 ease-in-out
  ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
`}>
        <div className="h-12 flex items-center px-3 border-b border-slate-800 gap-2">
          <BrandMark className="h-[26px] w-[26px] shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-xs font-bold text-slate-900 dark:text-white truncate">{brand.productName}</h1>
            <p className="text-[9px] text-slate-500 font-medium tracking-wide truncate">Atendimento inteligente</p>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="ml-auto lg:hidden text-slate-400 shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="p-2 border-b border-slate-800/50">
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2 dark:border-slate-700/50 dark:bg-slate-800/50 min-w-0">
            <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-[11px] shadow-sm shrink-0">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">{user.name}</div>
              <div className="text-[9px] font-medium text-slate-400 uppercase tracking-wider truncate">{user.actingAsPartner ? 'Parceiro' : user.role === 'PARTNER' ? 'Parceiro' : user.role}</div>
            </div>
          </div>
        </div>

        <nav className="sidebar-scrollbar flex-1 overflow-y-auto py-2 px-1.5 space-y-0.5">
          {user.role === 'AGENT' && (
            <>
              <NavItem to="/agent" icon={Headset} label="Meu Atendimento" />
              <NavItem to="/agent-dashboard" icon={BarChart3} label="Meu Dashboard" />
              {can(user, 'atendimento.ativo') && <NavItem to="/agent-active" icon={PhoneCall} label="Atendimento Ativo" />}
              {can(user, 'operacao.ver') && <NavItem to="/monitor" icon={Activity} label="Operação ao vivo" />}
            </>
          )}

          {user.role === 'SUPER_ADMIN' && (
            <>
              <NavSection>Administração</NavSection>
              <NavItem to="/billing" icon={CreditCard} label="Billing" />
              <NavItem to="/security" icon={Shield} label="Segurança" />
              <NavItem to="/super-admin" icon={LayoutDashboard} label="Dashboard Geral" />
              <NavItem to="/admin" icon={Building2} label="Tenants" />
              <NavItem to="/parceiros" icon={Handshake} label="Parceiros" />
              <NavItem to="/system-logs" icon={ScrollText} label="Logs Globais" />

              { }
              {tenant && tenant.id !== 'super_admin' && (
                <>
                  <div className="px-2 mt-3 mb-1 text-[9px] font-bold text-blue-500 uppercase tracking-wider truncate">
                    {tenant.name}
                  </div>
                  {renderTenantNavigation(`/tenant/${tenant.id}`)}
                </>
              )}
            </>
          )}

          {user.role === 'MANAGER' && (
            <>
              <NavSection>Gestão</NavSection>
              <NavItem to="/analytics" icon={BarChart3} label="Indicadores" />
              <NavItem to="/monitor" icon={Activity} label="Operação ao vivo" />
              <NavItem to="/history" icon={MessageSquare} label="Histórico" />
              <NavItem to="/reports" icon={ScrollText} label="Relatórios" />
              <NavItem to="/campaigns" icon={Megaphone} label="Operacao comercial" />
              {(hasManagerPermission(user, 'equipe') || hasManagerPermission(user, 'respostas')) && <NavItem to="/users" icon={Users} label="Equipe" />}
              <NavItem to="/flows" icon={Workflow} label="Fluxos" />
              {hasManagerPermission(user, 'contatos') && <NavItem to="/contacts" icon={ContactRound} label="Contatos" />}
            </>
          )}

          {user.role === 'PARTNER' && (
            <>
              <NavSection>Parceiro</NavSection>
              <NavItem to="/parceiro" icon={Building2} label="Clientes" end />
              <NavItem to="/parceiro/marca" icon={Palette} label="Marca" />
              <NavItem to="/parceiro/cobranca" icon={CircleDollarSign} label="Cobrança" />
            </>
          )}

          {/* Parceiro dentro de um cliente: volta para a carteira e navega como admin dele. */}
          {user.actingAsPartner && (
            <>
              <NavItem to="/parceiro" icon={Building2} label="Meus clientes" />
              <div className="px-2 mt-3 mb-1 text-[9px] font-bold text-blue-500 uppercase tracking-wider truncate">
                {tenant?.name || 'Cliente'}
              </div>
            </>
          )}

          {user.role === 'ADMIN' && renderTenantNavigation('', true)}
        </nav>
        {/* Sair fica so no menu de configuracoes, no topo. */}
      </aside>

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className={`${isAgentWorkspace ? 'h-12 px-3 lg:px-4' : 'h-16 px-4 lg:px-8'} bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 flex items-center justify-between shadow-sm z-20`}>
          <div className="flex items-center gap-2">
            <button onClick={() => setSidebarOpen(true)} className="lg:hidden p-2 text-slate-500 hover:bg-slate-100 rounded-lg">
              <Menu size={isAgentWorkspace ? 20 : 24} />
            </button>
            {/* O mascote e da marca Onion: com a marca de uma agencia, fica de fora. */}
            {!brand.custom && <OnionAssistant compact={isAgentWorkspace} />}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`${isAgentWorkspace ? 'p-1.5' : 'p-2.5'} rounded-full text-slate-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-700 transition-colors`}
            >
              {darkMode ? <Sun size={isAgentWorkspace ? 16 : 20} /> : <Moon size={isAgentWorkspace ? 16 : 20} />}
            </button>
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => {
                  const next = !showNotifications;
                  setShowNotifications(next);
                  if (next) markAllRead();
                }}
                className={`${isAgentWorkspace ? 'p-1.5' : 'p-2.5'} rounded-full text-slate-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-700 transition-colors relative`}
              >
                <Bell size={isAgentWorkspace ? 16 : 20} />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </button>
              {showNotifications && (
                <div className="absolute right-0 top-12 w-80 max-w-[90vw] bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-xl z-50 p-3 text-sm text-gray-600 dark:text-gray-300">
                  {notifications.length === 0 ? (
                    <div className="py-6 text-center text-xs text-gray-500">Nenhuma notificação nova.</div>
                  ) : (
                    <div className="space-y-2 max-h-[360px] overflow-y-auto">
                      {notifications.map((n) => (
                        <button
                          key={n.id}
                          onClick={() => {
                            if (n.action) navigate(n.action);
                            setShowNotifications(false);
                          }}
                          className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                            n.read ? 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700' : 'bg-blue-50/60 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/40'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-semibold text-gray-800 dark:text-gray-100">{n.title}</div>
                            <div className="text-[10px] text-gray-400 whitespace-nowrap">
                              {new Date(n.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{n.message}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <AppSettingsMenu
              compact={isAgentWorkspace}
              darkMode={darkMode}
              onToggleTheme={() => setDarkMode(!darkMode)}
              user={user}
              tenant={tenant}
              onLogout={logout}
            />
          </div>
        </header>

        <BillingPausedBanner tenant={tenant} supportEmail={brand.supportEmail} />

        <div
          className={`flex-1 overflow-auto bg-gray-50 dark:bg-slate-900 relative scroll-smooth ${
            isAgentWorkspace ? 'p-0 overflow-hidden' : 'p-3 sm:p-4 lg:p-8'
          }`}
        >
          <Suspense key={tenant?.id || user.tenantId || 'global'} fallback={<LoadingSpinner />}>
            <Routes>
              <Route path="/" element={user.role === 'AGENT' ? <Navigate to="/agent" /> : user.role === 'SUPER_ADMIN' ? <Navigate to="/super-admin" /> : user.role === 'PARTNER' ? <Navigate to="/parceiro" /> : user.role === 'MANAGER' ? <Navigate to="/analytics" /> : <Navigate to="/monitor" />} />
              <Route path="/parceiro" element={<PartnerClients />} />
              <Route path="/parceiro/marca" element={<PartnerBrand />} />
              <Route path="/parceiro/cobranca" element={<PartnerBilling />} />
              <Route path="/parceiros" element={<PartnersAdmin />} />
              <Route path="/super-admin" element={<SuperAdminDashboard />} />
              <Route path="/admin" element={<AdminPanel />} />
              <Route path="/billing" element={<BillingManager />} />
              <Route path="/monitor" element={<MonitoringDashboard />} />
              <Route path="/analytics" element={<AnalyticsDashboard />} />
              <Route path="/history" element={<ChatHistory />} />
              <Route path="/catalog" element={<Catalog />} />
              <Route path="/system-logs" element={<SystemLogs />} />
              <Route path="/flows" element={<FlowList />} />
              <Route path="/editor/:id" element={<FlowEditor />} />
              <Route path="/subflows" element={<SubflowLibrary />} />
              <Route path="/subflows/:id/editor" element={<SubflowEditor />} />
              <Route path="/agent" element={<AgentWorkspace />} />
              <Route path="/agent-dashboard" element={<AgentDashboard />} />
              <Route path="/agent-active" element={<ActiveContacts />} />
              <Route path="/contacts" element={<ActiveContacts />} />
              <Route path="/users" element={<AgentManager />} />
              <Route path="/tasks" element={<InternalTasks />} />
              <Route path="/templates" element={<TemplateManager />} />
              <Route path="/variables" element={<VariableManager />} />
              <Route path="/schedules" element={<ScheduleManager />} />
              <Route path="/channels" element={<Channels />} />
              <Route path="/meta-setup" element={<MetaSetup />} />
              <Route path="/security" element={<SecurityCenter />} />
              <Route path="/privacidade" element={<PrivacyPolicy />} />
              <Route path="/termos" element={<TermsOfService />} />
              <Route path="/reports" element={<ReportsCenter />} />
              <Route path="/inbox" element={<TenantModulePage moduleKey="inbox" />} />
              <Route path="/campaigns" element={<CommercialOperations />} />
              <Route path="/incidents" element={<TenantModulePage moduleKey="incidents" />} />
              <Route path="/library" element={<TenantModulePage moduleKey="library" />} />
              <Route path="/rules" element={<TenantModulePage moduleKey="rules" />} />
              <Route path="/tests" element={<TenantModulePage moduleKey="tests" />} />
              <Route path="/performance" element={<TenantModulePage moduleKey="performance" />} />
              <Route path="/permissions" element={<TenantModulePage moduleKey="cargos" />} />
              <Route path="/shifts" element={<TenantModulePage moduleKey="shifts" />} />
              <Route path="/identity" element={<TenantModulePage moduleKey="identity" />} />
              <Route path="/integrations" element={<TenantModulePage moduleKey="integrations" />} />
              <Route path="/retention" element={<TenantModulePage moduleKey="retention" />} />
              <Route path="/audit" element={<TenantModulePage moduleKey="audit" />} />
              <Route path="/usage" element={<TenantModulePage moduleKey="usage" />} />

              { }
              <Route path="/tenant/:tenantId">
                <Route index element={<TenantIndexRedirect />} />
                <Route path="monitor" element={<MonitoringDashboard />} />
                <Route path="analytics" element={<AnalyticsDashboard />} />
                <Route path="history" element={<ChatHistory />} />
                <Route path="catalog" element={<Catalog />} />
                <Route path="flows" element={<FlowList />} />
                <Route path="editor/:id" element={<FlowEditor />} />
                <Route path="subflows" element={<SubflowLibrary />} />
                <Route path="subflows/:id/editor" element={<SubflowEditor />} />
                <Route path="users" element={<AgentManager />} />
                <Route path="tasks" element={<InternalTasks />} />
                <Route path="templates" element={<TemplateManager />} />
                <Route path="variables" element={<VariableManager />} />
                <Route path="schedules" element={<ScheduleManager />} />
                <Route path="channels" element={<Channels />} />
                <Route path="meta-setup" element={<MetaSetup />} />
                <Route path="contacts" element={<ActiveContacts />} />
                <Route path="inbox" element={<TenantModulePage moduleKey="inbox" />} />
                <Route path="campaigns" element={<CommercialOperations />} />
                <Route path="incidents" element={<TenantModulePage moduleKey="incidents" />} />
                <Route path="library" element={<TenantModulePage moduleKey="library" />} />
                <Route path="rules" element={<TenantModulePage moduleKey="rules" />} />
                <Route path="tests" element={<TenantModulePage moduleKey="tests" />} />
                <Route path="performance" element={<TenantModulePage moduleKey="performance" />} />
                <Route path="permissions" element={<TenantModulePage moduleKey="cargos" />} />
                <Route path="shifts" element={<TenantModulePage moduleKey="shifts" />} />
                <Route path="identity" element={<TenantModulePage moduleKey="identity" />} />
                <Route path="integrations" element={<TenantModulePage moduleKey="integrations" />} />
                <Route path="retention" element={<TenantModulePage moduleKey="retention" />} />
                <Route path="audit" element={<TenantModulePage moduleKey="audit" />} />
                <Route path="usage" element={<TenantModulePage moduleKey="usage" />} />
              </Route>

              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </Suspense>
        </div>
      </main>
      {/* Ligacoes do WhatsApp tocam em qualquer tela do painel. */}
      <VoiceCallDock user={user} />
    </div>
  );
};

const App = () => {
  return (
    <TenantProvider>
      <AppContent />
    </TenantProvider>
  );
};

export default App;

