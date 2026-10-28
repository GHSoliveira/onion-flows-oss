import express from 'express';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorization.js';
import { requireTenant } from '../middleware/tenant.js';
import { createChannelEntry, deleteChannelEntry, getChannelConfig, listChannelEntries, markChannelEntryConfigured, saveTelegramConfig, saveWhatsAppConfig, updateChannelFlowRoute } from '../services/channelConfig.js';
import { completeEmbeddedSignup } from '../services/embeddedSignup.js';
import { disconnectWhatsApp } from '../services/whatsappDisconnect.js';
import { getAccountInsights } from '../services/whatsappAccountInsights.js';
import { listAccountAlerts, markAccountAlertsRead } from '../services/whatsappAccountAlerts.js';
import { getProfileIdentity, requestDisplayNameChange, updateProfilePicture } from '../services/whatsappProfileIdentity.js';
import { telegramFetch } from '../services/telegramApi.js';
import {
  diagnoseWhatsAppChannel,
  getBusinessProfile,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  subscribeWebhook,
  updateBusinessProfile
} from '../services/whatsappProvisioning.js';
import { createLog } from '../services/logs.js';

const router = express.Router();

const maskToken = (value) => (value ? '***' : null);

const maskChannelConfig = (config) => {
  if (!config) return { tenantId: config?.tenantId || null, telegram: null, whatsapp: null };
  const telegram = config.telegram ? {
    ...config.telegram,
    botToken: maskToken(config.telegram.botToken),
    webhookSecret: maskToken(config.telegram.webhookSecret)
  } : null;
  const whatsapp = config.whatsapp ? {
    ...config.whatsapp,
    accessToken: maskToken(config.whatsapp.accessToken),
    appSecret: maskToken(config.whatsapp.appSecret),
    webhookVerifyToken: maskToken(config.whatsapp.webhookVerifyToken),
    registrationPin: maskToken(config.whatsapp.registrationPin)
  } : null;
  const entries = Array.isArray(config.entries) ? config.entries.map((entry) => {
    const { tokenHash, modificationPasswordHash, ...safe } = entry;
    return {
      ...safe,
      tokenConfigured: Boolean(tokenHash),
      modificationPasswordConfigured: Boolean(modificationPasswordHash)
    };
  }) : [];
  return { ...config, entries, telegram, whatsapp };
};

const normalize = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};

const assertFlowBelongsToTenant = async (tenantId, flowId) => {
  const normalizedFlowId = normalize(flowId);
  if (!normalizedFlowId) return;

  const flows = await adapter.getCollection('flows', tenantId);
  const exists = Array.isArray(flows) && flows.some((flow) => flow?.id === normalizedFlowId);
  if (!exists) {
    const error = new Error('Fluxo nao encontrado neste tenant');
    error.status = 404;
    throw error;
  }
};

