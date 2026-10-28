import adapter from '../../db/DatabaseAdapter.js';
import { findWhatsAppConfigsByWabaId } from './channelConfig.js';
import { createLog, getIo } from './logs.js';
import { generateId } from '../utils/helpers.js';
import { reRegisterAfterNameApproval } from './whatsappProfileIdentity.js';
import { enforceOutreachQuality, qualitySignalFromAlert } from './outreachQualityGuard.js';

/**
 * Alertas da conta WhatsApp de cada tenant: qualidade e limite do numero, nome
 * de exibicao, templates, revisao e restricoes da conta.
 *
 * Duas fontes geram o mesmo alerta:
 *   - webhook de conta da Meta (tempo real; exige os campos assinados no app);
 *   - comparacao entre dois retratos da conta no sync periodico, que funciona
 *     sem esses campos e cobre webhook perdido.
 * As duas montam a mesma dedupKey, entao o mesmo acontecimento vira um alerta so.
 */

export const ACCOUNT_ALERTS_COLLECTION = 'whatsappAccountAlerts';

// Janela em que a mesma dedupKey nao gera alerta de novo: cobre reentrega do
// webhook e o sync que chega depois dele, sem esconder uma recaida semanas depois.
const DEDUP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export const ACCOUNT_WEBHOOK_FIELDS = new Set([
  'account_alerts',
  'account_review_update',
  'account_update',
  'message_template_quality_update',
  'message_template_status_update',
  'phone_number_name_update',
  'phone_number_quality_update',
  'template_category_update'
]);

const texto = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};
const maiusculo = (value) => texto(value)?.toUpperCase() || null;
const digitos = (value) => String(value || '').replace(/\D/g, '') || null;

const dataCurta = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};

/* ---------------------------- vocabulario ---------------------------- */

export const TIER_ORDER = ['TIER_NOT_SET', 'TIER_50', 'TIER_250', 'TIER_1K', 'TIER_2K', 'TIER_10K', 'TIER_100K', 'TIER_UNLIMITED'];

const TIER_LABELS = {
  TIER_NOT_SET: 'ainda não definido',
  TIER_50: '50 clientes por dia',
  TIER_250: '250 clientes por dia',
  TIER_1K: '1.000 clientes por dia',
  TIER_2K: '2.000 clientes por dia',
  TIER_10K: '10.000 clientes por dia',
  TIER_100K: '100.000 clientes por dia',
  TIER_UNLIMITED: 'sem limite diário'
};

export const describeTier = (tier) => TIER_LABELS[maiusculo(tier)] || texto(tier) || 'não informado';

const QUALITY_LABELS = { GREEN: 'alta', YELLOW: 'média', RED: 'baixa', UNKNOWN: 'em avaliação' };

const TEMPLATE_REASON_LABELS = {
  ABUSIVE_CONTENT: 'conteúdo abusivo',
  CATEGORY_NOT_AVAILABLE: 'categoria indisponível',
  INCORRECT_CATEGORY: 'categoria incorreta',
  INVALID_FORMAT: 'formato inválido',
  PROMOTIONAL: 'conteúdo promocional',
  SCAM: 'suspeita de golpe',
  TAG_CONTENT_MISMATCH: 'conteúdo não corresponde à categoria'
};

const NAME_REJECTION_LABELS = {
  NAME_EMPLOYEE_ISSUE: 'o nome inclui um funcionário ou pessoa',
  NAME_ENDCLIENT_NOTRELATED: 'o nome não tem relação com a empresa',
  NAME_FORMAT_UNACCEPTABLE: 'o formato do nome não é aceito',
  NAME_INDIVIDUAL_ISSUE: 'o nome inclui uma pessoa',
  NAME_NOT_CONSISTENT: 'o nome não bate com a marca da empresa'
};

const RESTRICTION_LABELS = {
  RESTRICTED_ADD_PHONE_NUMBER_ACTION: 'adicionar números',
  RESTRICTED_BIZ_INITIATED_MESSAGING: 'iniciar conversas com clientes',
  RESTRICTED_CUSTOMER_INITIATED_MESSAGING: 'responder clientes',
  RESTRICTED_DIRECT_SEND_UTILITY_TEMPLATES: 'enviar templates de utilidade',
  RESTRICTED_UTILITY_TEMPLATES: 'enviar templates de utilidade',
  RESTRICTED_BIZ_INITIATED_AND_USER_INITIATED_CALLING: 'chamadas de voz',
  RESTRICTED_BUSINESS_INITIATED_CALLING: 'chamadas de voz',
  RESTRICTED_USER_INITIATED_CALLING: 'chamadas de voz',
  RESTRICTED_USER_INITIATED_CALLING_CALL_BUTTON_HIDDEN: 'chamadas de voz'
};

