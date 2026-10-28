import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Phone, PhoneIncoming, PhoneOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../../services/api';
import { socketService } from '../../services/socket';

// Telefone do atendente para ligacoes do WhatsApp. O servidor avisa quando a
// ligacao toca para esta pessoa; ao atender, o navegador responde a oferta de
// audio da Meta (WebRTC) e o audio vai direto entre a Meta e este navegador.

const ATTEND_ROLES = new Set(['ADMIN', 'MANAGER', 'AGENT']);
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

const formatarNumero = (valor) => {
  const d = String(valor || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) return `+55 ${d.slice(2, 4)} ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55')) return `+55 ${d.slice(2, 4)} ${d.slice(4, 8)}-${d.slice(8)}`;
  return d ? `+${d}` : 'Número oculto';
};

const formatarTempo = (segundos) => {
  const s = Math.max(0, Math.floor(segundos));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const lerErro = async (response) => {
  const body = await response?.json().catch(() => null);
  return body?.message || `Falha (${response?.status || 0})`;
};

// Toque feito no proprio navegador: dois bipes curtos a cada 2 s.
const criarToque = () => {
  let ctx = null;
  let intervalo = null;
  const bipe = (inicio) => {
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.frequency.value = 880;
    ganho.gain.setValueAtTime(0.0001, inicio);
    ganho.gain.exponentialRampToValueAtTime(0.18, inicio + 0.02);
    ganho.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.25);
    osc.connect(ganho).connect(ctx.destination);
    osc.start(inicio);
    osc.stop(inicio + 0.3);
  };
  return {
    iniciar() {
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        ctx.resume?.();
        const tocar = () => { const t = ctx.currentTime; bipe(t); bipe(t + 0.35); };
        tocar();
        intervalo = setInterval(tocar, 2000);
      } catch { /* sem audio: o cartao na tela continua avisando */ }
    },
    parar() {
      clearInterval(intervalo);
      intervalo = null;
    },
    fechar() {
      this.parar();
      ctx?.close?.().catch(() => {});
      ctx = null;
    }
  };
};

const aguardarIce = (pc, ms = 2500) => new Promise((resolve) => {
  if (pc.iceGatheringState === 'complete') { resolve(); return; }
  const timer = setTimeout(resolve, ms);
  pc.addEventListener('icegatheringstatechange', () => {
    if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
  });
});

const VoiceCallDock = ({ user }) => {
  const [estado, setEstado] = useState('idle');
  const [chamada, setChamada] = useState(null);
  const [mudo, setMudo] = useState(false);
  const [agora, setAgora] = useState(Date.now());
  const [aviso, setAviso] = useState(null);
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const toqueRef = useRef(null);
  const estadoRef = useRef('idle');
  const chamadaRef = useRef(null);
  const tituloRef = useRef(null);

  useEffect(() => { chamadaRef.current = chamada; }, [chamada]);

  const podeAtender = ATTEND_ROLES.has(user?.role);

  const mudarEstado = useCallback((proximo) => {
    estadoRef.current = proximo;
    setEstado(proximo);
  }, []);

  const liberarAudio = useCallback(() => {
    toqueRef.current?.parar();
    pcRef.current?.getSenders?.().forEach((sender) => sender.track?.stop());
    pcRef.current?.close?.();
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setMudo(false);
  }, []);

  const encerrarVisual = useCallback((mensagem = null) => {
    liberarAudio();
    if (mensagem) {
      setAviso(mensagem);
      mudarEstado('ended');
      setTimeout(() => {
        if (estadoRef.current === 'ended') { mudarEstado('idle'); setChamada(null); setAviso(null); }
      }, 4000);
    } else {
      mudarEstado('idle');
      setChamada(null);
      setAviso(null);
    }
  }, [liberarAudio, mudarEstado]);

  // Relogio para contagem regressiva do toque e duracao da ligacao.
  useEffect(() => {
    if (!['ringing', 'active'].includes(estado)) return undefined;
    const id = setInterval(() => setAgora(Date.now()), 500);
    return () => clearInterval(id);
  }, [estado]);

  // Titulo da aba pisca enquanto toca, para quem esta em outra aba.
  useEffect(() => {
    if (estado !== 'ringing') return undefined;
    tituloRef.current = document.title;
    let alterna = false;
    const id = setInterval(() => {
      alterna = !alterna;
      document.title = alterna ? '📞 Ligação no WhatsApp' : (tituloRef.current || 'Onion Flows');
    }, 1000);
    return () => {
      clearInterval(id);
      if (tituloRef.current) document.title = tituloRef.current;
    };
  }, [estado]);

  useEffect(() => {
    if (!podeAtender) return undefined;
    toqueRef.current = criarToque();

    const aoTocar = (payload) => {
      if (!payload?.callId) return;
      if (['connecting', 'active'].includes(estadoRef.current)) return;
      setChamada((atual) => (atual?.callId === payload.callId ? { ...atual, ...payload } : payload));
      if (estadoRef.current !== 'ringing') {
        mudarEstado('ringing');
        setAviso(null);
        toqueRef.current?.iniciar();
      }
    };
    const aoPararToque = (payload) => {
      if (chamadaRef.current?.callId !== payload?.callId || estadoRef.current !== 'ringing') return;
      toqueRef.current?.parar();
      mudarEstado('idle');
      setChamada(null);
    };
    const aoEncerrar = (payload) => {
      if (chamadaRef.current?.callId !== payload?.callId) return;
      if (!['connecting', 'active', 'orphan'].includes(estadoRef.current)) return;
      const duracao = Number(payload?.duration);
      encerrarVisual(Number.isFinite(duracao) && duracao > 0 ? `Ligação encerrada · ${formatarTempo(duracao)}` : 'Ligação encerrada');
    };

    socketService.on('voice_call_ringing', aoTocar);
    socketService.on('voice_call_ringing_stop', aoPararToque);
    socketService.on('voice_call_ended', aoEncerrar);

    // Pagina recarregada no meio de um toque ou de uma ligacao.
    apiRequest('/voice-calls/current')
      .then((response) => (response?.ok ? response.json() : null))
      .then((dados) => {
        if (dados?.state === 'ringing' && dados.call) aoTocar(dados.call);
        if (dados?.state === 'active' && dados.call) {
          setChamada(dados.call);
          setAviso('A página foi recarregada e o áudio desta ligação se perdeu. Encerre para liberar a linha.');
          mudarEstado('orphan');
        }
      })
      .catch(() => {});

    return () => {
      socketService.off('voice_call_ringing', aoTocar);
      socketService.off('voice_call_ringing_stop', aoPararToque);
      socketService.off('voice_call_ended', aoEncerrar);
      toqueRef.current?.fechar();
      liberarAudio();
    };
  }, [podeAtender, encerrarVisual, liberarAudio, mudarEstado]);

  const recusar = async () => {
    if (!chamada) return;
    toqueRef.current?.parar();
    const callId = chamada.callId;
    mudarEstado('idle');
    setChamada(null);
    await apiRequest(`/voice-calls/${encodeURIComponent(callId)}/decline`, { method: 'POST' }).catch(() => {});
  };

  const atender = async () => {
    if (!chamada || estadoRef.current !== 'ringing') return;
    toqueRef.current?.parar();
    mudarEstado('connecting');
    const callId = chamada.callId;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        throw new Error('Este navegador não suporta ligações.');
      }
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        throw new Error('Libere o microfone no navegador para atender ligações.');
      }
      streamRef.current = stream;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.ontrack = (evento) => {
        if (audioRef.current) {
          audioRef.current.srcObject = evento.streams[0];
          audioRef.current.play?.().catch(() => {});
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && estadoRef.current === 'active') {
          setAviso('A conexão de áudio caiu. Encerre e peça para o cliente ligar de novo.');
        }
      };

      await pc.setRemoteDescription({ type: 'offer', sdp: chamada.sdp });
      const resposta = await pc.createAnswer();
      await pc.setLocalDescription(resposta);
      await aguardarIce(pc);

      const response = await apiRequest(`/voice-calls/${encodeURIComponent(callId)}/accept`, {
        method: 'POST',
        body: JSON.stringify({ sdp: pc.localDescription.sdp })
      });
      if (!response?.ok) throw new Error(await lerErro(response));
      setChamada((atual) => (atual ? { ...atual, answeredAt: new Date().toISOString() } : atual));
      mudarEstado('active');
    } catch (error) {
      toast.error(error.message || 'Não foi possível atender.');
      encerrarVisual();
      // Nao atendeu de fato: devolve para o proximo do rodizio.
      apiRequest(`/voice-calls/${encodeURIComponent(callId)}/decline`, { method: 'POST' }).catch(() => {});
    }
  };

  const desligar = async () => {
    if (!chamada) return;
    const callId = chamada.callId;
    const inicio = chamada.answeredAt ? new Date(chamada.answeredAt).getTime() : Date.now();
    encerrarVisual(`Ligação encerrada · ${formatarTempo((Date.now() - inicio) / 1000)}`);
    const response = await apiRequest(`/voice-calls/${encodeURIComponent(callId)}/hangup`, { method: 'POST' }).catch(() => null);
    if (response && !response.ok) toast.error(await lerErro(response));
  };

  const alternarMudo = () => {
    const proximo = !mudo;
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !proximo; });
    setMudo(proximo);
  };

  if (!podeAtender) return null;

  const nome = chamada?.contactName || formatarNumero(chamada?.from);
  const restante = chamada?.expiresAt ? Math.max(0, Math.ceil((new Date(chamada.expiresAt).getTime() - agora) / 1000)) : null;
  const duracao = chamada?.answeredAt ? (agora - new Date(chamada.answeredAt).getTime()) / 1000 : 0;

  return (
    <>
      <audio ref={audioRef} autoPlay className="hidden" />
      {estado !== 'idle' && chamada ? (
        <div
          role="dialog"
          aria-live="assertive"
          aria-label="Ligação do WhatsApp"
          className="fixed bottom-5 right-5 z-[70] w-[320px] border border-slate-200 bg-white shadow-[0_24px_60px_-20px_rgba(15,23,42,0.45)] dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
            <span className={`relative grid h-10 w-10 shrink-0 place-items-center ${estado === 'active' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300'}`}>
              {estado === 'ringing' ? <span className="absolute inset-0 animate-ping bg-blue-400/30" /> : null}
              {estado === 'active' ? <Phone size={18} /> : <PhoneIncoming size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                {estado === 'ringing' ? 'Ligação no WhatsApp' : estado === 'connecting' ? 'Conectando…' : estado === 'active' ? 'Em ligação' : estado === 'ended' ? 'Encerrada' : 'Ligação'}
              </div>
              <div className="truncate text-sm font-semibold text-slate-900 dark:text-white">{nome}</div>
              {chamada.contactName ? <div className="truncate text-xs text-slate-500">{formatarNumero(chamada.from)}</div> : null}
            </div>
            <div className="shrink-0 text-right font-mono text-xs tabular-nums text-slate-500">
              {estado === 'ringing' && restante !== null ? `${restante}s` : null}
              {estado === 'active' ? formatarTempo(duracao) : null}
            </div>
          </div>

          {aviso && estado !== 'ended' ? <div className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">{aviso}</div> : null}
          {estado === 'ringing' && chamada.queueName ? <div className="px-4 pt-2 text-xs text-slate-500">Fila {chamada.queueName}</div> : null}

          <div className="flex gap-2 p-3">
            {estado === 'ringing' ? (
              <>
                <button type="button" onClick={recusar} className="flex h-10 flex-1 items-center justify-center gap-2 border border-slate-300 text-sm font-medium text-slate-700 transition hover:border-rose-400 hover:text-rose-600 dark:border-slate-600 dark:text-slate-200">
                  <PhoneOff size={15} /> Recusar
                </button>
                <button type="button" onClick={atender} autoFocus className="flex h-10 flex-1 items-center justify-center gap-2 bg-emerald-600 text-sm font-semibold text-white transition hover:bg-emerald-700">
                  <Phone size={15} /> Atender
                </button>
              </>
            ) : null}
            {estado === 'connecting' ? (
              <div className="flex h-10 flex-1 items-center justify-center text-sm text-slate-500">Ligando o áudio…</div>
            ) : null}
            {estado === 'active' ? (
              <>
                <button type="button" onClick={alternarMudo} aria-pressed={mudo} className={`flex h-10 flex-1 items-center justify-center gap-2 border text-sm font-medium transition ${mudo ? 'border-amber-400 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-200' : 'border-slate-300 text-slate-700 hover:border-slate-500 dark:border-slate-600 dark:text-slate-200'}`}>
                  {mudo ? <MicOff size={15} /> : <Mic size={15} />} {mudo ? 'Sem som' : 'Mudo'}
                </button>
                <button type="button" onClick={desligar} className="flex h-10 flex-1 items-center justify-center gap-2 bg-rose-600 text-sm font-semibold text-white transition hover:bg-rose-700">
                  <PhoneOff size={15} /> Desligar
                </button>
              </>
            ) : null}
            {estado === 'orphan' ? (
              <button type="button" onClick={desligar} className="flex h-10 flex-1 items-center justify-center gap-2 bg-rose-600 text-sm font-semibold text-white transition hover:bg-rose-700">
                <PhoneOff size={15} /> Encerrar ligação
              </button>
            ) : null}
            {estado === 'ended' ? (
              <div className="flex h-10 flex-1 items-center justify-center text-sm text-slate-500">{aviso || 'Ligação encerrada'}</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
};

export default VoiceCallDock;
