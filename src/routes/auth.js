import express from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { loginSchema } from '../schemas/index.js';
import { authenticate } from '../middleware/auth.js';
import adapter from '../../db/DatabaseAdapter.js';
import { JWT_SECRET_VALUE, JWT_EXPIRES_IN } from '../config/constants.js';
import { markOffline, markOnline } from '../services/userStatus.js';
import { findUserByLogin, verifyUserPassword } from '../services/passwords.js';
import { generateSecret, otpauthUrl, verifyCode } from '../utils/totp.js';
import {
  createSession as createMfaSession,
  revokeSessionsForUser,
  getSessionTtlMinutes
} from '../services/mfaSessions.js';
import { getClientIp } from '../middleware/superAdminIp.js';
import { createLog } from '../services/logs.js';
import {
  checkLock as checkLoginLock,
  registerFailure as registerLoginFailure,
  clearFailures as clearLoginFailures
} from '../services/loginAttemptTracker.js';
import { noteLogin } from '../services/loginAnomalyDetector.js';
import { normalizeManagerPermissions } from '../services/managerPermissions.js';
import { resumoCargo } from '../services/cargos.js';

const router = express.Router();
const HEARTBEAT_LAST_SEEN_MIN_MS = Number.parseInt(process.env.HEARTBEAT_LAST_SEEN_MIN_MS || '60000', 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' }
});

const totpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const invalidCredentials = { error: 'Credenciais invalidas' };

    // Lockout por usuário: roda antes da consulta para não revelar se o user
    // existe (responde "Credenciais invalidas" de qualquer forma). Atacante
    // com botnet ainda fica preso aqui mesmo trocando de IP.
    const lockState = await checkLoginLock(username);
    if (lockState.locked) {
      return res.status(401).json(invalidCredentials);
    }

    const user = await findUserByLogin(username, password);

    if (!user) {
      await registerLoginFailure(username);
      return res.status(401).json(invalidCredentials);
    }

    // Sucesso — limpar contador de falhas
    await clearLoginFailures(username);

    user.status = 'online';
    user.lastSeen = new Date().toISOString();
    await adapter.updateOne(
      'users',
      { id: user.id },
      { $set: { status: user.status, lastSeen: user.lastSeen } }
    );
    markOnline(user.id);

    // Detecção de anomalia: IP novo dispara alerta socket + audit. Não bloqueia
    // o login, só sinaliza para SUPER_ADMINs online observarem.
    noteLogin({
      userId: user.id,
      role: user.role,
      tenantId: user.tenantId || null,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || null
    }).catch(() => {});

    const token = jwt.sign(
      { userId: user.id, tenantId: user.tenantId, role: user.role },
      JWT_SECRET_VALUE,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const { password: _, ...userWithoutPassword } = user;
    res.json({ user: { ...userWithoutPassword, cargoEfetivo: resumoCargo(user) }, token });
  } catch (error) {
    if (error.name === 'ZodError') {
      const issue = error.issues?.[0] || error.errors?.[0] || null;
      return res.status(400).json({ error: issue?.message || 'Dados de login invalidos' });
    }
    res.status(500).json({ error: error.message });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  try {
    const user = req.user;
    await adapter.updateOne(
      'users',
      { id: user.id },
      { $set: { status: 'offline', lastSeen: new Date().toISOString() } }
    );
    markOffline(user.id);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/confirm-password', authenticate, async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    if (!password) {
      return res.status(400).json({ error: 'Senha obrigatoria' });
    }

    const isMatch = await verifyUserPassword(req.user, password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/heartbeat', authenticate, async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    // Parceiro dentro de um cliente continua sendo Parceiro para o painel.
    const user = req.partnerUser || req.user;
    const stored = await adapter.findOne(
      'users',
      { id: user.id },
      {
        projection: {
          _id: 0,
          id: 1,
          name: 1,
          username: 1,
          role: 1,
          tenantId: 1,
          ratingAvg: 1,
          ratingCount: 1,
          ratingSum: 1,
          status: 1,
          lastSeen: 1
        }
      }
    );
    if (stored) {
      const now = Date.now();
      const lastSeenMs = stored.lastSeen ? new Date(stored.lastSeen).getTime() : 0;
      const shouldPersistLastSeen =
        !Number.isFinite(lastSeenMs) ||
        now - lastSeenMs >= HEARTBEAT_LAST_SEEN_MIN_MS ||
        stored.status !== 'online';

      if (shouldPersistLastSeen) {
        stored.status = 'online';
        stored.lastSeen = new Date(now).toISOString();
        await adapter.updateOne(
          'users',
          { id: user.id },
          { $set: { status: stored.status, lastSeen: stored.lastSeen } }
        );
      }
    }
    markOnline(user.id);

    res.json({
      valid: true,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        tenantId: user.tenantId,
        ...(user.partnerId ? { partnerId: user.partnerId } : {}),
        managerPermissions: normalizeManagerPermissions(user.managerPermissions),
        cargoEfetivo: resumoCargo(user),
        ratingAvg: stored?.ratingAvg || 0,
        ratingCount: stored?.ratingCount || 0,
        ratingSum: stored?.ratingSum || 0
      }
    });
  } catch (error) {
    res.status(500).json({ valid: false, error: error.message });
  }
});