/* ------------------------- construtores comuns ------------------------ */
// Usados pelo webhook e pela comparacao de retratos: a dedupKey precisa sair
// igual dos dois lados.

const TEMPLATE_STATUS_RULES = {
  APPROVED: { severity: 'success', title: 'Template aprovado', body: (n) => `O template "${n}" foi aprovado e já pode ser usado.` },
  REJECTED: { severity: 'warning', title: 'Template recusado', body: (n) => `A Meta recusou o template "${n}".` },
  PAUSED: { severity: 'warning', title: 'Template pausado', body: (n) => `O template "${n}" foi pausado por baixa qualidade. Envios com ele falham até a pausa terminar.` },
  DISABLED: { severity: 'critical', title: 'Template desativado', body: (n) => `O template "${n}" foi desativado e não pode mais ser enviado.` },
  FLAGGED: { severity: 'warning', title: 'Template sinalizado', body: (n) => `O template "${n}" recebeu avaliações negativas dos clientes. Se continuar assim, ele pode ser pausado.` },
  LIMIT_EXCEEDED: { severity: 'warning', title: 'Limite de templates atingido', body: (n) => `A conta atingiu o limite de templates ao criar "${n}".` },
  REINSTATED: { severity: 'success', title: 'Template reativado', body: (n) => `O template "${n}" voltou a poder ser enviado.` },
  IN_APPEAL: { severity: 'info', title: 'Recurso de template em análise', body: (n) => `A Meta está analisando o recurso do template "${n}".` },
  PENDING_DELETION: { severity: 'info', title: 'Template será excluído', body: (n) => `O template "${n}" está agendado para exclusão.` },
  DELETED: { severity: 'info', title: 'Template excluído', body: (n) => `O template "${n}" foi excluído.` },
  LOCKED: { severity: 'info', title: 'Template bloqueado para edição', body: (n) => `O template "${n}" não pode ser editado no momento.` }
};

export const buildTemplateStatusAlert = ({ id, name, language, status, reason = null, detail = null, recommendation = null }) => {
  const normalized = maiusculo(status);
  const rule = TEMPLATE_STATUS_RULES[normalized];
  if (!rule || !texto(id)) return null;

  const nome = texto(name) || String(id);
  const partes = [rule.body(nome)];
  const motivo = TEMPLATE_REASON_LABELS[maiusculo(reason)];
  if (motivo) partes.push(`Motivo: ${motivo}.`);
  if (texto(detail)) partes.push(texto(detail));
  if (texto(recommendation)) partes.push(`Sugestão da Meta: ${texto(recommendation)}`);

  return {
    kind: 'template_status',
    severity: rule.severity,
    title: rule.title,
    message: partes.join(' '),
    entity: { type: 'template', id: String(id), name: texto(name), language: texto(language) },
    dedupKey: `template:${id}:status:${normalized}`
  };
};

export const buildTemplateQualityAlert = ({ id, name, language, previous, next }) => {
  const anterior = maiusculo(previous);
  const atual = maiusculo(next);
  if (!texto(id) || !atual || atual === 'UNKNOWN' || atual === anterior) return null;
  // Voltar para verde so e noticia quando estava ruim.
  if (atual === 'GREEN' && !['YELLOW', 'RED'].includes(anterior)) return null;

  const nome = texto(name) || String(id);
  const regras = {
    RED: ['critical', 'Template com qualidade baixa', `O template "${nome}" está com qualidade baixa. Ele pode ser pausado se nada mudar.`],
    YELLOW: ['warning', 'Template com qualidade média', `A qualidade do template "${nome}" caiu para média. Vale revisar o texto e para quem ele está sendo enviado.`],
    GREEN: ['success', 'Qualidade do template recuperada', `O template "${nome}" voltou a ter qualidade alta.`]
  };
  const regra = regras[atual];
  if (!regra) return null;

  return {
    kind: 'template_quality',
    severity: regra[0],
    title: regra[1],
    message: regra[2],
    entity: { type: 'template', id: String(id), name: texto(name), language: texto(language) },
    dedupKey: `template:${id}:quality:${atual}`
  };
};

