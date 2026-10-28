import { useState } from 'react';
import { Loader2, Unplug } from 'lucide-react';
import toast from 'react-hot-toast';
import { apiRequest } from '../../services/api';
import { useBrand } from '../../context/BrandingContext';

// Desconectar o numero do tenant (cliente que saiu). Fica no fim da aba Conexao,
// com confirmacao em dois passos.

export default function WhatsAppDisconnect({ q = '', phone = null, onDisconnected }) {
  const brand = useBrand();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const numero = [phone?.verifiedName, phone?.displayPhoneNumber].filter(Boolean).join(' · ') || 'o número conectado';

  const handleDisconnect = async () => {
    setBusy(true);
    try {
      const res = await apiRequest(`/channels/whatsapp/disconnect${q}`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
      const data = res ? await res.json().catch(() => ({})) : null;
      if (!res || !res.ok) throw new Error(data?.error || 'Não foi possível desconectar o número.');
      toast.success('Número desconectado');
      if (data.metaWarning) toast(data.metaWarning, { icon: '⚠️', duration: 8000 });
      setConfirming(false);
      onDisconnected?.(data);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-3xl border border-red-200 bg-white dark:border-red-900/60 dark:bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Desconectar número</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Para quando o cliente sai ou o número vai para outro tenant.</p>
        </div>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="inline-flex h-9 shrink-0 items-center gap-2 border border-red-300 px-3 text-xs font-semibold text-red-700 transition hover:border-red-500 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40"
          >
            <Unplug size={14} aria-hidden="true" /> Desconectar
          </button>
        ) : null}
      </div>

      {confirming ? (
        <div className="border-t border-red-100 bg-red-50/60 px-4 py-4 dark:border-red-900/50 dark:bg-red-950/20">
          <p className="text-sm font-medium text-gray-900 dark:text-white">Desconectar {numero}?</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
            <li>O bot para de receber e enviar mensagens por este número a partir de agora.</li>
            <li>O {brand.productName} apaga o token e o PIN guardados e sai das notificações dessa conta na Meta.</li>
            <li>Fluxos, interactives, contatos e conversas continuam no tenant.</li>
            <li>O número continua ativo na Meta e pode ser conectado de novo, aqui ou em outro tenant.</li>
          </ul>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="inline-flex h-9 items-center border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 border border-red-600 bg-red-600 px-3 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Unplug size={14} aria-hidden="true" />}
              {busy ? 'Desconectando...' : 'Desconectar agora'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
