import adapter from '../../db/DatabaseAdapter.js';
import { hydrateChatsWithMessages } from './chatMessages.js';

const REPORT_ROLES = ['ADMIN', 'MANAGER', 'SUPER_ADMIN'];

const parseDate = (value, endOfDay = false) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    date.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }
  return date;
};

const toIso = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

const minutesBetween = (start, end) => {
  const startDate = new Date(start || 0);
  const endDate = new Date(end || 0);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
};

const average = (values = []) => {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (!numeric.length) return '';
  return Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 100) / 100;
};

const percent = (value, total) => {
  if (!total) return 0;
  return Math.round((value / total) * 10000) / 100;
};

const safeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const parseLogMessage = (message) => {
  if (!message) return {};
  if (typeof message === 'object') return message;
  try {
    return JSON.parse(message);
  } catch {
    return { message: String(message) };
  }
};

const getMessageAt = (message) => toIso(message?.timestamp || message?.createdAt || message?.sentAt);

const isInRange = (value, from, to) => {
  if (!from && !to) return true;
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
};

const chatHasDateInRange = (chat, from, to) => {
  if (!from && !to) return true;
  const candidates = [chat.createdAt, chat.updatedAt, chat.closedAt, chat.finalizedAt];
  if (candidates.some((date) => isInRange(date, from, to))) return true;
  return (Array.isArray(chat.messages) ? chat.messages : []).some((message) => (
    isInRange(message?.timestamp || message?.createdAt || message?.sentAt, from, to)
  ));
};

const firstMessageBySender = (messages, sender) => (
  messages.find((message) => String(message?.sender || '').toLowerCase() === sender) || null
);

const inferCloseType = (chat) => {
  if (chat?.status !== 'closed') return '';
  if (chat?.closedSilently || chat?.silentClose) return 'silencioso';
  if (chat?.closedByInactivity || chat?.inactivityClosed) return 'inatividade';
  if (chat?.activeOutreach) return 'ativo';
  return chat?.closedBy || 'manual';
};

const normalizeChat = (chat) => {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const firstUser = firstMessageBySender(messages, 'user');
  const firstBot = firstMessageBySender(messages, 'bot');
  const firstAgent = firstMessageBySender(messages, 'agent');
  const customerMessages = messages.filter((message) => message?.sender === 'user');
  const botMessages = messages.filter((message) => message?.sender === 'bot');
  const agentMessages = messages.filter((message) => message?.sender === 'agent');
  const mediaMessages = messages.filter((message) => message?.media);
  const failedMessages = messages.filter((message) => (
    String(message?.deliveryStatus || message?.meta?.deliveryStatus || '').toLowerCase() === 'failed'
      || message?.meta?.deliveryErrors
  ));
  const startedAt = toIso(chat.createdAt || messages[0]?.timestamp);
  const closedAt = toIso(chat.closedAt || chat.finalizedAt);

  return {
    chat,
    messages,
    firstUser,
    firstBot,
    firstAgent,
    startedAt,
    closedAt,
    totalMessages: messages.length,
    customerMessages: customerMessages.length,
    botMessages: botMessages.length,
    agentMessages: agentMessages.length,
    mediaMessages: mediaMessages.length,
    failedMessages: failedMessages.length,
    durationMinutes: closedAt ? minutesBetween(startedAt, closedAt) : minutesBetween(startedAt, chat.updatedAt),
    firstBotResponseMinutes: firstUser && firstBot ? minutesBetween(firstUser.timestamp, firstBot.timestamp) : null,
    firstAgentResponseMinutes: firstUser && firstAgent ? minutesBetween(firstUser.timestamp, firstAgent.timestamp) : null
  };
};

const applyFilters = (chats, filters) => (
  (Array.isArray(chats) ? chats : []).filter((chat) => {
    if (filters.tenantId && String(chat.tenantId || '') !== String(filters.tenantId)) return false;
    if (filters.channel && String(chat.channel || '').toLowerCase() !== filters.channel) return false;
    if (filters.status && String(chat.status || '').toLowerCase() !== filters.status) return false;
    if (filters.queue && String(chat.queue || '').toLowerCase() !== filters.queue) return false;
    if (filters.agentId && String(chat.agentId || '') !== filters.agentId) return false;
    if (filters.flowId && String(chat.flowId || '') !== filters.flowId) return false;
    return chatHasDateInRange(chat, filters.from, filters.to);
  })
);

