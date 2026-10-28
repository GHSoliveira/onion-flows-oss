import express from 'express';
import bcrypt from 'bcrypt';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import adapter from '../../db/DatabaseAdapter.js';
import { userSchema } from '../schemas/index.js';
import { createLog } from '../services/logs.js';
import { ensureTenantLimit } from '../services/tenantLimits.js';
import { generateId } from '../utils/helpers.js';
import { isUsernameTaken } from '../services/passwords.js';
import { normalizeManagerPermissions } from '../services/managerPermissions.js';
import { conferirAtribuicao, normalizarCargo, papelDoNivel, resolverCargo, resumoCargo } from '../services/cargos.js';

const router = express.Router();
// Username e o login e vale para a plataforma toda, nao so para o tenant.
const USERNAME_TAKEN_MESSAGE = 'Esse username ja existe na plataforma. Escolha outro.';
const USER_READ_ROLES = ['ADMIN', 'MANAGER', 'SUPER_ADMIN'];
const USER_WRITE_ROLES = ['ADMIN', 'SUPER_ADMIN'];
// MANAGER com a permissao "equipe" so mexe em atendentes (AGENT): nao cria nem
// edita outro gestor, admin ou a si mesmo, e nao marca permissoes.
const MANAGER_TEAM_ONLY_MESSAGE = 'Gestor so pode gerenciar atendentes.';
const isManagerActor = (req) => req.user?.role === 'MANAGER';
// Permissoes do gestor so valem para MANAGER e so o ADMIN/SUPER_ADMIN marca.
const resolveManagerPermissions = (req, role, incoming, current = []) => {
  if (role !== 'MANAGER') return [];
  if (isManagerActor(req) || incoming === undefined) return normalizeManagerPermissions(current);
  return normalizeManagerPermissions(incoming);
};

