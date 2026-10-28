import { PauseCircle } from 'lucide-react';

// Faixa no topo quando a conta esta pausada por cobranca. So aparece fora do
// normal. Cliente de agencia fala com a agencia; quem paga a Onion direto, com o suporte.
const pausada = (tenant) => {
  if (!tenant) return false;
  if (typeof tenant.billingPaused === 'boolean') return tenant.billingPaused;
  // Super admin olhando um cliente recebe o tenant cru da lista.
  const billing = tenant.billing || {};
  const confianca = billing.trustUnblockUntil && Date.now() <= new Date(billing.trustUnblockUntil).getTime();
  return billing.blocked === true && !confianca;
};

export default function BillingPausedBanner({ tenant, supportEmail }) {
  if (!pausada(tenant)) return null;
  const daAgencia = tenant.billingPausedBy ? tenant.billingPausedBy === 'partner' : Boolean(tenant.partnerId);
  return (
    <div role="status" className="flex items-start gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 lg:px-8 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100">
      <PauseCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <p className="min-w-0">
        <strong className="font-semibold">Atendimento automático pausado por uma pendência da conta.</strong>{' '}
        As mensagens dos clientes continuam chegando e ficam no histórico; o bot, as campanhas e os envios ativos voltam sozinhos quando a pendência for resolvida.{' '}
        {daAgencia ? 'Fale com a sua agência.' : supportEmail ? `Para regularizar, fale com o suporte: ${supportEmail}.` : 'Para regularizar, fale com o suporte.'}
      </p>
    </div>
  );
}
