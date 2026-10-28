import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiRequest } from '../services/api';
import { useTenant } from '../context/TenantContext';
import OperationalModal from '../components/OperationalModal';
import './AnalyticsDashboard.css';

const currentMonth = () =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
const number = (value, digits = 0) =>
  value == null
    ? '—'
    : Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits });
const minutes = (value) =>
  value == null
    ? '—'
    : value < 1
      ? `${Math.round(value * 60)} s`
      : value < 60
        ? `${number(value, 1)} min`
        : `${number(value / 60, 1)} h`;
const date = (value) =>
  new Date(value).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  });
// So a primeira letra maiuscula: "Setembro de 2026" (o CSS capitalize
// deixava "Setembro De 2026").
const monthName = (month) => {
  const text = new Date(`${month}-01T12:00:00-03:00`).toLocaleDateString('pt-BR', {
    month: 'long',
    year: 'numeric',
  });
  return text.charAt(0).toUpperCase() + text.slice(1);
};
const shiftMonth = (month, delta) => {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1 + delta, 1)).toISOString().slice(0, 7);
};
const difference = (value, before, kind) => {
  if (value == null || before == null) return 'Sem base comparavel';
  if (kind === 'rating')
    return `${value - before > 0 ? '+' : ''}${number(value - before, 1)} ponto(s)`;
  if (!before) return value ? 'Sem base comparavel' : 'Sem variacao';
  const change = ((value - before) / before) * 100;
  return `${change > 0 ? '+' : ''}${number(change, 1)}%`;
};
const movementFields = [
  ['opening', 'Em aberto no inicio', ''],
  ['incoming', 'Novas', '+'],
  ['reopened', 'Reaberturas', '+'],
  ['closed', 'Encerramentos', '−'],
  ['ending', 'Em aberto no fim', '='],
];
const incidentFields = [
  ['errors', 'Erros de execucao'],
  ['timeouts', 'Timeouts do fluxo'],
  ['closedWaiting', 'Encerrados em espera'],
  ['inactivity', 'Encerrados por inatividade'],
];
const qualityFields = [
  ['legacyClosures', 'Encerramentos recuperados de closedAt'],
  ['missingDates', 'Conversas sem data de abertura'],
  ['unmatchedPickups', 'Tomadas sem entrada na fila'],
  ['uncertainState', 'Estados sem historico suficiente'],
];