const getScopedTenantId = (req) => {
  if (req.user?.role === 'SUPER_ADMIN') {
    return req.query.tenantId || req.query.targetTenantId || req.tenantId || null;
  }
  return req.tenantId || req.user?.tenantId || null;
};

export const assertCanExportReports = (req, res) => {
  if (!REPORT_ROLES.includes(req.user?.role)) {
    res.status(403).json({ error: 'Acesso negado' });
    return false;
  }
  return true;
};

export const buildReportFilters = (req) => ({
  tenantId: getScopedTenantId(req),
  from: parseDate(req.query.from, false),
  to: parseDate(req.query.to, true),
  channel: String(req.query.channel || '').trim().toLowerCase(),
  status: String(req.query.status || '').trim().toLowerCase(),
  queue: String(req.query.queue || '').trim().toLowerCase(),
  agentId: String(req.query.agentId || '').trim(),
  flowId: String(req.query.flowId || '').trim()
});

const loadReportCollections = async (filters) => {
  if (!adapter.db) await adapter.init();
  const tenantQuery = filters.tenantId ? { tenantId: filters.tenantId } : {};
  const chatQuery = { ...tenantQuery, isFlowTest: { $ne: true } };
  const [
    tenants,
    chats,
    users,
    flows,
    queues,
    campaigns,
    campaignItems,
    logs,
    whatsappTemplates
  ] = await Promise.all([
    adapter.findMany('tenants', { projection: { _id: 0, id: 1, name: 1 } }),
    adapter.findMany('activeChats', { query: chatQuery, projection: { _id: 0 } }),
    adapter.findMany('users', { query: tenantQuery, projection: { _id: 0, password: 0 } }),
    adapter.findMany('flows', { query: tenantQuery, projection: { _id: 0, publishHistory: 0 } }),
    adapter.findMany('queues', { query: tenantQuery, projection: { _id: 0 } }),
    adapter.findMany('outreachCampaigns', { query: tenantQuery, projection: { _id: 0 } }),
    adapter.findMany('outreachCampaignItems', { query: tenantQuery, projection: { _id: 0 }, limit: 50000 }),
    adapter.findMany('systemLogs', {
      query: filters.tenantId ? {
        $or: [
          { tenantId: filters.tenantId },
          { message: { $regex: filters.tenantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }
        ]
      } : {},
      projection: { _id: 0 }
    }),
    adapter.findMany('whatsappTemplates', { query: tenantQuery, projection: { _id: 0 } })
  ]);

  const hydratedChats = await hydrateChatsWithMessages(chats, { limit: 2000 });
  const itemsByCampaign = new Map();
  (Array.isArray(campaignItems) ? campaignItems : []).forEach((item) => {
    const key = item.campaignId || item.id;
    if (!key) return;
    if (!itemsByCampaign.has(key)) itemsByCampaign.set(key, []);
    itemsByCampaign.get(key).push(item);
  });
  const hydratedCampaigns = (Array.isArray(campaigns) ? campaigns : []).map((campaign) => ({
    ...campaign,
    items: Array.isArray(campaign.items) && campaign.items.length
      ? campaign.items
      : (itemsByCampaign.get(campaign.id) || [])
  }));

  return {
    tenants,
    chats: applyFilters(hydratedChats, filters).map(normalizeChat),
    users,
    flows,
    queues,
    campaigns: hydratedCampaigns,
    logs: (Array.isArray(logs) ? logs : []).filter((log) => isInRange(log.timestamp, filters.from, filters.to)),
    whatsappTemplates
  };
};

const buildSummaryRows = ({ tenants, chats, filters }) => {
  const tenantById = new Map((tenants || []).map((tenant) => [tenant.id, tenant]));
  const total = chats.length;
  const closed = chats.filter(({ chat }) => chat.status === 'closed').length;
  const bot = chats.filter(({ chat }) => chat.status === 'bot').length;
  const waiting = chats.filter(({ chat }) => chat.status === 'waiting').length;
  const human = chats.filter(({ chat }) => chat.status === 'open' && chat.agentId).length;
  const activeOutreach = chats.filter(({ chat }) => chat.activeOutreach).length;
  const uniqueCustomers = new Set(chats.map(({ chat }) => chat.channelUserId || chat.customerCpf).filter(Boolean)).size;
  const totalMessages = chats.reduce((sum, item) => sum + item.totalMessages, 0);
  const errors = chats.reduce((sum, item) => sum + item.failedMessages, 0);

  return [{
    tenantId: filters.tenantId || 'todos',
    tenantNome: filters.tenantId ? (tenantById.get(filters.tenantId)?.name || '') : 'Todos',
    periodoInicio: filters.from ? filters.from.toISOString() : '',
    periodoFim: filters.to ? filters.to.toISOString() : '',
    totalConversas: total,
    totalClientesUnicos: uniqueCustomers,
    totalMensagens: totalMessages,
    totalBot: bot,
    totalFila: waiting,
    totalHumano: human,
    totalEncerradas: closed,
    totalAtivo: activeOutreach,
    tempoMedioAtendimentoMin: average(chats.map((item) => item.durationMinutes)),
    tempoMedioPrimeiraRespostaBotMin: average(chats.map((item) => item.firstBotResponseMinutes)),
    tempoMedioPrimeiraRespostaAgenteMin: average(chats.map((item) => item.firstAgentResponseMinutes)),
    taxaRespostaAtivo: percent(
      chats.filter(({ chat, customerMessages }) => chat.activeOutreach && customerMessages > 0).length,
      activeOutreach
    ),
    taxaErroMensagens: percent(errors, totalMessages)
  }];
};

const buildConversationRows = ({ chats }) => chats.map((item) => {
  const { chat } = item;
  return {
    chatId: chat.id,
    tenantId: chat.tenantId || '',
    clienteNome: chat.contactName || chat.customerName || chat.customerCpf || chat.channelUserId || '',
    waId: chat.channel === 'whatsapp' ? (chat.channelUserId || chat.channelChatId || '') : '',
    canal: chat.channel || '',
    status: chat.status || '',
    fila: chat.queue || '',
    agenteId: chat.agentId || '',
    agenteNome: chat.agentName || '',
    origem: chat.activeOutreach ? 'ativo' : (chat.source || 'fluxo'),
    flowId: chat.flowId || '',
    flowName: chat.flowName || '',
    iniciadoEm: item.startedAt,
    primeiraRespostaBotEm: getMessageAt(item.firstBot),
    primeiraRespostaAgenteEm: getMessageAt(item.firstAgent),
    assumidoEm: chat.assignedAt || chat.waitingSince || '',
    encerradoEm: item.closedAt,
    duracaoMinutos: item.durationMinutes ?? '',
    totalMensagensCliente: item.customerMessages,
    totalMensagensBot: item.botMessages,
    totalMensagensAgente: item.agentMessages,
    totalMidias: item.mediaMessages,
    teveErro: item.failedMessages > 0 ? 'sim' : 'nao',
    errosMensagem: item.failedMessages,
    encerramentoTipo: inferCloseType(chat)
  };
});

const buildMessageRows = ({ chats }) => chats.flatMap(({ chat, messages }) => (
  messages.map((message) => ({
    chatId: chat.id,
    tenantId: chat.tenantId || '',
    canal: chat.channel || '',
    waId: chat.channel === 'whatsapp' ? (chat.channelUserId || '') : '',
    messageId: message.id || '',
    sender: message.sender || '',
    tipo: message.media?.type || message.type || 'text',
    texto: message.media ? (message.media.caption || message.text || '') : (message.text || ''),
    mediaType: message.media?.type || '',
    fileName: message.media?.fileName || '',
    providerMessageId: message.providerMessageId || message.meta?.providerMessageId || '',
    deliveryStatus: message.deliveryStatus || message.meta?.deliveryStatus || '',
    enviadaEm: getMessageAt(message),
    statusEm: message.deliveryStatusAt || message.meta?.deliveryStatusAt || '',
    erro: message.meta?.deliveryErrors ? JSON.stringify(message.meta.deliveryErrors) : ''
  }))
));

const buildQueueRows = ({ chats, queues }) => {
  const queueNames = new Set((queues || []).map((queue) => queue.name || queue.id).filter(Boolean));
  chats.forEach(({ chat }) => {
    if (chat.queue) queueNames.add(chat.queue);
  });

  return [...queueNames].sort().map((queueName) => {
    const items = chats.filter(({ chat }) => String(chat.queue || '') === String(queueName));
    const waiting = items.filter(({ chat }) => chat.status === 'waiting').length;
    const open = items.filter(({ chat }) => chat.status === 'open').length;
    const closed = items.filter(({ chat }) => chat.status === 'closed').length;
    return {
      fila: queueName,
      totalEntradas: items.length,
      totalAtendidas: items.filter(({ chat }) => chat.agentId).length,
      totalPerdidas: items.filter(({ chat, agentMessages }) => chat.status === 'closed' && !chat.agentId && agentMessages === 0).length,
      totalEmAberto: open + waiting,
      totalAguardando: waiting,
      totalEncerradas: closed,
      tempoMedioAtendimentoMin: average(items.map((item) => item.durationMinutes)),
      tempoMedioPrimeiraRespostaAgenteMin: average(items.map((item) => item.firstAgentResponseMinutes))
    };
  });
};

const buildAgentRows = ({ chats, users }) => {
  const agents = new Map();
  (users || []).forEach((user) => {
    if (['AGENT', 'MANAGER', 'ADMIN'].includes(String(user.role || '').toUpperCase())) {
      agents.set(user.id, {
        agentId: user.id,
        agentName: user.name || user.username || user.id,
        totalAtendimentos: 0,
        totalMensagens: 0,
        totalAssumidos: 0,
        totalEncerrados: 0,
        atendimentosAtivos: 0,
        tempoMedioRespostaMin: '',
        tempoMedioAtendimentoMin: ''
      });
    }
  });

  chats.forEach((item) => {
    const { chat } = item;
    if (!chat.agentId) return;
    if (!agents.has(chat.agentId)) {
      agents.set(chat.agentId, {
        agentId: chat.agentId,
        agentName: chat.agentName || chat.agentId,
        totalAtendimentos: 0,
        totalMensagens: 0,
        totalAssumidos: 0,
        totalEncerrados: 0,
        atendimentosAtivos: 0,
        tempoMedioRespostaMin: '',
        tempoMedioAtendimentoMin: '',
        _responseTimes: [],
        _durations: []
      });
    }
    const row = agents.get(chat.agentId);
    row.totalAtendimentos += 1;
    row.totalMensagens += item.agentMessages;
    row.totalAssumidos += 1;
    if (chat.status === 'closed') row.totalEncerrados += 1;
    if (chat.status !== 'closed') row.atendimentosAtivos += 1;
    row._responseTimes = row._responseTimes || [];
    row._durations = row._durations || [];
    if (Number.isFinite(item.firstAgentResponseMinutes)) row._responseTimes.push(item.firstAgentResponseMinutes);
    if (Number.isFinite(item.durationMinutes)) row._durations.push(item.durationMinutes);
  });

  return [...agents.values()].map((row) => {
    const responseTimes = row._responseTimes || [];
    const durations = row._durations || [];
    const { _responseTimes, _durations, ...clean } = row;
    return {
      ...clean,
      tempoMedioRespostaMin: average(responseTimes),
      tempoMedioAtendimentoMin: average(durations)
    };
  });
};

const extractFlowSnapshot = (flow) => flow?.published || flow?.draft || flow?.editorSnapshot || flow || {};

const buildFlowNodeRows = ({ flows, chats, logs }) => {
  const errorByNode = new Map();
  logs.forEach((log) => {
    const payload = parseLogMessage(log.message);
    const nodeId = payload.nodeId || payload.node || null;
    if (!nodeId) return;
    const isError = /ERROR|FAILED|FAIL|WHATSAPP_STATUS/i.test(String(log.type || ''))
      || payload.error
      || payload.errorMessage
      || payload.status === 'failed';
    if (isError) errorByNode.set(nodeId, (errorByNode.get(nodeId) || 0) + 1);
  });

  const currentByNode = new Map();
  chats.forEach(({ chat }) => {
    [chat.currentNodeId, chat.resumeNodeId, chat.delayNodeId].filter(Boolean).forEach((nodeId) => {
      currentByNode.set(nodeId, (currentByNode.get(nodeId) || 0) + 1);
    });
  });

  return (flows || []).flatMap((flow) => {
    const snapshot = extractFlowSnapshot(flow);
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
    return nodes
      .filter((node) => node?.type !== 'secretNode')
      .map((node) => ({
        flowId: flow.id || '',
        flowName: flow.name || '',
        nodeId: node.id || '',
        nodeType: node.type || '',
        nodeLabel: node.data?.customName || node.data?.label || node.data?.text || node.type || '',
        totalEntradasRegistradas: '',
        chatsAtualmenteParados: currentByNode.get(node.id) || 0,
        totalErrosRegistrados: errorByNode.get(node.id) || 0,
        observacao: 'Passagens historicas por node exigem instrumentacao de runtime; esta coluna usa dados disponiveis hoje.'
      }));
  });
};

const buildCampaignRows = ({ campaigns }) => (campaigns || []).map((campaign) => {
  const items = Array.isArray(campaign.items) ? campaign.items : [];
  const sent = items.filter((item) => item.status === 'sent').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const pending = items.filter((item) => item.status === 'pending').length;
  const replied = items.filter((item) => item.chatId).length;
  return {
    campaignId: campaign.id || '',
    campaignName: campaign.name || campaign.templateName || '',
    tenantId: campaign.tenantId || '',
    channel: campaign.channel || '',
    templateId: campaign.templateId || '',
    templateName: campaign.templateName || '',
    senderPhoneNumberId: campaign.senderPhoneNumberId || '',
    totalContatos: items.length,
    totalEnviados: sent,
    totalFalhas: failed,
    totalPendentes: pending,
    totalComChat: replied,
    taxaFalha: percent(failed, items.length),
    status: campaign.status || '',
    criadaEm: campaign.createdAt || '',
    finalizadaEm: campaign.finishedAt || ''
  };
});

const buildTemplateRows = ({ whatsappTemplates, campaigns, chats }) => {
  const templateRows = new Map();
  (whatsappTemplates || []).forEach((template) => {
    templateRows.set(template.id, {
      templateId: template.id,
      templateName: template.name || '',
      language: template.language || '',
      status: template.status || '',
      totalCampanhas: 0,
      totalEnviado: 0,
      totalFalha: 0,
      totalLido: 0,
      taxaFalha: 0
    });
  });

  (campaigns || []).forEach((campaign) => {
    const key = campaign.templateId || campaign.templateName || 'sem_template';
    if (!templateRows.has(key)) {
      templateRows.set(key, {
        templateId: campaign.templateId || '',
        templateName: campaign.templateName || '',
        language: campaign.templateLanguage || '',
        status: '',
        totalCampanhas: 0,
        totalEnviado: 0,
        totalFalha: 0,
        totalLido: 0,
        taxaFalha: 0
      });
    }
    const row = templateRows.get(key);
    const items = Array.isArray(campaign.items) ? campaign.items : [];
    row.totalCampanhas += 1;
    row.totalEnviado += items.filter((item) => item.status === 'sent').length;
    row.totalFalha += items.filter((item) => item.status === 'failed').length;
  });

  chats.forEach(({ messages }) => {
    messages.forEach((message) => {
      const templateId = message.meta?.templateId || message.meta?.whatsappTemplateId || null;
      if (!templateId || !templateRows.has(templateId)) return;
      const row = templateRows.get(templateId);
      if (String(message.deliveryStatus || message.meta?.deliveryStatus || '').toLowerCase() === 'read') {
        row.totalLido += 1;
      }
    });
  });

  return [...templateRows.values()].map((row) => ({
    ...row,
    taxaFalha: percent(row.totalFalha, row.totalEnviado + row.totalFalha)
  }));
};

const buildErrorRows = ({ logs, chats }) => {
  const rows = [];
  logs.forEach((log) => {
    const payload = parseLogMessage(log.message);
    const isError = /ERROR|FAILED|FAIL|STATUS/i.test(String(log.type || ''))
      || payload.error
      || payload.errorMessage
      || payload.status === 'failed'
      || payload.errors;
    if (!isError) return;
    rows.push({
      data: log.timestamp || '',
      tenantId: payload.tenantId || log.tenantId || '',
      chatId: payload.chatId || '',
      canal: payload.channel || payload.canal || '',
      tipoErro: log.type || '',
      codigoErro: payload.code || payload.status || '',
      mensagemErro: payload.message || payload.error || payload.errorMessage || safeText(log.message),
      flowId: payload.flowId || '',
      nodeId: payload.nodeId || '',
      nodeType: payload.nodeType || '',
      providerMessageId: payload.messageId || payload.providerMessageId || '',
      detalhes: safeText(payload.details || payload.error_data || payload.errors || '')
    });
  });

  chats.forEach(({ chat, messages }) => {
    messages.forEach((message) => {
      if (String(message.deliveryStatus || message.meta?.deliveryStatus || '').toLowerCase() !== 'failed' && !message.meta?.deliveryErrors) {
        return;
      }
      rows.push({
        data: getMessageAt(message),
        tenantId: chat.tenantId || '',
        chatId: chat.id || '',
        canal: chat.channel || '',
        tipoErro: 'MESSAGE_DELIVERY_FAILED',
        codigoErro: '',
        mensagemErro: message.meta?.deliveryErrors ? JSON.stringify(message.meta.deliveryErrors) : 'Falha de entrega',
        flowId: chat.flowId || '',
        nodeId: '',
        nodeType: '',
        providerMessageId: message.providerMessageId || message.meta?.providerMessageId || '',
        detalhes: ''
      });
    });
  });

  return rows.sort((a, b) => new Date(b.data || 0) - new Date(a.data || 0));
};

export const buildReports = async (filters) => {
  const collections = await loadReportCollections(filters);
  const reports = {
    resumo_geral: buildSummaryRows({ ...collections, filters }),
    conversas: buildConversationRows(collections),
    mensagens: buildMessageRows(collections),
    filas: buildQueueRows(collections),
    agentes: buildAgentRows(collections),
    fluxo_nodes: buildFlowNodeRows(collections),
    campanhas: buildCampaignRows(collections),
    templates_whatsapp: buildTemplateRows(collections),
    erros: buildErrorRows(collections)
  };

  return { reports, filters };
};

export const reportColumns = {
  resumo_geral: [
    'tenantId', 'tenantNome', 'periodoInicio', 'periodoFim', 'totalConversas', 'totalClientesUnicos',
    'totalMensagens', 'totalBot', 'totalFila', 'totalHumano', 'totalEncerradas', 'totalAtivo',
    'tempoMedioAtendimentoMin', 'tempoMedioPrimeiraRespostaBotMin', 'tempoMedioPrimeiraRespostaAgenteMin',
    'taxaRespostaAtivo', 'taxaErroMensagens'
  ],
  conversas: [
    'chatId', 'tenantId', 'clienteNome', 'waId', 'canal', 'status', 'fila', 'agenteId', 'agenteNome',
    'origem', 'flowId', 'flowName', 'iniciadoEm', 'primeiraRespostaBotEm', 'primeiraRespostaAgenteEm',
    'assumidoEm', 'encerradoEm', 'duracaoMinutos', 'totalMensagensCliente', 'totalMensagensBot',
    'totalMensagensAgente', 'totalMidias', 'teveErro', 'errosMensagem', 'encerramentoTipo'
  ],
  mensagens: [
    'chatId', 'tenantId', 'canal', 'waId', 'messageId', 'sender', 'tipo', 'texto', 'mediaType',
    'fileName', 'providerMessageId', 'deliveryStatus', 'enviadaEm', 'statusEm', 'erro'
  ],
  filas: [
    'fila', 'totalEntradas', 'totalAtendidas', 'totalPerdidas', 'totalEmAberto', 'totalAguardando',
    'totalEncerradas', 'tempoMedioAtendimentoMin', 'tempoMedioPrimeiraRespostaAgenteMin'
  ],
  agentes: [
    'agentId', 'agentName', 'totalAtendimentos', 'totalMensagens', 'totalAssumidos', 'totalEncerrados',
    'atendimentosAtivos', 'tempoMedioRespostaMin', 'tempoMedioAtendimentoMin'
  ],
  fluxo_nodes: [
    'flowId', 'flowName', 'nodeId', 'nodeType', 'nodeLabel', 'totalEntradasRegistradas',
    'chatsAtualmenteParados', 'totalErrosRegistrados', 'observacao'
  ],
  campanhas: [
    'campaignId', 'campaignName', 'tenantId', 'channel', 'templateId', 'templateName',
    'senderPhoneNumberId', 'totalContatos', 'totalEnviados', 'totalFalhas', 'totalPendentes',
    'totalComChat', 'taxaFalha', 'status', 'criadaEm', 'finalizadaEm'
  ],
  templates_whatsapp: [
    'templateId', 'templateName', 'language', 'status', 'totalCampanhas', 'totalEnviado',
    'totalFalha', 'totalLido', 'taxaFalha'
  ],
  erros: [
    'data', 'tenantId', 'chatId', 'canal', 'tipoErro', 'codigoErro', 'mensagemErro',
    'flowId', 'nodeId', 'nodeType', 'providerMessageId', 'detalhes'
  ]
};
