import express from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import {
  acceptVoiceCall,
  declineVoiceCall,
  getCurrentCallForUser,
  getMetaCallingSettings,
  getVoiceSettings,
  hangupVoiceCall,
  listVoiceCalls,
  saveVoiceSettings,
  setMetaCallButton
} from '../services/voiceCalls.js';

const router = express.Router();
router.use(authenticate, requireTenant);

const adminRoles = ['ADMIN'];
const readRoles = ['ADMIN', 'MANAGER'];
// Quem atende e o agente; admin e gerente tambem podem estar numa fila.
const attendRoles = ['ADMIN', 'MANAGER', 'AGENT'];

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  queueName: z.string().trim().max(120).nullable().optional(),
  ringSeconds: z.number().int().min(5).max(25).optional(),
  maxRingSeconds: z.number().int().min(10).max(58).optional(),
  missedMessage: z.object({
    enabled: z.boolean().optional(),
    text: z.string().trim().min(1).max(1000).optional()
  }).optional()
}).strict();

const responder = (res, req, error) => {
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (status >= 500 && status !== 502) console.error('[VOICE] Erro na rota', error);
  res.status(status).json({ code: error.code || 'voice_error', message: error.message || 'Erro na ligação', correlationId: req.correlationId });
};

router.get('/settings', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    res.json(await getVoiceSettings(req.tenantId));
  } catch (error) {
    responder(res, req, error);
  }
});

router.put('/settings', authorize(adminRoles, { permission: 'config.whatsapp' }), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ code: 'invalid_voice_settings', message: parsed.error.issues[0]?.message || 'Configuração inválida', correlationId: req.correlationId });
  }
  try {
    res.json(await saveVoiceSettings(req.tenantId, parsed.data, req.user));
  } catch (error) {
    responder(res, req, error);
  }
});

router.get('/meta', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    res.json(await getMetaCallingSettings(req.tenantId));
  } catch (error) {
    responder(res, req, error);
  }
});

router.put('/meta', authorize(adminRoles, { permission: 'config.whatsapp' }), async (req, res) => {
  if (typeof req.body?.visible !== 'boolean') {
    return res.status(400).json({ code: 'invalid_voice_meta', message: 'Informe se o botão de ligar fica visível.', correlationId: req.correlationId });
  }
  try {
    res.json(await setMetaCallButton(req.tenantId, req.body.visible, req.user));
  } catch (error) {
    responder(res, req, error);
  }
});

router.get('/', authorize(readRoles, { permission: 'operacao.ver' }), async (req, res) => {
  try {
    res.json(await listVoiceCalls({ tenantId: req.tenantId, limit: req.query.limit, page: req.query.page }));
  } catch (error) {
    responder(res, req, error);
  }
});

router.get('/current', authorize(attendRoles, { permission: ['atendimento.fila', 'operacao.ver'] }), async (req, res) => {
  try {
    res.json(await getCurrentCallForUser({ tenantId: req.tenantId, user: req.user }));
  } catch (error) {
    responder(res, req, error);
  }
});

router.post('/:callId/accept', authorize(attendRoles, { permission: ['atendimento.fila', 'operacao.ver'] }), async (req, res) => {
  const sdp = typeof req.body?.sdp === 'string' ? req.body.sdp : null;
  if (!sdp || sdp.length > 20000) {
    return res.status(400).json({ code: 'voice_sdp_required', message: 'Resposta de áudio inválida.', correlationId: req.correlationId });
  }
  try {
    res.json(await acceptVoiceCall({ tenantId: req.tenantId, callId: req.params.callId, user: req.user, sdp }));
  } catch (error) {
    responder(res, req, error);
  }
});

router.post('/:callId/decline', authorize(attendRoles, { permission: ['atendimento.fila', 'operacao.ver'] }), async (req, res) => {
  try {
    res.json(await declineVoiceCall({ tenantId: req.tenantId, callId: req.params.callId, user: req.user }));
  } catch (error) {
    responder(res, req, error);
  }
});

router.post('/:callId/hangup', authorize(attendRoles, { permission: ['atendimento.fila', 'operacao.ver'] }), async (req, res) => {
  try {
    res.json(await hangupVoiceCall({ tenantId: req.tenantId, callId: req.params.callId, user: req.user }));
  } catch (error) {
    responder(res, req, error);
  }
});

export default router;
