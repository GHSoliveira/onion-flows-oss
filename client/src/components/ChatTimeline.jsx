import { useEffect, useState } from 'react';
import {
  Activity,
  AlarmClock,
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  MessageCirclePlus,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  Play,
  RotateCcw,
  Star,
  UserCheck,
  UserMinus,
  Users,
  UserX
} from 'lucide-react';
import { apiRequest } from '../services/api';
import { socketService } from '../services/socket';

const EVENT_META = {
  CHAT_OPENED: {
    icon: MessageCirclePlus,
    label: 'Atendimento aberto',
    tone: 'emerald',
    describe: (event) => `Cliente iniciou contato${event.context?.channel ? ` via ${event.context.channel}` : ''}.`
  },
  FLOW_STARTED: {
    icon: Play,
    label: 'Fluxo iniciado',
    tone: 'blue',
    describe: () => 'O bot começou a atender.'
  },
  FLOW_NODE_ENTERED: {
    icon: Activity,
    label: 'Etapa do fluxo',
    tone: 'slate',
    describe: (event) => `Entrou em "${event.context?.nodeLabel || event.context?.nodeType || 'nó'}".`
  },
  FLOW_TIMEOUT: {
    icon: Clock,
    label: 'Timeout no fluxo',
    tone: 'amber',
    describe: (event) => `Cliente não respondeu em ${event.context?.timeoutMinutes ?? '?'} min — fluxo seguiu adiante.`
  },
  QUEUE_ENTERED: {
    icon: Users,
    label: 'Entrou em fila',
    tone: 'violet',
    describe: (event) => `Encaminhado para a fila "${event.context?.queue || '—'}".`
  },
  QUEUE_TRANSFERRED: {
    icon: ArrowRightLeft,
    label: 'Transferido entre filas',
    tone: 'violet',
    describe: (event) => `De "${event.context?.fromQueue || '—'}" para "${event.context?.queue || '—'}".`
  },
  AGENT_ASSUMED: {
    icon: UserCheck,
    label: 'Agente assumiu',
    tone: 'blue',
    describe: (event) => `${event.actor?.name || 'Agente'} puxou o atendimento.`
  },
  AGENT_RELEASED: {
    icon: UserMinus,
    label: 'Agente saiu',
    tone: 'amber',
    describe: () => 'O atendimento voltou para a fila.'
  },
  AGENT_CLOSED: {
    icon: CheckCircle2,
    label: 'Encerrado pelo agente',
    tone: 'emerald',
    describe: (event) => `${event.actor?.name || 'Agente'} encerrou o atendimento.`
  },
  CLOSED_BY_INACTIVITY: {
    icon: AlarmClock,
    label: 'Encerrado por inatividade',
    tone: 'rose',
    critical: true,
    describe: (event) => `Inativo há mais de ${event.context?.inactivityHours ?? '?'}h.`
  },
  CUSTOMER_DISENGAGED: {
    icon: UserX,
    label: 'Cliente desengajou',
    tone: 'rose',
    critical: true,
    describe: (event) => `Cliente sem resposta há ${event.context?.minutesSinceLastMessage ?? '?'} min.`
  },
  RESUME_TO_FLOW: {
    icon: RotateCcw,
    label: 'Devolvido para o bot',
    tone: 'blue',
    describe: () => 'Atendimento humano encerrado; o fluxo continuou.'
  },
  RATING_SUBMITTED: {
    icon: Star,
    label: 'Nota do cliente',
    tone: 'amber',
    describe: (event) => {
      const nota = event.context?.value;
      const quem = event.context?.agentName ? ` para ${event.context.agentName}` : '';
      return `Nota ${nota ?? '—'} de 5${quem}.`;
    }
  },
  VOICE_CALL_RECEIVED: {
    icon: PhoneIncoming,
    label: 'Ligação recebida',
    tone: 'violet',
    describe: (event) => (event.context?.queueName ? `Tocando para a fila ${event.context.queueName}.` : 'O cliente ligou pelo WhatsApp.')
  },
  VOICE_CALL_ANSWERED: {
    icon: PhoneCall,
    label: 'Ligação atendida',
    tone: 'emerald',
    describe: (event) => `Atendida por ${event.context?.answeredBy || event.actor?.name || 'um atendente'}.`
  },
  VOICE_CALL_ENDED: {
    icon: PhoneOff,
    label: 'Ligação encerrada',
    tone: 'slate',
    describe: (event) => {
      const segundos = Number(event.context?.duration || 0);
      const duracao = `${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, '0')}`;
      return `Duração ${duracao}${event.context?.answeredBy ? ` com ${event.context.answeredBy}` : ''}.`;
    }
  },
  VOICE_CALL_MISSED: {
    icon: PhoneMissed,
    label: 'Ligação perdida',
    tone: 'rose',
    describe: (event) => {
      const tocou = Array.isArray(event.context?.ringedAgents) ? event.context.ringedAgents : [];
      return tocou.length ? `Ninguém atendeu. Tocou para ${tocou.join(', ')}.` : 'Ninguém atendeu.';
    }
  },
  ERROR: {
    icon: AlertTriangle,
    label: 'Erro',
    tone: 'red',
    critical: true,
    describe: (event) => event.context?.message || 'Erro registrado.'
  }
};