// --- TOTP / MFA elevation ---

router.get('/totp/status', authenticate, async (req, res) => {
  try {
    const totp = req.user?.totp || null;
    res.json({
      enabled: Boolean(totp?.enabled),
      enrolledAt: totp?.enrolledAt || null,
      ttlMinutes: getSessionTtlMinutes()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/totp/setup', authenticate, totpLimiter, async (req, res) => {
  try {
    const secret = generateSecret();
    const url = otpauthUrl({
      secret,
      label: req.user.username || req.user.id
    });
    res.json({ secret, otpauthUrl: url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/totp/confirm', authenticate, totpLimiter, async (req, res) => {
  try {
    const secret = String(req.body?.secret || '').trim();
    const code = String(req.body?.code || '').trim();
    if (!secret || !code) {
      return res.status(400).json({ error: 'secret e code são obrigatórios' });
    }
    if (!verifyCode(secret, code)) {
      return res.status(401).json({ error: 'Código inválido' });
    }

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('users');
    const update = {
      totp: {
        secret,
        enabled: true,
        enrolledAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString()
    };
    await collection.updateOne({ id: req.user.id }, { $set: update });
    await createLog('AUTH_TOTP_ENROLL', { userId: req.user.id }, req.user.id);
    res.json({ ok: true, enrolledAt: update.totp.enrolledAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/totp/disable', authenticate, totpLimiter, async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    const code = String(req.body?.code || '').trim();
    if (!password || !code) {
      return res.status(400).json({ error: 'senha e código são obrigatórios' });
    }
    const passwordOk = await verifyUserPassword(req.user, password);
    if (!passwordOk) return res.status(401).json({ error: 'Senha incorreta' });

    const currentSecret = req.user?.totp?.secret;
    if (!currentSecret || !verifyCode(currentSecret, code)) {
      return res.status(401).json({ error: 'Código inválido' });
    }

    if (!adapter.db) await adapter.init();
    const collection = adapter.db.collection('users');
    await collection.updateOne(
      { id: req.user.id },
      { $set: { totp: null, updatedAt: new Date().toISOString() } }
    );
    await revokeSessionsForUser(req.user.id);
    await createLog('AUTH_TOTP_DISABLE', { userId: req.user.id }, req.user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/totp/elevate', authenticate, totpLimiter, async (req, res) => {
  try {
    const code = String(req.body?.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'código obrigatório' });
    }
    const totp = req.user?.totp;
    if (!totp?.enabled || !totp.secret) {
      return res.status(412).json({ error: 'TOTP não configurado. Faça o enrollment primeiro.', code: 'totp_not_enrolled' });
    }
    if (!verifyCode(totp.secret, code)) {
      await createLog('AUTH_TOTP_ELEVATE_FAILED', { userId: req.user.id }, req.user.id);
      return res.status(401).json({ error: 'Código inválido' });
    }

    const clientIp = getClientIp(req);
    if (!clientIp) {
      return res.status(400).json({ error: 'Não foi possível determinar o IP da requisição' });
    }
    const session = await createMfaSession({ userId: req.user.id, clientIp });
    await createLog('AUTH_TOTP_ELEVATE', { userId: req.user.id, clientIp, expiresAt: session.expiresAt }, req.user.id);
    res.json({
      ok: true,
      expiresAt: session.expiresAt,
      ttlMinutes: session.ttlMinutes,
      clientIp
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

export default router;
