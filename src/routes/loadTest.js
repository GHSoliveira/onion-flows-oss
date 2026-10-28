import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireTenant } from '../middleware/tenant.js';
import { authorize } from '../middleware/authorization.js';
import adapter from '../../db/DatabaseAdapter.js';
import { generateId } from '../utils/helpers.js';
import { appendChatMessage, hydrateChatWithMessages } from '../services/chatMessages.js';
import { upsertContactFromChannel } from '../services/contactIdentity.js';
import { getIo } from '../services/logs.js';

const router = express.Router();

const SANDBOX_AGENT_ID = 'u_sandbox_agent';
const SANDBOX_AGENT_NAME = 'Sandbox Agent';
const SANDBOX_QUEUE = 'ATENDIMENTO';
const SANDBOX_PHONE_NUMBER_ID = 'sandbox_phone_001';
const MAX_SEED_MESSAGES = 200;

const toInt = (value, fallback, { min = 0, max = 100 } = {}) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

export const isSandboxSeedEnabled = () => {
  return String(process.env.SANDBOX_SEED_ENDPOINT || '').toLowerCase() === 'true';
};

const onlyDigits = (value) => String(value || '').replace(/\D/g, '');

const pickString = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
};

const normalizeSender = (raw) => {
  const key = String(raw || 'user').trim().toLowerCase();
  if (['user', 'customer', 'cliente', 'client', 'visitor'].includes(key)) return 'user';
  if (['agent', 'agente', 'humano', 'human'].includes(key)) return 'agent';
  if (['bot', 'system_bot', 'automacao', 'automação'].includes(key)) return 'bot';
  if (['system', 'sistema'].includes(key)) return 'system';
  return 'user';
};

const normalizeSeedMessages = (input) => {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const list = input.slice(0, MAX_SEED_MESSAGES).map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        sender: 'user',
        text: entry,
        timestamp: new Date(now - ((input.length - index) * 1000)).toISOString()
      };
    }
    if (!entry || typeof entry !== 'object') return null;
    const text = pickString(entry.text, entry.message, entry.body, entry.content);
    if (!text) return null;
    const explicitTs = entry.timestamp || entry.createdAt || entry.date;
    const timestamp = explicitTs
      ? new Date(explicitTs).toISOString()
      : new Date(now - ((input.length - index) * 1000)).toISOString();
    return {
      sender: normalizeSender(entry.sender || entry.from || entry.role),
      text,
      timestamp: Number.isNaN(new Date(timestamp).getTime())
        ? new Date(now - ((input.length - index) * 1000)).toISOString()
        : timestamp
    };
  }).filter(Boolean);

  return list;
};

router.get('/smoke', authenticate, requireTenant, authorize(['ADMIN']), async (req, res) => {
  const startedAt = Date.now();
  const tenantId = req.tenantId || req.user?.tenantId || null;
  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId obrigatorio para teste de carga' });
  }

  const sampleLimit = toInt(req.query.sampleLimit, 5, { min: 0, max: 20 });
  const includeSamples = String(req.query.samples || '').toLowerCase() === '1';
  const baseQuery = { tenantId };

  const [
    user,
    flowCount,
    openChatCount,
    waitingChatCount,
    closedChatCount,
    contactCount,
    templateCount,
    variableCount,
    queueCount,
    recentChats,
    recentFlows
  ] = await Promise.all([
    adapter.findOne('users', { id: req.user.id }, {
      projection: { _id: 0, id: 1, role: 1, tenantId: 1, status: 1, lastSeen: 1 }
    }),
    adapter.countDocuments('flows', baseQuery),
    adapter.countDocuments('activeChats', { tenantId, status: 'open' }),
    adapter.countDocuments('activeChats', { tenantId, status: 'waiting' }),
    adapter.countDocuments('activeChats', { tenantId, status: 'closed' }),
    adapter.countDocuments('contacts', baseQuery),
    adapter.countDocuments('templates', baseQuery),
    adapter.countDocuments('variables', baseQuery),
    adapter.countDocuments('queues', baseQuery),
    includeSamples && sampleLimit > 0
      ? adapter.findDocuments('activeChats', baseQuery, {
          projection: { _id: 0, id: 1, status: 1, queue: 1, updatedAt: 1, messages: { $slice: -1 } },
          sort: { updatedAt: -1 },
          limit: sampleLimit
        })
      : Promise.resolve([]),
    includeSamples && sampleLimit > 0
      ? adapter.findDocuments('flows', baseQuery, {
          projection: { _id: 0, id: 1, name: 1, updatedAt: 1 },
          sort: { updatedAt: -1 },
          limit: sampleLimit
        })
      : Promise.resolve([])
  ]);

  return res.json({
    ok: true,
    route: 'load-test/smoke',
    tenantId,
    user,
    durationMs: Date.now() - startedAt,
    counts: {
      flows: flowCount,
      chatsOpen: openChatCount,
      chatsWaiting: waitingChatCount,
      chatsClosed: closedChatCount,
      contacts: contactCount,
      templates: templateCount,
      variables: variableCount,
      queues: queueCount
    },
    samples: includeSamples ? {
      chats: recentChats,
      flows: recentFlows
    } : undefined
  });
});