export const buildTemplateCategoryAlert = ({ id, name, language, previous = null, next = null, upcoming = null, when = null }) => {
  if (!texto(id)) return null;
  const nome = texto(name) || String(id);
  const futura = maiusculo(upcoming);
  if (futura) {
    const data = dataCurta(when);
    return {
      kind: 'template_category',
      severity: 'warning',
      title: 'Categoria do template vai mudar',
      message: `A Meta vai mudar a categoria do template "${nome}" para ${futura}${data ? ` em ${data}` : ''}. Isso pode mudar o custo de cada envio.`,
      entity: { type: 'template', id: String(id), name: texto(name), language: texto(language) },
      dedupKey: `template:${id}:category:${futura}:agendada`
    };
  }
  const nova = maiusculo(next);
  if (!nova || nova === maiusculo(previous)) return null;
  return {
    kind: 'template_category',
    severity: 'warning',
    title: 'Categoria do template alterada',
    message: `A Meta mudou a categoria do template "${nome}"${previous ? ` de ${maiusculo(previous)}` : ''} para ${nova}. Isso pode mudar o custo de cada envio.`,
    entity: { type: 'template', id: String(id), name: texto(name), language: texto(language) },
    dedupKey: `template:${id}:category:${nova}`
  };
};

export const buildNameAlert = ({ phone, decision, requestedName = null, reason = null }) => {
  const numero = digitos(phone);
  const decisao = maiusculo(decision);
  if (!numero || !decisao) return null;
  const nome = texto(requestedName);
  const chave = `phone:${numero}:name:${decisao}:${(nome || '').toLowerCase()}`;
  const entity = { type: 'phone', id: numero, name: nome };

  if (decisao === 'APPROVED') {
    return { kind: 'display_name', severity: 'success', title: 'Nome de exibição aprovado', message: `${nome ? `"${nome}" foi aprovado` : 'O nome de exibição foi aprovado'} e já aparece no perfil do WhatsApp. O limite de envio pode subir a partir de agora.`, entity, dedupKey: chave };
  }
  if (decisao === 'REJECTED' || decisao === 'DECLINED') {
    const motivo = NAME_REJECTION_LABELS[maiusculo(reason)];
    return { kind: 'display_name', severity: 'critical', title: 'Nome de exibição recusado', message: `A Meta recusou ${nome ? `o nome "${nome}"` : 'o nome de exibição'}${motivo ? `: ${motivo}` : ''}. Enquanto isso o número segue com limite de envio reduzido.`, entity, dedupKey: `phone:${numero}:name:REJECTED:${(nome || '').toLowerCase()}` };
  }
  if (decisao === 'PENDING' || decisao === 'DEFERRED') {
    return { kind: 'display_name', severity: 'info', title: 'Nome de exibição em análise', message: `${nome ? `"${nome}"` : 'O nome de exibição'} ainda está em análise pela Meta.`, entity, dedupKey: chave };
  }
  return null;
};

export const buildReviewAlert = ({ wabaId, decision }) => {
  const decisao = maiusculo(decision);
  if (!texto(wabaId) || !decisao) return null;
  const regras = {
    APPROVED: ['success', 'Conta do WhatsApp aprovada', 'A Meta aprovou a conta do WhatsApp Business. Ela já pode ser usada normalmente.'],
    REJECTED: ['critical', 'Conta do WhatsApp recusada', 'A Meta recusou a conta do WhatsApp Business por não cumprir as políticas. Ela não pode ser usada até isso ser resolvido.'],
    PENDING: ['warning', 'Conta do WhatsApp em revisão', 'A conta do WhatsApp Business está em revisão pela Meta e pode não enviar mensagens até a decisão.'],
    DEFERRED: ['warning', 'Revisão da conta adiada', 'A Meta adiou a revisão da conta do WhatsApp Business. Ela pode não enviar mensagens até a decisão.']
  };
  const regra = regras[decisao];
  if (!regra) return null;
  return { kind: 'account_review', severity: regra[0], title: regra[1], message: regra[2], entity: { type: 'waba', id: String(wabaId) }, dedupKey: `waba:${wabaId}:review:${decisao}` };
};

