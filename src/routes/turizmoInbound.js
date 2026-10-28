import express from 'express';
import crypto from 'node:crypto';
import adapter from '../../db/DatabaseAdapter.js';
import { authenticateTurizmoInbound } from '../middleware/turizmoInboundAuth.js';
import { turizmoInboundLimiter } from '../middleware/rateLimits.js';
import { createLog } from '../services/logs.js';
import { executeTurizmoCommand, turizmoCommandSchema } from '../services/turizmoCommandExecution.js';
import { COLLECTIONS, nowIso } from '../services/outreachDomain.js';
import { wakeOutreachCampaignWorker } from '../services/outreachCampaignWorker.js';
import { storeTenantMediaBuffer } from '../services/mediaStorage.js';
import { validateUpload } from '../utils/fileType.js';
import { generateId } from '../utils/helpers.js';
import {
  campaignBridgeResponse,
  createTurizmoCampaign,
  ensureTurizmoTenant,
  executeTurizmoInboundIdempotent,
  formatBridgeError,
  getTurizmoCampaign,
  normalizeTurizmoWhatsAppPhone,
  turizmoCampaignCreateSchema,
  turizmoContactsUpsertSchema,
  turizmoInboundTestSchema,
  upsertTurizmoContacts
} from '../services/turizmoInboundBridge.js';

const router = express.Router();
const s2s = [turizmoInboundLimiter, authenticateTurizmoInbound];
const DEFAULT_MAX_UPLOAD_BYTES = 70 * 1024 * 1024;
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MEDIA_MAX_UPLOAD_BYTES || `${DEFAULT_MAX_UPLOAD_BYTES}`, 10);

const rejectTenantMismatch = (req, res, tenantId) => {
  const queryTenantId = String(req.query?.tenantId || '').trim();
  if (!queryTenantId || queryTenantId === tenantId) return false;
  res.status(400).json({
    code: 'tenant_mismatch',
    message: 'tenantId do corpo difere do tenantId da query.',
    correlationId: req.correlationId
  });
  return true;
};

const parseOrRespond = (schema, input, req, res) => {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  res.status(400).json({
    code: 'invalid_integration_payload',
    message: 'Payload da integracao invalido.',
    details: parsed.error.flatten(),
    correlationId: req.correlationId
  });
  return null;
};

const sendBridgeError = (req, res, error) => {
  const status = Math.min(599, Math.max(400, Number(error?.status || 500)));
  res.status(status).json({
    ...formatBridgeError(error),
    correlationId: req.correlationId
  });
};

router.post('/contacts/upsert', ...s2s, async (req, res) => {
  const payload = parseOrRespond(turizmoContactsUpsertSchema, req.body || {}, req, res);
  if (!payload || rejectTenantMismatch(req, res, payload.tenantId)) return;

  const invalidIndex = payload.contacts.findIndex((contact) => !normalizeTurizmoWhatsAppPhone(contact.phone));
  if (invalidIndex >= 0) {
    return res.status(400).json({
      code: 'invalid_phone',
      message: 'Telefone invalido para WhatsApp.',
      details: { index: invalidIndex },
      correlationId: req.correlationId
    });
  }

  try {
    const execution = await executeTurizmoInboundIdempotent({
      tenantId: payload.tenantId,
      idempotencyKey: req.get('Idempotency-Key'),
      operation: 'contacts.upsert',
      operationId: payload.batchId,
      payload,
      execute: async () => ({ statusCode: 200, result: await upsertTurizmoContacts(payload) })
    });
    await createLog('TURIZMO_INBOUND_CONTACTS_UPSERT', {
      tenantId: payload.tenantId,
      batchId: payload.batchId,
      requested: payload.contacts.length,
      createdCount: execution.result.createdCount,
      updatedCount: execution.result.updatedCount,
      replayed: execution.replayed
    }, req.integrationActor.id);
    return res.status(execution.statusCode).json(execution.result);
  } catch (error) {
    return sendBridgeError(req, res, error);
  }
});

