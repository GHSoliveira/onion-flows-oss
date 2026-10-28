import crypto from 'crypto';

export const correlationId = (req, res, next) => {
  const incoming = String(req.headers['x-correlation-id'] || '').trim();
  req.correlationId = incoming && incoming.length <= 128 ? incoming : crypto.randomUUID();
  res.setHeader('X-Correlation-Id', req.correlationId);
  next();
};

