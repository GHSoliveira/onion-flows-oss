import { createLog, getIo } from './logs.js';

const RECENT_ALERT_TTL_MS = 30000;
const recentAlerts = new Map();

const normalize = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};

const pickMetaError = (error) => {
  if (!error) return {};
  if (error.error && typeof error.error === 'object') return error.error;
  if (error.data?.error && typeof error.data.error === 'object') return error.data.error;
  return error;
};

const translateByCode = ({ code, message, details, operation }) => {
  const source = `${message || ''} ${details || ''}`.toLowerCase();

  if (code === 132000 || source.includes('number of parameters')) {
    return {
      title: 'Erro em template WhatsApp',
      message: 'O template exige uma quantidade de variaveis diferente da enviada. Confira os campos dinamicos do modelo.'
    };
  }

  if (code === 100 && (source.includes('parameter name') || source.includes('missing or empty'))) {
    return {
      title: 'Parametro invalido no WhatsApp',
      message: 'A Meta recusou um parametro vazio ou mal formatado. Confira variaveis, botoes e campos do template.'
    };
  }

  if (source.includes('invalid catalog_id') || source.includes('invalid catalog id')) {
    return {
      title: 'Catalogo nao vinculado ao WhatsApp',
      message: 'O catalogo existe, mas nao esta vinculado a conta WhatsApp Business deste canal. Reconecte o Catalogo Meta antes de enviar produtos.'
    };
  }

  if (source.includes('product not found for product_retailer_id')) {
    return {
      title: 'Produto ainda indisponivel no WhatsApp',
      message: 'O produto existe no Catalogo Meta, mas ainda nao foi indexado para este numero do WhatsApp. Confira o catalogo no WhatsApp Manager e aguarde o processamento da Meta.'
    };
  }

  if (code === 131009 || source.includes('parameter value is not valid')) {
    return {
      title: 'Interactive WhatsApp invalido',
      message: 'A mensagem interativa tem algum campo fora do formato aceito pela Meta. Confira titulos, IDs, botoes e secoes.'
    };
  }

  if (code === 131053 || source.includes('media upload error')) {
    return {
      title: 'Falha ao enviar midia no WhatsApp',
      message: 'A Meta recusou o arquivo de midia. Verifique tamanho, formato e se a URL do arquivo esta publica.'
    };
  }

  if (code === 131026 || source.includes('undeliverable')) {
    return {
      title: 'Mensagem nao entregue no WhatsApp',
      message: 'O WhatsApp nao conseguiu entregar a mensagem ao cliente. O numero pode estar invalido ou indisponivel.'
    };
  }

  if (code === 131047 || source.includes('24 hour') || source.includes('re-engagement')) {
    return {
      title: 'Janela de atendimento encerrada',
      message: 'A janela de 24 horas do WhatsApp fechou. Use um template aprovado para retomar o contato.'
    };
  }

  if (code === 190 || source.includes('access token')) {
    return {
      title: 'Token WhatsApp invalido',
      message: 'O access token da Meta parece invalido, expirado ou sem permissao. Confira o canal WhatsApp.'
    };
  }

  if ([10, 200, 368].includes(code) || source.includes('permission')) {
    return {
      title: 'Permissao WhatsApp recusada',
      message: 'A Meta recusou a operacao por permissao, politica ou bloqueio temporario. Confira o app e o numero no painel Meta.'
    };
  }

  if (operation === 'webhook_signature') {
    return {
      title: 'Webhook WhatsApp com assinatura invalida',
      message: 'O webhook recebeu uma assinatura invalida. Confira o App Secret salvo no canal WhatsApp.'
    };
  }

  if (operation === 'webhook_missing_signature') {
    return {
      title: 'Webhook WhatsApp sem assinatura',
      message: 'O webhook recebeu uma chamada sem assinatura da Meta. Confira a configuracao do webhook e seguranca.'
    };
  }

  if (operation === 'status_failed') {
    return {
      title: 'Envio WhatsApp falhou',
      message: details || message || 'A Meta retornou status failed para uma mensagem enviada.'
    };
  }

  return {
    title: 'Problema no WhatsApp',
    message: details || message || 'O WhatsApp retornou um erro. Confira os logs para mais detalhes.'
  };
};

const buildDedupKey = (alert) => [
  alert.tenantId || 'global',
  alert.operation || 'unknown',
  alert.code || 'no-code',
  alert.templateId || alert.templateName || '',
  alert.to || alert.recipientId || ''
].join('|');

const shouldSkipRecent = (alert) => {
  const now = Date.now();
  Array.from(recentAlerts.entries()).forEach(([key, timestamp]) => {
    if ((now - timestamp) > RECENT_ALERT_TTL_MS) {
      recentAlerts.delete(key);
    }
  });

  const key = buildDedupKey(alert);
  const last = recentAlerts.get(key);
  if (last && (now - last) < RECENT_ALERT_TTL_MS) return true;
  recentAlerts.set(key, now);
  return false;
};

export const buildWhatsAppAlert = ({
  operation = 'unknown',
  tenantId = null,
  status = null,
  data = null,
  error = null,
  context = {}
} = {}) => {
  const metaError = pickMetaError(data || error || {});
  const code = Number(metaError?.code || error?.code || 0) || null;
  const message = normalize(metaError?.message || error?.message || data?.message);
  const details = normalize(metaError?.error_data?.details || error?.details || data?.details);
  const translated = translateByCode({ code, message, details, operation });

  return {
    id: `wa_alert_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    type: 'WHATSAPP_ERROR',
    severity: code === 131026 ? 'warning' : 'error',
    channel: 'whatsapp',
    operation,
    tenantId: normalize(tenantId || context?.tenantId),
    title: translated.title,
    message: translated.message,
    status: status || null,
    code,
    rawMessage: message,
    details,
    fbtraceId: normalize(metaError?.fbtrace_id || error?.fbtraceId),
    templateId: normalize(context?.templateId),
    templateName: normalize(context?.templateName),
    flowId: normalize(context?.flowId),
    nodeId: normalize(context?.nodeId),
    to: normalize(context?.to),
    recipientId: normalize(context?.recipientId),
    phoneNumberId: normalize(context?.phoneNumberId),
    parameterSummary: context?.parameterSummary || null,
    createdAt: new Date().toISOString()
  };
};

export const notifyWhatsAppProblem = async (input = {}) => {
  const alert = buildWhatsAppAlert(input);
  if (shouldSkipRecent(alert)) return alert;

  try {
    await createLog('WHATSAPP_ERROR', alert, 'system');
  } catch (_) {}

  try {
    const io = getIo();
    if (io) {
      if (alert.tenantId) {
        io.to(`tenant:${alert.tenantId}`).emit('whatsapp_error', alert);
      }
      io.to('role:SUPER_ADMIN').emit('whatsapp_error', alert);
    }
  } catch (_) {}

  return alert;
};
