import express from 'express';
import { handleWhatsAppWebhook } from '../services/whatsappHandler.js';
import { findWhatsAppConfigByPhoneNumberId, getAllWhatsAppConfigs, getWhatsAppConfig } from '../services/channelConfig.js';
import { verifyWhatsAppSignature } from '../services/whatsappApi.js';
import { notifyWhatsAppProblem } from '../services/whatsappAlerts.js';
import { enqueueWhatsAppWebhook } from '../queues/webhookQueue.js';
import { isBullMqEnabled } from '../services/redisClient.js';
import { createLocalQueue } from '../services/localWebhookQueue.js';
import { getQueueConcurrency, QUEUE_NAMES } from '../queues/index.js';

const router = express.Router();

// Sem Redis o webhook roda nesta fila em memoria, com o mesmo limite da fila Redis.
const localWebhookQueue = createLocalQueue({
  concurrency: getQueueConcurrency(QUEUE_NAMES.whatsappWebhook),
  handler: ({ payload, tenantId }) => handleWhatsAppWebhook({ payload, tenantId }),
  onFailure: (error, job, attempts) => {
    console.error('Erro processamento webhook WhatsApp:', { tenantId: job?.tenantId || null, attempts, error: error?.message || error });
  }
});

// Credenciais do app Meta da propria Onion. Com Embedded Signup existe um app so
// para todos os clientes, entao estes valores sao a fonte primaria de verificacao.
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || null;
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || null;
const LEGACY_PER_TENANT_SECRET = String(
  process.env.WHATSAPP_LEGACY_PER_TENANT_SECRET || 'true'
).toLowerCase() === 'true';

// Com um segredo unico a assinatura nao identifica mais de quem e a mensagem: o
// tenant passa a sair do phone_number_id que a Meta manda no proprio payload.
const extractPhoneNumberId = (payload) => {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const id = change?.value?.metadata?.phone_number_id;
      if (id) return String(id);
    }
  }
  return null;
};

// Webhook replay protection — track recent payloads by signature hash
const recentWebhooks = new Map();
const WEBHOOK_DEDUP_TTL = 60_000; // 60s window
const WEBHOOK_DEDUP_MAX = 5000;

const isReplay = (signature) => {
  if (!signature) return false;
  const now = Date.now();
  if (recentWebhooks.has(signature)) return true;
  recentWebhooks.set(signature, now);
  // Cleanup old entries periodically
  if (recentWebhooks.size > WEBHOOK_DEDUP_MAX) {
    for (const [key, ts] of recentWebhooks) {
      if (now - ts > WEBHOOK_DEDUP_TTL) recentWebhooks.delete(key);
      if (recentWebhooks.size <= WEBHOOK_DEDUP_MAX / 2) break;
    }
  }
  return false;
};

router.get('/webhook', async (req, res) => {
  try {
    const tenantId = req.query.tenantId || null;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('[WHATSAPP] Verification request', {
      tenantId,
      mode: mode || null,
      hasToken: Boolean(token),
      hasChallenge: Boolean(challenge)
    });

    if (!mode || !token || !challenge) {
      return res.status(400).send('Missing verification params');
    }

    if (mode !== 'subscribe') {
      return res.status(403).send('Forbidden');
    }

    // Caminho primario: token global do app da Onion.
    if (VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }

    // Fallback legado: tenants que ainda tem token proprio cadastrado.
    if (LEGACY_PER_TENANT_SECRET) {
      const config = tenantId ? await getWhatsAppConfig(tenantId) : null;
      if (config?.webhookVerifyToken && token === config.webhookVerifyToken) {
        return res.status(200).send(challenge);
      }
      if (!tenantId) {
        const configs = await getAllWhatsAppConfigs();
        const match = configs.find((entry) => entry?.whatsapp?.webhookVerifyToken === token);
        if (match) {
          return res.status(200).send(challenge);
        }
      }
    }

    return res.status(403).send('Forbidden');
  } catch (error) {
    return res.status(500).send('Internal error');
  }
});

