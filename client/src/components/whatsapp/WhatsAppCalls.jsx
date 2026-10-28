import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, PhoneCall, PhoneMissed, PhoneOff, RefreshCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useDialog } from '../../context/DialogContext';
import { SkeletonBox } from '../LoadingSkeleton';
import TablePagination, { DEFAULT_PAGE_SIZE } from '../TablePagination';
import { Chip } from './whatsappLabels';
import { useBrand } from '../../context/BrandingContext';

// Aba "Chamadas" da Central do WhatsApp: o cliente liga pelo WhatsApp e a
// ligacao toca no painel, um atendente da fila por vez, em rodizio fixo.

const Card = ({ title, subtitle, children, action = null }) => (
  <section className="flex min-w-0 flex-col border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
    <header className="flex items-start justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{subtitle}</p> : null}
      </div>
      {action}
    </header>
    <div className="flex-1 px-4 py-4">{children}</div>
  </section>
);

const inputClass = 'w-full border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-500 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-950';

const STATUS = {
  completed: { tone: 'good', label: 'Atendida', icon: PhoneCall },
  missed: { tone: 'critical', label: 'Perdida', icon: PhoneMissed },
  unanswered: { tone: 'warning', label: 'Não atendida', icon: PhoneMissed },
  rejected: { tone: 'neutral', label: 'Recusada', icon: PhoneOff },
  failed: { tone: 'critical', label: 'Falhou', icon: PhoneOff },
  ringing: { tone: 'info', label: 'Tocando', icon: PhoneCall },
  connecting: { tone: 'info', label: 'Conectando', icon: PhoneCall },
  active: { tone: 'good', label: 'Em andamento', icon: PhoneCall }
};

const MOTIVO = {
  no_agents: 'ninguém da fila com o painel aberto',
  voice_disabled: 'ligações desligadas',
  all_declined: 'todos recusaram',
  not_answered: 'ninguém atendeu',
  accept_failed: 'a Meta recusou o atendimento'
};

