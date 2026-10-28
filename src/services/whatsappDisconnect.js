import { clearWhatsAppConfig, findWhatsAppConfigsByWabaId } from './channelConfig.js';
import { unsubscribeWebhook } from './whatsappProvisioning.js';

/**
 * Desconecta o numero WhatsApp de um tenant (cliente que saiu).
 *
 * Primeiro apaga a conexao aqui, depois tira o app do webhook da WABA na Meta.
 * A parte da Meta e melhor esforco: se falhar, ou se outro tenant ainda usa a
 * mesma WABA, o numero ja esta desconectado do Onion e so volta um aviso.
 * O numero continua registrado na Meta e pode ser conectado de novo depois.
 */
export const disconnectWhatsApp = async ({ tenantId, actorId = null }) => {
  const previous = await clearWhatsAppConfig(tenantId, { actorId });

  let metaUnsubscribed = false;
  let metaWarning = null;

  if (previous.accessToken && previous.wabaId) {
    const others = (await findWhatsAppConfigsByWabaId(previous.wabaId)).filter((entry) => entry.tenantId !== tenantId);
    if (others.length) {
      metaWarning = 'Outro tenant usa a mesma conta do WhatsApp Business, então a Onion continua recebendo as notificações dela.';
    } else {
      try {
        metaUnsubscribed = await unsubscribeWebhook({ accessToken: previous.accessToken, wabaId: previous.wabaId });
      } catch (error) {
        metaWarning = `O número foi desconectado da Onion, mas a Meta não confirmou a saída das notificações (${String(error?.message || error).slice(0, 160)}).`;
      }
    }
  }

  return {
    disconnected: true,
    metaUnsubscribed,
    metaWarning,
    phoneNumberCount: previous.phoneNumberIds.length
  };
};
