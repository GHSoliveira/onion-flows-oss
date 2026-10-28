/**
 * Limiters dedicados a operações irreversíveis ou de alto impacto.
 *
 * Usados acima e além do apiLimiter global (200 req/min). Aplicados em rotas
 * específicas como delete de tenant, close-all chats, geração de token
 * externo, erase/export de titular. Reduz o estrago possível por uma
 * credencial admin comprometida antes da revogação.
 */
import rateLimit from 'express-rate-limit';

const isDev = String(process.env.NODE_ENV || '').toLowerCase() !== 'production';

export const destructiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isDev ? 100 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de operações destrutivas atingido. Tente novamente em 1 hora.' }
});

export const dataSubjectLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isDev ? 200 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de solicitações de titular atingido. Tente novamente em 1 hora.' }
});

// Reports CSV: limite por IP para evitar exfiltração em massa por uma sessão
// comprometida. O ADMIN normalmente baixa o pacote completo 1-2 vezes por dia.
export const turizmoInboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 600 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    code: 'integration_rate_limit_exceeded',
    message: 'Limite de requisicoes da integracao atingido.'
  }
});

export const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isDev ? 100 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de exportações de relatório atingido. Tente novamente em 1 hora.' }
});
