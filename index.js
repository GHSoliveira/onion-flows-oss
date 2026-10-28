import './src/config/env.js';
import { existsSync } from 'node:fs';
import { recursosAgora } from './src/services/hostResources.js';
import { captureError, flushErrorTracking, initErrorTracking } from './src/services/errorTracking.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import adapter from './db/DatabaseAdapter.js';
import { setIo } from './src/services/logs.js';
import { handleSocketConnected, handleSocketDisconnected } from './src/services/socketPresence.js';
import { authenticate } from './src/middleware/auth.js';
import { authRouter } from './src/routes/index.js';
import { tenantsRouter } from './src/routes/index.js';
import { usersRouter } from './src/routes/index.js';
import { flowsRouter } from './src/routes/index.js';
import { subflowsRouter } from './src/routes/index.js';
import { variablesRouter } from './src/routes/index.js';
import { templatesRouter } from './src/routes/index.js';
import { schedulesRouter } from './src/routes/index.js';
import { queuesRouter } from './src/routes/index.js';
import { tagsRouter } from './src/routes/index.js';
import { webhooksRouter } from './src/routes/index.js';
import { chatsRouter } from './src/routes/index.js';
import { cannedResponsesRouter } from './src/routes/index.js';
import { logsRouter } from './src/routes/index.js';
import { superAdminRouter } from './src/routes/index.js';
import { superAdminIpWhitelist, superAdminIpCheck } from './src/middleware/superAdminIp.js';
import { tenantCurrentHandler } from './src/routes/index.js';
import { telegramRouter } from './src/routes/index.js';
import { channelsRouter } from './src/routes/index.js';
import { whatsappRouter } from './src/routes/index.js';
import { metricsRouter } from './src/routes/index.js';
import { catalogRouter } from './src/routes/index.js';
import { mediaRouter } from './src/routes/index.js';
import { contactsRouter } from './src/routes/index.js';
import { reportsRouter } from './src/routes/index.js';
import { analyticsRouter } from './src/routes/index.js';
import { loadTestRouter } from './src/routes/index.js';
import { systemRouter } from './src/routes/index.js';
import { tenantModulesRouter } from './src/routes/index.js';
import { brandingRouter } from './src/routes/index.js';
import { partnerBillingWebhookRouter, partnerRouter, partnersAdminRouter } from './src/routes/partner.js';
import { startPartnerBillingWorker, stopPartnerBillingWorker } from './src/services/partnerBilling.js';
import cargosRouter from './src/routes/cargos.js';
import restIntegrationsRouter from './src/routes/restIntegrations.js';
import { isAgencyOrigin } from './src/services/partnerDomains.js';
import flowAssistantRouter from './src/routes/flowAssistant.js';
import { findPartnerTenant } from './src/services/partners.js';
import { outreachRouter, voiceCallsRouter, cadencesRouter, classificationsRouter, integrationsRouter, turizmoInboundRouter, tasksRouter, attendanceRoutingRouter, documentationRouter } from './src/routes/index.js';
import { startTelegramPolling } from './src/services/telegramPolling.js';
import { startDbChangeLogger } from './src/services/dbChangeLogger.js';
import { startOutreachCampaignWorker, stopOutreachCampaignWorker } from './src/services/outreachCampaignWorker.js';
import { startChatRuntimeWatcher } from './src/services/chatRuntimeWatcher.js';
import { startDataRetentionWorker } from './src/services/dataRetentionWorker.js';
import { startWhatsAppInsightsSync } from './src/services/whatsappAccountInsights.js';
import { repairAllChatStates } from './src/services/chatStateGuard.js';
import { closeRedis, getRedisStatus, initRedis, isBullMqEnabled } from './src/services/redisClient.js';
import { closeQueues } from './src/queues/index.js';
import { closeBullMqWorkers, startBullMqWorkers } from './src/workers/index.js';
import { startCommercialRuntimeWorker, stopCommercialRuntimeWorker } from './src/services/commercialRuntimeWorker.js';
import { correlationId } from './src/middleware/correlationId.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET_VALUE } from './src/config/constants.js';
import {
  registerExtensionAtendimentoHandlers,
  isExtensionSocket,
  extensionRoomForAgent
} from './src/services/extensionAtendimento.js';

