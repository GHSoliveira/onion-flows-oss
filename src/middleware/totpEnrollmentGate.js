/**
 * Gate de enrollment de TOTP para SUPER_ADMIN.
 *
 * Quando TOTP_REQUIRED_FOR_SUPER_ADMIN=true, todo SUPER_ADMIN sem TOTP
 * configurado é redirecionado para /security pra completar o enrollment
 * antes de poder usar o resto da API.
 *
 * Implementação: middleware roda após `authenticate`. Se a flag estiver ativa
 * e o usuário for SUPER_ADMIN sem `totp.enabled`, responde 412 com
 * `code: 'totp_enrollment_required'`. O frontend intercepta esse código e
 * leva o usuário para `/security`.
 *
 * Algumas rotas são SEMPRE permitidas (allow-list) porque são justamente
 * onde o enrollment acontece:
 *   - /api/auth/totp/*       (setup, confirm)
 *   - /api/auth/logout       (sair sem ficar trancado)
 *   - /api/auth/heartbeat    (manter sessão viva enquanto cadastra)
 *   - /api/tenant/current    (front precisa pra montar a tela)
 *
 * Para qualquer outra rota, o gate dispara.
 */

const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
const enforcementEnabled = truthy(process.env.TOTP_REQUIRED_FOR_SUPER_ADMIN);

const ALLOWED_PATHS = [
  /^\/api\/auth\/totp(\/|$)/,
  /^\/api\/auth\/logout$/,
  /^\/api\/auth\/heartbeat$/,
  /^\/api\/auth\/confirm-password$/,
  /^\/api\/tenant\/current$/
];

const isAllowedPath = (req) => {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return ALLOWED_PATHS.some((re) => re.test(path));
};

export const totpEnrollmentGate = (req, res, next) => {
  if (!enforcementEnabled) return next();
  if (!req.user) return next();
  if (req.user.role !== 'SUPER_ADMIN') return next();
  if (req.user.totp?.enabled) return next();
  if (isAllowedPath(req)) return next();
  return res.status(412).json({
    error: 'Configure o segundo fator (TOTP) antes de prosseguir.',
    code: 'totp_enrollment_required'
  });
};
