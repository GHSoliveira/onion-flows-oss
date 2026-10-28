import { useState, useEffect, useRef } from 'react';
import { apiRequest } from '../services/api';
import { socketService } from '../services/socket';
import { ScrollText, Activity, ShieldCheck, Save, LogIn, ArrowRightLeft, MessageSquare, AlertCircle, Database, ChevronRight, ChevronLeft } from 'lucide-react';
import { TableSkeleton } from '../components/LoadingSkeleton';
import { Chip, CountUp, Freshness } from '../components/admin/OpsKit';
import { reveal } from '../components/admin/opsTones';

// Gravidade pelo nome do tipo: erro/falha em vermelho, aviso em amarelo,
// acoes de configuracao em azul; o resto fica neutro.
const typeTone = (type = '') => {
  if (/ERROR|FAIL|DENIED|BLOCK/.test(type)) return 'bad';
  if (/WARN|RETRY|PAUSE|TIMEOUT|LIMIT/.test(type)) return 'warn';
  if (/PUBLISH|SAVE|CREATE|UPDATE|DELETE/.test(type)) return 'info';
  return 'neutral';
};

const getLogConfig = (type) => {
  if (type && type.startsWith('DB_')) return { icon: Database, label: type };
  switch (type) {
    case 'PUBLISH': return { icon: ShieldCheck, label: 'PUBLICAÇÃO' };
    case 'SAVE': return { icon: Save, label: 'SALVAMENTO' };
    case 'LOGIN': return { icon: LogIn, label: 'ACESSO' };
    case 'TRANSFER': return { icon: ArrowRightLeft, label: 'TRANSFERÊNCIA' };
    case 'CHAT_START': return { icon: MessageSquare, label: 'NOVO CHAT' };
    case 'ERROR': return { icon: AlertCircle, label: 'ERRO' };
    default: return { icon: /ERROR|FAIL/.test(type || '') ? AlertCircle : Activity, label: type || 'SISTEMA' };
  }
};

const groupLabel = (type) => {
  if (type.startsWith('FLOW')) return 'Fluxos';
  if (type.startsWith('CHAT_MESSAGE')) return 'Mensagens';
  if (type.startsWith('CHAT')) return 'Chats';
  if (type.startsWith('VARIABLE')) return 'Variáveis';
  if (type.startsWith('TEMPLATE')) return 'Templates';
  if (type.startsWith('QUEUE')) return 'Filas';
  if (type.startsWith('USER')) return 'Usuários';
  if (type.startsWith('DB_')) return 'Banco de dados';
  return 'Sistema';
};