// Antes de montar rotas e workers, para os erros deles ja irem ao Sentry.
await initErrorTracking();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const NODE_ENV = process.env.NODE_ENV || 'development';
const DEFAULT_MEDIA_MAX_UPLOAD_BYTES = 70 * 1024 * 1024;
const MEDIA_MAX_UPLOAD_BYTES = Number.parseInt(
  process.env.MEDIA_MAX_UPLOAD_BYTES || `${DEFAULT_MEDIA_MAX_UPLOAD_BYTES}`,
  10
);
const MEDIA_JSON_LIMIT_BYTES = Math.ceil(
  (Number.isFinite(MEDIA_MAX_UPLOAD_BYTES) ? MEDIA_MAX_UPLOAD_BYTES : DEFAULT_MEDIA_MAX_UPLOAD_BYTES) * 1.45
  + (1024 * 1024)
);
const MEDIA_JSON_LIMIT = `${Math.max(16, Math.ceil(MEDIA_JSON_LIMIT_BYTES / (1024 * 1024)))}mb`;
const envFlag = (name, defaultValue = false) => {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return defaultValue;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
};
const CHAT_STATE_REPAIR_ON_BOOT = envFlag('CHAT_STATE_REPAIR_ON_BOOT', false);
const CHAT_RUNTIME_WATCHER_ENABLED = envFlag('CHAT_RUNTIME_WATCHER_ENABLED', false);
const DB_CHANGE_LOGGER_ENABLED = envFlag('DB_CHANGE_LOGGER_ENABLED', false);
const OUTREACH_CAMPAIGN_WORKER_ENABLED = envFlag('OUTREACH_CAMPAIGN_WORKER_ENABLED', true);

if (envFlag('TURIZMO_INTEGRATION_ENABLED', false) && !String(process.env.TURIZMO_INBOUND_API_KEY || '').trim()) {
  console.warn('[TURIZMO_INBOUND] Endpoints S2S desabilitados: TURIZMO_INBOUND_API_KEY nao configurada.');
}

try {
  await adapter.init();
  await initRedis();
  console.log('✅ Banco de dados inicializado');
  if (CHAT_STATE_REPAIR_ON_BOOT) {
    const chatRepairSummary = await repairAllChatStates({ log: true });
    if (chatRepairSummary?.repaired) {
      console.log(`[CHAT_STATE_GUARD] ${chatRepairSummary.repaired} chats reparados na inicializacao`);
    }
  } else {
    console.log('[CHAT_STATE_GUARD] Reparacao inicial desligada por configuracao');
  }
  if (DB_CHANGE_LOGGER_ENABLED) {
    await startDbChangeLogger();
  } else {
    console.log('[DB_CHANGE_LOGGER] Desligado por configuracao');
  }
  await startBullMqWorkers();
  const bullMqOperational = isBullMqEnabled() && getRedisStatus().ready;
  startCommercialRuntimeWorker({ bullMqOperational });
  if (NODE_ENV !== 'test') startPartnerBillingWorker();
  if (OUTREACH_CAMPAIGN_WORKER_ENABLED && !bullMqOperational) {
    startOutreachCampaignWorker();
  } else if (OUTREACH_CAMPAIGN_WORKER_ENABLED && bullMqOperational) {
    console.log('[OUTREACH_CAMPAIGN_WORKER] Worker local substituido por BullMQ');
  } else {
    console.log('[OUTREACH_CAMPAIGN_WORKER] Desligado por configuracao');
  }
  if (CHAT_RUNTIME_WATCHER_ENABLED) {
    startChatRuntimeWatcher();
  } else {
    console.log('[CHAT_RUNTIME_WATCHER] Desligado por configuracao');
  }
  startDataRetentionWorker();
  startWhatsAppInsightsSync();
} catch (error) {
  console.error('❌ Falha ao conectar ao banco de dados:', error.message);
  process.exit(1);
}

