import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';

// Vocabulario da Central do WhatsApp: traduz os codigos da Meta e define o tom
// visual de cada estado. Status sempre sai com icone + texto, nunca so cor.

export const TONES = {
  good: {
    icon: CircleCheck,
    iconClass: 'text-emerald-600 dark:text-emerald-400',
    chip: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200',
    bar: 'bg-emerald-600 dark:bg-emerald-500'
  },
  warning: {
    icon: TriangleAlert,
    iconClass: 'text-amber-500 dark:text-amber-400',
    chip: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200',
    bar: 'bg-amber-500'
  },
  critical: {
    icon: CircleX,
    iconClass: 'text-red-600 dark:text-red-400',
    chip: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200',
    bar: 'bg-red-600 dark:bg-red-500'
  },
  info: {
    icon: Info,
    iconClass: 'text-blue-600 dark:text-blue-400',
    chip: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/70 dark:bg-blue-950/40 dark:text-blue-200',
    bar: 'bg-blue-600'
  },
  neutral: {
    icon: Info,
    iconClass: 'text-gray-400 dark:text-gray-500',
    chip: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
    bar: 'bg-gray-300 dark:bg-gray-600'
  }
};

export const QUALITY = {
  GREEN: { label: 'Alta', tone: 'good' },
  YELLOW: { label: 'Média', tone: 'warning' },
  RED: { label: 'Baixa', tone: 'critical' },
  UNKNOWN: { label: 'Em avaliação', tone: 'neutral' }
};

export const TIER = {
  TIER_NOT_SET: { value: '—', foot: 'Ainda não definido pela Meta' },
  TIER_50: { value: '50', foot: 'clientes novos por dia' },
  TIER_250: { value: '250', foot: 'clientes novos por dia' },
  TIER_1K: { value: '1.000', foot: 'clientes novos por dia' },
  TIER_2K: { value: '2.000', foot: 'clientes novos por dia' },
  TIER_10K: { value: '10.000', foot: 'clientes novos por dia' },
  TIER_100K: { value: '100.000', foot: 'clientes novos por dia' },
  TIER_UNLIMITED: { value: 'Sem limite', foot: 'para iniciar conversas' }
};

export const NAME_STATUS = {
  APPROVED: { label: 'Aprovado', tone: 'good' },
  AVAILABLE_WITHOUT_REVIEW: { label: 'Aprovado', tone: 'good' },
  PENDING_REVIEW: { label: 'Em análise', tone: 'warning' },
  DECLINED: { label: 'Recusado', tone: 'critical' },
  EXPIRED: { label: 'Expirado', tone: 'warning' }
};

export const REVIEW_STATUS = {
  APPROVED: { label: 'Aprovada', tone: 'good' },
  PENDING: { label: 'Em revisão', tone: 'warning' },
  DEFERRED: { label: 'Revisão adiada', tone: 'warning' },
  REJECTED: { label: 'Recusada', tone: 'critical' }
};

export const TEMPLATE_STATUS = {
  APPROVED: { label: 'Aprovado', tone: 'good' },
  PENDING: { label: 'Em análise', tone: 'neutral' },
  IN_APPEAL: { label: 'Em recurso', tone: 'neutral' },
  REJECTED: { label: 'Recusado', tone: 'critical' },
  PAUSED: { label: 'Pausado', tone: 'warning' },
  FLAGGED: { label: 'Sinalizado', tone: 'warning' },
  DISABLED: { label: 'Desativado', tone: 'critical' },
  LIMIT_EXCEEDED: { label: 'Limite excedido', tone: 'warning' },
  LOCKED: { label: 'Bloqueado', tone: 'neutral' },
  PENDING_DELETION: { label: 'Exclusão agendada', tone: 'neutral' }
};

export const TEMPLATE_REASON = {
  ABUSIVE_CONTENT: 'Conteúdo abusivo',
  CATEGORY_NOT_AVAILABLE: 'Categoria indisponível',
  INCORRECT_CATEGORY: 'Categoria incorreta',
  INVALID_FORMAT: 'Formato inválido',
  PROMOTIONAL: 'Conteúdo promocional',
  SCAM: 'Suspeita de golpe',
  TAG_CONTENT_MISMATCH: 'Conteúdo não bate com a categoria'
};

export const CATEGORY = {
  MARKETING: 'Marketing',
  UTILITY: 'Utilidade',
  AUTHENTICATION: 'Autenticação',
  AUTHENTICATION_INTERNATIONAL: 'Autenticação internacional',
  SERVICE: 'Atendimento',
  OUTROS: 'Outros'
};

export const SEVERITY = {
  critical: { label: 'Crítico', tone: 'critical' },
  warning: { label: 'Atenção', tone: 'warning' },
  success: { label: 'Boa notícia', tone: 'good' },
  info: { label: 'Informativo', tone: 'info' }
};

// Avisos de saude chegam da Meta em ingles. Os que ja apareceram na pratica
// ganham traducao; o resto aparece como veio.
const HEALTH_TRANSLATIONS = [
  [/display name has not been approved/i, 'O nome de exibição ainda não foi aprovado. O limite de envio aumenta depois da aprovação.'],
  [/payment method/i, 'Falta cadastrar uma forma de pagamento na conta do WhatsApp.'],
  [/business verification|verify your business/i, 'A empresa precisa concluir a verificação na Meta.'],
  [/policy|violation/i, 'A conta tem pendências de política na Meta.'],
  [/not registered|register the phone/i, 'O número ainda não foi registrado na Cloud API.']
];

export const translateHealthIssue = (description = '') => {
  const match = HEALTH_TRANSLATIONS.find(([pattern]) => pattern.test(description));
  return match ? match[1] : description;
};

const numberFormatter = new Intl.NumberFormat('pt-BR');

export const formatNumber = (value) => (value == null ? '—' : numberFormatter.format(value));

export const formatPercent = (ratio) => (ratio == null || !Number.isFinite(ratio)
  ? '—'
  : `${(ratio * 100).toLocaleString('pt-BR', { maximumFractionDigits: ratio < 0.1 ? 1 : 0 })}%`);

export const formatCurrency = (value, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: value > 0 && value < 1 ? 3 : 2
    }).format(value || 0);
  } catch {
    return `${currency} ${Number(value || 0).toFixed(2)}`;
  }
};

// Datas dos pontos da Meta sao dias UTC (YYYY-MM-DD); meio-dia evita virar o dia.
export const formatDayShort = (isoDate) => new Date(`${isoDate}T12:00:00Z`)
  .toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

export const formatDayLong = (isoDate) => new Date(`${isoDate}T12:00:00Z`)
  .toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });

export const formatDateTime = (iso) => (iso
  ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' })
  : '');

export const formatRelative = (iso, now = Date.now()) => {
  if (!iso) return '';
  const diff = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'ontem' : `há ${days} dias`;
};

export const Chip = ({ tone = 'neutral', children }) => (
  <span className={`inline-flex items-center border px-1.5 py-0.5 text-[11px] font-medium leading-none ${TONES[tone]?.chip || TONES.neutral.chip}`}>
    {children}
  </span>
);