// Muitos logs guardam um objeto (ou JSON em texto): vira "chave valor" legivel.
const parseMessage = (message) => {
  if (message && typeof message === 'object') return message;
  const text = String(message ?? '');
  if (/^\s*[{[]/.test(text)) {
    try { return JSON.parse(text); } catch { /* texto comum */ }
  }
  return text;
};

const MessageCell = ({ message }) => {
  const value = parseMessage(message);
  if (typeof value === 'string') {
    if (value.length <= 220) return <span>{value}</span>;
    return (
      <details className="group/payload">
        <summary className="cursor-pointer list-none">
          {value.slice(0, 180)}… <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">ver tudo</span>
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all bg-slate-50 p-2 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">{value}</pre>
      </details>
    );
  }
  const entries = Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined && item !== '');
  const simple = entries.filter(([, item]) => typeof item !== 'object').slice(0, 6);
  return (
    <div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {simple.map(([key, item]) => (
          <span key={key} className="text-xs">
            <span className="text-slate-400">{key}</span>{' '}
            <span className="font-medium text-slate-700 dark:text-slate-200">{String(item).length > 80 ? `${String(item).slice(0, 80)}…` : String(item)}</span>
          </span>
        ))}
      </div>
      {entries.length > simple.length && (
        <details className="mt-1">
          <summary className="cursor-pointer list-none text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400">ver payload completo</summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all bg-slate-50 p-2 text-[11px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">{JSON.stringify(value, null, 2)}</pre>
        </details>
      )}
    </div>
  );
};

const SystemLogs = () => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadedAt, setLoadedAt] = useState(null);
  const [newCount, setNewCount] = useState(0);
  const PAGE_LIMIT = 200;
  const pageRef = useRef(1);
  const [collapsed, setCollapsed] = useState({
    Mensagens: true,
    'Banco de dados': true
  });

  const fetchLogs = async (targetPage = 1) => {
    try {
      setLoading(true);
      const res = await apiRequest(`/logs?page=${targetPage}&limit=${PAGE_LIMIT}`);
      if (res && res.ok) {
        const data = await res.json();
        const logArray = data.logs || (Array.isArray(data) ? data : []);
        const normalized = Array.isArray(logArray) ? logArray : [];
        normalized.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
        setLogs(normalized);
        setTotalPages(data.totalPages || 1);
        setPage(data.page || targetPage);
        pageRef.current = data.page || targetPage;
        setLoadedAt(Date.now());
        setNewCount(0);
      } else {
        console.warn("Falha ao buscar logs:", res?.status);
      }
    } catch (err) {
      console.error("Erro logs:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs(1);

    const handleNewLog = (newLog) => {
      if (pageRef.current !== 1) return;
      // _fresh so marca a linha nova: ela pisca uma vez ao entrar na tabela.
      setLogs(prev => [{ ...newLog, _fresh: true }, ...prev].slice(0, PAGE_LIMIT));
      setNewCount((count) => count + 1);
    };

    socketService.on('new_log', handleNewLog);

    return () => {
      socketService.off('new_log', handleNewLog);
    };
  }, []);

  const grouped = logs.reduce((acc, log) => {
    const key = groupLabel(log.type || '');
    if (!acc[key]) acc[key] = [];
    acc[key].push(log);
    return acc;
  }, {});

  return (
    <main className="super-admin-operational content min-h-screen bg-gray-50 dark:bg-gray-900 p-3 sm:p-4 lg:p-6 flex flex-col overflow-hidden">

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center border border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300">
            <ScrollText size={20} />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight text-gray-900 dark:text-white">Logs globais</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">Registro imutável de ações administrativas e operacionais.</p>
          </div>
        </div>
        <Freshness at={loadedAt} busy={loading} onRefresh={() => fetchLogs(page)} />
      </div>

      <div className="flex-1 bg-white dark:bg-slate-900 border-y border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950/40">
          <div className="flex min-h-[20px] items-center gap-3">
            {newCount > 0 && (
              <Chip tone="info" className="sa-reveal">
                +<CountUp value={newCount} duration={0.4} /> {newCount === 1 ? 'novo' : 'novos'}
              </Chip>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <button
              onClick={() => fetchLogs(Math.max(1, page - 1))}
              disabled={page <= 1 || loading}
              className="sa-btn sa-press h-7 px-2"
            >
              <ChevronLeft size={13} /> Anterior
            </button>
            <span className="tabular-nums">Página {page} de {totalPages}</span>
            <button
              onClick={() => fetchLogs(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages || loading}
              className="sa-btn sa-press h-7 px-2"
            >
              Próxima <ChevronRight size={13} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {loading && !logs.length ? (
            <TableSkeleton rows={6} cols={3} />
          ) : logs.length === 0 ? (
            <div className="px-6 py-12 text-center text-slate-500 text-sm">
              <ScrollText size={28} className="mx-auto mb-2 text-slate-300 dark:text-slate-600" />
              Nenhum log encontrado.
            </div>
          ) : (
            Object.entries(grouped).map(([group, items]) => {
              const open = !collapsed[group];
              const errors = items.filter((log) => typeTone(log.type) === 'bad').length;
              return (
                <div key={group} className={`border-b border-slate-200 dark:border-slate-800 transition-opacity ${loading ? 'opacity-60' : ''}`}>
                  <button
                    onClick={() => setCollapsed(prev => ({ ...prev, [group]: !prev[group] }))}
                    className="w-full flex items-center gap-2 px-4 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-[0.14em] bg-white hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-950"
                    aria-expanded={open}
                  >
                    <ChevronRight size={13} className={`transition-transform duration-200 ${open ? 'rotate-90' : ''}`} />
                    <span>{group}</span>
                    <Chip>{items.length}</Chip>
                    {errors > 0 && <Chip tone="bad">{errors} {errors === 1 ? 'erro' : 'erros'}</Chip>}
                  </button>
                  {open && (
                    <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse min-w-[720px]">
                      <thead className="bg-slate-50 dark:bg-slate-950 sticky top-0 z-10">
                        <tr>
                          <th className="px-6 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 w-48">Quando</th>
                          <th className="px-6 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400 w-56">Tipo</th>
                          <th className="px-6 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Mensagem</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                        {items.map((log, index) => {
                          const config = getLogConfig(log.type);
                          const rowKey = log.id || log._id || `${group}-${log.timestamp}-${index}`;
                          return (
                            <tr key={rowKey} className={`sa-row sa-reveal ${log._fresh ? 'sa-flash' : ''}`} style={reveal(index)}>
                              <td className="px-6 py-3 text-xs font-mono text-slate-400 whitespace-nowrap align-top">
                                {log.timestamp ? new Date(log.timestamp).toLocaleString('pt-BR') : '—'}
                              </td>
                              <td className="px-6 py-3 align-top">
                                <Chip tone={typeTone(log.type)} icon={config.icon} className="font-mono text-[10px]">{config.label}</Chip>
                              </td>
                              <td className="px-6 py-3 text-sm text-slate-600 dark:text-slate-300 break-all">
                                <MessageCell message={log.message} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </main>
  );
};

export default SystemLogs;