export const buildPhoneQualityAlert = ({ phone, previous, next }) => {
  const numero = digitos(phone);
  const anterior = maiusculo(previous);
  const atual = maiusculo(next);
  if (!numero || !atual || atual === anterior || atual === 'UNKNOWN') return null;
  if (atual === 'GREEN' && !['YELLOW', 'RED'].includes(anterior)) return null;
  const regras = {
    RED: ['critical', 'Qualidade do número baixa', 'Muitos clientes bloquearam ou denunciaram as mensagens. Se continuar, o limite de envio pode cair.'],
    YELLOW: ['warning', 'Qualidade do número caiu', 'A qualidade do número caiu para média. Revise o conteúdo e a frequência dos envios.'],
    GREEN: ['success', 'Qualidade do número recuperada', 'A qualidade do número voltou a ser alta.']
  };
  const regra = regras[atual];
  return { kind: 'phone_quality', severity: regra[0], title: regra[1], message: `${regra[2]} Qualidade atual: ${QUALITY_LABELS[atual]}.`, entity: { type: 'phone', id: numero }, dedupKey: `phone:${numero}:quality:${atual}` };
};

export const buildTierAlert = ({ phone, previous, next }) => {
  const numero = digitos(phone);
  const anterior = maiusculo(previous);
  const atual = maiusculo(next);
  if (!numero || !atual || atual === anterior) return null;
  const antes = TIER_ORDER.indexOf(anterior);
  const depois = TIER_ORDER.indexOf(atual);
  if (antes < 0 || depois < 0 || atual === 'TIER_NOT_SET') return null;
  const subiu = depois > antes;
  return {
    kind: 'phone_limit',
    severity: subiu ? 'success' : 'critical',
    title: subiu ? 'Limite de envio aumentou' : 'Limite de envio reduzido',
    message: `O número agora pode iniciar conversa com ${describeTier(atual)} (antes: ${describeTier(anterior)}).`,
    entity: { type: 'phone', id: numero },
    dedupKey: `phone:${numero}:tier:${atual}`
  };
};

const CAN_SEND_ORDER = { AVAILABLE: 0, LIMITED: 1, BLOCKED: 2 };

export const buildHealthAlert = ({ entityType, entityId, previous, next, issues = [] }) => {
  const anterior = maiusculo(previous);
  const atual = maiusculo(next);
  if (!texto(entityId) || !atual || atual === anterior || !(atual in CAN_SEND_ORDER)) return null;
  const alvo = entityType === 'phone' ? 'O número' : 'A conta';
  const principal = issues.find((issue) => issue.area !== 'calling')?.description || null;

  if (atual === 'AVAILABLE') {
    if (!(anterior in CAN_SEND_ORDER)) return null;
    return { kind: 'send_health', severity: 'success', title: 'Envio de mensagens normalizado', message: `${alvo} voltou a enviar mensagens sem restrição.`, entity: { type: entityType, id: String(entityId) }, dedupKey: `health:${entityType}:${entityId}:AVAILABLE` };
  }
  const bloqueado = atual === 'BLOCKED';
  return {
    kind: 'send_health',
    severity: bloqueado ? 'critical' : 'warning',
    title: bloqueado ? 'Envio de mensagens bloqueado' : 'Envio de mensagens limitado',
    message: `${alvo} está com envio ${bloqueado ? 'bloqueado' : 'limitado'} pela Meta.${principal ? ` Motivo informado: ${principal}` : ''}`,
    entity: { type: entityType, id: String(entityId) },
    dedupKey: `health:${entityType}:${entityId}:${atual}`
  };
};

// Resultado do novo registro depois que a Meta aprova o nome de exibicao.
export const buildReRegisterAlert = ({ phone, registered, reason = null, error = null }) => {
  const numero = digitos(phone);
  if (!numero) return null;
  const entity = { type: 'phone', id: numero };
  if (registered) {
    return { kind: 'display_name', severity: 'success', title: 'Número registrado com o novo nome', message: 'A Onion registrou o número de novo depois da aprovação, e o nome aprovado já está valendo.', entity, dedupKey: `phone:${numero}:reregister:ok` };
  }
  if (reason === 'missing_pin') {
    return { kind: 'display_name', severity: 'warning', title: 'Registre o número para ativar o novo nome', message: 'A Meta aprovou o nome, mas a Onion não tem o PIN deste número. Registre o número na Central do WhatsApp, aba Conexão, em até 14 dias; depois disso o nome volta para análise.', entity, dedupKey: `phone:${numero}:reregister:missing_pin` };
  }
  return { kind: 'display_name', severity: 'critical', title: 'Falha ao registrar o número com o novo nome', message: `A Meta aprovou o nome, mas o registro automático falhou${error ? ` (${error})` : ''}. Registre o número na Central do WhatsApp, aba Conexão, em até 14 dias.`, entity, dedupKey: `phone:${numero}:reregister:failed` };
};