const app = express();
// behind reverse proxies (cloudflared, etc.)
app.set('trust proxy', 1);
const httpServer = createServer(app);
app.use(compression());
app.use(correlationId);

// Helmet - Headers de segurança HTTP.
// styleSrc continua aceitando 'unsafe-inline' porque React + react-flow usam
// `style={{}}` inline em massa (posicionamento de nodes, transforms, handles).
// Refatorar para CSS classes não é viável sem trocar a lib do editor de fluxo.
// scriptSrc continua restrito a 'self' — XSS por <script> injetado bloqueado.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: [
        "'self'",
        ...(NODE_ENV === 'development' ? ["http://localhost:3001", "ws://localhost:3001"] : []),
        ...(CLIENT_URL ? [CLIENT_URL, CLIENT_URL.replace('https://', 'wss://')] : []),
      ],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS - permitir origens explicitas de desenvolvimento e producao
const isSandboxRuntime = () => {
  const adapter = String(process.env.DB_ADAPTER || '').toLowerCase();
  return adapter === 'json'
    || String(process.env.USE_JSON_DB || '').toLowerCase() === 'true'
    || String(process.env.SANDBOX_SEED_ENDPOINT || '').toLowerCase() === 'true';
};

const clientUrlVariants = (url) => {
  if (!url) return [];
  const parts = String(url).split(',').map((part) => part.trim().replace(/\/$/, '')).filter(Boolean);
  const variants = [];
  for (const raw of parts) {
    variants.push(raw);
    try {
      const parsed = new URL(raw);
      if (parsed.hostname === 'localhost') {
        variants.push(`${parsed.protocol}//127.0.0.1${parsed.port ? `:${parsed.port}` : ''}`);
      } else if (parsed.hostname === '127.0.0.1') {
        variants.push(`${parsed.protocol}//localhost${parsed.port ? `:${parsed.port}` : ''}`);
      }
    } catch {
      // ignore invalid CLIENT_URL entries
    }
  }
  return variants;
};

const developmentOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:30999',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:30999',
  ...clientUrlVariants(CLIENT_URL),
  ...clientUrlVariants(process.env.SOCKET_CORS_ORIGIN)
];

const productionOrigins = [
  ...clientUrlVariants(CLIENT_URL)
].filter(Boolean);

const allowedOrigins = [...new Set([
  ...(NODE_ENV === 'development' || isSandboxRuntime() ? developmentOrigins : []),
  ...productionOrigins
])];

const isLocalDevOrigin = (origin) => {
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Endereco proprio de agencia parceira (agencia.<AGENCY_ROOT_DOMAIN>)
  if (isAgencyOrigin(origin)) return true;
  // Local sandbox/dev: any localhost/127.0.0.1 port (Vite, preview, etc.)
  if ((NODE_ENV === 'development' || isSandboxRuntime()) && isLocalDevOrigin(origin)) return true;
  // Cloudflare quick tunnels (free local testing without VPS)
  if ((NODE_ENV === 'development' || isSandboxRuntime()) && /\.trycloudflare\.com$/i.test(origin)) return true;
  return false;
};

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    // Nao lanca Error: evita 500 unhandled; so recusa a origem
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  // O navegador guarda a liberacao por 10 min; sem isso refaz o OPTIONS a
  // cada 5 s e cada chamada do painel paga uma ida e volta a mais.
  maxAge: 600
}));

