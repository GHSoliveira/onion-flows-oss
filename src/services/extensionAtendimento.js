/**
 * Genesys ⇄ OnionFlows — handlers dos eventos da extensão coletora (v1 + fase 4).
 *
 * Extensão → app:  ext:atendimento:*
 * App → extensão:  cmd:enviar_mensagem | cmd:encerrar
 * Extensão → app:  cmd:resultado (ack opcional)
 *
 * Upsert por genesysConvId, mensagens idempotentes por messageId,
 * atendimento atribuido ao agente autenticado no socket (JWT).
 */
import adapter from '../../db/DatabaseAdapter.js';
import { generateId } from '../utils/helpers.js';
import { appendChatMessage, hydrateChatWithMessages } from './chatMessages.js';
import { withChatLock } from './chatLocks.js';
import { getIo } from './logs.js';

export const EXTENSION_CLIENT_KINDS = new Set([
  'genesys-extension',
  'extension',
  'genesys',
  'coletor'
]);

export const extensionRoomForAgent = (agentId) => `agent:${agentId}:extension`;

const onlyDigits = (value) => String(value || '').replace(/\D/g, '');

const pickString = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
};

export const isGenesysChat = (chat) => {
  if (!chat) return false;
  const channel = String(chat.channel || '').toLowerCase();
  const source = String(chat.externalSource || '').toLowerCase();
  return channel === 'genesys'
    || source === 'genesys'
    || Boolean(chat.genesysConvId)
    || (Boolean(chat.externalConvId) && source === 'genesys');
};

export const resolveGenesysConvId = (chat) => pickString(
  chat?.genesysConvId,
  chat?.externalConvId
);

const normalizeSender = (raw) => {
  const key = String(raw || 'user').trim().toLowerCase();
  if (['user', 'customer', 'cliente', 'client', 'visitor', 'inbound'].includes(key)) return 'user';
  if (['agent', 'agente', 'humano', 'human', 'outbound'].includes(key)) return 'agent';
  if (['bot', 'system_bot', 'automacao', 'automação'].includes(key)) return 'bot';
  if (['system', 'sistema'].includes(key)) return 'system';
  return 'user';
};

const toIsoFromTs = (ts, fallback = null) => {
  if (ts === undefined || ts === null || ts === '') {
    return fallback || new Date().toISOString();
  }
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    // epoch seconds vs ms
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? (fallback || new Date().toISOString()) : date.toISOString();
  }
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? (fallback || new Date().toISOString()) : date.toISOString();
};

const buildClienteVars = (cliente = {}) => {
  const nome = pickString(cliente.nome, cliente.name, cliente.customerName);
  const cpf = pickString(cliente.cpf, cliente.document, cliente.documento);
  const endereco = pickString(cliente.endereco, cliente.address, cliente.endereço);
  const telefone = onlyDigits(pickString(cliente.telefone, cliente.phone, cliente.whatsapp, cliente.celular));
  const ativo = cliente.ativo === undefined ? null : Boolean(cliente.ativo);
  const filial = pickString(cliente.filial, cliente.branch);

  const vars = {};
  if (nome) vars.nome_cliente = nome;
  if (cpf) vars.cpf = cpf;
  if (endereco) vars.endereco = endereco;
  if (telefone) vars.telefone = telefone;
  if (ativo !== null) vars.ativo = ativo ? 'sim' : 'nao';
  if (filial) vars.filial = filial;
  return { vars, nome, cpf, endereco, telefone, ativo, filial };
};

const publicChat = (chat) => {
  if (!chat) return null;
  const { secureVars, secureVarNames, ...rest } = chat;
  return rest;
};

const emitToAgentPanel = (chat, eventName, payload) => {
  const io = getIo();
  if (!io || !chat?.tenantId) return;

  const roomTenant = `tenant:${chat.tenantId}`;
  io.to(roomTenant).emit(eventName, payload);

  if (chat.agentId) {
    io.to(`agent:${chat.agentId}`).emit(eventName, payload);
  }
};

const findChatByConvId = async ({ tenantId, convId }) => {
  if (!tenantId || !convId) return null;

  const queries = [
    { tenantId, genesysConvId: convId, status: { $ne: 'closed' } },
    { tenantId, externalConvId: convId, status: { $ne: 'closed' } },
    { tenantId, genesysConvId: convId },
    { tenantId, externalConvId: convId }
  ];

  for (const query of queries) {
    const chat = await adapter.findOne('activeChats', query, { projection: { _id: 0 } });
    if (chat) return chat;
  }
  return null;
};

