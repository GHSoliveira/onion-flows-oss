import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { socketService } from '../services/socket';
import { useAuth } from '../context/AuthContext';
import ChatMessageContent from '../components/ChatMessageContent';
import OperationalModal from '../components/OperationalModal';
import { can } from '../utils/managerPermissions';
import MonitoringOverview, {
  monitoringName,
} from '../components/MonitoringOverview';
const ADMIN_ROLES = ['AGENT', 'MANAGER', 'ADMIN'];

const getChatDisplayName = monitoringName;

const getCurrentTenantId = (routeTenantId) => {
  if (routeTenantId) return routeTenantId;
  try {
    const saved = localStorage.getItem('selectedTenant');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.id && parsed.id !== 'super_admin') return parsed.id;
    }
    const userRaw = localStorage.getItem('user');
    if (userRaw) {
      const parsedUser = JSON.parse(userRaw);
      if (parsedUser?.tenantId) return parsedUser.tenantId;
    }
  } catch (error) {
    console.error(error);
  }
  return null;
};

const getCurrentUserRole = () => {
  try {
    const userRaw = localStorage.getItem('user');
    if (!userRaw) return null;
    const parsedUser = JSON.parse(userRaw);
    return String(parsedUser?.role || '').toUpperCase() || null;
  } catch (error) {
    console.error(error);
    return null;
  }
};

const buildScopedEndpoint = (routeTenantId, baseEndpoint) => {
  const currentTenantId = getCurrentTenantId(routeTenantId);
  if (baseEndpoint.startsWith('/chats/')) return baseEndpoint;
  if (currentTenantId && !baseEndpoint.includes('/tenants/')) {
    return `/tenants/${currentTenantId}${baseEndpoint}`;
  }
  return baseEndpoint;
};