/* ------------------------------ webhook ------------------------------ */

export const parseAccountChanges = (payload) => {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  return entries.flatMap((entry) => (Array.isArray(entry?.changes) ? entry.changes : [])
    .filter((change) => ACCOUNT_WEBHOOK_FIELDS.has(change?.field))
    .map((change) => ({ wabaId: texto(entry.id), field: change.field, value: change.value || {} })));
};

const translateAccountUpdate = (wabaId, value) => {
  const evento = maiusculo(value.event);
  const entity = { type: 'waba', id: String(wabaId) };

  if (evento === 'ACCOUNT_VIOLATION') {
    const tipo = texto(value.violation_info?.violation_type);
    return { kind: 'account_policy', severity: 'critical', title: 'Violação de política na conta', message: `A Meta registrou uma violação de política na conta do WhatsApp${tipo ? ` (${tipo})` : ''}. Novas violações podem restringir o envio.`, entity, dedupKey: `waba:${wabaId}:violation:${tipo || ''}` };
  }
  if (evento === 'ACCOUNT_RESTRICTION') {
    const restricoes = Array.isArray(value.restriction_info) ? value.restriction_info : [];
    const acoes = [...new Set(restricoes.map((r) => RESTRICTION_LABELS[maiusculo(r.restriction_type)] || texto(r.restriction_type)).filter(Boolean))];
    const ate = restricoes.map((r) => dataCurta(r.expiration)).find(Boolean);
    const remediacao = restricoes.map((r) => texto(r.remediation)).find(Boolean);
    const chave = restricoes.map((r) => `${maiusculo(r.restriction_type)}@${r.expiration || ''}`).sort().join(',');
    return {
      kind: 'account_restriction',
      severity: 'critical',
      title: 'Conta com restrição',
      message: `A Meta restringiu a conta${acoes.length ? `: não é possível ${acoes.join(', ')}` : ''}${ate ? ` até ${ate}` : ''}.${remediacao ? ` ${remediacao}` : ''}`,
      entity,
      dedupKey: `waba:${wabaId}:restriction:${chave}`
    };
  }
  if (evento === 'DISABLED_UPDATE') {
    const estado = maiusculo(value.ban_info?.waba_ban_state);
    const data = dataCurta(value.ban_info?.waba_ban_date);
    const regras = {
      DISABLE: ['critical', 'Conta desativada pela Meta', 'A conta do WhatsApp foi desativada e não envia nem recebe mensagens.'],
      SCHEDULE_FOR_DISABLE: ['critical', 'Conta será desativada', `A Meta agendou a desativação da conta${data ? ` para ${data}` : ''}. Resolva as pendências no Gerenciador do WhatsApp antes disso.`],
      REINSTATE: ['success', 'Conta reativada', 'A conta do WhatsApp foi reativada pela Meta.']
    };
    const regra = regras[estado];
    if (!regra) return null;
    return { kind: 'account_ban', severity: regra[0], title: regra[1], message: regra[2], entity, dedupKey: `waba:${wabaId}:ban:${estado}:${value.ban_info?.waba_ban_date || ''}` };
  }
  if (evento === 'PARTNER_REMOVED' || evento === 'PARTNER_APP_UNINSTALLED' || evento === 'ACCOUNT_OFFBOARDED' || evento === 'ACCOUNT_DELETED') {
    return { kind: 'account_access', severity: 'critical', title: 'Conta desconectada da Onion', message: 'A Onion perdeu o acesso a esta conta do WhatsApp. Mensagens deixam de chegar até a conta ser conectada de novo.', entity, dedupKey: `waba:${wabaId}:access:${evento}` };
  }
  if (evento === 'ACCOUNT_RECONNECTED') {
    return { kind: 'account_access', severity: 'success', title: 'Conta reconectada', message: 'A conta do WhatsApp voltou a estar conectada.', entity, dedupKey: `waba:${wabaId}:access:${evento}` };
  }
  // PARTNER_ADDED, precos, termos, localizacao: sem acao para o cliente.
  return null;
};