router.delete('/contacts/:turizmoLeadId', ...s2s, async (req,res) => {
  const tenantId=String(req.query?.tenantId||'').trim();
  const turizmoLeadId=String(req.params.turizmoLeadId||'').trim();
  if(!tenantId||!turizmoLeadId)return res.status(400).json({code:'contact_identity_required',message:'tenantId e turizmoLeadId sao obrigatorios.',correlationId:req.correlationId});
  try{
    await ensureTurizmoTenant(tenantId);
    const contact=await adapter.findOne('contacts',{tenantId,turizmoLeadId});
    if(!contact)return res.json({ok:true,deleted:false,tenantId,turizmoLeadId});
    await adapter.deleteMany('contacts',{tenantId,id:contact.id});
    await createLog('TURIZMO_INBOUND_CONTACT_DELETE',{tenantId,turizmoLeadId,contactId:contact.id},req.integrationActor.id);
    return res.json({ok:true,deleted:true,tenantId,turizmoLeadId,contactId:contact.id});
  }catch(error){return sendBridgeError(req,res,error);}
});

router.post('/campaigns', ...s2s, async (req, res) => {
  const payload = parseOrRespond(turizmoCampaignCreateSchema, req.body || {}, req, res);
  if (!payload || rejectTenantMismatch(req, res, payload.tenantId)) return;

  try {
    const execution = await executeTurizmoInboundIdempotent({
      tenantId: payload.tenantId,
      idempotencyKey: req.get('Idempotency-Key'),
      operation: 'campaigns.create',
      operationId: payload.turizmoCampaignId,
      payload,
      execute: async () => {
        const created = await createTurizmoCampaign({ payload, actor: req.integrationActor });
        return {
          statusCode: created.duplicate ? 200 : 201,
          result: campaignBridgeResponse(created.campaign, created.duplicate)
        };
      }
    });
    const result = execution.replayed
      ? { ...execution.result, duplicate: true }
      : execution.result;
    await createLog('TURIZMO_INBOUND_CAMPAIGN_CREATE', {
      tenantId: payload.tenantId,
      turizmoCampaignId: payload.turizmoCampaignId,
      onionCampaignId: result.onionCampaignId,
      contactCount: result.contactCount,
      replayed: execution.replayed || result.duplicate
    }, req.integrationActor.id);
    return res.status(execution.replayed ? 200 : execution.statusCode).json(result);
  } catch (error) {
    return sendBridgeError(req, res, error);
  }
});

router.get('/campaigns/:turizmoCampaignId', ...s2s, async (req, res) => {
  const tenantId = String(req.query?.tenantId || '').trim();
  if (!tenantId) {
    return res.status(400).json({ code: 'tenant_required', message: 'tenantId e obrigatorio.', correlationId: req.correlationId });
  }
  try {
    const campaign = await getTurizmoCampaign({ tenantId, turizmoCampaignId: String(req.params.turizmoCampaignId || '').trim() });
    if (!campaign) return res.status(404).json({ code: 'campaign_not_found', message: 'Campanha nao encontrada.', correlationId: req.correlationId });
    return res.json(campaign);
  } catch (error) {
    return sendBridgeError(req, res, error);
  }
});

router.post('/commands', ...s2s, async (req, res) => {
  const payload = parseOrRespond(turizmoCommandSchema, req.body || {}, req, res);
  if (!payload || rejectTenantMismatch(req, res, payload.tenantId)) return;
  try {
    const execution = await executeTurizmoInboundIdempotent({
      tenantId: payload.tenantId,
      idempotencyKey: req.get('Idempotency-Key'),
      operation: 'automation.command',
      operationId: payload.commandId,
      payload,
      execute: async () => ({
        statusCode: ['handoff_to_attendance', 'hold_attendance', 'close_attendance'].includes(payload.type) ? 202 : 200,
        result: await executeTurizmoCommand(payload)
      })
    });
    const result = execution.replayed
      ? { ...execution.result, duplicate: true }
      : execution.result;
    await createLog('TURIZMO_AUTOMATION_COMMAND', {
      tenantId: payload.tenantId,
      commandId: payload.commandId,
      type: payload.type,
      turizmoLeadId: payload.turizmoLeadId,
      replayed: execution.replayed
    }, req.integrationActor.id);
    return res.status(execution.statusCode).json(result);
  } catch (error) {
    return sendBridgeError(req, res, error);
  }
});