// O id do chat e um UUID aleatorio, nao carrega timestamp: extrair data dele
// gerava 31/12/1969 (epoch) ou "Data invalida", conforme o sorteio do UUID.
// A data real esta em createdAt.
const formatHistoryDate = (history) => {
  const raw =
    history?.createdAt ||
    history?.startedAt ||
    history?.updatedAt ||
    history?.closedAt;
  if (!raw) return 'Data nao registrada';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return 'Data nao registrada';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const toDateInputValue = (date) => {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return '';
  return value.toISOString().slice(0, 10);
};

const defaultReportFrom = () => {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return toDateInputValue(date);
};

const MonitoringDashboard = () => {
  const { tenantId } = useParams();
  const { user } = useAuth();
  const isReadOnly = !can(user, 'operacao.intervir');
  const [data, setData] = useState({ chats: [], agents: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [viewChat, setViewChatState] = useState(null);
  const [viewChatLoading, setViewChatLoading] = useState(false);
  const [transferChat, setTransferChat] = useState(null);
  const [historyChat, setHistoryChat] = useState(null);
  const [clientHistory, setClientHistory] = useState([]);
  const [targetQueue, setTargetQueue] = useState('');
  const [targetAgent, setTargetAgent] = useState('');
  const [forceCloseChat, setForceCloseChat] = useState(null);
  const [forceCloseSilent, setForceCloseSilent] = useState(false);
  const [filterQueue, setFilterQueue] = useState('ALL');
  const [filterAgent, setFilterAgent] = useState('ALL');
  const [searchClient, setSearchClient] = useState('');
  const [reportFrom, setReportFrom] = useState(defaultReportFrom);
  const [reportTo, setReportTo] = useState(() => toDateInputValue(new Date()));
  const [exportingReport, setExportingReport] = useState(false);
  const [queues, setQueues] = useState([]);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const viewChatRef = useRef(null);
  const chatEndRef = useRef(null);
  const realtimeRefreshTimeoutRef = useRef(null);
  const currentUserRole = getCurrentUserRole();
  const canUseSilentClose = ['ADMIN', 'SUPER_ADMIN'].includes(
    currentUserRole || '',
  );

  const setViewChat = (chat) => {
    viewChatRef.current = chat;
    setViewChatState(chat);
  };

  const closeViewChat = () => {
    viewChatRef.current = null;
    setViewChatLoading(false);
    setViewChatState(null);
  };

  const loadChatDetails = async (chatId, withLoader = false) => {
    if (!chatId) return null;
    if (withLoader) setViewChatLoading(true);
    try {
      const res = await apiRequest(`/chats/${chatId}`);
      if (!res || !res.ok) return null;
      const fullChat = await res.json();
      if (viewChatRef.current?.id === chatId) {
        viewChatRef.current = fullChat;
        setViewChatState(fullChat);
      }
      return fullChat;
    } catch (error) {
      console.error(error);
      return null;
    } finally {
      if (withLoader) setViewChatLoading(false);
    }
  };

  const openViewChat = async (chatSummary) => {
    const initialChat = {
      ...chatSummary,
      messages: Array.isArray(chatSummary?.messages)
        ? chatSummary.messages
        : [],
    };
    setViewChat(initialChat);
    await loadChatDetails(chatSummary?.id, true);
  };

  const fetchData = useCallback(
    async (withLoader = false) => {
      const currentTenantId = getCurrentTenantId(tenantId);
      if (withLoader) setLoading(true);
      setRefreshing(true);

      try {
        if (currentTenantId) {
          const [chatsRes, usersRes, queuesRes] = await Promise.allSettled([
            apiRequest(`/tenants/${currentTenantId}/chats?summary=1`),
            apiRequest(`/tenants/${currentTenantId}/users`),
            apiRequest('/queues'),
          ]);
          if (
            [chatsRes, usersRes, queuesRes].some(
              (result) => result.status !== 'fulfilled' || !result.value?.ok,
            )
          ) {
            throw new Error(
              'Nao foi possivel atualizar o monitoramento. Os ultimos dados disponiveis foram mantidos.',
            );
          }

          const chats =
            chatsRes.status === 'fulfilled' && chatsRes.value?.ok
              ? await chatsRes.value.json()
              : [];
          const users =
            usersRes.status === 'fulfilled' && usersRes.value?.ok
              ? await usersRes.value.json()
              : [];
          const queueData =
            queuesRes.status === 'fulfilled' && queuesRes.value?.ok
              ? await queuesRes.value.json()
              : [];

          setData({
            chats: Array.isArray(chats) ? chats : [],
            agents: (Array.isArray(users) ? users : []).filter((user) =>
              ADMIN_ROLES.includes(user.role),
            ),
          });
          setQueues(
            (Array.isArray(queueData) ? queueData : []).map(
              (queue) => queue.name,
            ),
          );
          setUpdatedAt(Date.now());
          setLoadError('');

          if (viewChatRef.current?.id) {
            void loadChatDetails(viewChatRef.current.id, false);
          }
          return;
        }

        const [overviewRes, queuesRes] = await Promise.allSettled([
          apiRequest('/monitoring/overview'),
          apiRequest('/queues'),
        ]);
        if (overviewRes.status === 'fulfilled' && overviewRes.value?.ok) {
          const json = await overviewRes.value.json();
          setData(json);
          setUpdatedAt(Date.now());
          setLoadError('');
          const queueData =
            queuesRes.status === 'fulfilled' && queuesRes.value?.ok
              ? await queuesRes.value.json()
              : [];
          setQueues(
            (Array.isArray(queueData) ? queueData : []).map(
              (queue) => queue.name,
            ),
          );

          if (viewChatRef.current?.id) {
            const updated = (Array.isArray(json?.chats) ? json.chats : []).find(
              (chat) => chat.id === viewChatRef.current.id,
            );
            if (updated) setViewChat(updated);
          }
        } else throw new Error('Nao foi possivel atualizar o monitoramento.');
      } catch (error) {
        console.error(error);
        setLoadError(error.message || 'Falha ao carregar monitoramento.');
      } finally {
        if (withLoader) setLoading(false);
        setRefreshing(false);
      }
    },
    [tenantId],
  );

  useEffect(() => {
    fetchData(true);
    const interval = setInterval(() => {
      void fetchData(false);
    }, 60000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return undefined;

    socketService.connect(token);
    const currentTenantId = getCurrentTenantId(tenantId);
    if (currentTenantId) {
      socketService.subscribeTenant(currentTenantId);
    }

    const scheduleRealtimeRefresh = () => {
      clearTimeout(realtimeRefreshTimeoutRef.current);
      realtimeRefreshTimeoutRef.current = setTimeout(() => {
        void fetchData(false);
      }, 750);
    };

    socketService.on('message', scheduleRealtimeRefresh);
    socketService.on('new_chat', scheduleRealtimeRefresh);
    socketService.on('queue_update', scheduleRealtimeRefresh);
    socketService.on('agent_assigned', scheduleRealtimeRefresh);
    socketService.on('chat_closed', scheduleRealtimeRefresh);

    return () => {
      clearTimeout(realtimeRefreshTimeoutRef.current);
      socketService.off('message', scheduleRealtimeRefresh);
      socketService.off('new_chat', scheduleRealtimeRefresh);
      socketService.off('queue_update', scheduleRealtimeRefresh);
      socketService.off('agent_assigned', scheduleRealtimeRefresh);
      socketService.off('chat_closed', scheduleRealtimeRefresh);
    };
  }, [fetchData]);

  useEffect(() => {
    if (viewChat) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [viewChat]);

  const loadHistory = async (cpf) => {
    if (!cpf || cpf === 'anonimo') {
      toast.error('Cliente sem CPF identificado.');
      return;
    }
    const res = await apiRequest(
      buildScopedEndpoint(tenantId, `/chats/history/${cpf}`),
    );
    if (res?.ok) {
      setClientHistory(await res.json());
      setHistoryChat(cpf);
    }
  };

  const openForceCloseModal = (chat) => {
    setForceCloseChat(chat);
    setForceCloseSilent(false);
  };

  const handleForceClose = async () => {
    if (!forceCloseChat?.id || actionPending) return;
    setActionPending(true);
    const payload =
      canUseSilentClose && forceCloseSilent ? { silent: true } : {};
    try {
      const res = await apiRequest(
        buildScopedEndpoint(tenantId, `/chats/${forceCloseChat.id}/close`),
        {
          method: 'PUT',
          ...(Object.keys(payload).length
            ? { body: JSON.stringify(payload) }
            : {}),
        },
      );
      if (!res?.ok) {
        const error = await res?.json().catch(() => ({}));
        throw new Error(
          error?.error || 'Nao foi possivel encerrar o atendimento.',
        );
      }
      toast.success(
        forceCloseSilent
          ? 'Atendimento encerrado em modo silencioso'
          : 'Atendimento encerrado',
      );
      setForceCloseChat(null);
      setForceCloseSilent(false);
      void fetchData(false);
    } catch (error) {
      toast.error(error.message || 'Falha ao encerrar atendimento.');
    } finally {
      setActionPending(false);
    }
  };

  const handleTransfer = async () => {
    if (!transferChat || actionPending) return;
    setActionPending(true);
    try {
      const res = await apiRequest(
        buildScopedEndpoint(tenantId, '/chats/transfer'),
        {
          method: 'POST',
          body: JSON.stringify({
            chatId: transferChat.id,
            queue: targetQueue || transferChat.queue,
            agentId: targetAgent || null,
            agentName: targetAgent
              ? data.agents.find((agent) => agent.id === targetAgent)?.name
              : null,
          }),
        },
      );
      const payload = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) {
        throw new Error(payload?.error || 'Falha ao transferir atendimento.');
      }
      toast.success('Transferido');
      setTransferChat(null);
      setTargetQueue('');
      setTargetAgent('');
      void fetchData(false);
    } catch (error) {
      toast.error(error?.message || 'Falha ao transferir atendimento.');
    } finally {
      setActionPending(false);
    }
  };

  const handleExportReport = async () => {
    if (exportingReport) return;
    setExportingReport(true);
    try {
      const params = new URLSearchParams();
      const currentTenantId = getCurrentTenantId(tenantId);
      if (currentTenantId) params.set('tenantId', currentTenantId);
      if (reportFrom) params.set('from', reportFrom);
      if (reportTo) params.set('to', reportTo);
      if (filterQueue !== 'ALL') params.set('queue', filterQueue);
      if (filterAgent !== 'ALL') {
        const agent = (data.agents || []).find(
          (item) => item.id === filterAgent,
        );
        if (agent?.id) params.set('agentId', agent.id);
      }

      const res = await apiRequest(`/reports/export.zip?${params.toString()}`);
      if (!res?.ok) {
        const error = await res?.json().catch(() => null);
        throw new Error(error?.error || 'Falha ao exportar relatório');
      }

      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition') || '';
      const filenameMatch = disposition.match(/filename="([^"]+)"/i);
      const filename =
        filenameMatch?.[1] ||
        `relatorio_onion_${reportFrom || 'inicio'}_${reportTo || 'hoje'}.zip`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Relatorio exportado');
      setExportOpen(false);
    } catch (error) {
      console.error(error);
      toast.error(error.message || 'Falha ao exportar relatorio');
    } finally {
      setExportingReport(false);
    }
  };

  return (
    <main className="monitoring-dashboard">
      <MonitoringOverview
        data={data}
        queues={queues}
        loading={loading}
        refreshing={refreshing}
        error={loadError}
        updatedAt={updatedAt}
        filterQueue={filterQueue}
        setFilterQueue={setFilterQueue}
        filterAgent={filterAgent}
        setFilterAgent={setFilterAgent}
        searchClient={searchClient}
        setSearchClient={setSearchClient}
        isReadOnly={isReadOnly}
        onRefresh={() => fetchData(false)}
        onExport={() => setExportOpen(true)}
        onView={openViewChat}
        onHistory={loadHistory}
        onClose={openForceCloseModal}
        onAgent={setSelectedAgent}
        onTransfer={(chat) => {
          setTransferChat(chat);
          setTargetQueue('');
          setTargetAgent('');
        }}
      />
      {exportOpen && (
        <Modal onClose={() => setExportOpen(false)} title="Exportar relatorio">
          <div className="monitor-fields">
            <div>
              <label htmlFor="monitor-report-from">Inicio</label>
              <input
                id="monitor-report-from"
                type="date"
                value={reportFrom}
                onChange={(event) => setReportFrom(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="monitor-report-to">Fim</label>
              <input
                id="monitor-report-to"
                type="date"
                value={reportTo}
                min={reportFrom}
                onChange={(event) => setReportTo(event.target.value)}
              />
            </div>
          </div>
          <div className="monitor-modal-footer">
            <button type="button" onClick={() => setExportOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="primary"
              disabled={
                exportingReport ||
                !reportFrom ||
                !reportTo ||
                reportFrom > reportTo
              }
              onClick={handleExportReport}
            >
              {exportingReport ? 'Exportando...' : 'Exportar ZIP'}
            </button>
          </div>
        </Modal>
      )}

      {viewChat && (
        <Modal
          onClose={closeViewChat}
          title={`Monitorando: ${getChatDisplayName(viewChat)}`}
        >
          <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 overflow-y-auto p-4 space-y-3 h-100">
            {viewChatLoading &&
            (!Array.isArray(viewChat.messages) ||
              viewChat.messages.length === 0) ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                Carregando mensagens...
              </div>
            ) : (
              (Array.isArray(viewChat.messages) ? viewChat.messages : []).map(
                (message, index) => (
                  <div
                    key={message.id || index}
                    className={`flex ${message.sender === 'agent' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm shadow-sm ${
                        message.sender === 'agent'
                          ? 'bg-blue-600 text-white rounded-br-sm'
                          : message.sender === 'system'
                            ? 'text-slate-500 dark:text-slate-400 text-xs mx-auto px-3 py-1 shadow-none'
                            : 'bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-700 rounded-bl-sm'
                      }`}
                    >
                      {message.sender !== 'system' && (
                        <div className="text-[10px] font-bold opacity-70 mb-1 uppercase tracking-wide">
                          {message.sender === 'bot' ? 'Bot' : message.sender}
                        </div>
                      )}
                      <ChatMessageContent message={message} />
                      {message.timestamp && (
                        <div className="mt-2 text-right text-[10px] opacity-60">
                          {new Date(message.timestamp).toLocaleTimeString(
                            'pt-BR',
                            { hour: '2-digit', minute: '2-digit' },
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )
            )}
            <div ref={chatEndRef} />
          </div>
        </Modal>
      )}

      {transferChat && (
        <Modal
          onClose={() => setTransferChat(null)}
          title="Transferir Atendimento"
        >
          <div className="monitor-fields">
            <div className="monitor-modal-notice">
              Transferindo <strong>{getChatDisplayName(transferChat)}</strong>{' '}
              da fila <strong>{transferChat.queue || 'Bot'}</strong>.
            </div>

            <div>
              <label htmlFor="monitor-transfer-queue">Nova fila</label>
              <select
                id="monitor-transfer-queue"
                value={targetQueue}
                onChange={(event) => {
                  setTargetQueue(event.target.value);
                  setTargetAgent('');
                }}
              >
                <option value="">Selecione...</option>
                {queues.map((queueName) => (
                  <option key={queueName} value={queueName}>
                    {queueName}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="monitor-transfer-agent">
                Atribuir a agente (opcional)
              </label>
              <select
                id="monitor-transfer-agent"
                value={targetAgent}
                onChange={(event) => {
                  setTargetAgent(event.target.value);
                  setTargetQueue('');
                }}
              >
                <option value="">Nenhum</option>
                {(data.agents || []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.isOnline ? 'ON' : 'OFF'})
                  </option>
                ))}
              </select>
            </div>

            <div className="monitor-modal-footer">
              <button
                type="button"
                disabled={actionPending}
                onClick={() => setTransferChat(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={actionPending || (!targetQueue && !targetAgent)}
                onClick={handleTransfer}
                className="primary"
              >
                {actionPending ? 'Transferindo...' : 'Transferir'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {forceCloseChat && (
        <Modal
          onClose={() => setForceCloseChat(null)}
          title="Encerrar Atendimento"
        >
          <div className="space-y-4">
            <div className="monitor-modal-notice">
              Encerrar atendimento de{' '}
              <strong>{getChatDisplayName(forceCloseChat)}</strong>?
            </div>

            {canUseSilentClose ? (
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={forceCloseSilent}
                  onChange={(event) =>
                    setForceCloseSilent(event.target.checked)
                  }
                  className="border-slate-300 accent-blue-600"
                />
                Encerramento silencioso (sem enviar mensagem ao cliente)
              </label>
            ) : null}

            <div className="monitor-modal-footer">
              <button
                type="button"
                disabled={actionPending}
                onClick={() => setForceCloseChat(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={actionPending}
                onClick={handleForceClose}
                className="primary"
              >
                {actionPending ? 'Encerrando...' : 'Encerrar atendimento'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {historyChat && (
        <Modal
          onClose={() => setHistoryChat(null)}
          title={`Historico: ${historyChat}`}
        >
          <div className="space-y-4 max-h-100 overflow-y-auto">
            {clientHistory.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                Nenhum historico anterior.
              </div>
            ) : (
              clientHistory.map((history) => (
                <div key={history.id} className="monitor-history-item">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">
                    {formatHistoryDate(history)}
                  </div>
                  <div className="text-xs text-gray-500 mb-2">
                    Atendido por: {history.agentName || 'Bot'} em{' '}
                    {history.queue || 'Fluxo'}
                  </div>
                  <small>
                    {history.messageCount ??
                      (Array.isArray(history.messages)
                        ? history.messages.length
                        : 0)}{' '}
                    mensagens trocadas.
                  </small>
                </div>
              ))
            )}
          </div>
        </Modal>
      )}

      {selectedAgent && (
        <AgentDetailModal
          agent={selectedAgent}
          chats={data.chats || []}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </main>
  );
};

const formatTimeSince = (isoDate) => {
  if (!isoDate) return 'Indisponivel';
  const diff = Date.now() - new Date(isoDate).getTime();
  if (diff < 0 || !Number.isFinite(diff)) return 'Indisponivel';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Agora';
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}min`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
};

const AgentDetailModal = ({ agent, chats, onClose }) => {
  const agentChats = (Array.isArray(chats) ? chats : []).filter(
    (chat) => chat.agentId === agent.id && chat.status !== 'closed',
  );
  const rating = Number(agent.ratingAvg);
  const count = Number(agent.ratingCount) || 0;
  const agentQueues = Array.isArray(agent.queues)
    ? agent.queues.filter((queue) => typeof queue === 'string')
    : [];
  return (
    <Modal title="Detalhes do agente" onClose={onClose}>
      <h2 className="monitor-agent-name">{agent.name}</h2>
      <div className="monitor-agent-summary">
        @{agent.username} · {agent.isOnline ? 'Online' : 'Offline'} ·{' '}
        {agent.role}
      </div>
      <div className="monitor-agent-metrics">
        <div>
          <strong>{agentChats.length}</strong>
          <span>Atendimentos ativos</span>
        </div>
        <div>
          <strong>
            {count && Number.isFinite(rating) ? rating.toFixed(1) : '—'}
          </strong>
          <span>{count} avaliacoes</span>
        </div>
        <div>
          <strong>
            {agent.isOnline ? 'Agora' : formatTimeSince(agent.lastSeen)}
          </strong>
          <span>Ultima atividade</span>
        </div>
      </div>
      <section className="monitor-agent-section">
        <h3>Filas atribuidas</h3>
        {agentQueues.length ? (
          <ul>
            {agentQueues.map((queue) => (
              <li key={queue}>{queue}</li>
            ))}
          </ul>
        ) : (
          <p>Nenhuma fila atribuida.</p>
        )}
      </section>
      <section className="monitor-agent-section">
        <h3>Clientes em atendimento</h3>
        {agentChats.length ? (
          <ul>
            {agentChats.map((chat) => (
              <li key={chat.id}>
                <span>{getChatDisplayName(chat)}</span>
                <span>{chat.queue || 'Sem fila'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>Nenhum atendimento ativo.</p>
        )}
      </section>
    </Modal>
  );
};

const Modal = ({ children, onClose, title }) =>
  createPortal(
    <OperationalModal open title={title} onClose={onClose} size="md">
      <div className="monitor-operational-body">{children}</div>
    </OperationalModal>,
    document.body,
  );

export default MonitoringDashboard;
