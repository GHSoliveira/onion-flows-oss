import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowRight, ChartColumn, CircleCheck, Table } from 'lucide-react';
import {
  CATEGORY,
  Chip,
  NAME_STATUS,
  QUALITY,
  REVIEW_STATUS,
  SEVERITY,
  TEMPLATE_REASON,
  TEMPLATE_STATUS,
  TIER,
  TONES,
  formatCurrency,
  formatDayLong,
  formatDayShort,
  formatNumber,
  formatPercent,
  formatRelative,
  translateHealthIssue
} from './whatsappLabels';

const SECTION_NAMES = {
  phone: 'número',
  account: 'conta',
  templates: 'templates',
  messages: 'mensagens',
  pricing: 'custo',
  templatePerformance: 'desempenho dos templates'
};

const Card = ({ title, subtitle, action, children, className = '' }) => (
  <section className={`flex min-w-0 flex-col border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 ${className}`}>
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

const StatTile = ({ label, value, foot, tone = null }) => {
  const Icon = tone ? TONES[tone].icon : null;
  return (
    <div className="border border-gray-200 bg-white px-4 py-4 dark:border-gray-800 dark:bg-gray-900">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</p>
      <div className="mt-2 flex items-center gap-2">
        {Icon ? <Icon size={20} className={TONES[tone].iconClass} aria-hidden="true" /> : null}
        <p className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">{value}</p>
      </div>
      {foot ? <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{foot}</p> : null}
    </div>
  );
};

const Row = ({ label, children }) => (
  <div className="flex items-start justify-between gap-4 py-2">
    <dt className="shrink-0 text-xs text-gray-500 dark:text-gray-400">{label}</dt>
    <dd className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-right text-sm text-gray-900 dark:text-gray-100">{children}</dd>
  </div>
);

/* ------------------------------ avisos ------------------------------ */

const AttentionBanner = ({ phone, account }) => {
  const limited = [phone?.canSendMessage, account?.canSendMessage].find((state) => state && state !== 'AVAILABLE');
  const issues = [...(phone?.healthIssues || []), ...(account?.healthIssues || [])]
    .filter((issue) => issue.area !== 'calling')
    .map((issue) => translateHealthIssue(issue.description));
  const unique = [...new Set(issues)];
  if (!limited && !unique.length) return null;

  const tone = limited === 'BLOCKED' ? 'critical' : 'warning';
  const Icon = TONES[tone].icon;
  const title = limited === 'BLOCKED'
    ? 'Envio de mensagens bloqueado'
    : limited === 'LIMITED' ? 'Envio de mensagens limitado pela Meta' : 'Avisos da Meta sobre a conta';

  return (
    <div className={`flex gap-3 border px-4 py-3 ${TONES[tone].chip}`} role="status">
      <Icon size={18} className={`mt-0.5 shrink-0 ${TONES[tone].iconClass}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        {unique.length ? (
          <ul className="mt-1 space-y-0.5 text-sm">
            {unique.map((text) => <li key={text}>{text}</li>)}
          </ul>
        ) : (
          <p className="mt-1 text-sm">A Meta não informou o motivo. Confira o número no Gerenciador do WhatsApp.</p>
        )}
      </div>
    </div>
  );
};

/* ---------------------------- mensagens ---------------------------- */

const DayTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const day = payload[0].payload;
  return (
    <div className="border border-gray-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <p className="text-gray-500 dark:text-gray-400">{formatDayLong(day.date)}</p>
      <p className="mt-1 flex items-center gap-2">
        <span className="h-0.5 w-3 bg-emerald-600" aria-hidden="true" />
        <span className="text-sm font-semibold text-gray-900 dark:text-white">{formatNumber(day.sent)}</span>
        <span className="text-gray-500 dark:text-gray-400">enviadas</span>
      </p>
      <p className="mt-0.5 pl-5 text-gray-500 dark:text-gray-400">
        {formatNumber(day.delivered)} entregues{day.sent ? ` · ${formatPercent(day.delivered / day.sent)}` : ''}
      </p>
    </div>
  );
};

const ViewToggle = ({ view, onChange }) => (
  <div className="flex border border-gray-200 dark:border-gray-700" role="group" aria-label="Forma de exibição">
    {[['chart', ChartColumn, 'Gráfico'], ['table', Table, 'Tabela']].map(([key, Icon, label]) => (
      <button
        key={key}
        type="button"
        onClick={() => onChange(key)}
        aria-pressed={view === key}
        title={label}
        className={`grid h-7 w-7 place-items-center transition-colors ${view === key
          ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
          : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'}`}
      >
        <Icon size={14} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </button>
    ))}
  </div>
);

const MessagesCard = ({ messages }) => {
  const [view, setView] = useState('chart');
  const data = useMemo(() => (messages?.days || []).map((day) => ({ ...day, label: formatDayShort(day.date) })), [messages]);
  const deliveryRate = messages?.sent ? messages.delivered / messages.sent : null;

  return (
    <Card
      title="Mensagens enviadas por dia"
      subtitle={messages ? `${formatNumber(messages.sent)} nos últimos 30 dias · ${formatPercent(deliveryRate)} entregues` : 'Sem dados'}
      action={messages?.sent ? <ViewToggle view={view} onChange={setView} /> : null}
      className="lg:col-span-2"
    >
      {!messages?.sent ? (
        <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">Nenhuma mensagem enviada nos últimos 30 dias.</p>
      ) : view === 'chart' ? (
        <div className="h-60 [--axis:#6b7280] [--bar:#059669] [--cursor:rgba(5,150,105,0.08)] [--grid:#e5e7eb] dark:[--axis:#9ca3af] dark:[--cursor:rgba(16,185,129,0.1)] dark:[--grid:#1f2937]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={{ stroke: 'var(--grid)' }}
                tick={{ fill: 'var(--axis)', fontSize: 11 }}
                interval="preserveStartEnd"
                minTickGap={20}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: 'var(--axis)', fontSize: 11 }} width={40} />
              <Tooltip cursor={{ fill: 'var(--cursor)' }} content={<DayTooltip />} />
              <Bar dataKey="sent" name="Enviadas" fill="var(--bar)" maxBarSize={24} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="max-h-60 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
              <tr>
                <th className="py-1.5 text-left font-medium">Dia</th>
                <th className="py-1.5 text-right font-medium">Enviadas</th>
                <th className="py-1.5 text-right font-medium">Entregues</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 tabular-nums dark:divide-gray-800">
              {[...data].reverse().map((day) => (
                <tr key={day.date}>
                  <td className="py-1.5 text-gray-600 dark:text-gray-300">{formatDayLong(day.date)}</td>
                  <td className="py-1.5 text-right text-gray-900 dark:text-white">{formatNumber(day.sent)}</td>
                  <td className="py-1.5 text-right text-gray-600 dark:text-gray-300">{formatNumber(day.delivered)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
};

/* ------------------------------ custo ------------------------------ */

const PricingCard = ({ pricing }) => {
  const max = Math.max(1, ...(pricing?.categories || []).map((c) => c.volume));
  return (
    <Card
      title="Custo por categoria"
      subtitle={pricing ? `Estimativa da Meta em ${pricing.currency} · 30 dias` : 'Sem dados'}
    >
      {!pricing?.volume ? (
        <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">Nenhuma conversa registrada nos últimos 30 dias.</p>
      ) : (
        <div className="flex h-full flex-col">
          <ul className="space-y-3">
            {pricing.categories.map((category) => (
              <li key={category.category}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-gray-700 dark:text-gray-200">{CATEGORY[category.category] || category.category}</span>
                  <span className="font-medium text-gray-900 dark:text-white">
                    {category.cost > 0 ? formatCurrency(category.cost, pricing.currency) : 'Grátis'}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 bg-gray-100 dark:bg-gray-800">
                    <div className="h-full rounded-r-sm bg-emerald-600" style={{ width: `${Math.max(2, (category.volume / max) * 100)}%` }} />
                  </div>
                  <span className="w-20 text-right text-xs text-gray-500 tabular-nums dark:text-gray-400">{formatNumber(category.volume)} msg</span>
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-auto border-t border-gray-100 pt-3 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
            <p>
              <span className="font-medium text-gray-900 dark:text-white">{formatNumber(pricing.paidVolume)}</span> cobradas ·{' '}
              <span className="font-medium text-gray-900 dark:text-white">{formatNumber(pricing.freeVolume)}</span> gratuitas
            </p>
            <p className="mt-1">Responder um cliente dentro de 24 horas não é cobrado.</p>
          </div>
        </div>
      )}
    </Card>
  );
};

/* ------------------------------- conta ------------------------------- */

const AccountCard = ({ phone, account }) => {
  const newName = NAME_STATUS[phone?.newNameStatus];
  const review = REVIEW_STATUS[account?.accountReviewStatus];
  const verified = account?.businessVerificationStatus === 'verified';
  return (
    <Card title="Conta" subtitle="Como a Meta vê este número">
      <dl className="-my-2 divide-y divide-gray-100 dark:divide-gray-800">
        <Row label="Nome de exibição">
          <span className="font-medium">{phone?.verifiedName || '—'}</span>
          {phone?.newNameStatus === 'PENDING_REVIEW' ? <Chip tone="warning">Novo nome em análise</Chip> : null}
          {phone?.newNameStatus === 'DECLINED' ? <Chip tone="critical">Novo nome recusado</Chip> : null}
          {!newName && NAME_STATUS[phone?.nameStatus] ? <Chip tone={NAME_STATUS[phone.nameStatus].tone}>{NAME_STATUS[phone.nameStatus].label}</Chip> : null}
        </Row>
        <Row label="Número">{phone?.displayPhoneNumber || '—'}</Row>
        <Row label="Empresa na Meta">
          <span>{account?.ownerBusinessName || '—'}</span>
          {account ? <Chip tone={verified ? 'good' : 'warning'}>{verified ? 'Verificada' : 'Não verificada'}</Chip> : null}
        </Row>
        <Row label="Conta do WhatsApp">
          <span>{account?.name || '—'}</span>
          {review ? <Chip tone={review.tone}>{review.label}</Chip> : null}
        </Row>
        <Row label="Modo">{phone?.accountMode === 'LIVE' ? 'Produção' : phone?.accountMode === 'SANDBOX' ? 'Teste' : '—'}</Row>
        <Row label="Capacidade de envio">{phone?.throughput === 'HIGH' ? 'Alta' : phone?.throughput === 'STANDARD' ? 'Padrão' : '—'}</Row>
        <Row label="Selo de conta oficial">{phone ? (phone.isOfficialBusinessAccount ? 'Sim' : 'Não') : '—'}</Row>
      </dl>
    </Card>
  );
};

/* ----------------------------- templates ----------------------------- */

const STATUS_GROUPS = [
  { key: 'approved', label: 'Aprovados', tone: 'good', statuses: ['APPROVED'] },
  { key: 'pending', label: 'Em análise', tone: 'neutral', statuses: ['PENDING', 'IN_APPEAL'] },
  { key: 'paused', label: 'Pausados', tone: 'warning', statuses: ['PAUSED', 'FLAGGED', 'LIMIT_EXCEEDED'] },
  { key: 'rejected', label: 'Recusados', tone: 'critical', statuses: ['REJECTED', 'DISABLED'] }
];

const TemplatesCard = ({ templates, templatesPath }) => {
  const groups = STATUS_GROUPS
    .map((group) => ({ ...group, count: group.statuses.reduce((sum, s) => sum + (templates?.byStatus?.[s] || 0), 0) }))
    .filter((group) => group.count > 0);
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <Card
      title="Templates"
      subtitle={templates ? `${formatNumber(templates.total)} cadastrados na Meta` : 'Sem dados'}
      action={templatesPath ? (
        <Link to={templatesPath} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
          Gerenciar <ArrowRight size={12} aria-hidden="true" />
        </Link>
      ) : null}
    >
      {!templates?.total ? (
        <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">Nenhum template criado ainda.</p>
      ) : (
        <>
          <div className="flex h-2 gap-0.5" aria-hidden="true">
            {groups.map((group) => (
              <div key={group.key} className={`h-full first:rounded-l-sm last:rounded-r-sm ${TONES[group.tone].bar}`} style={{ width: `${(group.count / total) * 100}%` }} />
            ))}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
            {groups.map((group) => (
              <li key={group.key} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 ${TONES[group.tone].bar}`} aria-hidden="true" />
                {group.label}
                <span className="font-semibold text-gray-900 dark:text-white">{group.count}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4">
            {templates.attention.length ? (
              <ul className="divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-800 dark:border-gray-800">
                {templates.attention.slice(0, 4).map((template) => {
                  const status = TEMPLATE_STATUS[template.status];
                  const badQuality = template.status === 'APPROVED' && ['RED', 'YELLOW'].includes(template.quality);
                  return (
                    <li key={template.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs text-gray-900 dark:text-white">{template.name}</p>
                        <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                          {TEMPLATE_REASON[template.rejectedReason] || CATEGORY[template.category] || ''}
                        </p>
                      </div>
                      {badQuality
                        ? <Chip tone={QUALITY[template.quality].tone}>Qualidade {QUALITY[template.quality].label.toLowerCase()}</Chip>
                        : <Chip tone={status?.tone}>{status?.label || template.status}</Chip>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="flex items-center gap-2 border-t border-gray-100 pt-3 text-sm text-gray-600 dark:border-gray-800 dark:text-gray-300">
                <CircleCheck size={16} className={TONES.good.iconClass} aria-hidden="true" />
                Nenhum template com problema.
              </p>
            )}
          </div>
        </>
      )}
    </Card>
  );
};

const PerformanceCard = ({ performance }) => (
  <Card title="Templates mais enviados" subtitle="Últimos 30 dias">
    {!performance?.length ? (
      <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">Nenhum template enviado nos últimos 30 dias.</p>
    ) : (
      <table className="w-full table-fixed text-sm">
        <thead className="text-xs text-gray-500 dark:text-gray-400">
          <tr>
            <th className="pb-2 text-left font-medium">Template</th>
            <th className="w-20 pb-2 pl-3 text-right font-medium">Enviados</th>
            <th className="w-16 pb-2 pl-3 text-right font-medium">Lidos</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 tabular-nums dark:divide-gray-800">
          {performance.slice(0, 5).map((template) => (
            <tr key={template.id}>
              <td className="py-2">
                <p className="truncate font-mono text-xs text-gray-900 dark:text-white">{template.name}</p>
                {template.clicked ? <p className="text-[11px] text-gray-500 dark:text-gray-400">{formatNumber(template.clicked)} cliques</p> : null}
              </td>
              <td className="py-2 text-right text-gray-900 dark:text-white">{formatNumber(template.sent)}</td>
              <td className="py-2 text-right text-gray-600 dark:text-gray-300">{formatPercent(template.readRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Card>
);

/* ------------------------------ alertas ------------------------------ */

const RecentAlerts = ({ alerts, onOpenAlerts, now }) => (
  <Card
    title="Alertas recentes"
    action={(
      <button type="button" onClick={onOpenAlerts} className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">
        Ver todos <ArrowRight size={12} aria-hidden="true" />
      </button>
    )}
  >
    {!alerts.length ? (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Nenhum alerta por enquanto. Mudanças de qualidade, limite, nome e templates aparecem aqui.
      </p>
    ) : (
      <ul className="-my-2 divide-y divide-gray-100 dark:divide-gray-800">
        {alerts.slice(0, 3).map((alert) => {
          const severity = SEVERITY[alert.severity] || SEVERITY.info;
          const Icon = TONES[severity.tone].icon;
          return (
            <li key={alert.id} className="flex items-start gap-3 py-2.5">
              <Icon size={16} className={`mt-0.5 shrink-0 ${TONES[severity.tone].iconClass}`} aria-label={severity.label} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-white">{alert.title}</p>
                <p className="truncate text-xs text-gray-500 dark:text-gray-400">{alert.message}</p>
              </div>
              <time className="shrink-0 text-[11px] text-gray-400" dateTime={alert.createdAt}>{formatRelative(alert.createdAt, now)}</time>
            </li>
          );
        })}
      </ul>
    )}
  </Card>
);

/* ------------------------------- pagina ------------------------------- */

export default function WhatsAppOverview({ insights, alerts = [], onOpenAlerts, templatesPath, now }) {
  const { phone, account, templates, messages, pricing, templatePerformance, errors = {} } = insights || {};
  const quality = QUALITY[phone?.qualityRating] || QUALITY.UNKNOWN;
  const tier = TIER[phone?.messagingLimitTier];
  const failed = Object.keys(errors).map((key) => SECTION_NAMES[key] || key);

  return (
    <div className="space-y-3">
      <AttentionBanner phone={phone} account={account} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Qualidade do número" value={quality.label} tone={quality.tone} foot="Pelas reações dos clientes nos últimos dias" />
        <StatTile label="Limite para iniciar conversas" value={tier?.value || '—'} foot={tier?.foot || 'Não informado pela Meta'} />
        <StatTile
          label="Mensagens enviadas"
          value={formatNumber(messages?.sent)}
          foot={messages?.sent ? `${formatPercent(messages.delivered / messages.sent)} entregues · 30 dias` : 'Últimos 30 dias'}
        />
        <StatTile
          label="Custo estimado"
          value={pricing ? formatCurrency(pricing.cost, pricing.currency) : '—'}
          foot={pricing ? `${formatNumber(pricing.paidVolume)} mensagens cobradas · 30 dias` : 'Últimos 30 dias'}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <MessagesCard messages={messages} />
        <PricingCard pricing={pricing} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <AccountCard phone={phone} account={account} />
        <TemplatesCard templates={templates} templatesPath={templatesPath} />
        <PerformanceCard performance={templatePerformance} />
      </div>

      <RecentAlerts alerts={alerts} onOpenAlerts={onOpenAlerts} now={now} />

      {failed.length ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Não deu para atualizar {failed.join(', ')} agora. Mostrando o último valor conhecido.
        </p>
      ) : null}
    </div>
  );
}