router.post('/media/assets', ...s2s, async (req, res) => {
  const tenantId=String(req.body?.tenantId||'').trim();
  const uploadId=String(req.body?.uploadId||'').trim();
  const filename=String(req.body?.filename||'video.mp4').trim().slice(0,120);
  const mimeType=String(req.body?.mimeType||'').trim().toLowerCase();
  const match=String(req.body?.dataUrl||'').match(/^data:([^;]+);base64,(.+)$/);
  if(!tenantId||!uploadId||!/^[a-zA-Z0-9_-]{8,120}$/.test(uploadId))return res.status(400).json({code:'media_identity_required',message:'tenantId e uploadId valido sao obrigatorios.',correlationId:req.correlationId});
  if(rejectTenantMismatch(req,res,tenantId))return;
  if(mimeType!=='video/mp4'||String(match?.[1]||'').toLowerCase()!=='video/mp4')return res.status(400).json({code:'invalid_video_type',message:'Somente video MP4 e aceito.',correlationId:req.correlationId});
  const buffer=Buffer.from(match?.[2]||'','base64');
  if(!buffer.length)return res.status(400).json({code:'empty_media',message:'Arquivo vazio.',correlationId:req.correlationId});
  if(buffer.length>MAX_UPLOAD_BYTES)return res.status(413).json({code:'media_too_large',message:`Arquivo excede o limite de ${Math.floor(MAX_UPLOAD_BYTES/(1024*1024))}MB.`,correlationId:req.correlationId});
  const validation=validateUpload(buffer,mimeType);
  if(!validation.ok)return res.status(400).json({code:'invalid_media_content',message:validation.reason,correlationId:req.correlationId});
  try{
    await ensureTurizmoTenant(tenantId);
    const fingerprint={tenantId,uploadId,filename,mimeType,sha256:crypto.createHash('sha256').update(buffer).digest('hex')};
    const execution=await executeTurizmoInboundIdempotent({
      tenantId,idempotencyKey:req.get('Idempotency-Key'),operation:'media.upload',operationId:uploadId,payload:fingerprint,
      execute:async()=>{
        const stored=await storeTenantMediaBuffer({tenantId,buffer,mimeType:validation.detected,originalName:filename,prefix:'turizmo'});
        const publicBase=String(process.env.PUBLIC_BASE_URL||'').trim().replace(/\/+$/,'')||`${req.protocol}://${req.get('host')}`;
        const asset={id:generateId('asset'),tenantId,...stored,url:`${publicBase}${stored.url}`,createdAt:new Date().toISOString(),createdBy:req.integrationActor.id,source:'turizmo'};
        if(!adapter.db)await adapter.init();
        await adapter.db.collection('mediaAssets').insertOne(asset);
        return {statusCode:201,result:{ok:true,duplicate:false,...asset}};
      }
    });
    const result=execution.replayed?{...execution.result,duplicate:true}:execution.result;
    await createLog('TURIZMO_MEDIA_UPLOAD',{tenantId,uploadId,assetId:result.id,size:result.size,replayed:execution.replayed},req.integrationActor.id);
    return res.status(execution.replayed?200:execution.statusCode).json(result);
  }catch(error){return sendBridgeError(req,res,error);}
});

router.get('/events', ...s2s, async (req, res) => {
  const tenantId = String(req.query?.tenantId || '').trim();
  const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 50) || 50));
  if (!tenantId) return res.status(400).json({ code: 'tenant_required', message: 'tenantId e obrigatorio.', correlationId: req.correlationId });
  try {
    await ensureTurizmoTenant(tenantId);
    const records = await adapter.findMany(COLLECTIONS.outbox, {
      query: {
        tenantId,
        destination: 'turizmo',
        status: { $in: ['pending', 'retry', 'dead_letter'] }
      },
      projection: { _id: 0, payload: 1, eventId: 1, createdAt: 1 },
      sort: { createdAt: 1 },
      limit
    });
    return res.json({
      events: records.map((record) => record.payload).filter(Boolean),
      count: records.length,
      hasMore: records.length === limit
    });
  } catch (error) {
    return sendBridgeError(req, res, error);
  }
});