const TONE_CLASSES = {
  emerald: 'text-emerald-600 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-900/30',
  blue: 'text-blue-600 bg-blue-50 dark:text-blue-300 dark:bg-blue-900/30',
  violet: 'text-violet-600 bg-violet-50 dark:text-violet-300 dark:bg-violet-900/30',
  amber: 'text-amber-600 bg-amber-50 dark:text-amber-300 dark:bg-amber-900/30',
  rose: 'text-rose-600 bg-rose-50 dark:text-rose-300 dark:bg-rose-900/30',
  red: 'text-red-600 bg-red-50 dark:text-red-300 dark:bg-red-900/30',
  slate: 'text-slate-500 bg-slate-100 dark:text-slate-300 dark:bg-slate-800'
};

const FALLBACK_META = {
  icon: Activity,
  label: (type) => type,
  tone: 'slate',
  describe: (event) => JSON.stringify(event.context || {})
};

const formatDateTime = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
};

const ChatTimeline = ({ chatId }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [events, setEvents] = useState([]);
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    if (!chatId) return undefined;

    let cancelled = false;
    const fetchTimeline = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiRequest(`/chats/${encodeURIComponent(chatId)}/timeline`);
        if (!response || !response.ok) {
          throw new Error('Falha ao carregar linha do tempo');
        }
        const data = await response.json();
        if (cancelled) return;
        setEvents(Array.isArray(data?.events) ? data.events : []);
        setMeta(data?.chat || null);
      } catch (err) {
        if (cancelled) return;
        setError(err?.message || 'Erro ao carregar linha do tempo');
        setEvents([]);
        setMeta(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchTimeline();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  useEffect(() => {
    if (!chatId) return undefined;

    const handleEvent = (event) => {
      if (!event || event.chatId !== chatId) return;
      setEvents((current) => {
        if (current.some((existing) => existing.id === event.id)) return current;
        const next = [...current, event];
        next.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        return next;
      });
    };

    socketService.on('chat_event', handleEvent);
    return () => {
      socketService.off('chat_event', handleEvent);
    };
  }, [chatId]);

  if (loading) {
    return (
      <div className="space-y-3 p-4">
        {[1, 2, 3, 4].map((line) => (
          <div key={line} className="flex items-start gap-3 animate-pulse">
            <div className="h-9 w-9 rounded-full bg-slate-200 dark:bg-slate-700" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 bg-slate-200 dark:bg-slate-700 rounded" />
              <div className="h-3 w-2/3 bg-slate-200 dark:bg-slate-800 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-sm text-rose-600 dark:text-rose-300">
        {error}
      </div>
    );
  }

  if (!events.length) {
    return (
      <div className="p-6 text-sm text-slate-500 dark:text-slate-400">
        Nenhum evento registrado para este atendimento.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-1">
      {meta && (
        <div className="px-1 pb-3 text-xs text-slate-500 dark:text-slate-400">
          Linha do tempo de {events.length} evento(s)
          {meta.createdAt ? ` · iniciado em ${formatDateTime(meta.createdAt)}` : ''}
        </div>
      )}
      <ol className="relative border-l border-slate-200 dark:border-slate-700 ml-4 space-y-4">
        {events.map((event) => {
          const meta = EVENT_META[event.type] || FALLBACK_META;
          const Icon = meta.icon;
          const tone = TONE_CLASSES[meta.tone] || TONE_CLASSES.slate;
          const label = typeof meta.label === 'function' ? meta.label(event.type) : meta.label;
          const description = typeof meta.describe === 'function' ? meta.describe(event) : '';
          const isInferred = Boolean(event.context?.inferred);

          return (
            <li key={event.id} className="pl-6 relative">
              <span className={`absolute -left-4 top-0 flex h-8 w-8 items-center justify-center rounded-full ring-4 ring-white dark:ring-slate-900 ${tone}`}>
                <Icon size={14} />
              </span>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {label}
                  </span>
                  {meta.critical && (
                    <span className="text-[10px] uppercase tracking-wide font-semibold text-rose-600 dark:text-rose-300 bg-rose-100 dark:bg-rose-900/30 px-1.5 py-0.5 rounded">
                      crítico
                    </span>
                  )}
                  {isInferred && (
                    <span className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">
                      inferido
                    </span>
                  )}
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {formatDateTime(event.timestamp)}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {description}
              </p>
              {event.actor?.kind && event.actor.kind !== 'system' && event.actor.kind !== 'flow' && (
                <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                  por {event.actor.name || event.actor.id || event.actor.kind}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default ChatTimeline;
