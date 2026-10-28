import { useState } from 'react';
import { BellOff, CheckCheck } from 'lucide-react';
import { SEVERITY, TONES, formatDateTime, formatRelative } from './whatsappLabels';
import TablePagination, { usePagination } from '../TablePagination';

const FILTERS = [
  ['all', 'Todos'],
  ['unread', 'Não lidos']
];

export default function WhatsAppAlerts({ alerts = [], unread = 0, onMarkAllRead, marking = false, now }) {
  const [filter, setFilter] = useState('all');
  const visible = filter === 'unread' ? alerts.filter((alert) => !alert.readAt) : alerts;
  const pagina = usePagination(visible);

  return (
    <section className="border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
        <div className="flex border border-gray-200 dark:border-gray-700" role="group" aria-label="Filtrar alertas">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${filter === key
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'}`}
            >
              {label}{key === 'unread' && unread ? ` (${unread})` : ''}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onMarkAllRead}
          disabled={!unread || marking}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600 transition-colors hover:text-gray-900 disabled:opacity-40 dark:text-gray-300 dark:hover:text-white"
        >
          <CheckCheck size={14} aria-hidden="true" />
          {marking ? 'Marcando...' : 'Marcar todos como lidos'}
        </button>
      </header>

      {!visible.length ? (
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <BellOff size={22} className="text-gray-300 dark:text-gray-600" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium text-gray-900 dark:text-white">
            {filter === 'unread' ? 'Tudo lido por aqui' : 'Nenhum alerta por enquanto'}
          </p>
          <p className="mt-1 max-w-sm text-xs text-gray-500 dark:text-gray-400">
            Quando a qualidade, o limite de envio, o nome de exibição ou um template mudar, o aviso aparece aqui.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {pagina.pageItems.map((alert) => {
            const severity = SEVERITY[alert.severity] || SEVERITY.info;
            const tone = TONES[severity.tone];
            const Icon = tone.icon;
            return (
              <li key={alert.id} className={`flex gap-3 px-4 py-3.5 ${alert.readAt ? '' : 'bg-blue-50/50 dark:bg-blue-950/15'}`}>
                <Icon size={18} className={`mt-0.5 shrink-0 ${tone.iconClass}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">{alert.title}</p>
                    <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{severity.label}</span>
                    {!alert.readAt ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-600" aria-hidden="true" /> Novo
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{alert.message}</p>
                  <p className="mt-1.5 text-[11px] text-gray-400">
                    <time dateTime={alert.createdAt} title={formatDateTime(alert.createdAt)}>{formatRelative(alert.createdAt, now)}</time>
                    {' · '}
                    {alert.source === 'webhook' ? 'Aviso da Meta' : 'Verificação automática'}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <TablePagination {...pagina} label="alertas" />
    </section>
  );
}