// Socket.IO com CORS
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: function(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Rate limiting para Socket.IO - controlar conexões por IP
const socketConnections = new Map();
// Browser do agente + extensão Genesys no mesmo IP
const SOCKET_MAX_CONNECTIONS_PER_IP = 12;
const SOCKET_RATE_LIMIT_WINDOW = 60000;
const socketMessageLimits = new Map();

io.use((socket, next) => {
  const clientIp = socket.handshake.address || socket.handshake.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  
  // Limitar conexões por IP
  const currentConnections = socketConnections.get(clientIp) || 0;
  if (currentConnections >= SOCKET_MAX_CONNECTIONS_PER_IP) {
    return next(new Error('Too many connections from this IP'));
  }
  
  // Registrar conexão
  socketConnections.set(clientIp, currentConnections + 1);
  
  socket.on('disconnect', () => {
    const count = socketConnections.get(clientIp) || 1;
    if (count <= 1) {
      socketConnections.delete(clientIp);
    } else {
      socketConnections.set(clientIp, count - 1);
    }
  });
  
  next();
});

// Reject socket connections without valid JWT
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET_VALUE);
    if (!decoded?.userId || !adapter.db) return next(new Error('Invalid token'));
    const user = await adapter.db.collection('users')
      .findOne({ id: decoded.userId }, { projection: { tenantId: 1, role: 1, name: 1, username: 1, partnerId: 1 } });
    if (!user) return next(new Error('User not found'));
    socket.userId = decoded.userId;
    socket.tenantId = user.tenantId || null;
    socket.userRole = user.role || null;
    socket.partnerId = user.partnerId || null;
    socket.userName = user.name || user.username || 'Agente';
    // Extensao Genesys: auth.client / auth.source = 'genesys-extension' | 'extension' | ...
    const clientKind = String(
      socket.handshake?.auth?.client
      || socket.handshake?.auth?.source
      || socket.handshake?.query?.client
      || 'app'
    ).trim().toLowerCase();
    socket.clientKind = clientKind;
    socket.isGenesysExtension = isExtensionSocket(socket);
    next();
  } catch (_) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address || 'unknown';

  // Join tenant room (user already authenticated by io.use middleware above)
  if (socket.tenantId) {
    socket.join(`tenant:${socket.tenantId}`);
  }
  if (socket.userId) {
    socket.join(`agent:${socket.userId}`);
    socket.join(`user:${socket.userId}`);
    // Room dedicada da extensao (fase 4: cmds app → extensao)
    if (socket.isGenesysExtension) {
      socket.join(extensionRoomForAgent(socket.userId));
      console.log(`[EXT] Extensao Genesys conectada agent=${socket.userId}`);
    }
  }
  if (socket.userRole === 'SUPER_ADMIN') {
    socket.join('role:SUPER_ADMIN');
  }

  // Painel conectado = online. Depois de um reinicio, o monitoramento volta
  // certo assim que os paineis reconectam, sem esperar login ou heartbeat.
  handleSocketConnected(io, socket).catch(() => {});

  socket.on('subscribe_tenant', async (tenantId) => {
    const requestedTenantId = String(tenantId || '').trim();
    if (!requestedTenantId) return;

    if (socket.userRole === 'SUPER_ADMIN' || String(socket.tenantId || '') === requestedTenantId) {
      socket.join(`tenant:${requestedTenantId}`);
      return;
    }
    // Parceiro so recebe o tempo real dos clientes da propria carteira.
    if (socket.userRole === 'PARTNER' && await findPartnerTenant(socket.partnerId, requestedTenantId).catch(() => null)) {
      socket.join(`tenant:${requestedTenantId}`);
    }
  });

  // Genesys: ext:atendimento:* (in) + cmd:* (out) + cmd:resultado (ack)
  registerExtensionAtendimentoHandlers(socket);

  // Rate limiting por socket (extensao + app podem gerar mais eventos)
  socket.use((event, next) => {
    const now = Date.now();
    const key = `${clientIp}:${socket.id}`;
    const userMessages = socketMessageLimits.get(key) || { count: 0, resetTime: now + SOCKET_RATE_LIMIT_WINDOW };
    
    if (now > userMessages.resetTime) {
      userMessages.count = 0;
      userMessages.resetTime = now + SOCKET_RATE_LIMIT_WINDOW;
    }
    
    if (userMessages.count >= 300) {
      return next(new Error('Rate limit exceeded'));
    }
    
    userMessages.count++;
    socketMessageLimits.set(key, userMessages);
    next();
  });
  
  socket.on('error', (err) => {
    if (err.message !== 'Rate limit exceeded') {
      console.error('Socket error:', err.message);
    }
  });

  socket.on('disconnect', () => {
    handleSocketDisconnected(io, socket).catch(() => {});
    const rateKey = `${clientIp}:${socket.id}`;
    socketMessageLimits.delete(rateKey);
  });
});

