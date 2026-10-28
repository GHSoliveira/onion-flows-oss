import { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  ChevronRight,
  Download,
  Eye,
  History,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import TablePagination, { usePagination } from './TablePagination';
import '../pages/MonitoringDashboard.css';

export const monitoringName = (chat) => {
  const values = [
    chat?.contactName,
    chat?.variables?.nome_cliente,
    chat?.vars?.nome_cliente,
    chat?.channelUserId,
    chat?.customerCpf,
  ];
  return (
    values.find(
      (value) =>
        typeof value === 'string' && value.trim() && value !== 'anonimo',
    ) || 'Nao identificado'
  );
};
export const waitingLabel = (date, now) => {
  if (!date) return '—';
  const elapsed = now - new Date(date).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return '—';
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440)
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`;
};
const roleName = (role) =>
  ({ AGENT: 'Atendente', ADMIN: 'Administrador', MANAGER: 'Gestor' })[role] ||
  role;
const statusName = (chat) =>
  chat.status === 'bot'
    ? 'No bot'
    : chat.status === 'waiting'
      ? 'Em espera'
      : chat.agentId
        ? 'Em atendimento'
        : 'Sem agente';

function IconAction({ title, icon: Icon, onClick }) {
  return (
    <button
      type="button"
      className="monitor-icon-action"
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      <Icon size={15} />
    </button>
  );
}

export default function MonitoringOverview({
  data,
  queues,
  loading,
  refreshing,
  error,
  updatedAt,
  filterQueue,
  setFilterQueue,
  filterAgent,
  setFilterAgent,
  searchClient,
  setSearchClient,
  isReadOnly,
  onRefresh,
  onExport,
  onView,
  onHistory,
  onTransfer,
  onClose,
  onAgent,
}) {
  const [status, setStatus] = useState('ALL');
  const [teamTab, setTeamTab] = useState('queues');
  const [now, setNow] = useState(Date.now);
  const reduced = useReducedMotion();
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  const active = (Array.isArray(data.chats) ? data.chats : []).filter(
    (chat) => chat.status !== 'closed',
  );
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const filtered = active
    .filter((chat) => {
      const text =
        `${monitoringName(chat)} ${chat.channelUserId || ''} ${chat.customerCpf || ''} ${chat.id}`.toLowerCase();
      return (
        (filterQueue === 'ALL' || chat.queue === filterQueue) &&
        (filterAgent === 'ALL' || chat.agentId === filterAgent) &&
        (status === 'ALL' ||
          (status === 'human'
            ? chat.status === 'open' && chat.agentId
            : chat.status === status)) &&
        (!searchClient.trim() ||
          text.includes(searchClient.trim().toLowerCase()))
      );
    })
    .sort((a, b) => {
      if ((a.status === 'waiting') !== (b.status === 'waiting'))
        return a.status === 'waiting' ? -1 : 1;
      if (a.status === 'waiting')
        return (
          (Date.parse(a.waitingSince || a.createdAt) || 0) -
          (Date.parse(b.waitingSince || b.createdAt) || 0)
        );
      return (
        (Date.parse(b.lastMessageAt || b.updatedAt || b.createdAt) || 0) -
        (Date.parse(a.lastMessageAt || a.updatedAt || a.createdAt) || 0)
      );
    });
  const chatsPage = usePagination(filtered, 10);
  useEffect(() => {
    chatsPage.setPage(1);
  }, [status, filterQueue, filterAgent, searchClient]);
  const waiting = active.filter((chat) => chat.status === 'waiting');
  const oldest = waiting
    .map((chat) => chat.waitingSince)
    .filter((date) => date && Number.isFinite(Date.parse(date)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const queueRows = [
    ...new Set([
      ...queues,
      ...active.map((chat) => chat.queue).filter(Boolean),
    ]),
  ]
    .map((name) => {
      const chats = active.filter((chat) => chat.queue === name);
      const pending = chats.filter((chat) => chat.status === 'waiting');
      const oldest = pending
        .map((chat) => chat.waitingSince)
        .filter((date) => date && Number.isFinite(Date.parse(date)))
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      return {
        name,
        total: chats.length,
        waiting: pending.length,
        human: chats.filter((chat) => chat.status === 'open' && chat.agentId)
          .length,
        oldest,
      };
    })
    .sort(
      (a, b) =>
        b.waiting - a.waiting ||
        b.total - a.total ||
        a.name.localeCompare(b.name),
    );
  const agentRows = agents
    .map((agent) => ({
      ...agent,
      assigned: active.filter((chat) => chat.agentId === agent.id).length,
    }))
    .sort(
      (a, b) =>
        Number(Boolean(b.isOnline)) - Number(Boolean(a.isOnline)) ||
        b.assigned - a.assigned ||
        String(a.name).localeCompare(String(b.name)),
    );
  const teamPage = usePagination(
    teamTab === 'queues' ? queueRows : agentRows,
    8,
  );
  const kpis = [
    [
      'ALL',
      'Conversas ativas',
      active.length,
      `${agents.filter((agent) => agent.isOnline).length} usuarios online`,
    ],
    [
      'bot',
      'No bot',
      active.filter((chat) => chat.status === 'bot').length,
      '',
    ],
    [
      'waiting',
      'Em espera',
      waiting.length,
      oldest ? `Maior espera: ${waitingLabel(oldest, now)}` : '',
    ],
    [
      'human',
      'Em atendimento',
      active.filter((chat) => chat.status === 'open' && chat.agentId).length,
      '',
    ],
  ];
  const filtersActive =
    status !== 'ALL' ||
    filterQueue !== 'ALL' ||
    filterAgent !== 'ALL' ||
    searchClient;
  return (
    <>
      <header className="monitor-heading">
        <div>
          <h1>Monitoramento</h1>
          <div className="monitor-update">
            {updatedAt
              ? `Atualizado ${new Date(updatedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
              : 'Operacao atual'}
          </div>
        </div>
        <div className="monitor-header-actions">
          <button type="button" onClick={onExport}>
            <Download size={15} /> Exportar
          </button>
          <button
            type="button"
            aria-label="Atualizar monitoramento"
            title="Atualizar monitoramento"
            disabled={loading || refreshing}
            onClick={onRefresh}
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>
      {error && (
        <div className="monitor-error" role="alert">
          {error}{' '}
          <button type="button" onClick={onRefresh}>
            Tentar novamente
          </button>
        </div>
      )}
      {loading ? (
        <div
          className="monitor-skeleton"
          role="status"
          aria-label="Carregando monitoramento"
        >
          <div />
          <div />
        </div>
      ) : (
        <motion.div
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          <section
            className="monitor-kpis"
            aria-label="Resumo do monitoramento"
          >
            {kpis.map(([key, label, value, foot]) => (
              <button
                type="button"
                key={key}
                className="monitor-kpi"
                aria-pressed={status === key}
                onClick={() => setStatus(key)}
              >
                <span>{label}</span>
                <strong>{value.toLocaleString('pt-BR')}</strong>
                {foot && <small>{foot}</small>}
              </button>
            ))}
          </section>
          <section className="monitor-section">
            <div className="monitor-section-heading">
              <h2>Atendimentos</h2>
              <span>
                {filtered.length} {filtersActive ? 'encontrados' : 'ativos'}
              </span>
            </div>
            <div className="monitor-toolbar">
              <div className="monitor-search">
                <Search size={15} />
                <input
                  aria-label="Buscar atendimento"
                  placeholder="Cliente, telefone ou ID"
                  value={searchClient}
                  onChange={(event) => setSearchClient(event.target.value)}
                />
              </div>
              <select
                aria-label="Filtrar fila"
                value={filterQueue}
                onChange={(event) => setFilterQueue(event.target.value)}
              >
                <option value="ALL">Todas as filas</option>
                {queueRows.map((queue) => (
                  <option key={queue.name} value={queue.name}>
                    {queue.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filtrar agente"
                value={filterAgent}
                onChange={(event) => setFilterAgent(event.target.value)}
              >
                <option value="ALL">Todos os agentes</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              {filtersActive && (
                <button
                  type="button"
                  className="monitor-text-action"
                  onClick={() => {
                    setStatus('ALL');
                    setFilterQueue('ALL');
                    setFilterAgent('ALL');
                    setSearchClient('');
                  }}
                >
                  Limpar
                </button>
              )}
            </div>
            <div className="monitor-table-scroll">
              <table className="monitor-chat-table">
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Canal</th>
                    <th>Situacao</th>
                    <th>Fila / agente</th>
                    <th>Espera atual</th>
                    <th className="monitor-right">Acoes</th>
                  </tr>
                </thead>
                <tbody>
                  {chatsPage.pageItems.map((chat) => (
                    <tr key={chat.id}>
                      <td>
                        <button
                          type="button"
                          className="monitor-client-link"
                          onClick={() => onView(chat)}
                        >
                          {monitoringName(chat)}
                        </button>
                        <small>
                          {chat.channelUserId ||
                            (chat.customerCpf !== 'anonimo'
                              ? chat.customerCpf
                              : '')}
                        </small>
                      </td>
                      <td className="monitor-channel">
                        {{
                          whatsapp: 'WhatsApp',
                          telegram: 'Telegram',
                          web: 'Web',
                          simulator: 'Simulador',
                        }[chat.channel] ||
                          chat.channel ||
                          '—'}
                      </td>
                      <td>
                        <span
                          className={`monitor-status ${chat.status === 'waiting' ? 'is-waiting' : ''}`}
                        >
                          <i />
                          {statusName(chat)}
                        </span>
                      </td>
                      <td>
                        <span>{chat.queue || '—'}</span>
                        <small>
                          {chat.agentName ||
                            (chat.status === 'bot'
                              ? 'Automacao'
                              : 'Sem agente atribuido')}
                        </small>
                      </td>
                      <td className="monitor-numeric">
                        {chat.status === 'waiting'
                          ? waitingLabel(chat.waitingSince, now)
                          : '—'}
                      </td>
                      <td>
                        <div className="monitor-row-actions">
                          <IconAction
                            title="Acompanhar conversa"
                            icon={Eye}
                            onClick={() => onView(chat)}
                          />
                          <IconAction
                            title="Historico do cliente"
                            icon={History}
                            onClick={() => onHistory(chat.customerCpf)}
                          />
                          {!isReadOnly && (
                            <>
                              <IconAction
                                title="Transferir atendimento"
                                icon={ArrowRightLeft}
                                onClick={() => onTransfer(chat)}
                              />
                              <IconAction
                                title="Encerrar atendimento"
                                icon={XCircle}
                                onClick={() => onClose(chat)}
                              />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!filtered.length && (
                    <tr>
                      <td colSpan={6} className="monitor-empty">
                        {filtersActive
                          ? 'Nenhum atendimento corresponde aos filtros.'
                          : 'Nenhum atendimento ativo neste momento.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <TablePagination {...chatsPage} label="atendimentos" />
          </section>
          <section className="monitor-section">
            <div className="monitor-section-heading">
              <h2>Distribuicao da operacao</h2>
              <div
                className="monitor-tabs"
                role="group"
                aria-label="Distribuicao"
              >
                {[
                  ['queues', 'Filas'],
                  ['agents', 'Agentes'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={teamTab === key}
                    onClick={() => {
                      setTeamTab(key);
                      teamPage.setPage(1);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="monitor-table-scroll">
              <table>
                <thead>
                  {teamTab === 'queues' ? (
                    <tr>
                      <th>Fila</th>
                      <th>Ativos</th>
                      <th>Em espera</th>
                      <th>Em atendimento</th>
                      <th>Maior espera</th>
                      <th>
                        <span className="sr-only">Acoes</span>
                      </th>
                    </tr>
                  ) : (
                    <tr>
                      <th>Agente</th>
                      <th>Funcao</th>
                      <th>Presenca</th>
                      <th>Atendimentos ativos</th>
                      <th>
                        <span className="sr-only">Acoes</span>
                      </th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {teamPage.pageItems.map((row) =>
                    teamTab === 'queues' ? (
                      <tr key={row.name}>
                        <td>{row.name}</td>
                        <td>{row.total}</td>
                        <td className={row.waiting ? 'monitor-accent' : ''}>
                          {row.waiting}
                        </td>
                        <td>{row.human}</td>
                        <td>{waitingLabel(row.oldest, now)}</td>
                        <td className="monitor-right">
                          <button
                            className="monitor-text-action"
                            type="button"
                            onClick={() => {
                              setFilterQueue(row.name);
                              setStatus('ALL');
                              document
                                .querySelector('.monitor-toolbar')
                                ?.scrollIntoView({
                                  behavior: reduced ? 'instant' : 'smooth',
                                  block: 'center',
                                });
                            }}
                          >
                            Ver atendimentos <ChevronRight size={13} />
                          </button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={row.id}>
                        <td>{row.name}</td>
                        <td>{roleName(row.role)}</td>
                        <td>
                          <span
                            className={`monitor-presence ${row.isOnline ? 'is-online' : ''}`}
                          >
                            <i />
                            {row.isOnline ? 'Online' : 'Offline'}
                          </span>
                        </td>
                        <td>{row.assigned}</td>
                        <td className="monitor-right">
                          <button
                            type="button"
                            className="monitor-text-action"
                            onClick={() => onAgent(row)}
                          >
                            Detalhes <ChevronRight size={13} />
                          </button>
                        </td>
                      </tr>
                    ),
                  )}
                  {!teamPage.total && (
                    <tr>
                      <td colSpan={6} className="monitor-empty">
                        {teamTab === 'queues'
                          ? 'Nenhuma fila configurada.'
                          : 'Nenhum agente disponivel.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <TablePagination
              {...teamPage}
              label={teamTab === 'queues' ? 'filas' : 'agentes'}
            />
          </section>
        </motion.div>
      )}
    </>
  );
}