const ensureAgentContext = (socket) => {
  const agentId = socket?.userId || null;
  const tenantId = socket?.tenantId || null;
  const agentName = socket?.userName || 'Agente';
  if (!agentId) {
    const err = new Error('Agente nao autenticado');
    err.code = 'AUTH';
    throw err;
  }
  if (!tenantId) {
    const err = new Error('Agente sem tenantId — use uma conta de agente do tenant');
    err.code = 'TENANT';
    throw err;
  }
  return { agentId, tenantId, agentName };
};

export const handleExtUpsert = async (socket, payload = {}) => {
  const { agentId, tenantId, agentName } = ensureAgentContext(socket);
  const convId = pickString(payload.convId, payload.conversationId, payload.id);
  if (!convId) {
    return { ok: false, error: 'convId obrigatorio' };
  }

  const { vars: clienteVars, nome, cpf, telefone } = buildClienteVars(payload.cliente || {});
  const statusRaw = pickString(payload.status, 'open').toLowerCase();
  const status = statusRaw === 'waiting' ? 'waiting' : 'open';
  const canal = pickString(payload.canal, payload.channel, 'genesys').toLowerCase() || 'genesys';
  const abertoEm = payload.abertoEm !== undefined
    ? toIsoFromTs(payload.abertoEm)
    : null;
  const now = new Date().toISOString();

  let chat = await findChatByConvId({ tenantId, convId });
  let created = false;

  if (!chat || chat.status === 'closed') {
    created = true;
    const channelUserId = telefone || `genesys_${onlyDigits(convId).slice(-10) || convId.slice(-10)}`;
    chat = {
      id: generateId('chat'),
      genesysConvId: convId,
      externalConvId: convId,
      externalSource: 'genesys',
      customerCpf: cpf ? `cpf_${onlyDigits(cpf) || cpf}` : `gx_${channelUserId}`,
      customerName: nome || null,
      customerPhone: telefone || null,
      status,
      messages: [],
      lastMessage: null,
      lastMessageAt: null,
      messageCount: 0,
      unreadByAgentCount: 0,
      vars: { ...clienteVars },
      variables: { ...clienteVars },
      tenantId,
      channel: canal,
      channelUserId,
      channelChatId: channelUserId,
      currentNodeId: null,
      processedMessageIds: [],
      createdAt: abertoEm || now,
      updatedAt: now,
      secureVars: {},
      secureVarNames: [],
      flowStarted: false,
      resumeNodeId: null,
      resumePending: false,
      continueFlowAfterQueue: false,
      closedAt: null,
      queue: 'ATENDIMENTO',
      waitingSince: status === 'waiting' ? now : null,
      agentId: status === 'open' ? agentId : null,
      agentName: status === 'open' ? agentName : null,
      closeReason: null
    };
  } else {
    // update
    chat.genesysConvId = convId;
    chat.externalConvId = convId;
    chat.externalSource = 'genesys';
    chat.channel = canal || chat.channel || 'genesys';
    chat.updatedAt = now;
    chat.vars = { ...(chat.vars || {}), ...clienteVars };
    chat.variables = { ...(chat.variables || {}), ...clienteVars };
    if (nome) chat.customerName = nome;
    if (telefone) {
      chat.customerPhone = telefone;
      chat.channelUserId = telefone;
      chat.channelChatId = telefone;
    }
    if (cpf && !chat.customerCpf?.startsWith('cpf_')) {
      chat.customerCpf = `cpf_${onlyDigits(cpf) || cpf}`;
    }

    // Reatribuir ao agente autenticado se estiver open
    if (status === 'open' || chat.status === 'open' || chat.status === 'waiting') {
      chat.status = status === 'waiting' ? 'waiting' : 'open';
      if (chat.status === 'open') {
        chat.agentId = agentId;
        chat.agentName = agentName;
        chat.waitingSince = null;
      } else {
        chat.agentId = null;
        chat.agentName = null;
        chat.waitingSince = chat.waitingSince || now;
      }
    }
  }

  await adapter.saveDocument('activeChats', chat);
  const hydrated = await hydrateChatWithMessages(chat, { limit: 500 });

  emitToAgentPanel(chat, created ? 'agent_assigned' : 'agent_assigned', {
    chat: publicChat(hydrated || chat)
  });
  emitToAgentPanel(chat, 'new_chat', {
    chat: publicChat(hydrated || chat)
  });

  return {
    ok: true,
    created,
    chatId: chat.id,
    convId,
    status: chat.status
  };
};