function exportCsv(report, month) {
  const rows = [
    ['Relatorio mensal', month],
    ['Gerado em', report.generatedAt],
    ['Fuso', report.range.timezone],
    ['Inicio', report.range.from],
    ['Fim exclusivo', report.range.to],
    [],
    ['Indicador', 'Atual', 'Anterior'],
  ];
  for (const [key, label] of [
    ['incoming', 'Novas conversas'],
    ['contacts', 'Contatos unicos'],
    ['waitMinutes', 'TME (minutos)'],
    ['waitSamples', 'Amostras TME'],
    ['rating', 'Nota media'],
    ['ratingSamples', 'Avaliacoes'],
  ])
    rows.push([label, report.summary[key], report.previous[key]]);
  rows.push([], ['Movimentacao', 'Quantidade']);
  movementFields.forEach(([key, label]) =>
    rows.push([label, report.movement[key]]),
  );
  for (const [scope, list] of [
    ['Fila', report.queues],
    ['Agente', report.agents],
  ]) {
    rows.push(
      [],
      [
        scope,
        'ID',
        'Conversas',
        'Tomadas',
        'TME (min)',
        'Amostras TME',
        'Encerramentos',
        'Nota media',
        'Avaliacoes',
      ],
    );
    for (const row of list)
      rows.push([
        row.name,
        row.id,
        row.conversations,
        row.pickups,
        row.waitMinutes,
        row.waitSamples,
        row.closed,
        row.rating,
        row.ratingSamples,
      ]);
  }
  rows.push([], ['Dia', 'Novas', 'Encerramentos', 'TME (min)', 'Amostras TME']);
  for (const day of report.days)
    rows.push([
      day.day,
      day.incoming,
      day.closed,
      day.waitMinutes,
      day.waitSamples,
    ]);
  rows.push([], ['Ocorrencia', 'Quantidade']);
  incidentFields.forEach(([key, label]) =>
    rows.push([label, report.incidents[key]]),
  );
  rows.push([], ['Metodologia']);
  report.methodology.forEach((text) => rows.push([text]));
  rows.push([], ['Qualidade dos registros', 'Quantidade']);
  qualityFields.forEach(([key, label]) =>
    rows.push([label, report.quality[key]]),
  );
  const escape = (value) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const url = URL.createObjectURL(
    new Blob(
      ['\uFEFF', rows.map((row) => row.map(escape).join(';')).join('\r\n')],
      { type: 'text/csv;charset=utf-8' },
    ),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `atendimento-${month}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AnalyticsDashboard() {
  const { tenantId } = useParams();
  const { tenant } = useTenant();
  const effectiveTenantId =
    tenantId || (tenant?.id !== 'super_admin' ? tenant?.id : null);
  const [month, setMonth] = useState(currentMonth);
  const [channel, setChannel] = useState('');
  const [revision, setRevision] = useState(0);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [chart, setChart] = useState('volume');
  const [table, setTable] = useState('queues');
  const [page, setPage] = useState(0);
  const [detail, setDetail] = useState(null);
  const [methodology, setMethodology] = useState(false);
  const reduced = useReducedMotion();
  const requestId = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const id = ++requestId.current;
    setLoading(true);
    setReport(null);
    setError('');
    setPage(0);
    setDetail(null);
    const params = new URLSearchParams({
      month,
      ...(channel ? { channel } : {}),
      ...(effectiveTenantId ? { tenantId: effectiveTenantId } : {}),
    });
    (async () => {
      try {
        const response = await apiRequest(`/analytics/monthly?${params}`, {
          signal: controller.signal,
        });
        if (!response) return;
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            data.error || 'Nao foi possivel carregar as analiticas.',
          );
        if (id === requestId.current) setReport(data);
      } catch (err) {
        if (err.name !== 'AbortError' && id === requestId.current)
          setError(err.message);
      } finally {
        if (id === requestId.current && !controller.signal.aborted)
          setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [effectiveTenantId, month, channel, revision]);

  const summary = report?.summary;
  const rows = report?.[table] || [];
  const pageCount = Math.max(1, Math.ceil(rows.length / 10));
  const hasQualityIssues =
    report && Object.values(report.quality).some((n) => n > 0);
  const kpis = summary
    ? [
        {
          key: 'incoming',
          label: 'Novas conversas',
          value: number(summary.incoming),
          foot: `${number(summary.attended)} conversas assumidas no periodo`,
        },
        {
          key: 'contacts',
          label: 'Contatos unicos',
          value: number(summary.contacts),
          foot: 'Entre as novas conversas',
        },
        {
          key: 'waitMinutes',
          label: 'Espera media',
          value: minutes(summary.waitMinutes),
          foot: `${number(summary.waitSamples)} esperas concluidas`,
        },
        {
          key: 'rating',
          label: 'Avaliacao',
          value:
            summary.rating == null ? '—' : `${number(summary.rating, 1)} / 5`,
          foot: `${number(summary.ratingSamples)} avaliacoes registradas`,
        },
      ]
    : [];

  return (
    <main className="monthly-analytics" aria-busy={loading}>
      <header className="monthly-heading">
        <div>
          <h1>Analiticas</h1>
          <div className="monthly-period-name">{monthName(month)}</div>
        </div>
        <div className="monthly-actions">
          <button
            type="button"
            disabled={!report || loading}
            onClick={() => exportCsv(report, month)}
          >
            <Download size={15} /> Exportar CSV
          </button>
          <button
            type="button"
            aria-label="Atualizar relatorio"
            title="Atualizar relatorio"
            disabled={loading}
            onClick={() => setRevision((v) => v + 1)}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </header>
      <div className="monthly-toolbar">
        <div className="monthly-month-picker">
          <button
            type="button"
            aria-label="Mes anterior"
            disabled={month <= '2020-01'}
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            <ChevronLeft size={16} />
          </button>
          <input
            aria-label="Mes do relatorio"
            type="month"
            min="2020-01"
            max={currentMonth()}
            value={month}
            onChange={(e) => {
              if (e.target.value) setMonth(e.target.value);
            }}
          />
          <button
            type="button"
            aria-label="Proximo mes"
            disabled={month >= currentMonth()}
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <select
          aria-label="Canal"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
        >
          <option value="">Todos os canais</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="telegram">Telegram</option>
          <option value="web">Web</option>
          <option value="simulator">Simulador</option>
        </select>
        <span className="monthly-updated">
          {report
            ? `Atualizado ${date(report.generatedAt)}`
            : 'Relatorio mensal'}
        </span>
      </div>
      {error && (
        <div role="alert" className="monthly-empty">
          {error}{' '}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            Tentar novamente
          </button>
        </div>
      )}
      {loading && (
        <div
          role="status"
          aria-label="Carregando relatorio"
          className="monthly-skeleton"
        >
          <div />
          <div />
          <div />
        </div>
      )}
      {report && (
        <motion.div
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18 }}
        >
          <section className="monthly-kpis" aria-label="Resumo mensal">
            {kpis.map((kpi) => (
              <div key={kpi.key} className="monthly-kpi">
                <h2>{kpi.label}</h2>
                <strong>{kpi.value}</strong>
                <span>{kpi.foot}</span>
                <div className="monthly-comparison">
                  {difference(
                    summary[kpi.key],
                    report.previous[kpi.key],
                    kpi.key,
                  )}{' '}
                  <span>vs. periodo anterior</span>
                </div>
              </div>
            ))}
          </section>
          <div className="monthly-comparison-note">
            {report.range.partial
              ? 'Mes em andamento · comparacao pelo mesmo intervalo decorrido'
              : 'Mes completo · comparacao com o mes anterior'}
          </div>
          <section className="monthly-section">
            <div className="monthly-section-heading">
              <h2>Movimentacao registrada</h2>
              <button
                type="button"
                className="monthly-text-button"
                onClick={() => setMethodology(true)}
              >
                Como calculamos
              </button>
            </div>
            <div className="monthly-movement">
              {movementFields.map(([key, label, sign]) => (
                <div key={key}>
                  <span className="monthly-sign" aria-hidden="true">
                    {sign}
                  </span>
                  <div>
                    <strong>{number(report.movement[key])}</strong>
                    <span>{label}</span>
                  </div>
                </div>
              ))}
            </div>
            {hasQualityIssues && (
              <button
                type="button"
                className="monthly-quality"
                onClick={() => setMethodology(true)}
              >
                O historico possui registros legados ou incompletos. Ver
                criterios do relatorio.
              </button>
            )}
          </section>
          <section className="monthly-section">
            <div className="monthly-section-heading">
              <h2>Evolucao diaria</h2>
              <div
                className="monthly-switch"
                role="group"
                aria-label="Visualizacao do grafico"
              >
                {[
                  ['volume', 'Volume'],
                  ['wait', 'Espera'],
                ].map(([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={chart === id}
                    onClick={() => setChart(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div
              className="monthly-chart"
              role="img"
              aria-label={
                chart === 'volume'
                  ? 'Novas conversas e encerramentos por dia. Valores disponiveis no CSV.'
                  : 'TME em minutos por dia. Valores disponiveis no CSV.'
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                {chart === 'volume' ? (
                  <BarChart
                    data={report.days}
                    margin={{ left: -18, right: 8, top: 16, bottom: 0 }}
                  >
                    <CartesianGrid
                      vertical={false}
                      stroke="var(--ma-line)"
                      strokeDasharray="3 5"
                    />
                    <XAxis
                      dataKey="day"
                      tickFormatter={(v) => v.slice(8)}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'var(--ma-muted)', fontSize: 11 }}
                      minTickGap={15}
                    />
                    <YAxis
                      allowDecimals={false}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'var(--ma-muted)', fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--ma-surface)',
                        border: '1px solid var(--ma-line)',
                        borderRadius: 0,
                        color: 'var(--ma-text)',
                      }}
                      labelFormatter={(v) => v.split('-').reverse().join('/')}
                      cursor={{ fill: 'var(--ma-soft)' }}
                    />
                    <Bar
                      name="Novas conversas"
                      dataKey="incoming"
                      fill="var(--ma-blue)"
                      maxBarSize={14}
                      isAnimationActive={false}
                    />
                    <Bar
                      name="Encerramentos"
                      dataKey="closed"
                      fill="#94a3b8"
                      maxBarSize={14}
                      isAnimationActive={false}
                    />
                  </BarChart>
                ) : (
                  <LineChart
                    data={report.days}
                    margin={{ left: -18, right: 8, top: 16, bottom: 0 }}
                  >
                    <CartesianGrid
                      vertical={false}
                      stroke="var(--ma-line)"
                      strokeDasharray="3 5"
                    />
                    <XAxis
                      dataKey="day"
                      tickFormatter={(v) => v.slice(8)}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'var(--ma-muted)', fontSize: 11 }}
                      minTickGap={15}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'var(--ma-muted)', fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--ma-surface)',
                        border: '1px solid var(--ma-line)',
                        borderRadius: 0,
                        color: 'var(--ma-text)',
                      }}
                      labelFormatter={(v) => v.split('-').reverse().join('/')}
                      formatter={(v) => [minutes(v), 'Espera media']}
                    />
                    <Line
                      name="Espera media"
                      dataKey="waitMinutes"
                      stroke="var(--ma-blue)"
                      strokeWidth={2}
                      dot={{ r: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
            <div className="monthly-chart-key">
              {chart === 'volume' ? (
                <>
                  <span>
                    <i /> Novas conversas
                  </span>
                  <span>
                    <i className="secondary" /> Encerramentos
                  </span>
                </>
              ) : (
                <span>Minutos · dias sem amostras nao recebem valor zero</span>
              )}
            </div>
          </section>
          <section className="monthly-section">
            <div className="monthly-section-heading">
              <h2>Atendimento humano</h2>
              <div
                className="monthly-switch"
                role="group"
                aria-label="Agrupamento"
              >
                {[
                  ['queues', 'Filas'],
                  ['agents', 'Agentes'],
                ].map(([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={table === id}
                    onClick={() => {
                      setTable(id);
                      setPage(0);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="monthly-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{table === 'queues' ? 'Fila' : 'Agente'}</th>
                    <th>Conversas</th>
                    <th>Tomadas</th>
                    <th>TME</th>
                    <th>Encerramentos</th>
                    <th>Nota</th>
                    <th>
                      <span className="sr-only">Acoes</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(page * 10, page * 10 + 10).map((row) => (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>{number(row.conversations)}</td>
                      <td>{number(row.pickups)}</td>
                      <td>{minutes(row.waitMinutes)}</td>
                      <td>{number(row.closed)}</td>
                      <td>{number(row.rating, 1)}</td>
                      <td>
                        <button
                          type="button"
                          className="monthly-text-button"
                          onClick={() => setDetail(row)}
                        >
                          Detalhes
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={7} className="monthly-empty">
                        Nenhum atendimento humano registrado neste periodo.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {pageCount > 1 && (
              <div className="monthly-pagination">
                <span>
                  {rows.length} registros · pagina {page + 1} de {pageCount}
                </span>
                <button
                  type="button"
                  aria-label="Pagina anterior"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft size={15} />
                </button>
                <button
                  type="button"
                  aria-label="Proxima pagina"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight size={15} />
                </button>
              </div>
            )}
          </section>
          <section className="monthly-section">
            <div className="monthly-section-heading">
              <h2>Ocorrencias registradas</h2>
            </div>
            <div className="monthly-incidents">
              {incidentFields.map(([key, label]) => (
                <div key={key}>
                  <span>{label}</span>
                  <strong>{number(report.incidents[key])}</strong>
                </div>
              ))}
            </div>
          </section>
        </motion.div>
      )}
      {createPortal(
        <OperationalModal
          open={Boolean(detail) || methodology}
          title={detail ? detail.name : 'Criterios do relatorio'}
          onClose={() => {
            setDetail(null);
            setMethodology(false);
          }}
          size="md"
        >
          <div className="monthly-modal-content">
            {detail ? (
              <>
                <div className="monthly-detail-id">{detail.id}</div>
                <dl>
                  {[
                    ['Conversas', number(detail.conversations)],
                    ['Tomadas de atendimento', number(detail.pickups)],
                    ['TME', minutes(detail.waitMinutes)],
                    ['Amostras de espera', number(detail.waitSamples)],
                    ['Encerramentos registrados', number(detail.closed)],
                    ['Nota media', number(detail.rating, 1)],
                    ['Avaliacoes', number(detail.ratingSamples)],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <p>
                  TME considera apenas esperas com entrada na fila e tomada
                  registradas. A mesma conversa pode passar por mais de uma fila
                  ou agente.
                </p>
              </>
            ) : (
              <>
                {report?.methodology.map((text) => (
                  <p key={text}>{text}</p>
                ))}
                {report && (
                  <dl>
                    {qualityFields.map(([key, label]) => (
                      <div key={key}>
                        <dt>{label}</dt>
                        <dd>{number(report.quality[key])}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
          </div>
        </OperationalModal>,
        document.body,
      )}
    </main>
  );
}
