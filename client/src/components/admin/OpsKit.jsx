import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { animate, useReducedMotion } from 'framer-motion';
import { Check, Copy, RefreshCcw } from 'lucide-react';
import toast from 'react-hot-toast';

/**
 * Pecas pequenas das telas de administracao (super admin). O estilo vem de
 * styles/super-admin-operational.css: cantos retos e linhas finas, com cor so
 * onde ela significa algo (ok, atencao, problema, informacao).
 */

const inteiro = (n) => Math.round(n).toLocaleString('pt-BR');

// O texto e escrito direto no DOM (sem children): um re-render do pai no meio da
// contagem nao faz o numero pular para o valor final.
export function CountUp({ value, format = inteiro, duration = 0.9 }) {
  const reduced = useReducedMotion();
  const ref = useRef(null);
  const shown = useRef(0);

  useLayoutEffect(() => {
    const target = Number(value) || 0;
    const node = ref.current;
    if (!node) return undefined;
    if (reduced || shown.current === target) {
      shown.current = target;
      node.textContent = format(target);
      return undefined;
    }
    node.textContent = format(shown.current);
    const controls = animate(shown.current, target, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (current) => {
        shown.current = current;
        node.textContent = format(current);
      }
    });
    // Parar no meio (valor novo, StrictMode) deixa shown no ponto atual: a proxima
    // contagem continua dali, sem voltar a zero nem saltar.
    return () => controls.stop();
    // format costuma ser uma arrow nova a cada render; so o valor dispara a animacao.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduced, duration]);

  return <span ref={ref} className="tabular-nums" />;
}

export const Chip = ({ tone = 'neutral', icon: Icon, children, title, className = '' }) => (
  <span className={`sa-chip ${className}`} data-tone={tone} title={title}>
    {Icon && <Icon size={11} strokeWidth={2.4} />}
    {children}
  </span>
);

// Uso contra limite do plano. Normal em azul, amarelo a partir de 80%, vermelho no teto.
export function Meter({ label, value = 0, max, className = '' }) {
  const hasMax = typeof max === 'number' && max > 0;
  const ratio = hasMax ? Math.min(1, value / max) : 0;
  const tone = !hasMax ? 'neutral' : value >= max ? 'bad' : ratio >= 0.8 ? 'warn' : 'info';
  const shown = value > 0 ? Math.max(ratio, 0.03) : 0;
  return (
    <div className={`sa-meter ${className}`} data-tone={tone} title={hasMax ? `${value} de ${max}` : `${value}`}>
      <div className="sa-meter-head">
        {label && <span>{label}</span>}
        <span className="tabular-nums">{value}{hasMax ? `/${max}` : ''}</span>
      </div>
      <div className="sa-meter-track"><div className="sa-meter-fill" style={{ '--p': shown }} /></div>
    </div>
  );
}

// Barra empilhada com legenda (ex.: carteira por estado ou por pagamento).
export function SegmentBar({ segments, className = '' }) {
  const total = segments.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  return (
    <div className={className}>
      <div className="sa-segbar">
        {total === 0
          ? <span data-tone="neutral" style={{ flexGrow: 1 }} />
          : segments.filter((item) => item.value > 0).map((item, index) => (
            <span key={item.label} data-tone={item.tone} style={{ flexGrow: item.value, animationDelay: `${index * 90}ms` }} title={`${item.value} ${item.label}`} />
          ))}
      </div>
      <div className="sa-seglegend">
        {segments.map((item) => (
          <span key={item.label} data-tone={item.tone} data-empty={!item.value ? '' : undefined}>
            <span className="sa-dot" />
            <strong><CountUp value={item.value} /></strong> {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ID em fonte mono que copia com um clique: o icone vira um check por um instante.
export function CopyId({ value, strong = false, className = '' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!value) return null;
  const copy = async (event) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(String(value));
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error('Não foi possível copiar');
    }
  };
  return (
    <button type="button" onClick={copy} className={`sa-copy ${className}`} data-strong={strong ? '' : undefined} data-copied={copied ? '' : undefined} title={copied ? 'Copiado' : 'Copiar'}>
      <span className="truncate font-mono">{value}</span>
      <span className="sa-copy-icon" aria-hidden="true">{copied ? <Check size={11} strokeWidth={3} /> : <Copy size={11} />}</span>
    </button>
  );
}

const relativo = (date) => {
  if (!date) return '';
  const seconds = Math.max(0, Math.round((Date.now() - date) / 1000));
  if (seconds < 10) return 'agora';
  if (seconds < 60) return `há ${seconds} s`;
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  return `às ${new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
};

// "Atualizado há 30 s" + botao de recarregar que gira enquanto busca.
export function Freshness({ at, busy, onRefresh }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 10000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span className="tabular-nums">{busy ? 'Atualizando…' : at ? `Atualizado ${relativo(at)}` : ''}</span>
      {onRefresh && (
        <button type="button" onClick={onRefresh} disabled={busy} className="sa-icon-btn" title="Atualizar" aria-label="Atualizar">
          <RefreshCcw size={14} className={busy ? 'animate-spin' : ''} />
        </button>
      )}
    </div>
  );
}