setIo(io);

// Upload de midia em base64 precisa de payload maior que o tamanho real do arquivo.
app.use('/api/media/assets', express.json({ limit: MEDIA_JSON_LIMIT }));
app.use('/api/integrations/turizmo/media/assets', express.json({ limit: MEDIA_JSON_LIMIT }));
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb', charset: 'utf-8' }));

app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    return origJson(body);
  };
  next();
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: NODE_ENV === 'development' ? 1000 : 200,
  skip: (req) => req.path === '/whatsapp/webhook',
  message: { error: "Limite de requisições excedido" }
});


app.use('/api/whatsapp/webhook', (req, res, next) => {
  try {
    console.log('[WHATSAPP] Webhook hit', {
      method: req.method,
      // A verificacao da Meta manda o verify token na query: nao vai para o log.
      path: String(req.originalUrl || req.url || '').replace(/(hub\.verify_token=)[^&]*/i, '$1***'),
      tenantId: req.query?.tenantId || null,
      hasSignature: Boolean(req.headers['x-hub-signature-256']),
      userAgent: req.headers['user-agent'] || null
    });
  } catch (error) {
    console.warn('[WHATSAPP] Falha ao registrar hit do webhook', error?.message || error);
  }
  next();
});

app.use('/api', apiLimiter);

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// Publico e proposital: e o que os monitores de uptime consultam. Por isso nao
// devolve release nem versao do Node, que sao dados de infraestrutura; esses
// ficam em /api/super-admin/version, autenticado.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});
// Pergunta de verdade ao banco (antes so olhava se o adaptador tinha
// inicializado, e o Supabase fora do ar seguia "ready"). Resultado guardado
// por 10 s para o monitor de uptime nao virar carga.
let databaseProbe = { at: 0, ready: false };
const probeDatabase = async () => {
  if (Date.now() - databaseProbe.at < 10000) return databaseProbe.ready;
  let ready = Boolean(adapter.db);
  if (ready && typeof adapter.pool?.query === 'function') {
    ready = await Promise.race([
      adapter.pool.query('select 1').then(() => true, () => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000).unref())
    ]);
  }
  databaseProbe = { at: Date.now(), ready };
  return ready;
};
// Interruptor para testar o alerta do monitor de uptime (ou tirar o servidor
// do ar para o monitor sem derrubar o atendimento): com o arquivo presente, so
// o ready responde 503. `touch` liga, `rm` desliga, sem reiniciar.
const HEALTH_FORCE_FAIL_FILE = process.env.HEALTH_FORCE_FAIL_FILE || '/opt/onion-flows/shared/health-force-fail';
app.get('/health/ready', async (req, res) => {
  if (existsSync(HEALTH_FORCE_FAIL_FILE)) {
    return res.status(503).json({ status: 'not_ready', reason: 'forced' });
  }
  const redis = getRedisStatus();
  const databaseReady = await probeDatabase();
  const redisRequired = String(process.env.REDIS_ENABLED || '').toLowerCase() === 'true';
  const ready = databaseReady && (!redisRequired || redis.ready);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    database: { ready: databaseReady },
    redis: { enabled: redisRequired, ready: Boolean(redis.ready) }
  });
});

// Memoria e carga da VPS para o monitor de uptime: 503 quando algum passa do
// limite. Publico como os outros, entao so diz o motivo, nunca os numeros.
// O arquivo de teste faz responder 503 sem mexer no resto, para conferir o alerta.
const HEALTH_RECURSOS_FORCE_FAIL_FILE = process.env.HEALTH_RECURSOS_FORCE_FAIL_FILE || '/opt/onion-flows/shared/health-recursos-force-fail';
app.get('/health/recursos', (req, res) => {
  const { ok, problemas } = existsSync(HEALTH_RECURSOS_FORCE_FAIL_FILE)
    ? { ok: false, problemas: ['forced'] }
    : recursosAgora();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'alerta', problemas });
});