export const handleExtBackfill = async (socket, payload = {}) => {
  const { agentId, tenantId } = ensureAgentContext(socket);
  const convId = pickString(payload.convId, payload.conversationId);
  if (!convId) return { ok: false, error: 'convId obrigatorio' };

  const chat = await findChatByConvId({ tenantId, convId });
  if (!chat) return { ok: false, error: 'Atendimento nao encontrado — envie upsert antes do backfill' };
  if (chat.status === 'closed') return { ok: false, error: 'Atendimento ja encerrado' };

  const list = Array.isArray(payload.mensagens)
    ? payload.mensagens
    : (Array.isArray(payload.messages) ? payload.messages : []);

  let inserted = 0;
  let skipped = 0;
  let liveChat = chat;

  await withChatLock(chat.id, async () => {
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      if (entry === undefined || entry === null) continue;

      let text = '';
      let sender = 'user';
      let messageId = null;
      let timestamp = null;

      if (typeof entry === 'string') {
        text = entry;
        messageId = `gx_bf_${convId}_${index}`;
      } else if (typeof entry === 'object') {
        text = pickString(entry.text, entry.message, entry.body, entry.content);
        sender = normalizeSender(entry.sender || entry.from || entry.role);
        messageId = pickString(entry.id, entry.messageId, entry.msgId) || `gx_bf_${convId}_${index}`;
        timestamp = entry.ts !== undefined ? entry.ts : (entry.timestamp || entry.createdAt);
      }
      if (!text) continue;

      const result = await appendChatMessage(liveChat, {
        id: messageId,
        messageId,
        sender,
        text,
        timestamp: toIsoFromTs(timestamp),
        providerMessageId: messageId,
        meta: { source: 'genesys', genesysMessageId: messageId }
      }, { incrementUnread: sender === 'user' });

      liveChat = result.chat || liveChat;
      if (result.inserted) {
        inserted += 1;
        emitToAgentPanel(liveChat, 'new_message', {
          chatId: liveChat.id,
          message: result.message
        });
      } else {
        skipped += 1;
      }
    }
  });

  // Refresh list for agent panel after bulk history
  const hydrated = await hydrateChatWithMessages(liveChat, { limit: 500 });
  emitToAgentPanel(liveChat, 'agent_assigned', { chat: publicChat(hydrated || liveChat) });

  return { ok: true, chatId: chat.id, convId, inserted, skipped };
};

export const handleExtMensagem = async (socket, payload = {}) => {
  const { agentId, tenantId } = ensureAgentContext(socket);
  const convId = pickString(payload.convId, payload.conversationId);
  if (!convId) return { ok: false, error: 'convId obrigatorio' };

  const rawMsg = payload.mensagem || payload.message || payload;
  const text = pickString(rawMsg?.text, rawMsg?.message, rawMsg?.body, payload.text);
  const messageId = pickString(rawMsg?.id, rawMsg?.messageId, payload.id);
  if (!text) return { ok: false, error: 'mensagem.text obrigatorio' };
  if (!messageId) return { ok: false, error: 'mensagem.id obrigatorio (dedup)' };

  const chat = await findChatByConvId({ tenantId, convId });
  if (!chat) return { ok: false, error: 'Atendimento nao encontrado — envie upsert antes' };
  if (chat.status === 'closed') return { ok: false, error: 'Atendimento ja encerrado' };

  const sender = normalizeSender(rawMsg?.sender || rawMsg?.from || payload.sender);
  const timestamp = toIsoFromTs(rawMsg?.ts ?? rawMsg?.timestamp ?? payload.ts);

  let result;
  await withChatLock(chat.id, async () => {
    result = await appendChatMessage(chat, {
      id: messageId,
      messageId,
      sender,
      text,
      timestamp,
      providerMessageId: messageId,
      meta: { source: 'genesys', genesysMessageId: messageId }
    }, { incrementUnread: sender === 'user' });
  });

  if (result?.inserted) {
    emitToAgentPanel(result.chat || chat, 'new_message', {
      chatId: chat.id,
      message: result.message
    });
  }

  return {
    ok: true,
    chatId: chat.id,
    convId,
    inserted: Boolean(result?.inserted),
    messageId
  };
};

