import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, ExternalLink, RefreshCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_BASE, apiRequest } from '../../services/api';
import { useBrand } from '../../context/BrandingContext';

// Passo a passo de conexao manual e diagnostico do canal. Era a pagina inteira
// de "Integracao com a Meta"; virou a aba Conexao da Central do WhatsApp.

const META_APPS_URL = 'https://developers.facebook.com/apps';
const META_WABA_URL = 'https://business.facebook.com/wa/manage/phone-numbers';

const StatusPill = ({ state }) => {
  const map = {
    done: ['Concluido', 'border-emerald-500 text-emerald-700 dark:text-emerald-300'],
    pending: ['Pendente', 'border-amber-500 text-amber-700 dark:text-amber-300'],
    blocked: ['Aguardando', 'border-gray-300 text-gray-500 dark:border-gray-600 dark:text-gray-400'],
    manual: ['Na Meta', 'border-blue-500 text-blue-700 dark:text-blue-300']
  };
  const [label, cls] = map[state] || map.blocked;
  return (
    <span className={`shrink-0 border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
};

const Step = ({ index, title, description, state, children }) => (
  <section className="border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
    <header className="flex items-start gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
      <span
        className={`grid h-7 w-7 shrink-0 place-items-center font-mono text-xs font-bold ${
          state === 'done'
            ? 'bg-emerald-600 text-white'
            : state === 'blocked'
              ? 'bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-500'
              : 'bg-blue-600 text-white'
        }`}
      >
        {state === 'done' ? <Check size={14} /> : index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="truncate text-sm font-semibold text-gray-900 dark:text-white">{title}</h2>
          <StatusPill state={state} />
        </div>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{description}</p>
        ) : null}
      </div>
    </header>
    {children ? <div className="space-y-3 px-4 py-4">{children}</div> : null}
  </section>
);

const CopyField = ({ label, value, hint }) => {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copiado`);
    } catch {
      toast.error('Nao foi possivel copiar');
    }
  };
  return (
    <div>
      <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">{label}</label>
      <div className="mt-1 flex items-stretch gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.target.select()}
          className="min-w-0 flex-1 border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800 outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
        />
        <button
          type="button"
          onClick={copy}
          className="shrink-0 border border-gray-300 px-3 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200"
        >
          <Copy size={14} />
        </button>
      </div>
      {hint ? <p className="mt-1 text-[11px] text-gray-400">{hint}</p> : null}
    </div>
  );
};