app.get('/api/tenant/current', authenticate, tenantCurrentHandler);

app.use('/api/auth', authRouter);
// superAdminIpCheck only restricts SUPER_ADMIN sessions; ADMIN/MANAGER/AGENT bypass it.
// Apply on routes that expose tenant-wide or cross-tenant admin actions.
app.use('/api/tenants', superAdminIpCheck, tenantsRouter);
app.use('/api/users', superAdminIpCheck, usersRouter);
app.use('/api/flows', superAdminIpCheck, flowsRouter);
app.use('/api/variables', variablesRouter);
app.use('/api/templates', superAdminIpCheck, templatesRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/queues', superAdminIpCheck, queuesRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/webhooks', superAdminIpCheck, webhooksRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/cannedResponses', cannedResponsesRouter);
app.use('/api/logs', superAdminIpWhitelist, logsRouter);
app.use('/api/super-admin', superAdminIpWhitelist, superAdminRouter);
app.use('/api/telegram', telegramRouter);
app.use('/api/subflows', subflowsRouter);
app.use('/api/channels', superAdminIpCheck, channelsRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/media', mediaRouter);
app.use('/api/contacts', contactsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/load-test', loadTestRouter);
app.use('/api/system', superAdminIpCheck, systemRouter);
app.use('/api/tenant-modules', superAdminIpCheck, tenantModulesRouter);
app.use('/api/branding', brandingRouter);
app.use('/api/partner', partnerRouter);
app.use('/api/cargos', cargosRouter);
app.use('/api/rest-integrations', restIntegrationsRouter);
app.use('/api/flow-assistant', flowAssistantRouter);
app.use('/api/partners', superAdminIpCheck, partnersAdminRouter);
app.use('/api/billing', partnerBillingWebhookRouter);
app.use('/api/outreach', superAdminIpCheck, outreachRouter);
app.use('/api/voice-calls', superAdminIpCheck, voiceCallsRouter);
app.use('/api/cadences', superAdminIpCheck, cadencesRouter);
app.use('/api/classifications', superAdminIpCheck, classificationsRouter);
app.use('/api/integrations/turizmo', turizmoInboundRouter);
app.use('/api/integrations', superAdminIpCheck, integrationsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/attendance-routing', superAdminIpCheck, attendanceRoutingRouter);
app.use('/api/documentation', documentationRouter);
app.use('/uploads', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  // Defense in depth: mesmo com a validação por magic bytes no upload, evita
  // que o navegador interprete um arquivo como tipo diferente do declarado e
  // bloqueia execução cross-origin de scripts ou plugins.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Não tipos inline (PDF/áudio/vídeo) — viraram download. Imagens continuam
  // exibíveis. Express.static define Content-Type por extensão; abaixo só
  // adicionamos Content-Disposition quando não for um tipo "inline-safe".
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox");
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  next();
}, express.static(path.join(__dirname, 'uploads')));

app.use(express.static(path.join(__dirname, '../client/dist')));

// Global error handler — hide internal details in production
app.use((err, req, res, _next) => {
  console.error('[UNHANDLED]', err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) captureError(err, { tags: { method: req.method, route: req.route?.path || req.baseUrl || req.path } });
  if (NODE_ENV === 'production' && status >= 500) {
    return res.status(status).json({ error: 'Erro interno do servidor' });
  }
  res.status(status).json({ error: err.message || 'Erro interno do servidor' });
});

httpServer.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  if (process.env.TELEGRAM_USE_POLLING === 'true') {
    console.log('✅ Telegram polling ativo');
    startTelegramPolling();
  }
});

const shutdown = async (signal) => {
  console.log(`[SHUTDOWN] Recebido ${signal}, encerrando Redis/BullMQ`);
  await closeBullMqWorkers();
  stopCommercialRuntimeWorker();
  stopPartnerBillingWorker();
  stopOutreachCampaignWorker();
  await closeQueues();
  await closeRedis();
  await flushErrorTracking();
  process.exit(0);
};

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

export default app;