export const handleExtCliente = async (socket, payload = {}) => {
  const { agentId, tenantId } = ensureAgentContext(socket);
  const convId = pickString(payload.convId, payload.conversationId);
  if (!convId) return { ok: false, error: 'convId obrigatorio' };

  const chat = await findChatByConvId({ tenantId, convId });
  if (!chat) return { ok: false, error: 'Atendimento nao encontrado' };

  const { vars: clienteVars, nome, telefone, cpf } = buildClienteVars(payload.cliente || {});
  if (!Object.keys(clienteVars).length) {
    return { ok: false, error: 'cliente sem campos uteis' };
  }

  chat.vars = { ...(chat.vars || {}), ...clienteVars };
  chat.variables = { ...(chat.variables || {}), ...clienteVars };
  if (nome) chat.customerName = nome;
  if (telefone) {
    chat.customerPhone = telefone;
    chat.channelUserId = telefone;
    chat.channelChatId = telefone;
  }
  if (cpf) chat.customerCpf = `cpf_${onlyDigits(cpf) || cpf}`;
  chat.updatedAt = new Date().toISOString();

  await adapter.saveDocument('activeChats', chat);
  const hydrated = await hydrateChatWithMessages(chat, { limit: 200 });
  emitToAgentPanel(chat, 'agent_assigned', { chat: publicChat(hydrated || chat) });

  return { ok: true, chatId: chat.id, convId, vars: chat.vars };
};

export const handleExtEncerrar = async (socket, payload = {}) => {
  const { agentId, tenantId } = ensureAgentContext(socket);
  const convId = pickString(payload.convId, payload.conversationId);
  if (!convId) return { ok: false, error: 'convId obrigatorio' };

  const chat = await findChatByConvId({ tenantId, convId });
  if (!chat) return { ok: false, error: 'Atendimento nao encontrado' };
  if (chat.status === 'closed') {
    return { ok: true, chatId: chat.id, convId, alreadyClosed: true };
  }

  const motivo = pickString(payload.motivo, payload.reason, 'genesys_agente');
  const now = new Date().toISOString();

  await withChatLock(chat.id, async () => {
    const live = await adapter.findOne('activeChats', { id: chat.id }, { projection: { _id: 0 } }) || chat;
    if (live.status === 'closed') return;
    live.status = 'closed';
    live.closedAt = now;
    live.updatedAt = now;
    live.closeReason = motivo;
    live.waitingSince = null;
    live.outreachPendingReply = false;
    await adapter.saveDocument('activeChats', live);
  });

  const io = getIo();
  if (io) {
    io.to(`tenant:${tenantId}`).emit('chat_closed', {
      chatId: chat.id,
      convId,
      motivo,
      source: 'genesys_extension'
    });
    if (agentId) {
      io.to(`agent:${agentId}`).emit('chat_closed', {
        chatId: chat.id,
        convId,
        motivo,
        source: 'genesys_extension'
      });
    }
  }

  return { ok: true, chatId: chat.id, convId, motivo };
};

// ─── Fase 4: app → extensão ─────────────────────────────────────────────────

export const isExtensionSocket = (socket) => {
  const raw = pickString(
    socket?.handshake?.auth?.client,
    socket?.handshake?.auth?.source,
    socket?.handshake?.query?.client,
    socket?.clientKind
  ).toLowerCase();
  return EXTENSION_CLIENT_KINDS.has(raw);
};

export const countExtensionSockets = async (agentId) => {
  const io = getIo();
  if (!io || !agentId) return 0;
  try {
    const sockets = await io.in(extensionRoomForAgent(agentId)).fetchSockets();
    return Array.isArray(sockets) ? sockets.length : 0;
  } catch {
    return 0;
  }
};

/**
 * Emite comando para a(s) extensao(oes) do agente.
 * Nao envia para o browser do painel — so room agent:{id}:extension.
 */
