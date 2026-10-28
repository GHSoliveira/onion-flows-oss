import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CalendarDays, ChevronRight, Clock, Filter, History, MessageSquare, Search, UserRound, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import ChatMessageContent from '../components/ChatMessageContent';
import ChatTimeline from '../components/ChatTimeline';
import { TableSkeleton } from '../components/LoadingSkeleton';
import OperationalModal from '../components/OperationalModal';

// Abre ja com os ultimos 7 dias: a busca exige ao menos um filtro, e a tela
// vazia pedindo filtro nao dizia nada para quem so queria ver o recente.
const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const defaultFilters = () => ({
  cpf: '',
  q: '',
  agentId: '',
  queue: '',
  channel: '',
  from: localDate(new Date(Date.now() - 7 * 86400000)),
  to: ''
});

const channels = [
  { value: '', label: 'Todos os canais' },
  { value: 'web', label: 'Web' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'whatsapp', label: 'WhatsApp' }
];

const normalizeHistoryResponse = async (response) => {
  const data = await response.json();
  if (Array.isArray(data)) {
    return { items: data, total: data.length, totalPages: 1, page: 1 };
  }
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    total: Number(data?.total || 0),
    totalPages: Number(data?.totalPages || 1),
    page: Number(data?.page || 1)
  };
};

// As mensagens nao ficam mais dentro da conversa: a lista do historico traz
// `messages: []` e o total real vem de `messageCount`. Lista vazia nao pode
// mascarar o contador.
const totalMensagens = (chat) => (Array.isArray(chat?.messages) && chat.messages.length)
  || Number(chat?.messageCount || 0);

