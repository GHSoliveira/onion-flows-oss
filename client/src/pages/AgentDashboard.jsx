import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CalendarDays,
  Clock3,
  Headset,
  MessageCircle,
  Star,
  TrendingUp
} from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';
import { SkeletonBox } from '../components/LoadingSkeleton';

import TablePagination, { usePagination } from '../components/TablePagination';
const fmtNumber = (value) => Number(value || 0).toLocaleString('pt-BR');

const fmtMinutes = (value) => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return '-';
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${m ? ` ${m}min` : ''}`;
};

const fmtDate = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const fmtRating = (value) => {
  const rating = Number(value || 0);
  return rating > 0 ? rating.toFixed(1) : '-';
};

const StatCard = ({ icon: Icon, label, value }) => {
  return (
    <div className="agent-metric-cell px-5 py-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 dark:text-white">{value}</div>
        </div>
        <div className="text-blue-600 dark:text-blue-400">
          <Icon size={18} />
        </div>
      </div>
    </div>
  );
};

const Stars = ({ value }) => {
  const rating = Number(value || 0);
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: 5 }).map((_, index) => (
        <Star
          key={index}
          size={16}
          className={index < Math.round(rating) ? 'text-blue-500' : 'text-slate-300 dark:text-slate-700'}
          fill={index < Math.round(rating) ? 'currentColor' : 'none'}
        />
      ))}
    </div>
  );
};

const AgentDashboard = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        setLoading(true);
        const res = await apiRequest('/chats/agent-dashboard/me');
        if (!res || !res.ok) {
          throw new Error('Falha ao carregar dashboard');
        }
        const payload = await res.json();
        if (alive) setData(payload);
      } catch (error) {
        toast.error(error.message || 'Erro ao carregar dashboard');
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  const history = useMemo(() => Array.isArray(data?.history) ? data.history : [], [data]);
  const historyPage = usePagination(history);

  if (loading) {
    return (
      <div className="agent-operational mx-auto max-w-7xl space-y-5">
        <section className="agent-section border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <SkeletonBox className="h-3 w-32" />
              <SkeletonBox className="h-8 w-64" />
            </div>
            <div className="space-y-2 border-l-2 border-slate-200 pl-4 dark:border-slate-700">
              <SkeletonBox className="h-3 w-24" />
              <SkeletonBox className="h-8 w-32" />
            </div>
          </div>
        </section>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={`agent_kpi_skel_${index}`} className="space-y-3 border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <SkeletonBox className="h-3 w-24" />
              <SkeletonBox className="h-7 w-16" />
            </div>
          ))}
        </div>
        <section className="space-y-3 border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <SkeletonBox className="h-4 w-40" />
          {Array.from({ length: 4 }).map((_, index) => (
            <SkeletonBox key={`agent_row_skel_${index}`} className="h-10 w-full" />
          ))}
        </section>
      </div>
    );
  }

  return (
    <div className="agent-operational mx-auto max-w-7xl space-y-5">
      <section className="agent-section border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="p-5 sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-400">
                <Headset size={14} />
                Painel do agente
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-950 dark:text-white sm:text-3xl">
                {data?.agent?.name || 'Meu desempenho'}
              </h1>
            </div>
            <div className="border-l-2 border-blue-500 pl-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Media geral</div>
              <div className="mt-2 flex items-center gap-3">
                <div className="text-3xl font-semibold text-slate-950 dark:text-white">{fmtRating(data?.agent?.ratingAvg)}</div>
                <div>
                  <Stars value={data?.agent?.ratingAvg} />
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {fmtNumber(data?.agent?.ratingCount)} avaliacoes
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="agent-metric-strip grid grid-cols-1 bg-white dark:bg-slate-900 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={CalendarDays} label="Atendimentos no mes" value={fmtNumber(data?.month?.atendimentos)} helper="Chats encerrados por voce neste mes" />
        <StatCard icon={Clock3} label="TME do mes" value={fmtMinutes(data?.month?.tmeMinutes)} helper="Tempo medio em espera antes de puxar" />
        <StatCard icon={Activity} label="Atendimentos hoje" value={fmtNumber(data?.today?.atendimentos)} helper="Encerrados hoje" />
        <StatCard icon={TrendingUp} label="TME de hoje" value={fmtMinutes(data?.today?.tmeMinutes)} helper="Espera media dos atendimentos puxados" />
      </section>

      <section className="agent-detail-grid grid grid-cols-1 border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:grid-cols-3">
        <div className="p-5">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Ultima nota</div>
          <div className="mt-3 flex items-center gap-3">
            <div className="text-3xl font-semibold text-slate-950 dark:text-white">{fmtRating(data?.agent?.latestRating)}</div>
            <Stars value={data?.agent?.latestRating} />
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Media de notas do mes</div>
          <div className="mt-3 flex items-center gap-3">
            <div className="text-3xl font-semibold text-slate-950 dark:text-white">{fmtRating(data?.month?.ratingAvg)}</div>
            <Stars value={data?.month?.ratingAvg} />
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">Agora</div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="border-l-2 border-blue-500 bg-slate-50 p-3 dark:bg-slate-800/70">
              <div className="text-2xl font-semibold text-slate-950 dark:text-white">{fmtNumber(data?.active?.open)}</div>
              <div className="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400">Ativos</div>
            </div>
            <div className="border-l-2 border-slate-400 bg-slate-50 p-3 dark:bg-slate-800/70">
              <div className="text-2xl font-semibold text-slate-950 dark:text-white">{fmtNumber(data?.active?.waitingOwned)}</div>
              <div className="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400">Em fila</div>
            </div>
          </div>
        </div>
      </section>

      <section className="overflow-hidden border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 className="text-lg font-bold text-slate-950 dark:text-white">Historico de atendimentos</h2>
          </div>
          <MessageCircle className="text-blue-500" size={22} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-400 dark:bg-slate-950/40">
              <tr>
                <th className="px-5 py-3">Cliente</th>
                <th className="px-5 py-3">Canal</th>
                <th className="px-5 py-3">Fila</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">TME</th>
                <th className="px-5 py-3">Nota</th>
                <th className="px-5 py-3">Atualizado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {history.length === 0 ? (
                <tr>
                  <td className="px-5 py-10 text-center text-slate-400" colSpan={7}>Nenhum atendimento encontrado.</td>
                </tr>
              ) : historyPage.pageItems.map((chat) => (
                <tr key={chat.id} className="transition-colors hover:bg-blue-50/40 dark:hover:bg-blue-950/20">
                  <td className="px-5 py-4">
                    <div className="font-semibold text-slate-900 dark:text-white">{chat.customerName || chat.id}</div>
                    <div className="text-xs text-slate-400">{chat.id}</div>
                  </td>
                  <td className="px-5 py-4 capitalize text-slate-600 dark:text-slate-300">{chat.channel || '-'}</td>
                  <td className="px-5 py-4 text-slate-600 dark:text-slate-300">{chat.queue || '-'}</td>
                  <td className="px-5 py-4">
                    <span className="border-l-2 border-blue-500 bg-slate-100 px-2.5 py-1 text-xs font-semibold uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {chat.status || '-'}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-slate-600 dark:text-slate-300">{fmtMinutes(chat.queueWaitMinutes)}</td>
                  <td className="px-5 py-4 text-slate-600 dark:text-slate-300">{fmtRating(chat.rating)}</td>
                  <td className="px-5 py-4 text-slate-500 dark:text-slate-400">{fmtDate(chat.closedAt || chat.updatedAt || chat.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <TablePagination {...historyPage} label="atendimentos" />
        </div>
      </section>
    </div>
  );
};

export default AgentDashboard;