export const emitCmdToExtension = async (agentId, eventName, payload = {}) => {
  const io = getIo();
  if (!io || !agentId) {
    return { ok: false, relayed: false, reason: 'no_io_or_agent', listeners: 0 };
  }
  const listeners = await countExtensionSockets(agentId);
  if (listeners <= 0) {
    return { ok: false, relayed: false, reason: 'extension_offline', listeners: 0 };
  }
  io.to(extensionRoomForAgent(agentId)).emit(eventName, payload);
  return { ok: true, relayed: true, reason: null, listeners };
};

/**
 * App → extensão: enviar texto no Genesys.
 */
export const relayAgentMessageToGenesys = async ({
  chat,
  message,
  agentId = null,
  agentName = null,
  replyTo = null
} = {}) => {
  if (!isGenesysChat(chat)) {
    return { ok: true, skipped: true, reason: 'not_genesys' };
  }
  const convId = resolveGenesysConvId(chat);
  if (!convId) {
    return { ok: false, relayed: false, reason: 'missing_convId' };
  }
  const targetAgentId = agentId || chat.agentId || null;
  if (!targetAgentId) {
    return { ok: false, relayed: false, reason: 'missing_agentId' };
  }

  const payload = {
    convId,
    chatId: chat.id,
    messageId: message?.id || message?.messageId || null,
    text: String(message?.text || ''),
    ts: message?.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
    agentId: targetAgentId,
    agentName: agentName || chat.agentName || null,
    replyTo: replyTo || message?.replyTo || null
  };

  if (!payload.text.trim()) {
    return { ok: false, relayed: false, reason: 'empty_text' };
  }

  const result = await emitCmdToExtension(targetAgentId, 'cmd:enviar_mensagem', payload);
  return { ...result, convId, messageId: payload.messageId };
};

/**
 * App → extensão: encerrar conversa no Genesys.
 */
export const relayAgentCloseToGenesys = async ({
  chat,
  agentId = null,
  motivo = 'app_agente',
  silent = false
} = {}) => {
  if (!isGenesysChat(chat)) {
    return { ok: true, skipped: true, reason: 'not_genesys' };
  }
  const convId = resolveGenesysConvId(chat);
  if (!convId) {
    return { ok: false, relayed: false, reason: 'missing_convId' };
  }
  const targetAgentId = agentId || chat.agentId || null;
  if (!targetAgentId) {
    return { ok: false, relayed: false, reason: 'missing_agentId' };
  }

  const payload = {
    convId,
    chatId: chat.id,
    motivo: pickString(motivo, 'app_agente'),
    silent: silent === true,
    agentId: targetAgentId,
    ts: Date.now()
  };

  const result = await emitCmdToExtension(targetAgentId, 'cmd:encerrar', payload);
  return { ...result, convId };
};

/**
 * Extensão → app: resultado de um comando (ack).
 * Atualiza delivery da mensagem quando enviar_mensagem ok + genesysMessageId.
 */