router.post('/events/ack', ...s2s, async (req, res) => {
  const tenantId = String(req.body?.tenantId || '').trim();
  const eventIds = [...new Set((Array.isArray(req.body?.eventIds) ? req.body.eventIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))].slice(0, 100);
  if (!tenantId || !eventIds.length) {
    return res.status(400).json({ code: 'event_ack_required', message: 'tenantId e eventIds sao obrigatorios.', correlationId: req.correlationId });
  }
  try {
    await ensureTurizmoTenant(tenantId);
    const timestamp = nowIso();
    let acknowledged = 0;
    for (const eventId of eventIds) {
      const record = await adapter.findOne(COLLECTIONS.outbox, { tenantId, destination: 'turizmo', eventId });
      if (!record) continue;
      await adapter.updateOne(COLLECTIONS.outbox, { tenantId, destination: 'turizmo', eventId }, {
        $set: { status: 'delivered', deliveredAt: timestamp, lastError: null, updatedAt: timestamp }
      });
      acknowledged += 1;
    }
    return res.json({ ok: true, acknowledged, eventIds });
  } catch (error) {
    return sendBridgeError(req, res, error);
  }
});

router.post('/campaigns/:turizmoCampaignId/:action', ...s2s, async (req, res) => {
  const tenantId=String(req.body?.tenantId||'').trim();
  const action=String(req.params.action||'').trim();
  if(!tenantId||!['pause','resume','cancel'].includes(action))return res.status(400).json({code:'invalid_campaign_action',message:'tenantId e ação válida são obrigatórios.',correlationId:req.correlationId});
  try{
    await ensureTurizmoTenant(tenantId);
    const campaign=await adapter.findOne(COLLECTIONS.campaigns,{tenantId,turizmoCampaignId:String(req.params.turizmoCampaignId||'').trim()});
    if(!campaign)return res.status(404).json({code:'campaign_not_found',message:'Campanha nao encontrada.',correlationId:req.correlationId});
    const status=action==='pause'?'paused':action==='cancel'?'cancelled':(campaign.cadenceId?'scheduled':'pending');
    const timestamp=nowIso();
    await adapter.updateOne(COLLECTIONS.campaigns,{tenantId,id:campaign.id},{$set:{status,updatedAt:timestamp,...(action==='cancel'?{finishedAt:timestamp}:{})}});
    if(action==='cancel'){
      const items=await adapter.findMany(COLLECTIONS.campaignItems,{query:{tenantId,campaignId:campaign.id,status:{$in:['pending','scheduled','sending']}},limit:100000});
      for(const item of items)await adapter.updateOne(COLLECTIONS.campaignItems,{tenantId,id:item.id},{$set:{status:'cancelled',updatedAt:timestamp}});
    }
    if(action==='pause'||action==='resume'||action==='cancel'){
      const from=action==='resume'?['paused']:['scheduled','waiting','running'];
      const executions=await adapter.findMany(COLLECTIONS.cadenceExecutions,{query:{tenantId,campaignId:campaign.id,status:{$in:from}},limit:100000});
      for(const execution of executions)await adapter.updateOne(COLLECTIONS.cadenceExecutions,{tenantId,id:execution.id},{$set:{status:action==='pause'?'paused':action==='cancel'?'cancelled':'waiting',updatedAt:timestamp,...(action==='resume'?{nextExecutionAt:execution.nextExecutionAt||timestamp}:{})}});
    }
    if(action==='resume'&&!campaign.cadenceId)wakeOutreachCampaignWorker();
    await createLog(`TURIZMO_INBOUND_CAMPAIGN_${action.toUpperCase()}`,{tenantId,turizmoCampaignId:campaign.turizmoCampaignId,onionCampaignId:campaign.id},req.integrationActor.id);
    return res.json({ok:true,turizmoCampaignId:campaign.turizmoCampaignId,onionCampaignId:campaign.id,status,updatedAt:timestamp});
  }catch(error){return sendBridgeError(req,res,error);}
});

// O diagnostico outbound legado usa JWT; chamadas S2S sempre usam X-API-Key.
router.post('/test', (req, _res, next) => {
  if (!req.get('X-API-Key') && /^Bearer\s+/i.test(String(req.get('Authorization') || ''))) {
    return next('router');
  }
  next();
}, ...s2s, async (req, res) => {
  const payload = parseOrRespond(turizmoInboundTestSchema, req.body || {}, req, res);
  if (!payload || rejectTenantMismatch(req, res, payload.tenantId)) return;
  try {
    await ensureTurizmoTenant(payload.tenantId);
    await createLog('TURIZMO_INBOUND_CONNECTIVITY_TEST', { tenantId: payload.tenantId }, req.integrationActor.id);
    return res.json({
      ok: true,
      reachable: true,
      authenticated: true,
      tenantId: payload.tenantId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return sendBridgeError(req, res, error);
  }
});

export default router;