router.post('/webhook', async (req, res) => {
  try {
    const tenantId = req.query.tenantId || null;
    const rawBody = req.rawBody ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));

    console.log('[WHATSAPP] Webhook payload received', {
      tenantId,
      bodyType: typeof req.body,
      entryCount: Array.isArray(req.body?.entry) ? req.body.entry.length : 0
    });

    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      console.warn('[WHATSAPP] Webhook sem assinatura', { tenantId });
      await notifyWhatsAppProblem({
        operation: 'webhook_missing_signature',
        tenantId,
        data: { error: { message: 'Webhook WhatsApp sem assinatura' } }
      });
      return res.status(401).json({ error: 'Missing signature' });
    }

    // Caminho primario: um app Meta so, o da Onion. O segredo global valida a
    // assinatura de todos os clientes conectados por Embedded Signup.
    let matchedTenantId = tenantId || null;
    let isValid = Boolean(APP_SECRET) && verifyWhatsAppSignature(rawBody, signature, APP_SECRET);

    // Fallback legado: tenants que ainda tem o proprio app Meta cadastrado.
    // Enquanto existir algum, este laco continua sendo a unica forma de validar
    // a assinatura deles. Desliga com WHATSAPP_LEGACY_PER_TENANT_SECRET=false.
    if (!isValid && LEGACY_PER_TENANT_SECRET) {
      const tenantSecret = tenantId ? (await getWhatsAppConfig(tenantId))?.appSecret : null;
      if (tenantSecret && verifyWhatsAppSignature(rawBody, signature, tenantSecret)) {
        isValid = true;
      } else if (!tenantId) {
        const configs = await getAllWhatsAppConfigs();
        for (const entry of configs) {
          const candidateSecret = entry?.whatsapp?.appSecret || null;
          if (!candidateSecret) continue;
          if (verifyWhatsAppSignature(rawBody, signature, candidateSecret)) {
            isValid = true;
            matchedTenantId = entry.tenantId || null;
            break;
          }
        }
      }
    }
    if (!isValid) {
      console.warn('[WHATSAPP] Assinatura invalida no webhook', {
        tenantId,
        matchedTenantId,
        hasSignature: Boolean(signature)
      });
      await notifyWhatsAppProblem({
        operation: 'webhook_signature',
        tenantId: matchedTenantId || tenantId || null,
        data: { error: { message: 'Assinatura invalida no webhook WhatsApp' } }
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Replay protection — reject duplicate webhooks
    if (isReplay(signature)) {
      return res.json({ ok: true, skipped: 'duplicate' });
    }

    const payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;

    // Quando a assinatura veio do segredo global, ela nao diz de quem e a
    // mensagem. Resolve pelo numero que a Meta identifica no payload.
    if (!matchedTenantId) {
      const phoneNumberId = extractPhoneNumberId(payload);
      if (phoneNumberId) {
        const match = await findWhatsAppConfigByPhoneNumberId(phoneNumberId);
        matchedTenantId = match?.tenantId || null;
        if (!matchedTenantId) {
          // Numero autentico do nosso app, mas sem tenant vinculado ainda. Pode
          // ser onboarding pela metade. Responder 200: erro faria a Meta
          // reenviar em loop por horas.
          console.warn('[WHATSAPP] Numero sem tenant vinculado', { phoneNumberId });
          return res.json({ ok: true, skipped: 'unmapped_phone_number' });
        }
      }
    }

    // Conta pausada por cobranca segue o caminho normal: a mensagem e gravada e
    // so o bot deixa de responder (whatsappHandler), para nada se perder.
    if (isBullMqEnabled()) {
      try {
        const job = await enqueueWhatsAppWebhook({
          payload,
          tenantId: matchedTenantId,
          signature
        });
        if (job) {
          return res.json({ ok: true, accepted: true, queued: true });
        }
        console.warn('[WHATSAPP] BullMQ indisponivel no webhook; usando fallback setImmediate', {
          tenantId: matchedTenantId || tenantId || null
        });
      } catch (error) {
        console.warn('[WHATSAPP] Falha ao enfileirar webhook; usando fallback setImmediate', {
          tenantId: matchedTenantId || tenantId || null,
          error: error?.message || 'queue_failed'
        });
      }
    }

    res.json({ ok: true, accepted: true });
    localWebhookQueue.push({ payload, tenantId: matchedTenantId });
    return;
  } catch (error) {
    console.error('Erro webhook WhatsApp:', error);
    return res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
