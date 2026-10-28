import { AnimatePresence, motion as Motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ambientLinesFor, periodOfDay, tipsForRoute } from '../data/assistantTips';
import { useBrand } from '../context/BrandingContext';

const STORAGE_KEY = 'onion_assistant_v1';
const ATRASO_ENTRADA = 3500;                      // deixa a pagina assentar antes de falar
const DURACAO_BALAO = 10000;                      // some sozinho
const INTERVALO_TENTATIVA = 5 * 60 * 1000;        // reavalia enquanto o usuario fica na mesma tela
const INTERVALO_MINIMO = 15 * 60 * 1000;          // silencio garantido entre dois baloes
const REPETIR_DICA_APOS = 5 * 24 * 60 * 60 * 1000;
const CHANCE_AMBIENTE = 0.25;
const RETORNO_NEUTRO = 10000;                     // volta a encarar de frente depois do ultimo clique
const ESPERA_CAFE = 3000;                         // tempo escondido atras da sidebar
const DURACAO_CAFE = 3500;                        // quanto o cafe fica ao lado dele na volta

// Aba anonima e navegador com dados de site bloqueados fazem o acesso jogar.
// Falhar aqui nao pode derrubar o header, entao o assistente so perde a memoria.
const lerEstado = () => {
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
};

const gravarEstado = (estado) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(estado));
  } catch {
    /* sem persistencia: a dica so nao vai ser lembrada entre sessoes */
  }
};

const sortear = (lista) => lista[Math.floor(Math.random() * lista.length)];

const EYE_POSES = {
  // Leve inclinacao de proposito: olho perfeitamente vertical dava o ar
  // vetorial que a gente estava tentando tirar.
  neutral: {
    left: 'M27.6 36.4 C26.5 40.2 26.2 43.9 26.6 47.4',
    right: 'M38.6 36.2 C37.5 40.2 37.2 43.8 37.6 47.3',
  },
  left: {
    left: 'M15.19 34.39 C13.91 39.39 13.91 44.17 15.07 49.17',
    right: 'M24.58 34.61 C23.42 39.62 23.42 44.39 24.46 49.4',
  },
  right: {
    left: 'M40 35.18 C41.16 39.94 41.16 44.92 40.12 49.68',
    right: 'M49.62 34.95 C50.9 39.71 50.9 44.24 49.74 49',
  },
  up: {
    left: 'M26.55 29.06 C26.09 32.24 25.74 35.63 25.62 38.8',
    right: 'M37.8 28.84 C38.26 32.24 38.61 35.63 38.72 39.03',
  },
  down: {
    left: 'M25.39 43.79 C25.39 46.96 25.86 50.13 26.43 53.3',
    right: 'M38.72 43.56 C38.72 46.96 38.38 50.13 37.68 53.53',
  },
  'up-left': {
    left: 'M17.9 29.47 C16.39 32.44 14.87 35.41 14.29 38.38',
    right: 'M26.23 30.39 C24.66 33.81 23.38 37.01 22.68 40.44',
  },
  'down-left': {
    left: 'M14.17 40.07 C14.41 43.26 15.34 46.67 16.74 49.85',
    right: 'M25.01 42.35 C25.48 45.53 26.76 48.94 28.5 52.13',
  },
  'up-right': {
    left: 'M33.74 31.56 C35.48 34.73 36.87 38.12 37.45 41.29',
    right: 'M44.29 29.52 C46.03 32.24 47.3 35.18 48 37.9',
  },
  'down-right': {
    left: 'M36.06 44.39 C35.83 47.58 35.25 50.99 34.09 54.18',
    right: 'M48 43.03 C47.77 45.99 46.96 49.17 45.68 52.13',
  },
  // Precisa manter a estrutura "M + um C" das outras poses: o framer interpola
  // o atributo d numericamente e so casa curva com curva do mesmo formato.
  // Arcos estreitos de proposito: a ponta arredondada estende o traco em meia
  // largura para cada lado, entao arco largo faz os dois olhos se encostarem e
  // virar um bigode. Estes 4.5 de largura estao calibrados para o traco 6; se
  // alguem engrossar o traco, tem que estreitar os arcos junto.
  feliz: {
    left: 'M24.05 44.6 C25.18 37.5 27.42 37.5 28.55 44.6',
    right: 'M35.95 44.6 C37.08 37.5 39.32 37.5 40.45 44.6',
  },
};