/**
 * POST /api/load-test/seed-client
 *
 * Endpoint de teste (sandbox/dev) para criar um atendimento ja atribuido
 * ao agente sandbox, com historico de mensagens e dados do cliente.
 *
 * Body:
 * {
 *   "nome": "Maria Silva",
 *   "cpf": "123.456.789-00",
 *   "endereco": "Rua das Flores, 100 - SP",
 *   "telefone": "5511999887766",
 *   "mensagens": [
 *     { "sender": "user", "text": "Ola" },
 *     { "sender": "bot", "text": "Bem-vindo" },
 *     { "sender": "agent", "text": "Em que posso ajudar?" }
 *   ]
 * }
 *
 * Aceita aliases em ingles: name, address, phone, messages.
 * Opcional: status ("open" | "waiting"), agentId, agentName, queue, tenantId.
 */
router.post('/seed-client', authenticate, requireTenant, authorize(['ADMIN']), async (req, res) => {
  try {
    if (!isSandboxSeedEnabled()) {
      return res.status(403).json({
        error: 'Endpoint de seed disponivel apenas em sandbox/development'
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const nome = pickString(body.nome, body.name, body.customerName, body.cliente);
    const cpf = pickString(body.cpf, body.document, body.documento);
    const endereco = pickString(body.endereco, body.address, body.endereço);
    const telefoneRaw = pickString(body.telefone, body.phone, body.whatsapp, body.celular);
    const telefone = onlyDigits(telefoneRaw);
    const messages = normalizeSeedMessages(body.mensagens || body.messages || body.historico || []);

    if (!nome && !cpf && !telefone) {
      return res.status(400).json({
        error: 'Informe ao menos nome, cpf ou telefone do cliente'
      });
    }
    if (!messages.length) {
      return res.status(400).json({
        error: 'Informe um array "mensagens" com ao menos 1 item'
      });
    }

    const tenantId = req.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio para seed de teste' });
    }
    const agentId = pickString(body.agentId) || SANDBOX_AGENT_ID;
    const queue = pickString(body.queue, body.fila) || SANDBOX_QUEUE;
    const statusRaw = pickString(body.status, 'open').toLowerCase();
    const status = statusRaw === 'waiting' ? 'waiting' : 'open';

    let agentName = pickString(body.agentName, body.agenteNome);
    if (!agentName) {
      const agent = await adapter.findOne('users', { id: agentId }, {
        projection: { _id: 0, id: 1, name: 1 }
      });
      agentName = agent?.name || SANDBOX_AGENT_NAME;
    }

    const channelUserId = telefone || `seed${onlyDigits(cpf).slice(-8) || Date.now().toString().slice(-8)}`;
    const now = new Date().toISOString();
    const vars = {
      ...(cpf ? { cpf } : {}),
      ...(nome ? { nome_cliente: nome } : {}),
      ...(endereco ? { endereco } : {}),
      ...(telefone || channelUserId ? { telefone: telefone || channelUserId } : {})
    };

    const chatId = generateId('chat');
    let chat = {
      id: chatId,
      customerCpf: cpf ? `cpf_${onlyDigits(cpf) || cpf}` : `wa_${channelUserId}`,
      customerName: nome || null,
      customerPhone: telefone || channelUserId,
      status,
      messages: [],
      lastMessage: null,
      lastMessageAt: null,
      messageCount: 0,
      unreadByAgentCount: 0,
      vars: { ...vars },
      variables: { ...vars },
      tenantId,
      channel: 'whatsapp',
      channelUserId,
      channelChatId: channelUserId,
      whatsappPhoneNumberId: SANDBOX_PHONE_NUMBER_ID,
      currentNodeId: null,
      processedMessageIds: [],
      createdAt: now,
      updatedAt: now,
      secureVars: {},
      currentNodeEnteredAt: null,
      flowStarted: false,
      resumeNodeId: null,
      resumePending: false,
      continueFlowAfterQueue: false,
      catalogContext: null,
      sequentialContext: null,
      holderContext: null,
      delayNodeId: null,
      delayNextNodeId: null,
      delayUntil: null,
      secureVarNames: [],
      closedAt: null,
      queue: status === 'waiting' || status === 'open' ? queue : null,
      waitingSince: status === 'waiting' ? now : null,
      agentId: status === 'open' ? agentId : null,
      agentName: status === 'open' ? agentName : null
    };

    await adapter.saveDocument('activeChats', chat);

    try {
      await upsertContactFromChannel({
        tenantId,
        channel: 'whatsapp',
        rawIdentifier: channelUserId,
        channelDisplayName: nome || null,
        channelMeta: {
          waId: channelUserId,
          phoneNumberId: SANDBOX_PHONE_NUMBER_ID,
          cpf: cpf || null,
          endereco: endereco || null
        }
      });
    } catch (contactError) {
      console.warn('[LOAD_TEST] seed-client: falha ao upsert contato', contactError?.message || contactError);
    }

    let unread = 0;
    for (const message of messages) {
      const appended = await appendChatMessage(chat, {
        id: generateId('msg'),
        sender: message.sender,
        text: message.text,
        timestamp: message.timestamp,
        buttons: null,
        meta: null
      }, {
        incrementUnread: message.sender === 'user'
      });
      chat = appended.chat || chat;
      if (message.sender === 'user') unread += 1;
    }

    // Garante contadores e lastMessage coerentes apos o loop
    chat = await adapter.findOne('activeChats', { id: chatId }, { projection: { _id: 0 } }) || chat;
    if (unread > 0 && Number(chat.unreadByAgentCount || 0) !== unread) {
      chat.unreadByAgentCount = unread;
      chat.updatedAt = new Date().toISOString();
      await adapter.saveDocument('activeChats', chat);
    }

    const hydrated = await hydrateChatWithMessages(chat, { limit: MAX_SEED_MESSAGES });
    const io = getIo();
    if (io) {
      const { secureVars: _sv, secureVarNames: _svn, ...publicChat } = hydrated || chat;
      if (status === 'waiting') {
        io.to(`tenant:${tenantId}`).emit('new_chat_in_queue', { chat: publicChat });
      } else {
        io.to(`tenant:${tenantId}`).emit('agent_assigned', { chat: publicChat });
      }
      for (const message of (hydrated?.messages || [])) {
        io.to(`tenant:${tenantId}`).emit('new_message', {
          chatId,
          message
        });
      }
    }

    return res.status(200).json({
      ok: true,
      route: 'load-test/seed-client',
      chatId,
      tenantId,
      agentId: chat.agentId,
      agentName: chat.agentName,
      status: chat.status,
      queue: chat.queue,
      customer: {
        nome: nome || null,
        cpf: cpf || null,
        endereco: endereco || null,
        telefone: telefone || channelUserId
      },
      messageCount: Number(chat.messageCount || messages.length),
      vars: chat.vars || vars
    });
  } catch (error) {
    console.error('[LOAD_TEST] seed-client falhou', error);
    return res.status(500).json({ error: error?.message || 'Falha ao criar cliente de teste' });
  }
});

export default router;
