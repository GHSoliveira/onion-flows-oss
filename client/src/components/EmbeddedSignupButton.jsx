import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../services/api';

const APP_ID = import.meta.env.VITE_WHATSAPP_APP_ID;
const CONFIG_ID = import.meta.env.VITE_WHATSAPP_ES_CONFIG_ID;
const GRAPH_VERSION = import.meta.env.VITE_WHATSAPP_GRAPH_VERSION || 'v25.0';

// O SDK e global e so pode ser inicializado uma vez por pagina. A promessa fica
// no modulo para que varias instancias do botao compartilhem o mesmo load.
let promessaSdk = null;

const carregarSdk = () => {
  if (promessaSdk) return promessaSdk;
  promessaSdk = new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB);

    window.fbAsyncInit = () => {
      window.FB.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: true, version: GRAPH_VERSION });
      resolve(window.FB);
    };

    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      promessaSdk = null;   // permite tentar de novo depois de uma falha de rede
      reject(new Error('Nao foi possivel carregar o SDK da Meta.'));
    };
    document.body.appendChild(script);
  });
  return promessaSdk;
};

/**
 * Botao de conexao do WhatsApp via Embedded Signup v4.
 *
 * Nao renderiza nada enquanto o app Meta nao estiver configurado, para nao expor
 * um botao que so daria erro. O caminho manual do MetaSetup continua valendo.
 *
 * `substituiCanal`: o tenant ja tem WhatsApp com token. O onboarding grava por
 * cima dessa credencial, entao o botao pede confirmacao ANTES de abrir a janela
 * da Meta. Depois ja nao da: o code expira em 30 segundos.
 *
 * `query`: o mesmo `?tenantId=` da pagina, para o super admin conectar o tenant
 * que esta vendo, e nao o selecionado em outro lugar.
 */