// Xicara desenhada em vez do emoji ☕: em 20px o emoji do sistema vira uma
// bolota marrom sem forma, e ainda era a unica coisa colorida num header que e
// todo linha fina. Aqui o traco acompanha o da cebola e o azul da bebida e o
// mesmo do broto dela.
const XicaraDeCafe = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path d="M12.3 4 c-1.7 1.3 1.3 2.4 -0.4 3.9" strokeWidth="1.5" strokeLinecap="round" className="stroke-slate-400 dark:stroke-slate-500" />
    <path d="M16.3 4 c-1.7 1.3 1.3 2.4 -0.4 3.9" strokeWidth="1.5" strokeLinecap="round" className="stroke-slate-400 dark:stroke-slate-500" />
    <path d="M8.5 10.5 h11 v4.5 a5.5 5.5 0 0 1 -11 0 z" strokeWidth="1.6" strokeLinejoin="round" className="fill-white stroke-slate-600 dark:stroke-slate-300" />
    <path d="M8.5 12 h-1.6 a2.6 2.6 0 0 0 0 5.2 h1.6" strokeWidth="1.6" strokeLinecap="round" className="stroke-slate-600 dark:stroke-slate-300" />
    <path d="M9.6 12.4 h8.8" strokeWidth="1.8" strokeLinecap="round" className="stroke-blue-600 dark:stroke-blue-400" />
  </svg>
);

const directionFromPointer = (element, clientX, clientY) => {
  const bounds = element.getBoundingClientRect();
  const dx = clientX - (bounds.left + bounds.width / 2);
  const dy = clientY - (bounds.top + bounds.height / 2);

  if (Math.hypot(dx, dy) < 18) return 'neutral';

  const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return ({
    '-4': 'left',
    '-3': 'up-left',
    '-2': 'up',
    '-1': 'up-right',
    0: 'right',
    1: 'down-right',
    2: 'down',
    3: 'down-left',
    4: 'left',
  })[octant] || 'neutral';
};