const formatarNumero = (valor) => {
  const d = String(valor || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) return `+55 ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  return d ? `+${d}` : '—';
};
const formatarDuracao = (segundos) => {
  const s = Math.max(0, Number(segundos) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const lerErro = async (response) => {
  const body = await response?.json().catch(() => null);
  return body?.message || `Falha (${response?.status || 0})`;
};

export default function WhatsAppCalls({ q = '' }) {
  const brand = useBrand();
  const { user } = useAuth();
  const { confirm } = useDialog();
  const podeEditar = ['ADMIN', 'SUPER_ADMIN'].includes(user?.role);

  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [trocandoBotao, setTrocandoBotao] = useState(false);
  const [filas, setFilas] = useState([]);
  const [form, setForm] = useState(null);
  const [salvo, setSalvo] = useState(null);
  const [meta, setMeta] = useState(null);
  const [historico, setHistorico] = useState([]);
  const [paginacao, setPaginacao] = useState({ page: 1, pages: 1, total: 0 });

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [rConfig, rFilas, rMeta, rLista] = await Promise.all([
        apiRequest(`/voice-calls/settings${q}`),
        apiRequest(`/queues${q}`),
        apiRequest(`/voice-calls/meta${q}`),
        apiRequest(`/voice-calls${q ? `${q}&` : '?'}page=1&limit=${DEFAULT_PAGE_SIZE}`)
      ]);
      const config = rConfig?.ok ? await rConfig.json() : null;
      setForm(config);
      setSalvo(config);
      setFilas(rFilas?.ok ? (await rFilas.json()).filter((fila) => fila.active !== false) : []);
      setMeta(rMeta?.ok ? await rMeta.json() : null);
      const lista = rLista?.ok ? await rLista.json() : null;
      setHistorico(lista?.items || []);
      setPaginacao(lista?.pagination || { page: 1, pages: 1, total: 0 });
    } catch {
      toast.error('Não foi possível carregar as ligações.');
    } finally {
      setCarregando(false);
    }
  }, [q]);

  useEffect(() => { carregar(); }, [carregar]);

  // So o historico troca de pagina; configuracao e fila ficam como estao.
  const irParaPagina = async (pagina) => {
    try {
      const resposta = await apiRequest(`/voice-calls${q ? `${q}&` : '?'}page=${pagina}&limit=${DEFAULT_PAGE_SIZE}`);
      const lista = resposta?.ok ? await resposta.json() : null;
      if (!lista) throw new Error();
      setHistorico(lista.items || []);
      setPaginacao(lista.pagination || { page: pagina, pages: 1, total: 0 });
    } catch {
      toast.error('Não foi possível carregar as ligações.');
    }
  };

  const alterado = useMemo(() => JSON.stringify(form) !== JSON.stringify(salvo), [form, salvo]);
  const cabem = form ? Math.max(1, Math.ceil(form.maxRingSeconds / form.ringSeconds)) : 0;
  const botaoVisivel = meta?.status === 'ENABLED' && meta?.callIconVisibility === 'DEFAULT';

  const salvar = async () => {
    setSalvando(true);
    try {
      const response = await apiRequest(`/voice-calls/settings${q}`, {
        method: 'PUT',
        body: JSON.stringify({
          enabled: form.enabled,
          queueName: form.queueName || null,
          ringSeconds: Number(form.ringSeconds),
          maxRingSeconds: Number(form.maxRingSeconds),
          missedMessage: { enabled: form.missedMessage.enabled, text: form.missedMessage.text }
        })
      });
      if (!response?.ok) throw new Error(await lerErro(response));
      const config = await response.json();
      setForm(config);
      setSalvo(config);
      toast.success('Configuração de ligações salva.');
      if (!config.enabled) setMeta(await (await apiRequest(`/voice-calls/meta${q}`)).json().catch(() => meta));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSalvando(false);
    }
  };

  const trocarBotao = async (visivel) => {
    const ok = await confirm({
      title: visivel ? 'Mostrar o botão de ligar?' : 'Esconder o botão de ligar?',
      message: visivel
        ? 'Os clientes passam a ver o botão de ligar na conversa e no perfil da empresa no WhatsApp. As ligações tocam para a fila escolhida.'
        : 'Os clientes deixam de ver o botão de ligar. Mensagens continuam normais.',
      confirmText: visivel ? 'Mostrar botão' : 'Esconder botão',
      type: visivel ? 'warning' : 'danger'
    });
    if (!ok) return;
    setTrocandoBotao(true);
    try {
      const response = await apiRequest(`/voice-calls/meta${q}`, { method: 'PUT', body: JSON.stringify({ visible: visivel }) });
      if (!response?.ok) throw new Error(await lerErro(response));
      setMeta(await response.json());
      toast.success(visivel ? 'Botão de ligar visível no WhatsApp.' : 'Botão de ligar escondido.');
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTrocandoBotao(false);
    }
  };

  if (carregando || !form) {
    return (
      <div className="grid gap-3 lg:grid-cols-2" aria-busy="true">
        <SkeletonBox className="h-72 w-full" />
        <SkeletonBox className="h-72 w-full" />
      </div>
    );
  }

  const set = (patch) => setForm((atual) => ({ ...atual, ...patch }));

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title={`Ligações no ${brand.productName}`} subtitle="Quem recebe as ligações feitas para o seu WhatsApp.">
          <div className="space-y-4">
            <label className="flex items-center justify-between gap-3">
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-white">Receber ligações</span>
                <span className="block text-xs text-gray-500">A ligação toca no painel de um atendente da fila por vez.</span>
              </span>
              <input type="checkbox" className="h-4 w-4" checked={form.enabled} disabled={!podeEditar} onChange={(e) => set({ enabled: e.target.checked })} />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-300">Fila que atende</span>
              <select className={inputClass} value={form.queueName || ''} disabled={!podeEditar} onChange={(e) => set({ queueName: e.target.value || null })}>
                <option value="">Escolha uma fila</option>
                {filas.map((fila) => <option key={fila.id} value={fila.name}>{fila.name}</option>)}
              </select>
              <span className="mt-1 block text-[11px] text-gray-500">Toca para quem está com o painel aberto e livre, na ordem fixa da fila. Cada ligação começa pelo próximo depois de quem recebeu a anterior. Se ninguém estiver com o painel aberto, a ligação continua chamando até alguém entrar ou o prazo acabar.</span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-300">Toque por atendente</span>
                <select className={inputClass} value={form.ringSeconds} disabled={!podeEditar} onChange={(e) => set({ ringSeconds: Number(e.target.value) })}>
                  {[5, 8, 10, 12, 15, 20, 25].map((s) => <option key={s} value={s}>{s} segundos</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-300">Tempo total</span>
                <select className={inputClass} value={form.maxRingSeconds} disabled={!podeEditar} onChange={(e) => set({ maxRingSeconds: Number(e.target.value) })}>
                  {[20, 30, 40, 50, 55].map((s) => <option key={s} value={s}>{s} segundos</option>)}
                </select>
              </label>
            </div>
            <p className="-mt-2 text-[11px] text-gray-500">
              A Meta segura a ligação por cerca de 60 segundos. Com essa configuração, o toque passa por até {cabem} atendente{cabem > 1 ? 's' : ''}, e quem abrir o painel no meio ainda entra no rodízio.
            </p>

            <div className="border-t border-gray-100 pt-4 dark:border-gray-800">
              <label className="flex items-center justify-between gap-3">
                <span>
                  <span className="block text-sm font-medium text-gray-900 dark:text-white">Mensagem quando ninguém atende</span>
                  <span className="block text-xs text-gray-500">Vai pelo WhatsApp logo após a ligação perdida. Não tem custo: a ligação abre a janela de 24 h.</span>
                </span>
                <input type="checkbox" className="h-4 w-4" checked={form.missedMessage.enabled} disabled={!podeEditar} onChange={(e) => set({ missedMessage: { ...form.missedMessage, enabled: e.target.checked } })} />
              </label>
              <textarea
                rows={3}
                maxLength={1000}
                className={`${inputClass} mt-2`}
                value={form.missedMessage.text}
                disabled={!podeEditar || !form.missedMessage.enabled}
                onChange={(e) => set({ missedMessage: { ...form.missedMessage, text: e.target.value } })}
              />
            </div>

            {podeEditar ? (
              <div className="flex justify-end">
                <button type="button" onClick={salvar} disabled={!alterado || salvando} className="inline-flex h-9 items-center gap-2 bg-blue-600 px-4 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50">
                  {salvando ? <Loader2 size={14} className="animate-spin" /> : null} Salvar
                </button>
              </div>
            ) : null}
          </div>
        </Card>

        <Card title="Botão de ligar no WhatsApp" subtitle="O que o cliente vê no app.">
          {!meta?.connected ? (
            <p className="text-sm text-gray-500">Conecte o número do WhatsApp para configurar ligações.</p>
          ) : meta?.error ? (
            <p className="text-sm text-rose-600">{meta.error}</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-700 dark:text-gray-300">Situação</span>
                <Chip tone={botaoVisivel ? 'good' : 'neutral'}>{botaoVisivel ? 'Visível para os clientes' : 'Escondido'}</Chip>
              </div>
              <p className="text-xs text-gray-500">
                {botaoVisivel
                  ? 'Os clientes podem ligar pela conversa e pelo perfil da empresa.'
                  : 'Os clientes não veem o botão de ligar. Mostre quando a fila estiver pronta para atender.'}
              </p>
              {salvo?.enabled && alterado ? <p className="text-xs text-amber-600">Salve a configuração ao lado antes de mudar o botão.</p> : null}
              {podeEditar ? (
                botaoVisivel ? (
                  <button type="button" onClick={() => trocarBotao(false)} disabled={trocandoBotao} className="inline-flex h-9 items-center gap-2 border border-gray-300 px-4 text-sm font-medium text-gray-700 transition hover:border-gray-500 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200">
                    {trocandoBotao ? <Loader2 size={14} className="animate-spin" /> : null} Esconder botão
                  </button>
                ) : (
                  <button type="button" onClick={() => trocarBotao(true)} disabled={trocandoBotao || !salvo?.enabled || !salvo?.queueName || alterado} className="inline-flex h-9 items-center gap-2 bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50">
                    {trocandoBotao ? <Loader2 size={14} className="animate-spin" /> : null} Mostrar botão
                  </button>
                )
              ) : null}
              <p className="border-t border-gray-100 pt-3 text-[11px] text-gray-500 dark:border-gray-800">
                Só ligações feitas pelo cliente. Elas não têm custo. Clientes do WhatsApp Web e do computador não conseguem ligar para empresas; só pelo celular.
              </p>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Últimas ligações"
        subtitle="As 50 mais recentes. Cada ligação também aparece na linha do tempo da conversa."
        action={<button type="button" onClick={carregar} className="inline-flex h-8 items-center gap-1.5 border border-gray-200 px-2.5 text-xs text-gray-600 hover:border-gray-400 dark:border-gray-700 dark:text-gray-300"><RefreshCcw size={13} /> Atualizar</button>}
      >
        {historico.length === 0 ? (
          <p className="text-sm text-gray-500">Nenhuma ligação ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-gray-100 text-[10px] uppercase tracking-wider text-gray-500 dark:border-gray-800">
                <tr>
                  <th className="py-2 pr-4">Quando</th>
                  <th className="py-2 pr-4">Cliente</th>
                  <th className="py-2 pr-4">Situação</th>
                  <th className="py-2 pr-4">Atendente</th>
                  <th className="py-2">Duração</th>
                </tr>
              </thead>
              <tbody>
                {historico.map((call) => {
                  const info = STATUS[call.status] || { tone: 'neutral', label: call.status };
                  return (
                    <tr key={call.id} className="border-b border-gray-50 last:border-0 dark:border-gray-800/60">
                      <td className="whitespace-nowrap py-2 pr-4 text-gray-600 dark:text-gray-400">{new Date(call.receivedAt || call.createdAt).toLocaleString('pt-BR')}</td>
                      <td className="py-2 pr-4">
                        <div className="font-medium text-gray-900 dark:text-white">{call.contactName || formatarNumero(call.from)}</div>
                        {call.contactName ? <div className="text-gray-500">{formatarNumero(call.from)}</div> : null}
                      </td>
                      <td className="py-2 pr-4">
                        <Chip tone={info.tone}>{info.label}</Chip>
                        {MOTIVO[call.endReason] && call.status !== 'completed' ? <div className="mt-1 text-gray-500">{MOTIVO[call.endReason]}</div> : null}
                      </td>
                      <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">{call.answeredBy?.name || '—'}</td>
                      <td className="py-2 tabular-nums text-gray-700 dark:text-gray-300">{call.status === 'completed' ? formatarDuracao(call.duration) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <TablePagination
              page={paginacao.page}
              totalPages={paginacao.pages}
              setPage={irParaPagina}
              total={paginacao.total}
              from={(paginacao.page - 1) * DEFAULT_PAGE_SIZE + 1}
              to={Math.min(paginacao.page * DEFAULT_PAGE_SIZE, paginacao.total)}
              label="ligações"
            />
          </div>
        )}
      </Card>
    </div>
  );
}