export const handleCmdResultado = async (socket, payload = {}) => {
  const { agentId, tenantId } = ensureAgentContext(socket);
  const cmd = pickString(payload.cmd, payload.command).toLowerCase();
  const ok = payload.ok !== false;
  const convId = pickString(payload.convId, payload.conversationId);
  const chatId = pickString(payload.chatId);
  const messageId = pickString(payload.messageId, payload.appMessageId);
  const genesysMessageId = pickString(
    payload.genesysMessageId,
    payload.providerMessageId,
    payload.externalMessageId
  );
  const error = pickString(payload.error, payload.message) || null;

  let chat = null;
  if (chatId) {
    chat = await adapter.findOne('activeChats', { id: chatId }, { projection: { _id: 0 } });
  }
  if (!chat && convId) {
    chat = await findChatByConvId({ tenantId, convId });
  }

  if (cmd === 'enviar_mensagem' || cmd === 'enviar' || cmd === 'send_message') {
    if (ok && chat?.id && messageId) {
      const now = new Date().toISOString();
      const deliveryPatch = {
        deliveryStatus: 'sent',
        deliveryStatusAt: now,
        ...(genesysMessageId ? {
          providerMessageId: genesysMessageId,
          'meta.providerMessageId': genesysMessageId,
          'meta.deliveryStatus': 'sent',
          'meta.deliveryStatusAt': now,
          'meta.source': 'genesys'
        } : {})
      };

      try {
        await adapter.updateOne(
          'chatMessages',
          { chatId: chat.id, messageId },
          { $set: deliveryPatch }
        );
      } catch (err) {
        console.warn('[EXT_CMD] falha ao atualizar delivery da mensagem', err?.message || err);
      }

      const io = getIo();
      if (io && chat.tenantId) {
        io.to(`tenant:${chat.tenantId}`).emit('message_delivery', {
          chatId: chat.id,
          messageId,
          providerMessageId: genesysMessageId || null,
          deliveryStatus: 'sent',
          source: 'genesys'
        });
        if (agentId) {
          io.to(`agent:${agentId}`).emit('message_delivery', {
            chatId: chat.id,
            messageId,
            providerMessageId: genesysMessageId || null,
            deliveryStatus: 'sent',
            source: 'genesys'
          });
        }
      }
    }

    if (!ok) {
      console.warn('[EXT_CMD] enviar_mensagem falhou na extensao', {
        agentId,
        convId,
        messageId,
        error
      });
      const io = getIo();
      if (io && agentId) {
        io.to(`agent:${agentId}`).emit('genesys_cmd_failed', {
          cmd: 'enviar_mensagem',
          convId,
          chatId: chat?.id || chatId || null,
          messageId,
          error
        });
      }
    }
  }

  if ((cmd === 'encerrar' || cmd === 'close') && !ok) {
    console.warn('[EXT_CMD] encerrar falhou na extensao', { agentId, convId, error });
    const io = getIo();
    if (io && agentId) {
      io.to(`agent:${agentId}`).emit('genesys_cmd_failed', {
        cmd: 'encerrar',
        convId,
        chatId: chat?.id || chatId || null,
        error
      });
    }
  }

  return {
    ok: true,
    received: true,
    cmd: cmd || null,
    convId: convId || null,
    messageId: messageId || null
  };
};

/**
 * Registra handlers no socket autenticado.
 * - Todos os agentes: podem receber cmds se forem extensão (room dedicada).
 * - Extensão emite ext:atendimento:* e cmd:resultado.
 * Ack opcional em todos os handlers.
 */
export const registerExtensionAtendimentoHandlers = (socket) => {
  const wrap = (handler, eventName) => async (payload, ack) => {
    try {
      const result = await handler(socket, payload || {});
      if (typeof ack === 'function') ack(result);
      if (result && result.ok === false) {
        console.warn(`[EXT_ATENDIMENTO] ${eventName}:`, result.error || result);
      }
      return result;
    } catch (error) {
      const result = {
        ok: false,
        error: error?.message || 'Falha no handler da extensao',
        code: error?.code || 'INTERNAL'
      };
      console.error(`[EXT_ATENDIMENTO] ${eventName} falhou`, error);
      if (typeof ack === 'function') ack(result);
      socket.emit('ext:atendimento:error', { event: eventName, ...result });
      return result;
    }
  };

  // Extensão → app (fase 1–3)
  socket.on('ext:atendimento:upsert', wrap(handleExtUpsert, 'upsert'));
  socket.on('ext:atendimento:backfill', wrap(handleExtBackfill, 'backfill'));
  socket.on('ext:atendimento:mensagem', wrap(handleExtMensagem, 'mensagem'));
  socket.on('ext:atendimento:cliente', wrap(handleExtCliente, 'cliente'));
  socket.on('ext:atendimento:encerrar', wrap(handleExtEncerrar, 'encerrar'));

  // Extensão → app (fase 4 ack)
  socket.on('cmd:resultado', wrap(handleCmdResultado, 'cmd:resultado'));
  socket.on('ext:cmd:resultado', wrap(handleCmdResultado, 'ext:cmd:resultado'));

  // Registro explicito (opcional) — reforça room da extensao
  socket.on('ext:register', (payload = {}, ack) => {
    const kind = pickString(payload.client, payload.source, 'genesys-extension').toLowerCase();
    socket.clientKind = kind;
    if (socket.userId && (EXTENSION_CLIENT_KINDS.has(kind) || isExtensionSocket(socket))) {
      socket.join(extensionRoomForAgent(socket.userId));
      socket.isGenesysExtension = true;
    }
    const result = {
      ok: true,
      registered: Boolean(socket.isGenesysExtension),
      room: socket.userId ? extensionRoomForAgent(socket.userId) : null
    };
    if (typeof ack === 'function') ack(result);
  });
};
