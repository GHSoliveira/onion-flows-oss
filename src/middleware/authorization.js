import { managerCan } from '../services/managerPermissions.js';
import { resolverCargo, temPermissao } from '../services/cargos.js';

// `manager`: permissao extra que tambem libera a rota para um MANAGER que a
// tenha marcada. So soma: quem ja passava pelo papel continua passando igual.
//
// `permission`: permissao do catalogo de cargos (ou lista: basta uma). Vale
// para quem ja tem nivel gravado (user.cargo); quem esta no modelo antigo
// segue pelo papel. O teste de equivalencia garante que A4, B1, C6 e Z7 liberam
// aqui exatamente o que os papeis de hoje liberam.
export const authorize = (roles, { manager = null, permission = null } = {}) => (req, res, next) => {
  if (req.user.role === 'SUPER_ADMIN') {
    return next();
  }
  if (permission && resolverCargo(req.user).modelo === 'cargo') {
    const lista = Array.isArray(permission) ? permission : [permission];
    if (lista.some((item) => temPermissao(req.user, item))) return next();
    return res.status(403).json({ error: 'Acesso negado' });
  }
  if (!roles.includes(req.user.role) && !(manager && managerCan(req.user, manager))) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
};

export const requireSuperAdminPermission = (required = []) => (req, res, next) => {
  if (req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Acesso negado' });
  }

  const permissions = Array.isArray(req.user.permissions) ? req.user.permissions : [];
  if (permissions.includes('*') || permissions.includes('ALL')) {
    return next();
  }

  if (required.length === 0) {
    return next();
  }

  if (permissions.length === 0) {
    return res.status(403).json({ error: 'Permissao insuficiente' });
  }

  const ok = required.every(p => permissions.includes(p));
  if (!ok) {
    return res.status(403).json({ error: 'Permissão insuficiente' });
  }
  next();
};