const ChatHistory = () => {
  const { tenantId } = useParams();
  const [filters, setFilters] = useState(defaultFilters);
  const [agents, setAgents] = useState([]);
  const [queues, setQueues] = useState([]);
  const [results, setResults] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);
  const [detailTab, setDetailTab] = useState('messages');
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [meta, setMeta] = useState({ total: 0, totalPages: 1, page: 1 });

  const currentTenantId = useMemo(() => {
    if (tenantId) return tenantId;
    try {
      const saved = localStorage.getItem('selectedTenant');
      const parsed = saved ? JSON.parse(saved) : null;
      if (parsed?.id && parsed.id !== 'super_admin') return parsed.id;
    } catch (error) {
      console.error('Erro ao ler tenant selecionado:', error);
    }
    return null;
  }, [tenantId]);

  useEffect(() => {
    const loadFilters = async () => {
      try {
        const [usersRes, queuesRes] = await Promise.all([
          currentTenantId ? apiRequest(`/tenants/${currentTenantId}/users`) : apiRequest('/users?limit=200&page=1'),
          apiRequest('/queues')
        ]);

        if (usersRes && usersRes.ok) {
          const usersData = await usersRes.json();
          const users = Array.isArray(usersData) ? usersData : (usersData?.items || []);
          setAgents(users.filter((user) => ['AGENT', 'MANAGER', 'ADMIN'].includes(user.role)));
        }

        if (queuesRes && queuesRes.ok) {
          const queuesData = await queuesRes.json();
          const queueList = Array.isArray(queuesData) ? queuesData : [];
          setQueues(currentTenantId ? queueList.filter((queue) => queue.tenantId === currentTenantId) : queueList);
        }
      } catch (error) {
        console.error(error);
        toast.error('Erro ao carregar filtros do histórico');
      }
    };

    loadFilters();
  }, [currentTenantId]);

  // A lista do historico vem com projecao enxuta, sem as mensagens. O detalhe
  // busca a conversa inteira, com mensagens e variaveis.
  const openChatDetails = async (chat) => {
    setSelectedChat(chat);
    setDetailTab('messages');
    setDetailLoading(true);
    try {
      const res = await apiRequest(`/chats/${encodeURIComponent(chat.id)}`);
      if (res?.ok) {
        const completo = await res.json();
        setSelectedChat((atual) => (atual && atual.id === chat.id ? { ...atual, ...completo } : atual));
      }
    } catch {
      // Sem o detalhe completo, fica o resumo que ja veio da lista.
    } finally {
      setDetailLoading(false);
    }
  };

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const buildSearchParams = (page = 1) => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      const trimmed = String(value || '').trim();
      if (trimmed) {
        params.set(key, trimmed);
      }
    });
    params.set('page', String(page));
    params.set('limit', '50');
    return params;
  };

  const hasAnyCriteria = () => (
    Object.values(filters).some((value) => String(value || '').trim() !== '')
  );

  const executeSearch = async (page = 1) => {
    if (!hasAnyCriteria()) {
      toast.error('Preencha pelo menos um filtro para pesquisar.');
      return;
    }

    setLoading(true);
    setHasSearched(true);
    setSelectedChat(null);

    try {
      const params = buildSearchParams(page);
      const res = await apiRequest(`/chats/history?${params.toString()}`);
      if (!res || !res.ok) {
        throw new Error('Falha ao carregar histórico');
      }

      const data = await normalizeHistoryResponse(res);
      setResults(data.items);
      setMeta({ total: data.total, totalPages: data.totalPages, page: data.page });
    } catch (error) {
      console.error(error);
      toast.error('Erro ao pesquisar histórico');
      setResults([]);
      setMeta({ total: 0, totalPages: 1, page: 1 });
    } finally {
      setLoading(false);
    }
  };

  // Primeira abertura ja lista os ultimos 7 dias.
  useEffect(() => { executeSearch(1); }, [currentTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const resetSearch = () => {
    setFilters(defaultFilters());
    setHasSearched(false);
    setResults([]);
    setSelectedChat(null);
    setMeta({ total: 0, totalPages: 1, page: 1 });
  };

  const pageLabel = hasSearched
    ? `${meta.total} resultado(s)${meta.totalPages > 1 ? ` · página ${meta.page} de ${meta.totalPages}` : ''}`
    : 'Nenhum chat é carregado até você pesquisar.';

  const resultSummary = {
    chats: meta.total,
    messages: results.reduce((total, chat) => total + totalMensagens(chat), 0),
    agents: new Set(results.map((chat) => chat.agentId || chat.agentName).filter(Boolean)).size,
    channels: new Set(results.map((chat) => chat.channel).filter(Boolean)).size
  };

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-3 sm:p-4 lg:p-6">
      <header>
          <h1 className="text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">Historico de chats</h1>
      </header>

      <section className="border-y border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/20">
        <div className="hidden">
          <Filter size={16} />
          Filtros
        </div>

        <form
          className="grid grid-cols-1 gap-4 px-1 py-5 sm:px-4 md:grid-cols-2 xl:grid-cols-4 [&_button]:rounded-none [&_input]:rounded-none [&_select]:rounded-none"
          onSubmit={(event) => {
            event.preventDefault();
            executeSearch(1);
          }}
        >
          <label className="space-y-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">CPF</span>
            <input
              value={filters.cpf}
              onChange={(event) => updateFilter('cpf', event.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Somente números ou valor salvo"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Nome ou texto</span>
            <input
              value={filters.q}
              onChange={(event) => updateFilter('q', event.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Nome do cliente, mensagem, observação"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Agente</span>
            <select
              value={filters.agentId}
              onChange={(event) => updateFilter('agentId', event.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Todos os agentes</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Fila</span>
            <select
              value={filters.queue}
              onChange={(event) => updateFilter('queue', event.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Todas as filas</option>
              {queues.map((queue) => (
                <option key={queue.id} value={queue.name}>{queue.name}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Canal</span>
            <select
              value={filters.channel}
              onChange={(event) => updateFilter('channel', event.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
            >
              {channels.map((channel) => (
                <option key={channel.value || 'all'} value={channel.value}>{channel.label}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">De</span>
            <div className="relative">
              <CalendarDays size={16} className="absolute left-3 top-2.5 text-slate-400" />
              <input
                type="date"
                value={filters.from}
                onChange={(event) => updateFilter('from', event.target.value)}
                className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </label>

          <label className="space-y-1">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Até</span>
            <div className="relative">
              <CalendarDays size={16} className="absolute left-3 top-2.5 text-slate-400" />
              <input
                type="date"
                value={filters.to}
                onChange={(event) => updateFilter('to', event.target.value)}
                className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </label>

          <div className="md:col-span-2 xl:col-span-1 flex items-end gap-2">
            <button
              type="submit"
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 text-sm font-medium"
            >
              <Search size={16} />
              Pesquisar
            </button>
            <button
              type="button"
              onClick={resetSearch}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 dark:border-slate-600 px-4 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              <X size={16} />
              Limpar
            </button>
          </div>
        </form>
      </section>

      {hasSearched && <section className="grid grid-cols-2 border-y border-gray-200 dark:border-gray-800 lg:grid-cols-4">
        {[
          ['Atendimentos', resultSummary.chats], ['Mensagens na pagina', resultSummary.messages], ['Agentes', resultSummary.agents], ['Canais', resultSummary.channels]
        ].map(([label, value], index) => <div key={label} className={`px-4 py-4 ${index ? 'border-l border-gray-200 dark:border-gray-800' : ''}`}><span className="text-xs text-gray-500 dark:text-gray-400">{label}</span><strong className="mt-2 block text-2xl font-semibold tracking-tight text-gray-950 dark:text-white">{value}</strong></div>)}
      </section>}

      <section>
        <div className="px-4 sm:px-6 py-4 border-b border-slate-200 dark:border-slate-700 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Resultados</h2>
        </div>

        {loading ? (
          <TableSkeleton rows={8} cols={6} />
        ) : !hasSearched ? (
          <div className="px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400">
            Defina os filtros e clique em pesquisar para carregar o histórico.
          </div>
        ) : results.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-slate-500 dark:text-slate-400">
            Nenhum chat encerrado encontrado com os filtros informados.
          </div>
        ) : (
          <>
            <div className="border-y border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900/20">
              {results.map((chat, index) => (
                <div key={`history_row_${chat.id}`} className={`grid gap-4 px-1 py-4 transition hover:bg-gray-50 dark:hover:bg-gray-900/40 sm:grid-cols-[minmax(220px,1.1fr)_minmax(180px,0.8fr)_minmax(160px,0.7fr)_auto] sm:items-center sm:px-4 ${index ? 'border-t border-gray-100 dark:border-gray-800' : ''}`}>
                  <div className="min-w-0"><p className="truncate text-sm font-semibold text-gray-900 dark:text-white">{chat.customerName || chat.vars?.nome_cliente || chat.variables?.nome_cliente || 'Cliente nao identificado'}</p><p className="mt-1 truncate font-mono text-[11px] text-gray-400">{chat.customerCpf || chat.channelUserId || chat.id}</p></div>
                  <div className="text-xs text-gray-500 dark:text-gray-300"><p>{chat.agentName || 'Bot'} / {chat.queue || chat.transferredTo || 'Sem fila'}</p><p className="mt-1 uppercase text-[11px] text-gray-400">{chat.channel || 'web'}</p></div>
                  <div className="text-xs text-gray-500 dark:text-gray-400"><p>{new Date(chat.closedAt || chat.updatedAt || chat.createdAt || 0).toLocaleString()}</p><p className="mt-1">{totalMensagens(chat)} mensagens</p></div>
                  <button type="button" onClick={() => openChatDetails(chat)} className="inline-flex h-8 items-center gap-1.5 justify-self-start border border-gray-200 px-3 text-xs font-semibold text-gray-500 transition hover:border-blue-400 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 sm:justify-self-end">Detalhes <ChevronRight size={13} /></button>
                </div>
              ))}
            </div>
            <div className="hidden">
              <table className="w-full min-w-[920px] text-sm text-left">
                <thead className="bg-slate-50 dark:bg-slate-900/60 text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Encerrado em</th>
                    <th className="px-4 py-3 font-medium">Cliente</th>
                    <th className="px-4 py-3 font-medium">CPF</th>
                    <th className="px-4 py-3 font-medium">Agente</th>
                    <th className="px-4 py-3 font-medium">Fila</th>
                    <th className="px-4 py-3 font-medium">Canal</th>
                    <th className="px-4 py-3 font-medium">Mensagens</th>
                    <th className="px-4 py-3 font-medium text-right">Detalhes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                  {results.map((chat) => (
                    <tr key={chat.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30">
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                        {new Date(chat.closedAt || chat.updatedAt || chat.createdAt || 0).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-slate-900 dark:text-white">
                        {chat.variables?.nome_cliente || chat.customerName || 'Não identificado'}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {chat.customerCpf || chat.channelUserId || '-'}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {chat.agentName || 'Bot'}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {chat.queue || chat.transferredTo || '-'}
                      </td>
                      <td className="px-4 py-3 uppercase text-xs text-slate-500 dark:text-slate-400">
                        {chat.channel || 'web'}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {totalMensagens(chat)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => openChatDetails(chat)}
                          className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                        >
                          Ver chat
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {meta.totalPages > 1 && (
              <div className="px-4 sm:px-6 py-4 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => executeSearch(Math.max(1, meta.page - 1))}
                  disabled={meta.page <= 1}
                  className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-200 disabled:opacity-40"
                >
                  Página anterior
                </button>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Página {meta.page} de {meta.totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => executeSearch(Math.min(meta.totalPages, meta.page + 1))}
                  disabled={meta.page >= meta.totalPages}
                  className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-200 disabled:opacity-40"
                >
                  Próxima página
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <OperationalModal open={Boolean(selectedChat)} onClose={() => setSelectedChat(null)} size="xl" title="Detalhes do atendimento" bodyClassName="bg-slate-100 dark:bg-slate-950">
        {selectedChat && <div className="mx-auto max-w-5xl px-4 py-7 sm:px-6 sm:py-9">
          <header className="border-b border-gray-200 pb-7 dark:border-gray-800">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div><h2 className="text-3xl font-semibold tracking-tight text-gray-950 dark:text-white">{selectedChat.customerName || selectedChat.vars?.nome_cliente || selectedChat.variables?.nome_cliente || 'Cliente nao identificado'}</h2><p className="mt-2 font-mono text-xs text-gray-400">{selectedChat.customerCpf || selectedChat.channelUserId || selectedChat.id}</p></div>
              <div className="flex border border-gray-200 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-900">{[['messages', 'Mensagens'], ['timeline', 'Linha do tempo']].map(([value, label]) => <button key={value} type="button" onClick={() => setDetailTab(value)} className={`h-8 px-3 text-xs font-semibold ${detailTab === value ? 'bg-white text-blue-700 shadow-sm dark:bg-gray-700 dark:text-blue-300' : 'text-gray-500'}`}>{label}</button>)}</div>
            </div>
          </header>
          <section className="grid grid-cols-2 divide-x divide-y divide-gray-200 border-b border-gray-200 dark:divide-gray-800 dark:border-gray-800 sm:grid-cols-4 sm:divide-y-0">{[
            ['Agente', selectedChat.agentName || 'Bot'], ['Fila', selectedChat.queue || selectedChat.transferredTo || '-'], ['Canal', selectedChat.channel || 'web'], ['Mensagens', totalMensagens(selectedChat)]
          ].map(([label, value]) => <div key={label} className="px-4 py-4"><span className="text-xs text-gray-500">{label}</span><strong className="mt-2 block truncate text-sm font-semibold text-gray-900 dark:text-white">{value}</strong></div>)}</section>
          <div className="py-7">
            {detailTab === 'timeline' ? <ChatTimeline chatId={selectedChat.id} /> : <div className="space-y-3">{detailLoading && !(selectedChat.messages || []).length ? <div className="border-y border-gray-200 py-10 text-center text-sm text-gray-500 dark:border-gray-800">Carregando mensagens...</div> : (selectedChat.messages || []).length === 0 ? <div className="border-y border-gray-200 py-10 text-center text-sm text-gray-500 dark:border-gray-800">Nenhuma mensagem registrada.</div> : selectedChat.messages.map((message, index) => { const sender = message.sender || 'system'; const bubbleClass = sender === 'agent' ? 'bg-blue-600 text-white ml-auto' : sender === 'bot' ? 'ml-auto border border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100' : sender === 'system' ? 'bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 mx-auto' : 'mr-auto border border-gray-200 bg-white text-gray-900 dark:border-gray-800 dark:bg-gray-900 dark:text-white'; const senderLabel = { user: 'Cliente', bot: 'Bot', agent: message.agentName || 'Atendente', system: 'Sistema' }[sender] || sender; return <div key={message.id || `${sender}_${index}`} className={`max-w-[82%] px-4 py-3 ${bubbleClass}`}><div className="mb-1 text-[10px] uppercase tracking-wide opacity-70">{senderLabel}</div><div className="text-sm"><ChatMessageContent message={message} /></div><div className="mt-2 text-[10px] opacity-60">{message.timestamp ? new Date(message.timestamp).toLocaleString() : ''}</div></div>; })}</div>}
          </div>
        </div>}
      </OperationalModal>

      {detailTab === 'legacy' && selectedChat && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setSelectedChat(null)}>
          <div
            className="w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                  {selectedChat.variables?.nome_cliente || selectedChat.customerName || 'Chat encerrado'}
                </h3>
                <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1"><UserRound size={12} /> {selectedChat.agentName || 'Bot'}</span>
                  <span>{selectedChat.queue || selectedChat.transferredTo || 'Sem fila'}</span>
                  <span>{selectedChat.channel || 'web'}</span>
                  <span>{selectedChat.customerCpf || selectedChat.channelUserId || '-'}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedChat(null)}
                className="rounded-lg p-2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X size={18} />
              </button>
            </div>

            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 flex items-center justify-between gap-3">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Encerrado em {new Date(selectedChat.closedAt || selectedChat.updatedAt || selectedChat.createdAt || 0).toLocaleString()}
              </div>
              <div className="flex items-center gap-1 rounded-lg bg-slate-200/60 dark:bg-slate-800 p-1">
                <button
                  type="button"
                  onClick={() => setDetailTab('messages')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    detailTab === 'messages'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  <MessageSquare size={14} />
                  Mensagens
                </button>
                <button
                  type="button"
                  onClick={() => setDetailTab('timeline')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    detailTab === 'timeline'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  <Clock size={14} />
                  Linha do tempo
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto bg-slate-50/60 dark:bg-slate-950/40">
              {detailTab === 'timeline' ? (
                <ChatTimeline chatId={selectedChat.id} />
              ) : (
                <div className="p-5 space-y-3">
                  {(selectedChat.messages || []).length === 0 ? (
                    <div className="text-sm text-slate-500 dark:text-slate-400">Nenhuma mensagem registrada.</div>
                  ) : (
                    selectedChat.messages.map((message, index) => {
                      const sender = message.sender || 'system';
                      const bubbleClass = sender === 'agent'
                        ? 'bg-blue-600 text-white ml-auto'
                        : sender === 'system'
                          ? 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 mx-auto'
                          : 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white';

                      return (
                        <div key={message.id || `${sender}_${index}`} className={`max-w-[80%] rounded-2xl px-4 py-3 shadow-sm ${bubbleClass}`}>
                          <div className="text-[10px] uppercase tracking-wide opacity-70 mb-1">{sender}</div>
                          <div className="text-sm">
                            <ChatMessageContent message={message} />
                          </div>
                          <div className="mt-2 text-[10px] opacity-60">
                            {message.timestamp ? new Date(message.timestamp).toLocaleString() : ''}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

export default ChatHistory;