const OnionAssistant = ({ compact = false, className = '' }) => {
  const brand = useBrand();
  const rootRef = useRef(null);
  const [direction, setDirection] = useState('neutral');
  const [mensagem, setMensagem] = useState(null);
  const [comemorando, setComemorando] = useState(false);
  const [emPausa, setEmPausa] = useState(false);
  const [cafe, setCafe] = useState(false);
  const mensagemRef = useRef(null);
  const pausaRef = useRef(false);
  const montadoRef = useRef(true);
  const corpo = useAnimationControls();
  const reduceMotion = useReducedMotion();
  const { pathname } = useLocation();

  useEffect(() => { mensagemRef.current = mensagem; }, [mensagem]);
  useEffect(() => { pausaRef.current = emPausa; }, [emPausa]);
  useEffect(() => () => { montadoRef.current = false; }, []);

  const escolherFala = useCallback((rota) => {
    const estado = lerEstado();
    const agora = Date.now();
    if (agora - (estado.ultimoBalao || 0) < INTERVALO_MINIMO) return null;

    const vistas = estado.vistas || {};
    const dicas = tipsForRoute(rota).filter((dica) => agora - (vistas[dica.id] || 0) > REPETIR_DICA_APOS);

    // A fala ambiente nao tem carencia por linha, so o limite de uma por periodo
    // do dia: sao poucas por periodo e uma carencia longa acabaria com elas em
    // uma semana. O limite e por periodo, e nao por dia, porque com um por dia o
    // "bom dia" gastava a cota e o "como foi o seu dia" nunca chegava a noite.
    const relogio = new Date();
    const hoje = relogio.toDateString();
    const periodo = periodOfDay(relogio.getHours());
    const jaFalouNoPeriodo = (estado.ultimoAmbiente || {})[periodo] === hoje;
    if (!jaFalouNoPeriodo && (dicas.length === 0 || Math.random() < CHANCE_AMBIENTE)) {
      const ambientes = ambientLinesFor(relogio.getHours());
      if (ambientes.length) return { ...sortear(ambientes), ambiente: true, periodo };
    }

    return dicas.length ? sortear(dicas) : null;
  }, []);

  const registrar = useCallback((fala) => {
    const estado = lerEstado();
    gravarEstado({
      ...estado,
      ultimoBalao: Date.now(),
      vistas: { ...(estado.vistas || {}), [fala.id]: Date.now() },
      ultimoAmbiente: fala.ambiente
        ? { ...(estado.ultimoAmbiente || {}), [fala.periodo]: new Date().toDateString() }
        : estado.ultimoAmbiente,
    });
  }, []);

  useEffect(() => {
    setMensagem(null);
    let cancelado = false;

    const tentar = () => {
      if (cancelado || mensagemRef.current || pausaRef.current) return;
      const fala = escolherFala(pathname);
      if (!fala) return;
      setMensagem(fala);
      registrar(fala);
    };

    const primeira = window.setTimeout(tentar, ATRASO_ENTRADA);
    const recorrente = window.setInterval(tentar, INTERVALO_TENTATIVA);
    return () => {
      cancelado = true;
      window.clearTimeout(primeira);
      window.clearInterval(recorrente);
    };
  }, [pathname, escolherFala, registrar]);

  useEffect(() => {
    if (!mensagem) return undefined;
    const timer = window.setTimeout(() => setMensagem(null), DURACAO_BALAO);
    return () => window.clearTimeout(timer);
  }, [mensagem]);

  useEffect(() => {
    if (!comemorando) return undefined;
    const timer = window.setTimeout(() => setComemorando(false), 1400);
    return () => window.clearTimeout(timer);
  }, [comemorando]);

  const dispensar = () => {
    setMensagem(null);
    setComemorando(true);
  };

  // Quanto ele precisa andar para a esquerda para sumir de vez. O <main> tem
  // overflow-hidden e a sidebar encosta na borda esquerda dele, entao o proprio
  // corte do main faz o efeito de entrar atras da sidebar: basta levar a borda
  // direita da cebola para depois da borda esquerda do header. Medir em vez de
  // fixar um numero resolve o header do celular, onde o botao de menu empurra
  // a cebola para a direita.
  const distanciaAteSumir = () => {
    const cebola = rootRef.current;
    const cabecalho = cebola?.closest('header');
    if (!cebola || !cabecalho) return -140;
    return -(cebola.getBoundingClientRect().right - cabecalho.getBoundingClientRect().left + 8);
  };

  const pausaCafe = async () => {
    if (pausaRef.current) return;
    setEmPausa(true);
    setMensagem(null);
    setCafe(false);

    if (!reduceMotion) {
      await corpo.start({ x: distanciaAteSumir(), transition: { duration: 0.5, ease: [0.4, 0, 1, 1] } });
      await new Promise((resolve) => window.setTimeout(resolve, ESPERA_CAFE));
      if (!montadoRef.current) return;
      await corpo.start({ x: 0, transition: { type: 'spring', stiffness: 200, damping: 21, mass: 0.8 } });
    }

    if (!montadoRef.current) return;
    setEmPausa(false);
    setCafe(true);
    setComemorando(true);   // volta do cafe de bom humor
  };

  useEffect(() => {
    if (!cafe) return undefined;
    const timer = window.setTimeout(() => setCafe(false), DURACAO_CAFE);
    return () => window.clearTimeout(timer);
  }, [cafe]);

  // Olha para onde foi o ultimo clique em vez de perseguir o cursor: vira reacao
  // pontual no lugar de movimento continuo numa tela que fica aberta o dia
  // inteiro. Passados RETORNO_NEUTRO sem clique nenhum, volta a encarar de
  // frente para nao ficar com o olhar travado de lado.
  useEffect(() => {
    if (reduceMotion) return undefined;

    let repouso = null;

    const handlePointerDown = (event) => {
      if (!rootRef.current) return;
      const proxima = directionFromPointer(rootRef.current, event.clientX, event.clientY);
      setDirection((atual) => (atual === proxima ? atual : proxima));
      window.clearTimeout(repouso);
      repouso = window.setTimeout(() => setDirection('neutral'), RETORNO_NEUTRO);
    };

    // Fase de captura porque muito componente do app chama stopPropagation no
    // clique. Sem ela o assistente perderia justamente os cliques em botao,
    // node do editor e card de atendimento.
    const opcoes = { capture: true, passive: true };
    window.addEventListener('pointerdown', handlePointerDown, opcoes);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.clearTimeout(repouso);
    };
  }, [reduceMotion]);

  // Durante a pausa o olhar fica travado na direcao da viagem, sem depender do
  // estado de direction, que continua sendo mexido pelo handler de clique.
  const pose = emPausa
    ? EYE_POSES.left
    : comemorando
      ? EYE_POSES.feliz
      : EYE_POSES[reduceMotion ? 'neutral' : direction];
  const eyeTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring', stiffness: 190, damping: 24, mass: 0.62 };

  return (
    <Motion.div
      ref={rootRef}
      className={`relative shrink-0 select-none ${compact ? 'h-9 w-9' : 'h-11 w-11'} ${className}`}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.88, y: 2 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      {/* Camada separada so para a viagem ate a sidebar: o elemento raiz precisa
          ficar parado porque e dele que saem o balao e o cafe, e e ele que serve
          de referencia para calcular a direcao do olhar. */}
      <Motion.button
        type="button"
        onClick={pausaCafe}
        animate={corpo}
        title="Pausa para o cafe"
        aria-label={`Assistente ${brand.productName}`}
        className="block h-full w-full"
      >
      <svg
        viewBox="0 0 64 64"
        className="h-full w-full overflow-visible"
        aria-hidden="true"
      >
        {/* O contorno nao e decorativo: no header claro o corpo e branco sobre
            branco e sem ele sobram os olhos e as folhas flutuando no vazio. */}
        <path
          d="M32.2 13.5 C30.8 19.5 27.6 22.8 22.4 25.8 C12.6 31.4 7.2 41.4 10.6 50.4 C14 59 22.6 62.8 32 62.8 C41.4 62.8 50 59 53.4 50.4 C56.8 41.4 51.4 31.4 41.6 25.8 C36.4 22.8 33.6 19.5 32.2 13.5 Z"
          className="fill-white stroke-slate-300/90 dark:stroke-slate-500/80"
          strokeWidth="0.9"
        />
        <path d="M32 15 C26 12 21 7 19.5 2 C24.5 2.5 30 8 33 14 Z" fill="#2563eb" />
        <path d="M32.5 14 C34.5 8.5 39 4 44.5 3 C45.5 8.5 40 12.5 33.5 14.5 Z" fill="#2563eb" />
        <Motion.path
          d={EYE_POSES.neutral.left}
          animate={{ d: pose.left }}
          transition={eyeTransition}
          fill="none"
          stroke="#050505"
          strokeWidth="6"
          strokeLinecap="round"
        />
        <Motion.path
          d={EYE_POSES.neutral.right}
          animate={{ d: pose.right }}
          transition={eyeTransition}
          fill="none"
          stroke="#050505"
          strokeWidth="6"
          strokeLinecap="round"
        />
      </svg>
      </Motion.button>

      <AnimatePresence>
        {cafe && (
          <Motion.div
            className="pointer-events-none absolute left-full top-1/2 z-30 hidden pl-2 sm:block"
            initial={reduceMotion ? { opacity: 0, y: '-50%' } : { opacity: 0, x: -6, y: '-40%', scale: 0.6 }}
            animate={{ opacity: 1, x: 0, y: '-50%', scale: 1 }}
            exit={{ opacity: 0, y: '-50%', scale: 0.8 }}
            transition={reduceMotion
              ? { duration: 0.12 }
              : { type: 'spring', stiffness: 320, damping: 18, mass: 0.6 }}
            aria-hidden="true"
          >
            <XicaraDeCafe className={compact ? 'h-5 w-5' : 'h-6 w-6'} />
          </Motion.div>
        )}
      </AnimatePresence>

      {/* Escondido abaixo de md: no header do celular nao sobra largura entre a
          cebola e os botoes da direita, e o balao cairia por cima deles. */}
      <AnimatePresence>
        {mensagem && (
          <Motion.div
            key={mensagem.id}
            // w-max e obrigatorio: sendo absoluto dentro de um pai de 44px com
            // left-full, a largura disponivel para o shrink-to-fit e zero e o
            // balao colapsa para uma palavra por linha, ignorando o max-w.
            // A largura tambem controla a altura: com 276px a dica mais longa
            // quebrava em 3 linhas e o balao estourava as bordas do header.
            // 360px (+12px do pl-3) segura tudo em 2 linhas.
            className="pointer-events-none absolute left-full top-1/2 z-30 hidden w-max max-w-[372px] pl-3 md:block"
            initial={reduceMotion ? { opacity: 0, y: '-50%' } : { opacity: 0, x: -8, y: '-50%', scale: 0.94 }}
            animate={{ opacity: 1, x: 0, y: '-50%', scale: 1 }}
            exit={reduceMotion ? { opacity: 0, y: '-50%' } : { opacity: 0, x: -6, y: '-50%', scale: 0.96 }}
            transition={reduceMotion
              ? { duration: 0.12 }
              : { type: 'spring', stiffness: 260, damping: 26, mass: 0.7 }}
          >
            <button
              type="button"
              onClick={dispensar}
              role="status"
              title="Dispensar"
              // Duas escalas porque os headers tem alturas diferentes e o balao
              // nao pode encostar nas bordas de nenhum dos dois: 2 linhas dao
              // 47px no header de 64px, e 38px no de 48px do atendimento.
              className={`pointer-events-auto relative block max-w-[360px] rounded-lg border border-slate-200 bg-white text-left font-medium text-slate-600 transition hover:border-blue-300 hover:text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-blue-500 dark:hover:text-white ${
                compact ? 'px-2.5 py-1 text-[11px] leading-tight' : 'px-3 py-1.5 text-xs leading-snug'
              }`}
            >
              <span
                aria-hidden="true"
                className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-b border-l border-slate-200 bg-white dark:border-slate-600 dark:bg-slate-900"
              />
              {mensagem.text}
            </button>
          </Motion.div>
        )}
      </AnimatePresence>
    </Motion.div>
  );
};

export default OnionAssistant;
