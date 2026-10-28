import crypto from 'crypto';
import { envFlag } from '../utils/env.js';

const digest = (value) => crypto
  .createHash('sha256')
  .update(String(value || ''), 'utf8')
  .digest();

export const timingSafeSecretEqual = (provided, expected) => crypto.timingSafeEqual(
  digest(provided),
  digest(expected)
);

export const authenticateTurizmoInbound = (req, res, next) => {
  const configuredKey = String(process.env.TURIZMO_INBOUND_API_KEY || '');
  // Inbound commands and outbound event delivery are independent directions.
  // A configured inbound secret is enough unless an explicit inbound flag is set.
  const enabled = envFlag('TURIZMO_INBOUND_ENABLED', Boolean(configuredKey));

  if (!enabled || !configuredKey) {
    return res.status(503).json({
      code: 'turizmo_inbound_not_configured',
      message: 'Integracao inbound Turizmo nao esta configurada.',
      correlationId: req.correlationId
    });
  }

  const providedKey = String(req.get('X-API-Key') || '');
  if (!providedKey || !timingSafeSecretEqual(providedKey, configuredKey)) {
    return res.status(401).json({
      code: 'invalid_api_key',
      message: 'Chave de integracao ausente ou invalida.',
      correlationId: req.correlationId
    });
  }

  req.integrationActor = {
    id: 'integration:turizmo',
    name: 'Turizmo',
    role: 'SYSTEM'
  };
  next();
};