const EmbeddedSignupButton = ({ onSuccess = null, className = '', substituiCanal = false, query = '' }) => {
  const [conectando, setConectando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  // O `code` chega pelo callback do FB.login e os ids chegam por postMessage, em
  // ordem nao garantida. Guarda-se o que chegar primeiro e envia quando os dois
  // estiverem presentes.
  const parcialRef = useRef({ code: null, dados: null });
  const enviadoRef = useRef(false);
  const confirmouRef = useRef(false);

  const enviarQuandoCompleto = useCallback(async () => {
    const { code, dados } = parcialRef.current;
    if (!code || !dados || enviadoRef.current) return;
    enviadoRef.current = true;

    try {
      const res = await apiRequest(`/channels/whatsapp/embedded-signup${query}`, {
        method: 'POST',
        body: JSON.stringify({
          code,
          wabaId: dados.waba_id,
          phoneNumberId: dados.phone_number_id,
          businessId: dados.business_id || null,
          confirmReplace: confirmouRef.current
        })
      });
      const payload = await res?.json().catch(() => null);

      if (!res?.ok) {
        throw new Error(payload?.error || 'Falha ao concluir a conexao.');
      }

      if (payload?.avisos?.length) {
        // Onboarding parcial: a credencial ficou salva, mas algum passo falhou.
        // O caso comum e o numero nao registrar por falta de metodo de pagamento.
        toast.success('WhatsApp conectado, com pendencias.');
        payload.avisos.forEach((aviso) => toast(aviso.mensagem));
      } else {
        toast.success('WhatsApp conectado.');
      }
      onSuccess?.(payload);
    } catch (erro) {
      toast.error(erro.message || 'Falha ao concluir a conexao.');
    } finally {
      setConectando(false);
      parcialRef.current = { code: null, dados: null };
      enviadoRef.current = false;
      confirmouRef.current = false;
    }
  }, [onSuccess, query]);

  useEffect(() => {
    if (!APP_ID || !CONFIG_ID) return undefined;

    const aoReceberMensagem = (evento) => {
      // Sem esta checagem qualquer iframe da pagina poderia forjar a conclusao.
      if (!String(evento.origin || '').endsWith('facebook.com')) return;
      let dados = null;
      try {
        dados = JSON.parse(evento.data);
      } catch {
        return;   // a propria Meta manda payloads nao-JSON nesse canal
      }
      if (dados?.type !== 'WA_EMBEDDED_SIGNUP') return;

      if (dados.event === 'FINISH') {
        parcialRef.current.dados = dados.data || null;
        enviarQuandoCompleto();
        return;
      }
      if (dados.event === 'CANCEL') {
        setConectando(false);
        parcialRef.current = { code: null, dados: null };
        confirmouRef.current = false;
        const motivo = dados.data?.error_message
          || (dados.data?.current_step ? `Interrompido em: ${dados.data.current_step}` : null);
        if (dados.data?.error_message) toast.error(motivo);
        else if (motivo) toast(motivo);
      }
    };

    window.addEventListener('message', aoReceberMensagem);
    return () => window.removeEventListener('message', aoReceberMensagem);
  }, [enviarQuandoCompleto]);

  const abrirMeta = async (confirmado) => {
    setConfirmando(false);
    setConectando(true);
    parcialRef.current = { code: null, dados: null };
    enviadoRef.current = false;
    confirmouRef.current = confirmado;

    try {
      const FB = await carregarSdk();
      FB.login((resposta) => {
        const code = resposta?.authResponse?.code || null;
        if (!code) {
          // Fechou a janela ou negou permissao. O CANCEL do listener costuma
          // chegar junto e ja explica o motivo com mais detalhe.
          setConectando(false);
          confirmouRef.current = false;
          return;
        }
        // O code expira em 30 segundos: enviar assim que possivel, sem
        // confirmacao intermediaria do usuario.
        parcialRef.current.code = code;
        enviarQuandoCompleto();
      }, {
        config_id: CONFIG_ID,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {} }
      });
    } catch (erro) {
      setConectando(false);
      confirmouRef.current = false;
      toast.error(erro.message || 'Nao foi possivel abrir a conexao com a Meta.');
    }
  };

  const aoClicar = () => {
    if (substituiCanal) {
      setConfirmando((aberto) => !aberto);
      return;
    }
    abrirMeta(false);
  };

  if (!APP_ID || !CONFIG_ID) return null;

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={aoClicar}
        disabled={conectando}
        aria-expanded={substituiCanal ? confirmando : undefined}
        className={`inline-flex h-10 items-center gap-2 border border-emerald-600 bg-emerald-600 px-4 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
      >
        {conectando ? <Loader2 size={16} className="animate-spin" /> : <MessageCircle size={16} />}
        {conectando ? 'Conectando...' : 'Conectar WhatsApp'}
      </button>

      {confirmando && (
        <span
          role="dialog"
          aria-label="Substituir WhatsApp conectado"
          onKeyDown={(evento) => { if (evento.key === 'Escape') setConfirmando(false); }}
          className="absolute right-0 top-full z-30 mt-2 block w-72 border border-amber-300 bg-white p-3 text-left shadow-lg dark:border-amber-700 dark:bg-gray-900"
        >
          <span className="block text-xs font-semibold text-gray-900 dark:text-white">
            Esta empresa ja tem um WhatsApp conectado
          </span>
          <span className="mt-1 block text-[11px] leading-relaxed text-gray-600 dark:text-gray-300">
            Conectar pela Meta substitui o token atual. Catalogo e outras integracoes que dependem dele podem precisar ser refeitos.
          </span>
          <span className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmando(false)}
              autoFocus
              className="border border-gray-300 px-3 py-1.5 text-[11px] font-semibold text-gray-700 hover:border-gray-400 dark:border-gray-600 dark:text-gray-200"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => abrirMeta(true)}
              className="border border-amber-600 bg-amber-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-amber-700"
            >
              Substituir e conectar
            </button>
          </span>
        </span>
      )}
    </span>
  );
};

export default EmbeddedSignupButton;