router.get('/', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    const config = await getChannelConfig(tenantId);
    res.json(maskChannelConfig(config || { tenantId, telegram: null, whatsapp: null }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/entries', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });
    res.json({ items: await listChannelEntries(tenantId) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/entries', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });
    const result = await createChannelEntry(tenantId, req.body || {}, req.user || null);
    await createLog('CHANNEL_ENTRY_CREATE', { tenantId, channelId: result.channel.id, platform: result.channel.platform }, req.user?.id || 'system');
    res.status(201).json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.delete('/entries/:channelId', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });
    const saved = await deleteChannelEntry(tenantId, req.params.channelId, req.body || {});
    await createLog('CHANNEL_ENTRY_DELETE', { tenantId, channelId: req.params.channelId }, req.user?.id || 'system');
    res.json(maskChannelConfig(saved));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/telegram', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    const { entryId = null, ...telegramInput } = req.body || {};
    await saveTelegramConfig(tenantId, telegramInput);
    if (entryId) await markChannelEntryConfigured(tenantId, entryId, 'telegram', req.user || null, telegramInput);
    const config = await getChannelConfig(tenantId);
    res.json(maskChannelConfig(config));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/whatsapp', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    const { entryId = null, ...whatsappInput } = req.body || {};
    await saveWhatsAppConfig(tenantId, whatsappInput);
    if (entryId) await markChannelEntryConfigured(tenantId, entryId, 'whatsapp', req.user || null, whatsappInput);
    const config = await getChannelConfig(tenantId);
    res.json(maskChannelConfig(config));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recebe o resultado do fluxo de Embedded Signup concluido no navegador.
// O `code` vive 30 segundos, entao esta rota resolve tudo de forma sincrona:
// nao enfileirar, nao adiar, nao pedir confirmacao antes de chamar.
router.post('/whatsapp/embedded-signup', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    const { code, wabaId, phoneNumberId, businessId = null, confirmReplace = false } = req.body || {};
    const resultado = await completeEmbeddedSignup({
      tenantId,
      code,
      wabaId,
      phoneNumberId,
      businessId,
      confirmReplace: confirmReplace === true,
      actorId: req.user?.id || null
    });
    const config = await getChannelConfig(tenantId);
    res.json({ ...resultado, config: maskChannelConfig(config) });
  } catch (error) {
    const status = Number(error?.status) >= 400 && Number(error?.status) <= 599 ? Number(error.status) : 500;
    res.status(status).json({
      error: error?.message || 'Falha no Embedded Signup',
      code: error?.code || 'embedded_signup_error',
      graphCode: error?.graphCode ?? null
    });
  }
});

router.patch('/flow-routing', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }

    await assertFlowBelongsToTenant(tenantId, req.body?.flowId);
    const saved = await updateChannelFlowRoute(tenantId, req.body || {}, req.user || null);
    await createLog('CHANNEL_FLOW_ROUTE_UPDATE', {
      tenantId,
      channel: req.body?.channel || null,
      flowId: req.body?.flowId || null,
      senderId: req.body?.senderId || null,
      entryId: req.body?.entryId || null,
      senderPhoneNumberId: req.body?.senderPhoneNumberId || req.body?.phoneNumberId || null
    }, req.user?.id || 'system');

    res.json(maskChannelConfig(saved));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Descobre os numeros de uma WABA. Aceita credenciais no body para funcionar
// enquanto o admin ainda esta preenchendo o formulario, antes de salvar.
router.post('/whatsapp/phone-numbers', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }

    let accessToken = normalize(req.body?.accessToken);
    let wabaId = normalize(req.body?.wabaId);
    // Placeholder mascarado ou campo vazio: usa o que ja esta salvo no tenant.
    if (!accessToken || accessToken === '***') {
      const saved = await getChannelConfig(tenantId);
      accessToken = saved?.whatsapp?.accessToken || null;
      wabaId = wabaId || saved?.whatsapp?.wabaId || null;
    }

    const numbers = await listWabaPhoneNumbers({ accessToken, wabaId });
    res.json({ numbers });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/whatsapp/diagnostics', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    res.json(await diagnoseWhatsAppChannel(tenantId));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Dashboard da conta WhatsApp. Le o retrato salvo (ate 15 min) ou busca na Meta;
// `?refresh=1` forca a busca.
router.get('/whatsapp/insights', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    const refresh = ['1', 'true'].includes(String(req.query.refresh || '').toLowerCase());
    res.json(await getAccountInsights(tenantId, { refresh }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/whatsapp/alerts', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    res.json(await listAccountAlerts(tenantId, { limit: req.query.limit }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Sem `ids` marca todos os alertas do tenant como lidos.
router.post('/whatsapp/alerts/read', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    res.json({ marked: await markAccountAlertsRead(tenantId, { ids }) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/whatsapp/subscribe-webhook', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    const config = await getChannelConfig(tenantId);
    const accessToken = config?.whatsapp?.accessToken || null;
    const wabaId = config?.whatsapp?.wabaId || null;
    if (!accessToken || !wabaId) {
      return res.status(400).json({ error: 'Token e wabaId precisam estar salvos antes de assinar o webhook.' });
    }

    const subscribed = await subscribeWebhook({ accessToken, wabaId });
    await createLog('CHANNEL_WHATSAPP_WEBHOOK_SUBSCRIBE', { tenantId, wabaId, subscribed }, req.user?.id || 'system');
    res.json({ subscribed });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Credenciais do canal salvo. Usado pelas rotas que agem sobre a conta na Meta.
const requireWhatsAppCredentials = async (tenantId) => {
  const config = await getChannelConfig(tenantId);
  const accessToken = config?.whatsapp?.accessToken || null;
  if (!accessToken) {
    throw Object.assign(new Error('Configure o access token do WhatsApp antes.'), { status: 400 });
  }
  return {
    accessToken,
    wabaId: config?.whatsapp?.wabaId || null,
    phoneNumberId: config?.whatsapp?.phoneNumberId || null,
    pinStored: Boolean(config?.whatsapp?.registrationPin)
  };
};

router.post('/whatsapp/register-number', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });

    const { accessToken, phoneNumberId } = await requireWhatsAppCredentials(tenantId);
    const targetId = normalize(req.body?.phoneNumberId) || phoneNumberId;
    if (!targetId) return res.status(400).json({ error: 'phoneNumberId obrigatorio' });

    const registered = await registerPhoneNumber({ accessToken, phoneNumberId: targetId, pin: req.body?.pin });
    await createLog('CHANNEL_WHATSAPP_NUMBER_REGISTER', { tenantId, phoneNumberId: targetId, registered }, req.user?.id || 'system');
    res.json({ registered });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Desconecta o numero do tenant. Exige confirm:true para nao sair por engano.
router.post('/whatsapp/disconnect', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirme a desconexao do numero.' });

    const result = await disconnectWhatsApp({ tenantId, actorId: req.user?.id || null });
    await createLog('CHANNEL_WHATSAPP_DISCONNECT', {
      tenantId,
      metaUnsubscribed: result.metaUnsubscribed,
      metaWarning: Boolean(result.metaWarning),
      phoneNumberCount: result.phoneNumberCount
    }, req.user?.id || 'system');
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.get('/whatsapp/business-profile', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });

    const { accessToken, phoneNumberId } = await requireWhatsAppCredentials(tenantId);
    if (!phoneNumberId) return res.status(400).json({ error: 'Configure o numero remetente antes.' });
    res.json(await getBusinessProfile({ accessToken, phoneNumberId }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.put('/whatsapp/business-profile', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });

    const { accessToken, phoneNumberId } = await requireWhatsAppCredentials(tenantId);
    if (!phoneNumberId) return res.status(400).json({ error: 'Configure o numero remetente antes.' });

    const updated = await updateBusinessProfile({ accessToken, phoneNumberId, profile: req.body || {} });
    await createLog('CHANNEL_WHATSAPP_PROFILE_UPDATE', {
      tenantId,
      phoneNumberId,
      changedFields: Object.keys(req.body || {})
    }, req.user?.id || 'system');
    res.json({ updated, profile: await getBusinessProfile({ accessToken, phoneNumberId }) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Nome de exibicao e foto de perfil (aba "Nome e foto" da Central do WhatsApp).
router.get('/whatsapp/profile-identity', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });

    const { accessToken, phoneNumberId, pinStored } = await requireWhatsAppCredentials(tenantId);
    if (!phoneNumberId) return res.status(400).json({ error: 'Configure o numero remetente antes.' });
    res.json(await getProfileIdentity({ tenantId, accessToken, phoneNumberId, pinStored }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/whatsapp/display-name', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });

    const { accessToken, phoneNumberId, pinStored } = await requireWhatsAppCredentials(tenantId);
    if (!phoneNumberId) return res.status(400).json({ error: 'Configure o numero remetente antes.' });

    const identity = await requestDisplayNameChange({ tenantId, accessToken, phoneNumberId, name: req.body?.name, pinStored, actorId: req.user?.id || null });
    await createLog('CHANNEL_WHATSAPP_DISPLAY_NAME_REQUEST', { tenantId, phoneNumberId, name: identity.newDisplayName }, req.user?.id || 'system');
    res.json({ requested: true, identity });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/whatsapp/profile-picture', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) return res.status(400).json({ error: 'tenantId obrigatorio' });

    const { accessToken, phoneNumberId } = await requireWhatsAppCredentials(tenantId);
    if (!phoneNumberId) return res.status(400).json({ error: 'Configure o numero remetente antes.' });

    const result = await updateProfilePicture({ accessToken, phoneNumberId, dataUrl: req.body?.dataUrl, fileName: req.body?.fileName });
    await createLog('CHANNEL_WHATSAPP_PROFILE_PICTURE_UPDATE', { tenantId, phoneNumberId }, req.user?.id || 'system');
    res.json({ updated: true, ...result });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

router.post('/telegram/webhook', authenticate, authorize(['ADMIN', 'SUPER_ADMIN'], { permission: 'config.whatsapp' }), requireTenant, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.tenantId || null;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId obrigatorio' });
    }
    const config = await getChannelConfig(tenantId);
    const telegram = config?.telegram || null;
    if (!telegram?.botToken || !telegram?.webhookUrl) {
      return res.status(400).json({ error: 'Bot token e webhook URL sao obrigatorios' });
    }

    const payload = {
      url: telegram.webhookUrl,
      secret_token: telegram.webhookSecret || undefined
    };
    const result = await telegramFetch('setWebhook', payload, telegram.botToken);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