const ACCOUNT_ALERT_TYPES = {
  OBA_APPROVED: ['success', 'Selo de conta oficial aprovado'],
  OBA_REJECTED: ['warning', 'Selo de conta oficial recusado'],
  PROFILE_PICTURE_LOST: ['warning', 'Foto de perfil removida'],
  INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED: ['warning', 'Aumento de limite adiado'],
  INCREASED_CAPABILITIES_ELIGIBILITY_FAILED: ['warning', 'Aumento de limite negado'],
  INCREASED_CAPABILITIES_ELIGIBILITY_NEED_MORE_INFO: ['warning', 'Meta pediu mais informações']
};

export const translateAccountChange = ({ wabaId, field, value = {} }) => {
  if (!texto(wabaId)) return null;

  switch (field) {
    case 'account_review_update':
      return buildReviewAlert({ wabaId, decision: value.decision });

    case 'account_update':
      return translateAccountUpdate(wabaId, value);

    case 'account_alerts': {
      const info = value.alert_info || {};
      if (maiusculo(info.alert_status) !== 'ACTIVE') return null;
      const tipo = maiusculo(info.alert_type);
      const severidade = { CRITICAL: 'critical', WARNING: 'warning', INFORMATIONAL: 'info' }[maiusculo(info.alert_severity)] || 'info';
      const [regraSeveridade, titulo] = ACCOUNT_ALERT_TYPES[tipo] || [severidade, 'Aviso da Meta sobre a conta'];
      return {
        kind: 'meta_alert',
        severity: regraSeveridade,
        title: titulo,
        // A descricao vem da Meta, em ingles; melhor mostrar do que inventar.
        message: texto(info.alert_description) || 'A Meta enviou um aviso sobre esta conta.',
        entity: { type: String(value.entity_type || 'business').toLowerCase(), id: texto(value.entity_id) || String(wabaId) },
        dedupKey: `meta-alert:${value.entity_id || wabaId}:${tipo || ''}`
      };
    }

    case 'phone_number_quality_update': {
      const numero = digitos(value.display_phone_number);
      const evento = maiusculo(value.event);
      const limite = maiusculo(value.max_daily_conversations_per_business || value.current_limit);
      if (!numero || !evento) return null;
      const entity = { type: 'phone', id: numero };
      if (evento === 'FLAGGED') {
        return { kind: 'phone_quality', severity: 'warning', title: 'Qualidade do número caiu', message: 'A Meta sinalizou queda de qualidade no número. Se continuar, o limite de envio pode cair.', entity, dedupKey: `phone:${numero}:quality:FLAGGED` };
      }
      if (evento === 'UNFLAGGED') {
        return { kind: 'phone_quality', severity: 'success', title: 'Qualidade do número recuperada', message: 'A Meta removeu o alerta de qualidade do número.', entity, dedupKey: `phone:${numero}:quality:GREEN` };
      }
      if (evento === 'DOWNGRADE' || evento === 'UPGRADE' || evento === 'THROUGHPUT_UPGRADE') {
        if (!limite) return null;
        const subiu = evento !== 'DOWNGRADE';
        const anterior = maiusculo(value.old_limit);
        return {
          kind: 'phone_limit',
          severity: subiu ? 'success' : 'critical',
          title: subiu ? 'Limite de envio aumentou' : 'Limite de envio reduzido',
          message: `O número agora pode iniciar conversa com ${describeTier(limite)}${anterior ? ` (antes: ${describeTier(anterior)})` : ''}.`,
          entity,
          dedupKey: `phone:${numero}:tier:${limite}`
        };
      }
      return null;
    }

    case 'phone_number_name_update':
      return buildNameAlert({
        phone: value.display_phone_number,
        decision: value.decision,
        requestedName: value.requested_verified_name,
        reason: value.rejection_reason
      });

    case 'message_template_status_update':
      return buildTemplateStatusAlert({
        id: value.message_template_id,
        name: value.message_template_name,
        language: value.message_template_language,
        status: value.event,
        reason: value.reason,
        detail: value.rejection_info?.reason || value.other_info?.description || null,
        recommendation: value.rejection_info?.recommendation || null
      });

    case 'message_template_quality_update':
      return buildTemplateQualityAlert({
        id: value.message_template_id,
        name: value.message_template_name,
        language: value.message_template_language,
        previous: value.previous_quality_score,
        next: value.new_quality_score
      });

    case 'template_category_update':
      return buildTemplateCategoryAlert({
        id: value.message_template_id,
        name: value.message_template_name,
        language: value.message_template_language,
        previous: value.previous_category,
        next: value.new_category,
        upcoming: value.correct_category && value.category_update_timestamp ? value.correct_category : null,
        when: value.category_update_timestamp
      });

    default:
      return null;
  }
};

