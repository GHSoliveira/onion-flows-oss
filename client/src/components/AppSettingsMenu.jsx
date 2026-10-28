import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Building2, Check, Copy, LogOut, Moon, RefreshCcw, Settings, Sun, CircleHelp} from 'lucide-react';
import { API_BASE, apiRequest } from '../services/api';
import { socketService } from '../services/socket';
import toast from 'react-hot-toast';

const BUILD_COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'n/d';
const BUILD_TIME = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : null;

const formatDateTime = (iso) => {
  if (!iso) return 'n/d';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'n/d';
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const formatUptime = (seconds) => {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return 'n/d';
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
};

const Row = ({ label, value, tone = 'default' }) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <span className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">{label}</span>
    <span
      className={`min-w-0 truncate text-right font-mono text-[11px] ${
        tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400'
          : tone === 'bad' ? 'text-red-600 dark:text-red-400'
            : 'text-slate-700 dark:text-slate-200'
      }`}
      title={String(value)}
    >
      {value}
    </span>
  </div>
);

const Section = ({ title, children }) => (
  <div className="border-t border-gray-200 px-3 py-2.5 first:border-t-0 dark:border-slate-700">
    <p className="mb-1 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-400">{title}</p>
    {children}
  </div>
);

export default function AppSettingsMenu({ compact = false, darkMode, onToggleTheme, user, tenant, onLogout }) {
  const [open, setOpen] = useState(false);
  const [health, setHealth] = useState(null);
  const [latency, setLatency] = useState(null);
  const [socketUp, setSocketUp] = useState(Boolean(socketService.socket?.connected));
  const [versionInfo, setVersionInfo] = useState(null);
  const boxRef = useRef(null);
  const navigate = useNavigate();

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  // Atendente ve so o essencial: quem e, a empresa, o tema e as acoes do dia a dia.
  const isAgent = user?.role === 'AGENT';
  const isDevelopmentTenant = String(tenant?.environment || '').toLowerCase() === 'development';
  const environment = /localhost|127\.0\.0\.1/.test(API_BASE) ? 'local' : 'producao';

  const probe = useCallback(async () => {
    // /health e publico e minimo: serve para medir latencia e saber se a API
    // responde. Os dados de infraestrutura vem de uma rota autenticada e so
    // sao pedidos quando quem esta olhando e SUPER_ADMIN.
    // A primeira chamada abre a conexao (DNS, TLS, tunel) e leva ate 2 s;
    // ela so aquece. A latencia e a menor de tres chamadas seguintes.
    try {
      let res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
      let menor = Infinity;
      for (let i = 0; i < 3; i += 1) {
        const startedAt = performance.now();
        res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
        menor = Math.min(menor, performance.now() - startedAt);
      }
      setLatency(Math.round(menor));
      setHealth({ ok: res.ok });
    } catch {
      setLatency(null);
      setHealth({ ok: false });
    }
    setSocketUp(Boolean(socketService.socket?.connected));

    if (isSuperAdmin) {
      try {
        const res = await apiRequest('/super-admin/version');
        if (res && res.ok) setVersionInfo(await res.json());
      } catch {
        setVersionInfo(null);
      }
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    if (!open) return undefined;
    if (!isAgent) probe();
    const onClickOutside = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false);
    };
    const onEsc = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open, probe, isAgent]);

  const copyDiagnostics = async () => {
    // O diagnostico descreve a sessao de quem copiou. Detalhes de
    // infraestrutura (release, versao do Node, endereco da API) so entram
    // para SUPER_ADMIN; o hash do front fica sempre, porque identifica a
    // versao que a pessoa esta vendo e nao revela nada do servidor.
    const lines = [
      `usuario: ${user?.name || user?.username || 'n/d'} (${user?.role || 'n/d'})`,
      `empresa: ${tenant?.name || tenant?.id || 'n/d'}`,
      `ambiente da empresa: ${tenant?.environment || 'production'}`,
      `front: ${BUILD_COMMIT} | ${formatDateTime(BUILD_TIME)}`,
      ...(isSuperAdmin ? [
        `backend: ${versionInfo?.release || 'n/d'} | node ${versionInfo?.node || 'n/d'}`,
        `api: ${API_BASE} (${environment})`
      ] : []),
      `conexao: ${health?.ok ? 'online' : 'offline'}`,
      `latencia: ${latency !== null ? `${latency}ms` : 'n/d'}`,
      `socket: ${socketUp ? 'conectado' : 'desconectado'}`,
      `navegador: ${navigator.userAgent}`,
      `url: ${window.location.href}`
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast.success('Diagnostico copiado');
    } catch {
      toast.error('Nao foi possivel copiar');
    }
  };

  // Recarrega ignorando o cache do navegador e limpando o Cache Storage, que e
  // a causa comum de "continuo vendo a versao antiga" depois de um deploy.
  const hardReload = async () => {
    try {
      if (window.caches?.keys) {
        const keys = await window.caches.keys();
        await Promise.all(keys.map((key) => window.caches.delete(key)));
      }
      const regs = await navigator.serviceWorker?.getRegistrations?.();
      if (regs?.length) await Promise.all(regs.map((reg) => reg.unregister()));
    } catch {
      // segue para o reload mesmo se a limpeza falhar
    }
    window.location.reload(true);
  };

  const iconSize = compact ? 16 : 20;

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Configuracoes da aplicacao"
        aria-expanded={open}
        className={`${compact ? 'p-1.5' : 'p-2.5'} rounded-full transition-colors ${
          open
            ? 'bg-gray-100 text-slate-700 dark:bg-slate-700 dark:text-slate-100'
            : 'text-slate-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-700'
        }`}
      >
        <Settings size={iconSize} />
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-50 w-80 max-w-[92vw] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800">
          <Section title="Sessao">
            <Row label="Usuario" value={user?.name || user?.username || 'n/d'} />
            {!isAgent && <Row label="Papel" value={user?.role || 'n/d'} />}
            <Row label="Empresa" value={tenant?.name || tenant?.id || 'n/d'} />
            {isDevelopmentTenant && !isAgent && (
              <div className="mt-1.5 flex items-center gap-2 border border-amber-400 bg-amber-50 px-2 py-1.5 dark:border-amber-700 dark:bg-amber-950/30">
                <AlertTriangle size={13} className="shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                  Ambiente de desenvolvimento
                </span>
              </div>
            )}
          </Section>

          {/* Nome da release, versao do Node e uptime descrevem a nossa
              infraestrutura, nao a sessao do usuario: ficam so para SUPER_ADMIN. */}
          {isSuperAdmin && (
            <Section title="Versao">
              <Row label="Front" value={BUILD_COMMIT} />
              <Row label="Publicado em" value={formatDateTime(BUILD_TIME)} />
              <Row label="Backend" value={versionInfo?.release || 'n/d'} />
              <Row label="Ambiente" value={environment} />
            </Section>
          )}

          {/* Status da API e do tempo real e coisa nossa: o cliente nao precisa
              ver, mas o diagnostico copiado continua levando esses dados. */}
          {isSuperAdmin && (
          <Section title="Conexao">
            <Row
              label="API"
              value={health ? (health.ok ? 'online' : 'offline') : 'carregando...'}
              tone={health ? (health.ok ? 'ok' : 'bad') : 'default'}
            />
            <Row label="Latencia" value={latency !== null ? `${latency}ms` : 'n/d'} />
            <Row
              label="Tempo real"
              value={socketUp ? 'conectado' : 'desconectado'}
              tone={socketUp ? 'ok' : 'bad'}
            />
            {isSuperAdmin && <Row label="Backend no ar ha" value={formatUptime(versionInfo?.uptimeSeconds)} />}
            <button
              type="button"
              onClick={probe}
              className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
            >
              <RefreshCcw size={11} /> Testar novamente
            </button>
          </Section>
          )}

          <Section title="Preferencias">
            <button
              type="button"
              onClick={onToggleTheme}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1.5 text-left text-xs text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <span className="flex items-center gap-2">
                {darkMode ? <Sun size={14} /> : <Moon size={14} />} Tema
              </span>
              <span className="font-mono text-[11px] text-slate-500">{darkMode ? 'escuro' : 'claro'}</span>
            </button>
          </Section>

          <Section title="Acoes">
            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => { setOpen(false); navigate('/super-admin'); }}
                className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <Building2 size={14} /> Trocar de empresa
              </button>
            )}
            {!isAgent && (
              <button
                type="button"
                onClick={copyDiagnostics}
                className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <Copy size={14} /> Copiar diagnostico
              </button>
            )}
            {isAgent && (
              <a
                href="/privacidade"
                className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <Check size={14} /> Politica de privacidade
              </a>
            )}
            <a
              href="/ajuda"
              className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <CircleHelp size={14} /> Ajuda
            </a>
            <button
              type="button"
              onClick={hardReload}
              className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <RefreshCcw size={14} /> Recarregar limpando cache
            </button>
            {!isAgent && (
              <a
                href="/privacidade"
                className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-slate-600 transition-colors hover:bg-gray-100 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <Check size={14} /> Politica de privacidade
              </a>
            )}
            <button
              type="button"
              onClick={onLogout}
              className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-950/30"
            >
              <LogOut size={14} /> Sair
            </button>
          </Section>
        </div>
      )}
    </div>
  );
}
