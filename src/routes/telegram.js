import express from 'express';
import { handleTelegramUpdate } from '../services/telegramHandler.js';
import { getTelegramConfig } from '../services/channelConfig.js';
import { timingSafeSecretEqual } from '../middleware/turizmoInboundAuth.js';

const router = express.Router();

// Replay protection — track recent update_ids
const recentUpdateIds = new Map();
const TG_DEDUP_TTL = 60_000;
const TG_DEDUP_MAX = 5000;

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const handleWebhook = async (req, res, tenantId = null) => {
  try {
    const config = tenantId ? await getTelegramConfig(tenantId) : null;
    const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
    const expectedSecret = config?.webhookSecret || process.env.TELEGRAM_WEBHOOK_SECRET || null;
    if (!expectedSecret) {
      return res.status(503).json({ error: 'Webhook secret not configured' });
    }
    if (!secretHeader || !timingSafeSecretEqual(secretHeader, expectedSecret)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Replay protection
    const updateId = req.body?.update_id;
    if (updateId !== undefined) {
      const now = Date.now();
      if (recentUpdateIds.has(updateId)) {
        return res.json({ ok: true, skipped: 'duplicate' });
      }
      recentUpdateIds.set(updateId, now);
      if (recentUpdateIds.size > TG_DEDUP_MAX) {
        for (const [key, ts] of recentUpdateIds) {
          if (now - ts > TG_DEDUP_TTL) recentUpdateIds.delete(key);
          if (recentUpdateIds.size <= TG_DEDUP_MAX / 2) break;
        }
      }
    }

    // Conta pausada por cobranca: a mensagem e gravada e o bot nao responde
    // (telegramHandler).

    await handleTelegramUpdate(req.body, config ? {
      tenantId,
      flowId: config.flowId || null,
      botToken: config.botToken || null
    } : null);
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro Telegram webhook:', error);
    res.status(500).json({ error: 'internal_error' });
  }
};

router.post('/webhook', async (req, res) => {
  const tenantId = req.query.tenantId || null;
  return handleWebhook(req, res, tenantId);
});

router.post('/webhook/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  return handleWebhook(req, res, tenantId);
});

export default router;