router.get('/', authenticate, authorize(USER_READ_ROLES, { permission: 'operacao.ver' }), requireTenant, async (req, res) => {
  try {
    if (!req.tenantId) return res.status(400).json({ error: 'Selecione um tenant para listar usuarios.' });
    const users = await adapter.getCollection('users', req.tenantId);
    const usersWithoutPasswords = users.map(({ password, ...user }) => ({ ...user, cargoEfetivo: resumoCargo(user) }));
    const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);
    const limitRaw = parseInt(req.query.limit || '0', 10) || 0;
    const limit = limitRaw > 0 ? Math.min(Math.max(limitRaw, 1), 500) : 0;

    if (!limit) {
      return res.json(usersWithoutPasswords);
    }

    const total = usersWithoutPasswords.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    const items = usersWithoutPasswords.slice(start, start + limit);
    res.json({ items, total, page, totalPages, limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', authenticate, authorize(USER_WRITE_ROLES, { manager: 'equipe', permission: 'equipe.atendentes' }), requireTenant, async (req, res) => {
  try {
    const { name, username, password, role: rolePedido, queues, tenantId: bodyTenantId, permissions, managerPermissions, email, phone, avatarUrl, availabilityMode, maxConcurrentChats, workSchedule, notificationPreferences } = userSchema.parse(req.body);
    // Com cargo (nivel A/B/C), o papel vem do nivel e quem pode atribuir e
    // decidido pelo cargo de quem cria; sem cargo, valem as regras de antes.
    const cargo = req.body?.cargo ? normalizarCargo(req.body.cargo) : null;
    if (cargo) conferirAtribuicao(req.user, cargo);
    const role = cargo ? papelDoNivel(cargo.nivel) : rolePedido;
    if (!cargo && isManagerActor(req) && (role || 'AGENT') !== 'AGENT') {
      return res.status(403).json({ error: MANAGER_TEAM_ONLY_MESSAGE });
    }
    // So um SUPER_ADMIN cria outro SUPER_ADMIN. Antes o papel pedido passava
    // direto quando quem criava era ADMIN do tenant.
    if (role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Apenas SUPER_ADMIN pode criar outro SUPER_ADMIN' });
    }
    const tenantId = req.user.role === 'SUPER_ADMIN'
      ? (bodyTenantId || req.tenantId || req.user.tenantId)
      : req.tenantId;

    if (!tenantId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(400).json({ error: 'Administrador deve pertencer a um tenant' });
    }

    await ensureTenantLimit(tenantId, 'users');

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('users');

    if (await isUsernameTaken(username)) {
      return res.status(400).json({ error: USERNAME_TAKEN_MESSAGE });
    }

    const nextRole = req.user.role === 'SUPER_ADMIN' && role === 'SUPER_ADMIN' ? 'SUPER_ADMIN' : (role || 'AGENT');
    const user = {
      id: generateId('u'),
      name,
      username,
      password: await bcrypt.hash(password, 10),
      role: nextRole,
      queues: queues || [],
      permissions: req.user.role === 'SUPER_ADMIN' ? (permissions || []) : [],
      managerPermissions: cargo ? [] : resolveManagerPermissions(req, nextRole, managerPermissions),
      ...(cargo ? { cargo } : {}),
      email: email || null,
      phone: phone || null,
      avatarUrl: avatarUrl || null,
      availabilityMode: availabilityMode || 'auto',
      maxConcurrentChats: maxConcurrentChats || null,
      workSchedule: workSchedule || null,
      notificationPreferences: notificationPreferences || { browser: true, sound: true, email: false },
      tenantId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: req.user.id
    };

    await collection.insertOne(user);

    await createLog('USER_CREATE', { id: user.id, name: user.name, tenantId: user.tenantId, role: user.role }, req.user.id);
    const { password: _, ...userWithoutPassword } = user;
    res.status(201).json({ ...userWithoutPassword, cargoEfetivo: resumoCargo(user) });
  } catch (error) {
    if (error.name === 'ZodError') {
      return res.status(400).json({ error: error.errors });
    }
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/:id', authenticate, authorize(USER_WRITE_ROLES, { manager: 'equipe', permission: 'equipe.atendentes' }), async (req, res) => {
  try {
    const { name, username, password, role, queues, managerPermissions, email, phone, avatarUrl, availabilityMode, maxConcurrentChats, workSchedule, notificationPreferences } = req.body || {};
    const nextName = String(name || '').trim();
    const nextUsername = String(username || '').trim();
    const allowedRoles = ['ADMIN', 'MANAGER', 'AGENT', 'SUPER_ADMIN'];
    const nextRole = allowedRoles.includes(role) ? role : 'AGENT';

    if (!nextName) return res.status(400).json({ error: 'Nome e obrigatorio' });
    if (nextUsername.length < 3) return res.status(400).json({ error: 'Username deve ter pelo menos 3 caracteres' });
    if (password && String(password).length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('users');

    const query = { id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.tenantId = req.user.tenantId;
    }

    const user = await collection.findOne(query);
    if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
    if (user.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Apenas SUPER_ADMIN pode alterar outro SUPER_ADMIN' });
    }
    const cargo = req.body?.cargo ? normalizarCargo(req.body.cargo) : null;
    if (cargo) {
      const atual = resolverCargo(user);
      const mudou = JSON.stringify(cargo) !== JSON.stringify(user.cargo || null);
      // Ninguem muda o proprio cargo: evita se promover e evita o unico admin
      // se trancar para fora.
      if (mudou && user.id === req.user.id) return res.status(403).json({ error: 'Peça a outra pessoa para mudar o seu cargo.' });
      conferirAtribuicao(req.user, cargo, atual.codigo);
    } else if (isManagerActor(req) && (user.role !== 'AGENT' || nextRole !== 'AGENT')) {
      return res.status(403).json({ error: MANAGER_TEAM_ONLY_MESSAGE });
    }

    if (await isUsernameTaken(nextUsername, user.id)) {
      return res.status(400).json({ error: USERNAME_TAKEN_MESSAGE });
    }

    const roleSemCargo = req.user.role === 'SUPER_ADMIN' && nextRole === 'SUPER_ADMIN'
      ? 'SUPER_ADMIN'
      : (nextRole === 'SUPER_ADMIN' ? user.role : nextRole);
    // Quem ja tem cargo so muda de papel trocando o nivel.
    const safeRole = cargo ? papelDoNivel(cargo.nivel) : (user.cargo ? user.role : roleSemCargo);

    const update = {
      name: nextName,
      username: nextUsername,
      role: safeRole,
      queues: safeRole === 'AGENT' && Array.isArray(queues) ? queues : [],
      managerPermissions: cargo ? [] : resolveManagerPermissions(req, safeRole, managerPermissions, user.managerPermissions),
      ...(cargo ? { cargo } : {}),
      email: String(email || '').trim() || null,
      phone: String(phone || '').trim() || null,
      avatarUrl: String(avatarUrl || '').trim() || null,
      availabilityMode: ['auto', 'available', 'away', 'offline'].includes(availabilityMode) ? availabilityMode : 'auto',
      maxConcurrentChats: Number.isInteger(Number(maxConcurrentChats)) && Number(maxConcurrentChats) > 0 ? Math.min(Number(maxConcurrentChats), 100) : null,
      workSchedule: workSchedule && typeof workSchedule === 'object' ? workSchedule : null,
      notificationPreferences: notificationPreferences && typeof notificationPreferences === 'object'
        ? {
            browser: notificationPreferences.browser !== false,
            sound: notificationPreferences.sound !== false,
            email: notificationPreferences.email === true
          }
        : { browser: true, sound: true, email: false },
      updatedAt: new Date().toISOString()
    };

    if (password) {
      update.password = await bcrypt.hash(String(password), 10);
    }

    await collection.updateOne({ id: user.id }, { $set: update });
    const updated = await collection.findOne({ id: user.id });

    await createLog('USER_UPDATE', { id: updated.id, name: updated.name, tenantId: updated.tenantId, role: updated.role }, req.user.id);
    const { password: _, ...userWithoutPassword } = updated;
    res.json(userWithoutPassword);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete('/:id', authenticate, authorize(USER_WRITE_ROLES, { manager: 'equipe', permission: 'equipe.atendentes' }), async (req, res) => {
  try {
    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('users');

    const query = { id: req.params.id };
    if (req.user.role !== 'SUPER_ADMIN') {
      query.tenantId = req.user.tenantId;
    }

    const user = await collection.findOne(query);
    if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });
    if (user.role === 'SUPER_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Apenas SUPER_ADMIN pode remover outro SUPER_ADMIN' });
    }
    if (resolverCargo(req.user).modelo === 'cargo') {
      conferirAtribuicao(req.user, null, resolverCargo(user).codigo);
    } else if (isManagerActor(req) && user.role !== 'AGENT') {
      return res.status(403).json({ error: MANAGER_TEAM_ONLY_MESSAGE });
    }
    if (user.id === req.user.id) return res.status(403).json({ error: 'Voce nao pode remover o proprio acesso.' });

    await collection.deleteOne(query);

    await createLog('USER_DELETE', { id: user.id, name: user.name, tenantId: user.tenantId, role: user.role }, req.user.id);
    const { password: _, ...userWithoutPassword } = user;
    res.json({ message: 'Usuario removido', deleted: userWithoutPassword });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/:id/permissions', authenticate, authorize(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { permissions } = req.body || {};
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions deve ser um array' });
    }

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('users');

    const result = await collection.updateOne(
      { id: req.params.id, role: 'SUPER_ADMIN' },
      { $set: { permissions, updatedAt: new Date().toISOString() } }
    );

    if (!result.matchedCount) {
      return res.status(404).json({ error: 'Usuario SUPER_ADMIN nao encontrado' });
    }

    const updated = await collection.findOne({ id: req.params.id }, { projection: { id: 1, permissions: 1 } });
    res.json({ id: updated.id, permissions: updated.permissions || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