export default function WhatsAppSetupSteps({ tenantId, q, channelsPath, config, onConfigChanged }) {
  const brand = useBrand();
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState({ accessToken: '', wabaId: config.wabaId || '', webhookVerifyToken: config.verifyToken || '' });
  const [diag, setDiag] = useState(null);
  const [numbers, setNumbers] = useState([]);
  const [pin, setPin] = useState('');

  const webhookUrl = `${API_BASE}/api/whatsapp/webhook${tenantId ? `?tenantId=${tenantId}` : ''}`;

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      wabaId: config.wabaId || prev.wabaId,
      webhookVerifyToken: config.verifyToken || prev.webhookVerifyToken
    }));
  }, [config.wabaId, config.verifyToken]);

  const runDiagnostics = useCallback(async (silent = false) => {
    if (!silent) setBusy('diag');
    try {
      const res = await apiRequest(`/channels/whatsapp/diagnostics${q}`);
      const data = res && res.ok ? await res.json() : null;
      setDiag(data);
    } catch {
      if (!silent) toast.error('Falha ao verificar a integracao');
    } finally {
      if (!silent) setBusy('');
    }
  }, [q]);

  useEffect(() => { if (config.hasToken) runDiagnostics(true); }, [config.hasToken, runDiagnostics]);

  const checkBy = useMemo(() => {
    const map = {};
    (diag?.checks || []).forEach((c) => { map[c.key] = c; });
    return map;
  }, [diag]);

  const refreshAll = async () => {
    await onConfigChanged?.();
    await runDiagnostics(true);
  };

  const saveCredentials = async () => {
    if (!form.accessToken.trim() && !config.hasToken) {
      toast.error('Cole o token de acesso.');
      return;
    }
    try {
      setSaving(true);
      const payload = { wabaId: form.wabaId.trim(), webhookVerifyToken: form.webhookVerifyToken.trim() };
      if (form.accessToken.trim()) payload.accessToken = form.accessToken.trim();
      const res = await apiRequest(`/channels/whatsapp${q}`, { method: 'PUT', body: JSON.stringify(payload) });
      if (!res || !res.ok) throw new Error('Falha ao salvar');
      toast.success('Credenciais salvas');
      setForm((prev) => ({ ...prev, accessToken: '' }));
      await refreshAll();
    } catch (error) {
      toast.error(error.message || 'Falha ao salvar credenciais');
    } finally {
      setSaving(false);
    }
  };

  const act = async (key, endpoint, options, okMessage) => {
    try {
      setBusy(key);
      const res = await apiRequest(endpoint, options);
      const data = res ? await res.json().catch(() => ({})) : {};
      if (!res || !res.ok) throw new Error(data?.error || 'Falha na operacao');
      toast.success(okMessage);
      return data;
    } catch (error) {
      toast.error(error.message || 'Falha na operacao');
      return null;
    } finally {
      setBusy('');
    }
  };

  const loadNumbers = async () => {
    const data = await act('numbers', `/channels/whatsapp/phone-numbers${q}`, {
      method: 'POST',
      body: JSON.stringify({ wabaId: form.wabaId || config.wabaId })
    }, 'Numeros carregados');
    if (data) setNumbers(data.numbers || []);
  };

  const selectNumber = async (phoneNumberId) => {
    const res = await apiRequest(`/channels/whatsapp${q}`, {
      method: 'PUT', body: JSON.stringify({ phoneNumberId })
    });
    if (res && res.ok) {
      toast.success('Numero definido');
      await refreshAll();
    } else toast.error('Falha ao definir numero');
  };

  // Estado de cada passo, derivado do que ja esta salvo e do diagnostico ao vivo.
  const steps = useMemo(() => {
    const tokenOk = config.hasToken && checkBy.token?.status === 'ok';
    const wabaOk = Boolean(config.wabaId);
    const webhookOk = checkBy.webhook?.status === 'ok';
    const numberOk = checkBy.number?.status === 'ok';
    return {
      app: 'manual',
      credentials: tokenOk && wabaOk ? 'done' : 'pending',
      webhook: !config.hasToken ? 'blocked' : (webhookOk ? 'done' : 'pending'),
      number: !config.hasToken ? 'blocked' : (numberOk ? 'done' : 'pending'),
      ready: tokenOk && wabaOk && webhookOk && numberOk ? 'done' : 'blocked'
    };
  }, [config, checkBy]);

  const doneCount = Object.values(steps).filter((s) => s === 'done').length;
  const totalTrackable = 4;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">
            {steps.ready === 'done' ? 'Canal pronto para atender' : `${doneCount} de ${totalTrackable} passos concluidos`}
          </p>
          <div className="mt-2 h-1 w-full max-w-xs bg-gray-200 dark:bg-gray-800">
            <div className="h-full bg-blue-600 transition-all" style={{ width: `${(doneCount / totalTrackable) * 100}%` }} />
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => runDiagnostics(false)}
            disabled={!config.hasToken || busy === 'diag'}
            className="inline-flex h-9 items-center gap-2 border border-gray-300 px-3 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
          >
            <RefreshCcw size={14} className={busy === 'diag' ? 'animate-spin' : ''} /> Verificar
          </button>
          <Link
            to={channelsPath}
            className="inline-flex h-9 items-center border border-gray-300 px-3 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200"
          >
            Configuracao avancada
          </Link>
        </div>
      </div>

      <Step
        index={1}
        title="Criar o app e a conta comercial na Meta"
        description="Feito uma unica vez, dentro do painel da Meta. Voce precisa de um app com o produto WhatsApp e de uma conta comercial verificada."
        state={steps.app}
      >
        <ol className="ml-4 list-decimal space-y-1.5 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
          <li>Acesse o painel de apps da Meta e crie um app do tipo <strong>Empresa</strong>.</li>
          <li>Adicione o produto <strong>WhatsApp</strong> ao app.</li>
          <li>Vincule ou crie uma <strong>conta do WhatsApp Business (WABA)</strong>.</li>
          <li>Na tela de introducao do WhatsApp, copie o <strong>token</strong>, o <strong>WABA ID</strong> e anote o numero.</li>
        </ol>
        <a
          href={META_APPS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
        >
          Abrir painel de apps da Meta <ExternalLink size={12} />
        </a>
      </Step>

      <Step
        index={2}
        title="Colar as credenciais aqui"
        description={`O token permite que o ${brand.productName} envie mensagens e leia os templates. O WABA ID identifica a conta comercial.`}
        state={steps.credentials}
      >
        <div>
          <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">
            Token de acesso {config.hasToken ? <span className="font-normal text-emerald-600">(ja salvo)</span> : null}
          </label>
          <input
            type="password"
            className="mt-1 w-full border border-gray-300 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800"
            value={form.accessToken}
            onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
            placeholder={config.hasToken ? 'Preencha apenas para substituir' : 'EAAG...'}
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">WABA ID</label>
          <input
            className="mt-1 w-full border border-gray-300 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800"
            value={form.wabaId}
            onChange={(e) => setForm({ ...form, wabaId: e.target.value })}
            placeholder="9876543210"
          />
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={saveCredentials}
            disabled={saving}
            className="bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Salvando...' : 'Salvar credenciais'}
          </button>
        </div>
        {checkBy.token ? (
          <p className={`text-xs ${checkBy.token.status === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            Token: {checkBy.token.detail}
          </p>
        ) : null}
      </Step>

      <Step
        index={3}
        title="Ligar o webhook"
        description={`E por aqui que a Meta avisa o ${brand.productName} sobre cada mensagem recebida. Sem este passo o bot nao responde ninguem.`}
        state={steps.webhook}
      >
        <CopyField
          label="URL de callback"
          value={webhookUrl}
          hint="Cole no campo Callback URL, na configuracao de webhooks do produto WhatsApp."
        />
        <div>
          <label className="text-xs font-semibold text-gray-600 dark:text-gray-300">Token de verificacao</label>
          <input
            className="mt-1 w-full border border-gray-300 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800"
            value={form.webhookVerifyToken}
            onChange={(e) => setForm({ ...form, webhookVerifyToken: e.target.value })}
            placeholder="uma senha qualquer que voce inventa"
          />
          <p className="mt-1 text-[11px] text-gray-400">
            Escolha um texto qualquer, salve aqui e use o mesmo no campo Verify Token da Meta.
          </p>
        </div>
        <p className="text-xs leading-relaxed text-gray-600 dark:text-gray-300">
          Depois de verificar na Meta, assine o app na sua conta comercial para que os eventos comecem a chegar.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={saveCredentials}
            disabled={saving}
            className="border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
          >
            Salvar token de verificacao
          </button>
          <button
            type="button"
            onClick={async () => {
              const ok = await act('subscribe', `/channels/whatsapp/subscribe-webhook${q}`, { method: 'POST' }, 'Webhook assinado');
              if (ok) await runDiagnostics(true);
            }}
            disabled={!config.hasToken || busy === 'subscribe'}
            className="bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'subscribe' ? 'Assinando...' : 'Assinar webhook'}
          </button>
        </div>
        {checkBy.webhook ? (
          <p className={`text-xs ${checkBy.webhook.status === 'ok' ? 'text-emerald-600' : 'text-amber-600'}`}>
            Webhook: {checkBy.webhook.detail}
          </p>
        ) : null}
      </Step>

      <Step
        index={4}
        title="Escolher e registrar o numero"
        description="O numero que vai atender. Registrar libera o envio pela Cloud API."
        state={steps.number}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={loadNumbers}
            disabled={!config.hasToken || busy === 'numbers'}
            className="border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
          >
            {busy === 'numbers' ? 'Buscando...' : 'Buscar numeros da WABA'}
          </button>
          <a
            href={META_WABA_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
          >
            Gerenciar numeros na Meta <ExternalLink size={12} />
          </a>
        </div>

        {numbers.length > 0 && (
          <div className="divide-y divide-gray-200 border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            {numbers.map((n) => (
              <div key={n.phoneNumberId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-gray-900 dark:text-white">
                    {n.displayPhoneNumber || n.phoneNumberId}
                  </p>
                  <p className="truncate font-mono text-[10px] text-gray-400">
                    {[n.verifiedName, n.qualityRating].filter(Boolean).join(' | ')}
                  </p>
                </div>
                {config.phoneNumberId === n.phoneNumberId ? (
                  <span className="shrink-0 font-mono text-[9px] font-bold uppercase text-emerald-600">Em uso</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => selectNumber(n.phoneNumberId)}
                    className="shrink-0 border border-gray-300 px-2 py-1 text-[11px] font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200"
                  >
                    Usar
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <input
            inputMode="numeric"
            maxLength={6}
            className="w-28 border border-gray-300 bg-gray-50 px-3 py-2 text-sm tracking-widest outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="PIN"
          />
          <button
            type="button"
            onClick={async () => {
              const ok = await act('register', `/channels/whatsapp/register-number${q}`, {
                method: 'POST', body: JSON.stringify({ pin })
              }, 'Numero registrado');
              if (ok) { setPin(''); await runDiagnostics(true); }
            }}
            disabled={pin.length !== 6 || busy === 'register'}
            className="border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:border-blue-500 hover:text-blue-600 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
          >
            {busy === 'register' ? 'Registrando...' : 'Registrar numero'}
          </button>
          <span className="text-[11px] text-gray-400">PIN de verificacao em duas etapas, 6 digitos.</span>
        </div>

        {checkBy.number ? (
          <p className={`text-xs ${checkBy.number.status === 'ok' ? 'text-emerald-600' : 'text-amber-600'}`}>
            Numero: {checkBy.number.detail}
          </p>
        ) : null}
      </Step>

      <Step
        index={5}
        title="Pronto para atender"
        description="Com os passos acima concluidos, o canal ja envia e recebe. A saude do numero fica na aba Visao geral."
        state={steps.ready}
      >
        <div className="flex flex-wrap gap-2">
          <Link
            to={channelsPath}
            className="border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200"
          >
            Perfil do negocio e remetentes
          </Link>
          <Link
            to={tenantId ? `/tenant/${tenantId}/templates` : '/templates'}
            className="border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200"
          >
            Criar templates
          </Link>
          <Link
            to={tenantId ? `/tenant/${tenantId}/flows` : '/flows'}
            className="border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:border-blue-500 hover:text-blue-600 dark:border-gray-600 dark:text-gray-200"
          >
            Montar o fluxo
          </Link>
        </div>
      </Step>
    </div>
  );
}
