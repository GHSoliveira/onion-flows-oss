/**
 * Onboarding de cliente via WhatsApp Embedded Signup v4.
 *
 * Sequencia definida pela Meta, nesta ordem:
 *   1. trocar o `code` do fluxo por um token de negocio
 *   2. assinar o nosso app nos webhooks da WABA do cliente
 *   3. registrar o numero do cliente para uso na Cloud API
 *   4. persistir a credencial no canal do tenant
 *
 * Os passos 2 e 3 reaproveitam whatsappProvisioning.js, que ja fazia essas
 * chamadas para o fluxo manual do MetaSetup.
 */
import crypto from 'node:crypto';
import { registerPhoneNumber, subscribeWebhook } from './whatsappProvisioning.js';
import { findWhatsAppPhoneNumberOwners, getWhatsAppConfig, saveWhatsAppConfig } from './channelConfig.js';
import { createLog } from './logs.js';

const getGraphVersion = () => process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const REQUEST_TIMEOUT_MS = Number(process.env.WHATSAPP_GRAPH_TIMEOUT_MS || 10000);

const falha = (message, status = 400, code = 'embedded_signup_error') => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
};

/** PIN de 6 digitos exigido no registro do numero, e de novo em qualquer rereg. */
export const generateRegistrationPin = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * Troca o code do Embedded Signup por um token de negocio.
 *
 * Nao usa o graphRequest de whatsappProvisioning porque aquele sempre envia
 * Authorization: Bearer, e este endpoint se autentica por client_id/client_secret.
 *
 * O code expira em 30 segundos, entao esta chamada precisa acontecer na hora em
 * que a requisicao do cliente chega. Nao enfileirar.
 */
export const exchangeSignupCode = async (code) => {
  const appId = process.env.WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appId || !appSecret) {
    throw falha(
      'WHATSAPP_APP_ID e WHATSAPP_APP_SECRET precisam estar configurados para o Embedded Signup.',
      503,
      'embedded_signup_not_configured'
    );
  }

  const url = new URL(`https://graph.facebook.com/${getGraphVersion()}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('code', code);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { method: 'GET', signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.access_token) {
      const error = falha(
        data?.error?.message || 'Nao foi possivel trocar o codigo do Embedded Signup.',
        res.status >= 400 && res.status <= 599 ? res.status : 502,
        'code_exchange_failed'
      );
      error.graphCode = data?.error?.code ?? null;
      throw error;
    }
    return data.access_token;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw falha('A Graph API nao respondeu a tempo na troca do codigo.', 504, 'code_exchange_timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * Executa o onboarding completo depois que o cliente conclui o fluxo no navegador.
 *
 * Retorna o resumo dos passos para a interface conseguir mostrar exatamente onde
 * parou quando algum deles falha. O registro do numero e tratado como nao fatal:
 * ele costuma falhar quando o cliente ainda nao adicionou metodo de pagamento, e
 * nesse caso o canal ja fica utilizavel para receber, so nao para enviar.
 */
export const completeEmbeddedSignup = async ({
  tenantId,
  code,
  wabaId,
  phoneNumberId,
  businessId = null,
  confirmReplace = false,
  actorId = null
}) => {
  if (!tenantId) throw falha('tenantId obrigatorio.', 400, 'missing_tenant');
  if (!code) throw falha('code obrigatorio.', 400, 'missing_code');
  if (!wabaId) throw falha('wabaId obrigatorio.', 400, 'missing_waba_id');
  if (!phoneNumberId) throw falha('phoneNumberId obrigatorio.', 400, 'missing_phone_number_id');

  // Travas locais, antes de gastar o code: quando o onboarding e recusado, nada
  // abaixo delas pode chegar na Meta (nem assinatura de webhook, nem registro).
  const donos = await findWhatsAppPhoneNumberOwners(phoneNumberId);
  if (donos.some((dono) => dono !== tenantId)) {
    // Mesmo numero em dois tenants faz o webhook entregar mensagem de cliente
    // para o tenant errado. A mensagem nao diz qual e o outro tenant.
    throw falha(
      'Este numero de WhatsApp ja esta conectado a outra conta da plataforma. Desconecte-o de la antes de conectar aqui.',
      409,
      'phone_number_in_use'
    );
  }

  // O onboarding grava token, WABA e numero por cima do canal. Num canal que ja
  // funciona isso troca a credencial (e o token do Embedded Signup nao carrega
  // permissoes extras, como a de catalogo), entao so com confirmacao explicita.
  const atual = await getWhatsAppConfig(tenantId);
  const substituindo = Boolean(atual?.accessToken);
  if (substituindo && confirmReplace !== true) {
    throw falha(
      'Esta conta ja tem um WhatsApp conectado. Confirme a substituicao para trocar a credencial atual.',
      409,
      'whatsapp_already_connected'
    );
  }

  const passos = { tokenExchange: false, subscribeWebhook: false, registerPhoneNumber: false, saved: false };
  const avisos = [];

  const accessToken = await exchangeSignupCode(code);
  passos.tokenExchange = true;

  await subscribeWebhook({ accessToken, wabaId });
  passos.subscribeWebhook = true;

  const registrationPin = generateRegistrationPin();
  try {
    await registerPhoneNumber({ accessToken, phoneNumberId, pin: registrationPin });
    passos.registerPhoneNumber = true;
  } catch (error) {
    // Nao aborta: sem registro o canal recebe mensagem mas nao envia, e e melhor
    // guardar a credencial do que perder o onboarding inteiro e o code ja gasto.
    avisos.push({
      etapa: 'registerPhoneNumber',
      mensagem: error?.message || 'Falha ao registrar o numero.',
      graphCode: error?.graphCode ?? null
    });
  }

  await saveWhatsAppConfig(tenantId, {
    enabled: true,
    accessToken,
    wabaId,
    phoneNumberId,
    registrationPin,
    onboardedVia: 'embedded_signup',
    onboardedAt: new Date().toISOString(),
    businessId
  });
  passos.saved = true;

  await createLog('WHATSAPP_EMBEDDED_SIGNUP', {
    tenantId,
    wabaId,
    phoneNumberId,
    businessId,
    passos,
    avisos: avisos.map((a) => a.etapa),
    substituiu: substituindo ? { wabaId: atual.wabaId || null, phoneNumberId: atual.phoneNumberId || null } : null
  }, actorId);

  return { ok: true, tenantId, wabaId, phoneNumberId, passos, avisos };
};