/* ----------------------- comparacao de retratos ----------------------- */

const phoneOf = (insights) => insights?.phone?.displayPhoneNumber || insights?.phone?.id || null;

export const diffInsightsToAlerts = (previous, next, { wabaId = null } = {}) => {
  if (!previous || !next) return [];
  const alerts = [];
  const push = (alert) => { if (alert) alerts.push(alert); };

  const antes = previous.phone;
  const depois = next.phone;
  if (antes && depois) {
    const phone = phoneOf(next);
    push(buildPhoneQualityAlert({ phone, previous: antes.qualityRating, next: depois.qualityRating }));
    push(buildTierAlert({ phone, previous: antes.messagingLimitTier, next: depois.messagingLimitTier }));
    push(buildHealthAlert({ entityType: 'phone', entityId: digitos(phone), previous: antes.canSendMessage, next: depois.canSendMessage, issues: depois.healthIssues }));

    // Nome: o recurso sai de "em analise" para aprovado ou recusado.
    const pendenteAntes = maiusculo(antes.newNameStatus) === 'PENDING_REVIEW' || maiusculo(antes.nameStatus) === 'PENDING_REVIEW';
    const statusDepois = maiusculo(depois.newNameStatus) || maiusculo(depois.nameStatus);
    if (pendenteAntes && statusDepois && statusDepois !== 'PENDING_REVIEW') {
      const decisao = ['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(statusDepois) || maiusculo(depois.nameStatus) === 'APPROVED'
        ? 'APPROVED'
        : statusDepois === 'DECLINED' ? 'REJECTED' : null;
      if (decisao) push(buildNameAlert({ phone, decision: decisao, requestedName: depois.verifiedName }));
    }
  }

  if (previous.account && next.account && wabaId) {
    if (maiusculo(previous.account.accountReviewStatus) !== maiusculo(next.account.accountReviewStatus)) {
      push(buildReviewAlert({ wabaId, decision: next.account.accountReviewStatus }));
    }
    push(buildHealthAlert({ entityType: 'waba', entityId: wabaId, previous: previous.account.canSendMessage, next: next.account.canSendMessage, issues: next.account.healthIssues }));
  }

  if (previous.templates?.items && next.templates?.items) {
    const anteriores = new Map(previous.templates.items.map((t) => [t.id, t]));
    for (const atual of next.templates.items) {
      const anterior = anteriores.get(atual.id);
      if (!anterior) {
        // Template novo desde o ultimo retrato: so vira alerta se ja nasceu com decisao.
        if (atual.status !== 'PENDING') {
          push(buildTemplateStatusAlert({ id: atual.id, name: atual.name, language: atual.language, status: atual.status, reason: atual.rejectedReason }));
        }
        continue;
      }
      if (anterior.status !== atual.status) {
        push(buildTemplateStatusAlert({ id: atual.id, name: atual.name, language: atual.language, status: atual.status, reason: atual.rejectedReason }));
      }
      push(buildTemplateQualityAlert({ id: atual.id, name: atual.name, language: atual.language, previous: anterior.quality, next: atual.quality }));
      if (anterior.category && atual.category && anterior.category !== atual.category) {
        push(buildTemplateCategoryAlert({ id: atual.id, name: atual.name, language: atual.language, previous: anterior.category, next: atual.category }));
      }
    }
  }

  return alerts;
};

/* ------------------------------ gravacao ------------------------------ */

export const recordAccountAlert = async (tenantId, alert, { source = 'sync', now = new Date() } = {}) => {
  if (!tenantId || !alert?.dedupKey) return null;

  const [recente] = await adapter.findMany(ACCOUNT_ALERTS_COLLECTION, {
    query: { tenantId, dedupKey: alert.dedupKey },
    sort: { createdAt: -1 },
    limit: 1
  });
  if (recente && (now.getTime() - Date.parse(recente.createdAt)) < DEDUP_WINDOW_MS) return null;

  const doc = {
    id: generateId('wa_account_alert'),
    tenantId,
    kind: alert.kind,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    entity: alert.entity || null,
    dedupKey: alert.dedupKey,
    source,
    createdAt: now.toISOString(),
    readAt: null
  };
  await adapter.insertOne(ACCOUNT_ALERTS_COLLECTION, doc);

  try {
    await createLog('WHATSAPP_ACCOUNT_ALERT', { tenantId, kind: doc.kind, severity: doc.severity, title: doc.title, source }, 'system');
  } catch (_) {}
  try {
    getIo()?.to(`tenant:${tenantId}`).emit('whatsapp_account_alert', doc);
  } catch (_) {}

  return doc;
};

export const recordAccountAlerts = async (tenantId, alerts = [], options = {}) => {
  const gravados = [];
  for (const alert of alerts) {
    const doc = await recordAccountAlert(tenantId, alert, options);
    if (doc) gravados.push(doc);
  }
  return gravados;
};

// Chamado no inicio de cada webhook do WhatsApp. Eventos de conta nao trazem
// phone_number_id: o tenant sai do id da WABA que vem no entry.
export const handleWhatsAppAccountWebhook = async (payload) => {
  const changes = parseAccountChanges(payload);
  let recorded = 0;
  for (const change of changes) {
    const alert = translateAccountChange(change);
    if (!alert) continue;
    const configs = await findWhatsAppConfigsByWabaId(change.wabaId);
    if (!configs.length) {
      console.warn('[WHATSAPP_ACCOUNT_ALERT] WABA sem tenant vinculado', { wabaId: change.wabaId, field: change.field });
      continue;
    }
    const signal = qualitySignalFromAlert(alert);
    for (const config of configs) {
      if (await recordAccountAlert(config.tenantId, alert, { source: 'webhook' })) recorded += 1;
      // Mesmo alerta repetido (dedup) ainda pausa campanha que foi retomada sem ciencia dele.
      if (signal) {
        await enforceOutreachQuality(config.tenantId, [signal], { source: 'webhook' }).catch((error) => {
          console.warn('[OUTREACH_QUALITY] Falha ao pausar campanhas pelo webhook', { tenantId: config.tenantId, error: error?.message || error });
        });
      }
    }

    // Nome aprovado so passa a valer depois de registrar o numero de novo.
    if (change.field === 'phone_number_name_update' && String(change.value?.decision || '').toUpperCase() === 'APPROVED') {
      const resultados = await reRegisterAfterNameApproval({
        wabaId: change.wabaId,
        displayPhoneNumber: change.value?.display_phone_number
      }).catch((error) => {
        console.warn('[WHATSAPP_ACCOUNT_ALERT] Falha ao registrar numero apos aprovacao do nome', error?.message || error);
        return [];
      });
      for (const resultado of resultados) {
        const aviso = buildReRegisterAlert({ phone: change.value?.display_phone_number, ...resultado });
        if (aviso && await recordAccountAlert(resultado.tenantId, aviso, { source: 'webhook' })) recorded += 1;
      }
    }
  }
  return { changes: changes.length, recorded };
};

export const listAccountAlerts = async (tenantId, { limit = 50 } = {}) => {
  if (!tenantId) return { alerts: [], unread: 0 };
  const [alerts, unread] = await Promise.all([
    adapter.findMany(ACCOUNT_ALERTS_COLLECTION, {
      query: { tenantId },
      sort: { createdAt: -1 },
      limit: Math.min(Math.max(Number(limit) || 50, 1), 200)
    }),
    adapter.countDocuments(ACCOUNT_ALERTS_COLLECTION, { tenantId, readAt: null })
  ]);
  return { alerts, unread };
};

export const markAccountAlertsRead = async (tenantId, { ids = null, now = new Date() } = {}) => {
  if (!tenantId) return 0;
  const alvo = Array.isArray(ids) ? new Set(ids.map(String)) : null;
  const pendentes = await adapter.findDocuments(ACCOUNT_ALERTS_COLLECTION, { tenantId, readAt: null });
  let marcados = 0;
  for (const alert of pendentes) {
    if (alvo && !alvo.has(String(alert.id))) continue;
    await adapter.saveDocument(ACCOUNT_ALERTS_COLLECTION, { ...alert, readAt: now.toISOString() });
    marcados += 1;
  }
  return marcados;
};
