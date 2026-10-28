import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const dbPath = path.join(os.tmpdir(), `onion-turizmo-inbound-${process.pid}.json`);
const apiKey = 'turizmo-inbound-test-key-with-at-least-32-bytes';

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'turizmo-inbound-test-jwt-secret';
process.env.TURIZMO_INTEGRATION_ENABLED = 'true';
process.env.TURIZMO_INBOUND_API_KEY = apiKey;
process.env.TURIZMO_API_KEY = 'outbound-disabled-in-tests';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.OUTREACH_CAMPAIGN_MAX_CONTACTS = '250';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { default: turizmoInboundRouter } = await import('../src/routes/turizmoInbound.js');
const {
  normalizeTurizmoWhatsAppPhone,
  upsertTurizmoContacts
} = await import('../src/services/turizmoInboundBridge.js');
const { timingSafeSecretEqual } = await import('../src/middleware/turizmoInboundAuth.js');
const { attributeInboundReply } = await import('../src/services/replyAttribution.js');
const { notifyProtectedAttendanceInbound } = await import('../src/services/protectedAttendance.js');

let server;
let baseUrl;
const uploadedMediaFiles = [];

const request = async (route, { method = 'GET', body, key = apiKey, idempotencyKey } = {}) => {
  const headers = {};
  if (key !== null) headers['X-API-Key'] = key;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, payload: await response.json() };
};

const contactPayload = (overrides = {}) => ({
  turizmoLeadId: 'lead_1',
  turizmoCompanyId: 'company_1',
  name: 'Contato Teste',
  phone: '+55 (11) 99999-0001',
  company: 'Empresa Teste',
  email: 'contato@example.test',
  tags: ['Prospeccao'],
  source: 'tes_maps',
  sourcePlaceId: 'place_1',
  metadata: { city: 'Sao Paulo', state: 'SP', segment: 'Teste' },
  ...overrides
});

const seedHandoffContext = async (suffix, {
  stage = 'values_sent',
  campaignId = null,
  chatHasLeadId = true
} = {}) => {
  const turizmoLeadId = `lead_handoff_${suffix}`;
  const contactId = `contact_handoff_${suffix}`;
  const chatId = `chat_handoff_${suffix}`;
  const resolvedCampaignId = campaignId || `campaign_handoff_${suffix}`;
  await adapter.insertOne('contacts', {
    id: contactId,
    tenantId: 'tenant_a',
    turizmoLeadId,
    name: `Lead Handoff ${suffix}`,
    normalizedPrimaryPhone: `55119888${String(suffix).padStart(4, '0')}`,
    phones: []
  });
  await adapter.insertOne('activeChats', {
    id: chatId,
    tenantId: 'tenant_a',
    ...(chatHasLeadId ? { turizmoLeadId } : {}),
    contactId,
    campaignId: resolvedCampaignId,
    status: 'bot',
    mode: 'automation',
    automationMode: 'automation',
    channel: 'whatsapp',
    channelUserId: `55119888${String(suffix).padStart(4, '0')}`,
    channelChatId: `55119888${String(suffix).padStart(4, '0')}`,
    whatsappPhoneNumberId: 'sender_1',
    activeOutreach: true,
    attendanceDeferred: true,
    outreachPendingReply: true,
    messages: [],
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  await adapter.insertOne('turizmoAutomationStates', {
    id: `turizmo_state_handoff_${suffix}`,
    tenantId: 'tenant_a',
    turizmoLeadId,
    campaignId: resolvedCampaignId,
    chatId,
    stage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return { turizmoLeadId, contactId, chatId, campaignId: resolvedCampaignId, stage };
};

const handoffPayload = (context, overrides = {}) => ({
  tenantId: 'tenant_a',
  commandId: `command_handoff_${context.chatId}`,
  type: 'handoff_to_attendance',
  turizmoLeadId: context.turizmoLeadId,
  campaignId: context.campaignId,
  chatId: context.chatId,
  expectedStage: context.stage,
  nextStage: 'human_handoff',
  text: null,
  media: null,
  reason: 'Lead confirmou interesse depois dos valores.',
  decisionId: `decision_${context.chatId}`,
  handoff: {
    queueId: null,
    priority: 'high',
    title: 'Lead comercial quente',
    reason: 'Lead confirmou interesse depois dos valores.'
  },
  ...overrides
});

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('tenants', { id: 'tenant_a', name: 'Tenant A', status: 'active' });
  await adapter.insertOne('tenants', { id: 'tenant_b', name: 'Tenant B', status: 'active' });
  await adapter.insertOne('queues', { id: 'queue_commercial', tenantId: 'tenant_a', name: 'COMERCIAL', active: true });
  await adapter.insertOne('queues', { id: 'queue_explicit', tenantId: 'tenant_a', name: 'VENDAS ESPECIAIS', active: true });
  await adapter.insertOne('queues', { id: 'queue_inactive', tenantId: 'tenant_a', name: 'INATIVA', active: false });
  await adapter.insertOne('channelConfigs', {
    id: 'channels_tenant_a',
    tenantId: 'tenant_a',
    whatsapp: {
      enabled: true,
      accessToken: 'test-access-token',
      phoneNumberId: 'sender_1',
      senderNumbers: [{ id: 'sender_entry_1', label: 'Principal', phoneNumberId: 'sender_1', enabled: true, isDefault: true }]
    }
  });
  await adapter.insertOne('whatsappTemplates', {
    id: 'template_approved',
    tenantId: 'tenant_a',
    name: 'template_aprovado',
    language: 'pt_BR',
    status: 'APPROVED'
  });
  await adapter.insertOne('whatsappTemplates', {
    id: 'template_pending',
    tenantId: 'tenant_a',
    name: 'template_pendente',
    language: 'pt_BR',
    status: 'PENDING'
  });

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/integrations/turizmo', turizmoInboundRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await adapter.close();
  for (const filePath of uploadedMediaFiles) { try { fs.unlinkSync(filePath); } catch {} }
  try { fs.unlinkSync(dbPath); } catch {}
});

test('normaliza apenas telefones internacionais validos para WhatsApp', () => {
  assert.equal(normalizeTurizmoWhatsAppPhone('+55 (11) 99999-0001'), '5511999990001');
  assert.equal(normalizeTurizmoWhatsAppPhone('5511999990001'), '5511999990001');
  assert.equal(normalizeTurizmoWhatsAppPhone('0119999'), null);
  assert.equal(normalizeTurizmoWhatsAppPhone('001234567890'), null);
});

test('comparacao da chave usa resultado constante para entradas de qualquer tamanho', () => {
  assert.equal(timingSafeSecretEqual(apiKey, apiKey), true);
  assert.equal(timingSafeSecretEqual('x', apiKey), false);
  assert.equal(timingSafeSecretEqual(`${apiKey}x`, apiKey), false);
});

test('rejeita chave ausente ou invalida e aceita teste autenticado', async () => {
  const missing = await request('/api/integrations/turizmo/test', {
    method: 'POST', key: null, body: { tenantId: 'tenant_a' }
  });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.payload.code, 'invalid_api_key');

  const invalid = await request('/api/integrations/turizmo/test', {
    method: 'POST', key: 'invalid', body: { tenantId: 'tenant_a' }
  });
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.payload.code, 'invalid_api_key');

  const valid = await request('/api/integrations/turizmo/test', {
    method: 'POST', body: { tenantId: 'tenant_a' }
  });
  assert.equal(valid.response.status, 200);
  assert.equal(valid.payload.authenticated, true);
});

test('upload de video do Turizmo cria URL publica e e idempotente', async () => {
  const buffer = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(8)]);
  const body = { tenantId: 'tenant_a', uploadId: 'upload_video_1', filename: 'demonstracao.mp4', mimeType: 'video/mp4', dataUrl: `data:video/mp4;base64,${buffer.toString('base64')}` };
  const first = await request('/api/integrations/turizmo/media/assets', { method: 'POST', idempotencyKey: 'turizmo-media:tenant_a:upload_video_1', body });
  assert.equal(first.response.status, 201);
  assert.equal(first.payload.ok, true);
  assert.equal(first.payload.duplicate, false);
  assert.match(first.payload.url, /^http:\/\/127\.0\.0\.1:\d+\/uploads\/tenant_a\/turizmo_/);
  assert.equal(first.payload.mimeType, 'video/mp4');
  uploadedMediaFiles.push(path.join(process.cwd(), 'uploads', 'tenant_a', first.payload.fileName));

  const replay = await request('/api/integrations/turizmo/media/assets', { method: 'POST', idempotencyKey: 'turizmo-media:tenant_a:upload_video_1', body });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.duplicate, true);
  assert.equal(replay.payload.id, first.payload.id);
  const assets = await adapter.getCollection('mediaAssets', 'tenant_a');
  assert.equal(assets.filter((item) => item.id === first.payload.id).length, 1);
});

test('upload Turizmo rejeita conteudo que nao seja MP4 real', async () => {
  const invalid = await request('/api/integrations/turizmo/media/assets', { method: 'POST', idempotencyKey: 'turizmo-media:tenant_a:upload_invalid', body: { tenantId: 'tenant_a', uploadId: 'upload_invalid', filename: 'falso.mp4', mimeType: 'video/mp4', dataUrl: `data:video/mp4;base64,${Buffer.from('<html>').toString('base64')}` } });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, 'invalid_media_content');
});

test('upsert cria, atualiza e repete o mesmo batch sem duplicar', async () => {
  const body = { tenantId: 'tenant_a', batchId: 'batch_1', contacts: [contactPayload()] };
  const first = await request('/api/integrations/turizmo/contacts/upsert', {
    method: 'POST', idempotencyKey: 'contacts:tenant_a:batch_1', body
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.createdCount, 1);

  const replay = await request('/api/integrations/turizmo/contacts/upsert', {
    method: 'POST', idempotencyKey: 'contacts:tenant_a:batch_1', body
  });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.payload, first.payload);
  assert.equal((await adapter.findMany('contacts', { query: { tenantId: 'tenant_a' } })).length, 1);

  const update = await request('/api/integrations/turizmo/contacts/upsert', {
    method: 'POST',
    idempotencyKey: 'contacts:tenant_a:batch_2',
    body: {
      tenantId: 'tenant_a', batchId: 'batch_2',
      contacts: [contactPayload({ name: 'Contato Atualizado', tags: ['Atualizado'] })]
    }
  });
  assert.equal(update.response.status, 200);
  assert.equal(update.payload.updatedCount, 1);
  const stored = await adapter.findOne('contacts', { tenantId: 'tenant_a', turizmoLeadId: 'lead_1' });
  assert.equal(stored.name, 'Contato Atualizado');
  assert.deepEqual(stored.tags.sort(), ['Atualizado', 'Prospeccao'].sort());
});

test('reconcilia por telefone dentro do tenant e isola tenants', async () => {
  await adapter.insertOne('contacts', {
    id: 'contact_legacy_phone', tenantId: 'tenant_a', name: 'Legado',
    phones: [{ id: 'phone_legacy', number: '5511999990002', normalizedNumber: '5511999990002', isPrimary: true }],
    tags: ['Preservada']
  });
  const reconciled = await upsertTurizmoContacts({
    tenantId: 'tenant_a', batchId: 'service_batch',
    contacts: [contactPayload({ turizmoLeadId: 'lead_phone', phone: '5511999990002' })]
  });
  assert.equal(reconciled.updatedCount, 1);
  assert.equal(reconciled.items[0].contactId, 'contact_legacy_phone');

  const isolated = await upsertTurizmoContacts({
    tenantId: 'tenant_b', batchId: 'service_batch_b',
    contacts: [contactPayload({ turizmoLeadId: 'lead_tenant_b', phone: '5511999990002' })]
  });
  assert.equal(isolated.createdCount, 1);
  assert.notEqual(isolated.items[0].contactId, 'contact_legacy_phone');
});

test('rejeita telefone invalido e conflito entre lead e telefone', async () => {
  const invalid = await request('/api/integrations/turizmo/contacts/upsert', {
    method: 'POST', idempotencyKey: 'contacts:invalid',
    body: { tenantId: 'tenant_a', batchId: 'invalid', contacts: [contactPayload({ phone: '123' })] }
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.code, 'invalid_integration_payload');

  await adapter.insertOne('contacts', {
    id: 'contact_conflict_lead', tenantId: 'tenant_a', turizmoLeadId: 'lead_conflict', name: 'Lead',
    normalizedPrimaryPhone: '5511999990003', phones: []
  });
  await adapter.insertOne('contacts', {
    id: 'contact_conflict_phone', tenantId: 'tenant_a', name: 'Phone',
    normalizedPrimaryPhone: '5511999990004', phones: []
  });
  const conflict = await request('/api/integrations/turizmo/contacts/upsert', {
    method: 'POST', idempotencyKey: 'contacts:conflict',
    body: {
      tenantId: 'tenant_a', batchId: 'conflict',
      contacts: [contactPayload({ turizmoLeadId: 'lead_conflict', phone: '5511999990004' })]
    }
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.code, 'contact_identity_conflict');
});

test('campanha resolve leads, persiste correlacao e repete sem duplicar', async () => {
  const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const body = {
    tenantId: 'tenant_a',
    turizmoCampaignId: 'tur_campaign_1',
    name: 'Campanha de integracao',
    channel: 'whatsapp',
    templateId: 'template_approved',
    senderPhoneNumberId: 'sender_1',
    turizmoLeadIds: ['lead_1'],
    values: { body: ['Contato Atualizado'] },
    scheduledAt,
    timezone: 'America/Sao_Paulo',
    postHandoff: {
      autoClose: false,
      holdHours: 48,
      inboundDuringHold: 'notify_turizmo',
      closureMode: 'manual'
    }
  };
  const first = await request('/api/integrations/turizmo/campaigns', {
    method: 'POST', idempotencyKey: 'campaign:tenant_a:tur_campaign_1', body
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.payload.turizmoCampaignId, 'tur_campaign_1');
  assert.equal(first.payload.contactCount, 1);

  const campaign = await adapter.findOne('outreachCampaigns', { tenantId: 'tenant_a', turizmoCampaignId: 'tur_campaign_1' });
  assert.ok(campaign);
  const items = await adapter.findMany('outreachCampaignItems', { query: { tenantId: 'tenant_a', campaignId: campaign.id } });
  assert.equal(items.length, 1);
  assert.equal(items[0].turizmoLeadId, 'lead_1');
  assert.equal(items[0].turizmoCompanyId, 'company_1');
  assert.deepEqual(campaign.postHandoff, body.postHandoff);
  const campaignState = await adapter.findOne('turizmoAutomationStates', {
    tenantId: 'tenant_a', turizmoLeadId: 'lead_1'
  });
  assert.deepEqual(campaignState.postHandoff, body.postHandoff);
  assert.equal(campaignState.campaignId, campaign.id);
  assert.equal(campaignState.turizmoCampaignId, body.turizmoCampaignId);

  const event = await adapter.findOne('integrationOutbox', { tenantId: 'tenant_a', eventType: 'campaign.created', aggregateId: campaign.id });
  assert.equal(event.payload.data.turizmoCampaignId, 'tur_campaign_1');

  const replay = await request('/api/integrations/turizmo/campaigns', {
    method: 'POST', idempotencyKey: 'campaign:tenant_a:tur_campaign_1', body
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.duplicate, true);
  assert.equal(replay.payload.onionCampaignId, campaign.id);
  assert.equal((await adapter.findMany('outreachCampaigns', { query: { tenantId: 'tenant_a', turizmoCampaignId: 'tur_campaign_1' } })).length, 1);

  const lookup = await request('/api/integrations/turizmo/campaigns/tur_campaign_1?tenantId=tenant_a');
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.payload.onionCampaignId, campaign.id);
  const isolatedLookup = await request('/api/integrations/turizmo/campaigns/tur_campaign_1?tenantId=tenant_b');
  assert.equal(isolatedLookup.response.status, 404);
});

test('comando Turizmo envia uma vez, avanca etapa e bloqueia atendimento humano', async () => {
  await adapter.insertOne('outreachCampaigns', {
    id:'campaign_1',tenantId:'tenant_a',turizmoCampaignId:'turizmo_campaign_command',automationManagedBy:'turizmo',status:'completed',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  await adapter.insertOne('outreachCampaignItems', {
    id:'campaign_item_command_1',tenantId:'tenant_a',campaignId:'campaign_1',contactId:'contact_1',turizmoLeadId:'lead_1',status:'replied',repliedAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  await adapter.insertOne('activeChats', {
    id: 'chat_turizmo_command', tenantId: 'tenant_a', turizmoLeadId: 'lead_1',
    contactId: 'contact_1', status: 'bot', mode: 'automation', channel: 'whatsapp',
    channelUserId: '5511999990001', channelChatId: '5511999990001',
    whatsappPhoneNumberId: 'sender_1', messages: [], messageCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
  const body = {
    tenantId: 'tenant_a', commandId: 'command_video_1', type: 'send_media',
    turizmoLeadId: 'lead_1', campaignId: 'campaign_1', chatId: 'chat_turizmo_command',
    expectedStage: 'qualification', nextStage: 'video_sent', decisionId: 'decision_1',
    reason: 'Lead interessado', text: null,
    media: { type: 'video', url: 'https://example.test/demo.mp4', caption: 'Veja como funciona', filename: null }
  };
  const first = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: 'turizmo-command:command_video_1', body
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.stage, 'video_sent');
  const replay = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: 'turizmo-command:command_video_1', body
  });
  assert.equal(replay.response.status, 200);
  const messages = await adapter.findMany('chatMessages', { query: { tenantId: 'tenant_a', chatId: 'chat_turizmo_command' } });
  assert.equal(messages.length, 1);
  const followups=await adapter.findMany('contactOutreachHistory',{query:{tenantId:'tenant_a',commandId:'command_video_1'}});
  assert.equal(followups.length,1);
  assert.equal(followups[0].source,'turizmo_command');
  assert.equal(followups[0].campaignItemId,'campaign_item_command_1');
  assert.equal(followups[0].repliedAt,undefined);
  assert.equal(followups[0].countsTowardCampaignMetrics,false);

  await adapter.insertOne('chatMessages',{
    id:'msg_second_reply',messageId:'msg_second_reply',tenantId:'tenant_a',chatId:'chat_turizmo_command',contactId:'contact_1',sender:'user',text:'qual é o valor?',timestamp:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  const activeChat=await adapter.findOne('activeChats',{tenantId:'tenant_a',id:'chat_turizmo_command'});
  const attributed=await attributeInboundReply({tenantId:'tenant_a',chat:activeChat,message:{id:'msg_second_reply',text:'qual é o valor?',timestamp:new Date().toISOString()}});
  assert.equal(attributed.attributed,true);
  assert.equal(attributed.outreachId,followups[0].id);
  const secondReply=await adapter.findOne('chatMessages',{tenantId:'tenant_a',messageId:'msg_second_reply'});
  assert.equal(secondReply.campaignId,'campaign_1');
  assert.equal(secondReply.campaignItemId,'campaign_item_command_1');
  assert.equal(secondReply.turizmoLeadId,'lead_1');
  const repliedFollowup=await adapter.findOne('contactOutreachHistory',{tenantId:'tenant_a',id:followups[0].id});
  assert.ok(repliedFollowup.repliedAt);

  const replayFollowups=await adapter.findMany('contactOutreachHistory',{query:{tenantId:'tenant_a',commandId:'command_video_1'}});
  assert.equal(replayFollowups.length,1);

  await adapter.updateOne('activeChats', { tenantId: 'tenant_a', id: 'chat_turizmo_command' }, { $set: { status: 'open', mode: 'human', automationLocked: true } });
  const blocked = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: 'turizmo-command:command_price_1',
    body: { ...body, commandId: 'command_price_1', type: 'send_text', expectedStage: 'video_sent', nextStage: 'values_sent', text: 'Valores', media: null }
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.payload.code, 'human_attendance_active');
});

test('resposta posterior recupera comando Turizmo antigo sem outreach registrado',async()=>{
  await adapter.insertOne('contacts',{id:'contact_turizmo_legacy',tenantId:'tenant_a',turizmoLeadId:'lead_turizmo_legacy',name:'Lead legado',normalizedPrimaryPhone:'5511988877777',phones:[]});
  await adapter.insertOne('outreachCampaignItems',{id:'campaign_item_legacy',tenantId:'tenant_a',campaignId:'campaign_1',contactId:'contact_turizmo_legacy',turizmoLeadId:'lead_turizmo_legacy',status:'replied',repliedAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  await adapter.insertOne('activeChats',{
    id:'chat_turizmo_legacy',tenantId:'tenant_a',turizmoLeadId:'lead_turizmo_legacy',contactId:'contact_turizmo_legacy',campaignId:'campaign_1',status:'bot',mode:'automation',channel:'whatsapp',channelUserId:'5511988877777',whatsappPhoneNumberId:'sender_1',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  await adapter.insertOne('turizmoAutomationStates',{
    id:'state_turizmo_legacy',tenantId:'tenant_a',turizmoLeadId:'lead_turizmo_legacy',campaignId:'campaign_1',chatId:'chat_turizmo_legacy',stage:'video_sent',lastCommandId:'command_video_legacy',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  await adapter.insertOne('turizmoAutomationCommands',{
    id:'command_record_legacy',tenantId:'tenant_a',commandId:'command_video_legacy',decisionId:'decision_video_legacy',type:'send_media',turizmoLeadId:'lead_turizmo_legacy',campaignId:'campaign_1',chatId:'chat_turizmo_legacy',expectedStage:'qualification',nextStage:'video_sent',media:{type:'video',url:'https://example.test/demo.mp4',caption:'Veja como funciona'},status:'executed',result:{providerMessageId:'wamid.legacy'},executedAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  await adapter.insertOne('chatMessages',{
    id:'msg_legacy_price',messageId:'msg_legacy_price',tenantId:'tenant_a',chatId:'chat_turizmo_legacy',contactId:'contact_turizmo_legacy',sender:'user',text:'qual é o valor?',timestamp:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  });
  assert.ok(await adapter.findOne('turizmoAutomationStates',{tenantId:'tenant_a',chatId:'chat_turizmo_legacy'}));
  assert.ok(await adapter.findOne('turizmoAutomationCommands',{tenantId:'tenant_a',commandId:'command_video_legacy',status:'executed'}));
  assert.equal(await adapter.findOne('contactOutreachHistory',{tenantId:'tenant_a',commandId:'command_video_legacy'}),null);
  const chat=await adapter.findOne('activeChats',{tenantId:'tenant_a',id:'chat_turizmo_legacy'});
  const attributed=await attributeInboundReply({tenantId:'tenant_a',chat,message:{id:'msg_legacy_price',text:'qual é o valor?',timestamp:new Date().toISOString()}});
  assert.equal(attributed.attributed,true);
  const recovered=await adapter.findOne('contactOutreachHistory',{tenantId:'tenant_a',commandId:'command_video_legacy'});
  assert.ok(recovered);
  assert.equal(recovered.source,'turizmo_command_recovered');
  assert.equal(recovered.campaignItemId,'campaign_item_legacy');
  assert.ok(recovered.repliedAt);
  const message=await adapter.findOne('chatMessages',{tenantId:'tenant_a',messageId:'msg_legacy_price'});
  assert.equal(message.turizmoLeadId,'lead_turizmo_legacy');
  assert.equal(message.campaignItemId,'campaign_item_legacy');
});

test('handoff Turizmo cria exatamente um atendimento e uma tarefa e repete idempotente', async () => {
  const context = await seedHandoffContext(101, { chatHasLeadId: false });
  const body = handoffPayload(context, { chatId: null });
  const first = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${body.commandId}`, body
  });
  assert.equal(first.response.status, 202);
  assert.equal(first.payload.duplicate, false);
  assert.equal(first.payload.chatId, context.chatId);
  assert.equal(first.payload.attendanceId, context.chatId);
  assert.equal(first.payload.queueId, 'queue_commercial');
  assert.equal(first.payload.stage, 'human_handoff');

  const chat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  assert.equal(chat.status, 'waiting');
  assert.equal(chat.attendanceStatus, 'waiting');
  assert.equal(chat.automationLocked, true);
  assert.equal(chat.automationMode, 'human');
  assert.equal(chat.activeOutreach, false);
  assert.equal(chat.attendanceDeferred, false);
  assert.equal(chat.outreachPendingReply, false);
  assert.equal(chat.journeyStage, 'human_handoff');

  const task = await adapter.findOne('commercialTasks', { tenantId: 'tenant_a', id: first.payload.taskId });
  assert.ok(task);
  assert.equal(task.attendanceId, context.chatId);
  assert.equal(task.commandId, body.commandId);
  assert.equal(task.priority, 'high');
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId: 'tenant_a', commandId: body.commandId }), 1);

  const event = await adapter.findOne('integrationOutbox', {
    tenantId: 'tenant_a', eventType: 'automation.command.executed', 'payload.data.commandId': body.commandId
  });
  assert.ok(event);
  assert.equal(event.payload.data.attendanceId, context.chatId);
  assert.equal(event.payload.data.taskId, first.payload.taskId);
  assert.equal(event.payload.data.queueId, 'queue_commercial');
  assert.equal(event.payload.data.nextStage, 'human_handoff');

  const replay = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${body.commandId}`, body
  });
  assert.equal(replay.response.status, 202);
  assert.equal(replay.payload.duplicate, true);
  assert.equal(replay.payload.attendanceId, first.payload.attendanceId);
  assert.equal(replay.payload.taskId, first.payload.taskId);
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId: 'tenant_a', commandId: body.commandId }), 1);
  assert.equal(await adapter.countDocuments('integrationOutbox', {
    tenantId: 'tenant_a', eventType: 'automation.command.executed', 'payload.data.commandId': body.commandId
  }), 1);
});

test('duas requisicoes concorrentes do mesmo handoff produzem um atendimento', async () => {
  const context = await seedHandoffContext(102);
  const body = handoffPayload(context);
  const options = { method: 'POST', idempotencyKey: `turizmo-command:${body.commandId}`, body };
  const [left, right] = await Promise.all([
    request('/api/integrations/turizmo/commands', options),
    request('/api/integrations/turizmo/commands', options)
  ]);
  assert.deepEqual([left.response.status, right.response.status].sort(), [202, 202]);
  assert.equal([left.payload.duplicate, right.payload.duplicate].filter(Boolean).length, 1);
  assert.equal(left.payload.attendanceId, right.payload.attendanceId);
  assert.equal(left.payload.taskId, right.payload.taskId);
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId: 'tenant_a', commandId: body.commandId }), 1);
  assert.equal(await adapter.countDocuments('attendanceRoutingDecisions', { tenantId: 'tenant_a', commandId: body.commandId }), 1);
});

test('handoff respeita queueId explicito', async () => {
  const context = await seedHandoffContext(103);
  const body = handoffPayload(context, {
    handoff: { queueId: 'queue_explicit', priority: 'urgent', title: null, reason: null }
  });
  const response = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${body.commandId}`, body
  });
  assert.equal(response.response.status, 202);
  assert.equal(response.payload.queueId, 'queue_explicit');
  assert.equal(response.payload.priority, 'urgent');
  const chat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  assert.equal(chat.queueId, 'queue_explicit');
  assert.equal(chat.agentId, null);
});

test('fila invalida falha sem bloquear automacao e registra evento de falha', async () => {
  const context = await seedHandoffContext(104);
  const body = handoffPayload(context, {
    handoff: { queueId: 'queue_inactive', priority: 'high', title: null, reason: null }
  });
  const response = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${body.commandId}`, body
  });
  assert.equal(response.response.status, 404);
  assert.equal(response.payload.code, 'attendance_queue_not_found');
  const chat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  assert.equal(chat.status, 'bot');
  assert.equal(chat.activeOutreach, true);
  assert.notEqual(chat.automationLocked, true);
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId: 'tenant_a', commandId: body.commandId }), 0);
  const failed = await adapter.findOne('integrationOutbox', {
    tenantId: 'tenant_a', eventType: 'automation.command.failed', 'payload.data.commandId': body.commandId
  });
  assert.ok(failed);
  assert.equal(failed.payload.data.error.code, 'attendance_queue_not_found');
  assert.ok(failed.payload.data.failedAt);
});

test('conflito de etapa nao modifica conversa nem cria atendimento', async () => {
  const context = await seedHandoffContext(105, { stage: 'video_sent' });
  const body = handoffPayload(context, { expectedStage: 'values_sent' });
  const response = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${body.commandId}`, body
  });
  assert.equal(response.response.status, 409);
  assert.equal(response.payload.code, 'automation_stage_conflict');
  const chat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  const state = await adapter.findOne('turizmoAutomationStates', { tenantId: 'tenant_a', turizmoLeadId: context.turizmoLeadId });
  assert.equal(chat.status, 'bot');
  assert.equal(chat.activeOutreach, true);
  assert.equal(state.stage, 'video_sent');
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId: 'tenant_a', commandId: body.commandId }), 0);
});

test('send_text e send_media sao rejeitados depois do handoff', async () => {
  const context = await seedHandoffContext(106);
  const handoff = handoffPayload(context);
  const routed = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${handoff.commandId}`, body: handoff
  });
  assert.equal(routed.response.status, 202);

  const textCommand = {
    ...handoff,
    commandId: `${handoff.commandId}_text`,
    type: 'send_text',
    expectedStage: 'human_handoff',
    nextStage: 'after_handoff',
    text: 'Nao deve enviar',
    handoff: null
  };
  const mediaCommand = {
    ...handoff,
    commandId: `${handoff.commandId}_media`,
    type: 'send_media',
    expectedStage: 'human_handoff',
    nextStage: 'after_handoff',
    media: { type: 'image', url: 'https://example.test/blocked.jpg', caption: null, filename: null },
    handoff: null
  };
  const textResponse = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${textCommand.commandId}`, body: textCommand
  });
  const mediaResponse = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${mediaCommand.commandId}`, body: mediaCommand
  });
  assert.equal(textResponse.response.status, 409);
  assert.equal(textResponse.payload.code, 'human_attendance_active');
  assert.equal(mediaResponse.response.status, 409);
  assert.equal(mediaResponse.payload.code, 'human_attendance_active');
});

test('mensagem inbound durante protecao fica aguardando e notifica Turizmo uma unica vez', async () => {
  const context = await seedHandoffContext(107);
  const handoff = handoffPayload(context, {
    handoff: {
      queueId: null,
      priority: 'high',
      title: 'Atendimento protegido',
      reason: 'Lead em acompanhamento',
      autoClose: false,
      holdHours: 24,
      inboundDuringHold: 'notify_turizmo'
    }
  });
  const routed = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${handoff.commandId}`, body: handoff
  });
  assert.equal(routed.response.status, 202);

  const message = {
    id: `msg_protected_${context.chatId}`,
    text: 'Ainda estou aguardando retorno',
    timestamp: new Date().toISOString()
  };
  await adapter.insertOne('chatMessages', {
    ...message,
    messageId: message.id,
    tenantId: 'tenant_a',
    chatId: context.chatId,
    sender: 'user',
    createdAt: message.timestamp,
    updatedAt: message.timestamp
  });
  const protectedChat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  const first = await notifyProtectedAttendanceInbound({ chat: protectedChat, message });
  const replay = await notifyProtectedAttendanceInbound({ chat: protectedChat, message });
  assert.equal(first.handled, true);
  assert.equal(replay.handled, true);

  const chat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  assert.equal(chat.status, 'waiting');
  assert.equal(chat.attendanceStatus, 'message_waiting');
  assert.equal(chat.automationLocked, true);
  assert.equal(chat.flowStarted, false);
  assert.equal(await adapter.countDocuments('messageClassifications', { tenantId: 'tenant_a', messageId: message.id }), 0);

  const events = await adapter.findMany('integrationOutbox', {
    query: {
      tenantId: 'tenant_a',
      eventType: 'attendance.message_waiting',
      'payload.data.messageId': message.id
    }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.data.turizmoLeadId, context.turizmoLeadId);
  assert.equal(events[0].payload.data.campaignId, context.campaignId);
  assert.equal(events[0].payload.data.chatId, context.chatId);
  assert.equal(events[0].payload.data.currentMessage, message.text);
  assert.equal(events[0].payload.data.direction, 'inbound');
});

test('handoff manual recoloca a mesma conversa e reutiliza a mesma tarefa', async () => {
  const context = await seedHandoffContext(108);
  const firstCommand = handoffPayload(context);
  const first = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${firstCommand.commandId}`, body: firstCommand
  });
  assert.equal(first.response.status, 202);
  await adapter.updateOne('activeChats', { tenantId: 'tenant_a', id: context.chatId }, {
    $set: { status: 'open', attendanceStatus: 'open', agentId: 'agent_1', agentName: 'Agente 1' }
  });

  const requeueCommand = handoffPayload(context, {
    commandId: `command_requeue_${context.chatId}`,
    decisionId: `decision_requeue_${context.chatId}`,
    expectedStage: 'etapa_antiga_aceita_no_requeue',
    handoff: {
      queueId: 'queue_explicit',
      priority: 'urgent',
      title: 'Reencaminhar lead',
      reason: 'Nova tentativa manual',
      autoClose: false,
      holdHours: 36,
      inboundDuringHold: 'notify_turizmo'
    }
  });
  const requeued = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${requeueCommand.commandId}`, body: requeueCommand
  });
  assert.equal(requeued.response.status, 202);
  assert.equal(requeued.payload.chatId, context.chatId);
  assert.equal(requeued.payload.taskId, first.payload.taskId);
  assert.equal(requeued.payload.requeued, true);

  const chat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  assert.equal(chat.status, 'waiting');
  assert.equal(chat.queueId, 'queue_explicit');
  assert.equal(chat.agentId, null);
  assert.equal(chat.automationLocked, true);
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId: 'tenant_a', chatId: context.chatId }), 1);

  const duplicateDecision = await request('/api/integrations/turizmo/commands', {
    method: 'POST',
    idempotencyKey: `turizmo-command:${requeueCommand.commandId}:same-decision`,
    body: { ...requeueCommand, commandId: `${requeueCommand.commandId}_other` }
  });
  assert.equal(duplicateDecision.response.status, 202);
  assert.equal(duplicateDecision.payload.duplicate, true);
  assert.equal(duplicateDecision.payload.taskId, first.payload.taskId);
  assert.equal(await adapter.countDocuments('commercialTasks', { tenantId: 'tenant_a', chatId: context.chatId }), 1);
});

test('hold renova protecao e somente close confirmado encerra atendimento', async () => {
  const context = await seedHandoffContext(109);
  const handoff = handoffPayload(context);
  const routed = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${handoff.commandId}`, body: handoff
  });
  assert.equal(routed.response.status, 202);
  const initialProtectedUntil = new Date(routed.payload.protectedUntil).getTime();

  const hold = {
    ...handoff,
    commandId: `command_hold_${context.chatId}`,
    decisionId: `decision_hold_${context.chatId}`,
    type: 'hold_attendance',
    expectedStage: 'human_handoff',
    nextStage: 'human_handoff',
    holdHours: 120
  };
  const held = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${hold.commandId}`, body: hold
  });
  assert.equal(held.response.status, 202);
  assert.ok(new Date(held.payload.protectedUntil).getTime() > initialProtectedUntil);
  const heldChat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  assert.equal(heldChat.automationLocked, true);
  assert.equal(heldChat.protectedAttendance, true);
  assert.equal(heldChat.postHandoff.holdHours, 120);

  const invalidClose = {
    ...handoff,
    commandId: `command_close_invalid_${context.chatId}`,
    decisionId: `decision_close_invalid_${context.chatId}`,
    type: 'close_attendance',
    expectedStage: 'human_handoff',
    nextStage: 'closed',
    handoff: null,
    confirmation: null
  };
  const rejected = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${invalidClose.commandId}`, body: invalidClose
  });
  assert.equal(rejected.response.status, 400);
  assert.equal((await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId })).status, 'waiting');

  const close = {
    ...invalidClose,
    commandId: `command_close_${context.chatId}`,
    decisionId: `decision_close_${context.chatId}`,
    confirmation: {
      manual: true,
      confirmedBy: 'turizmo-user-1',
      confirmedAt: new Date().toISOString()
    }
  };
  const closed = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${close.commandId}`, body: close
  });
  assert.equal(closed.response.status, 202);
  assert.equal(closed.payload.closureMode, 'manual');
  const closedChat = await adapter.findOne('activeChats', { tenantId: 'tenant_a', id: context.chatId });
  assert.equal(closedChat.status, 'closed');
  assert.equal(closedChat.automationLocked, false);
  assert.equal(closedChat.protectedAttendance, false);
  assert.equal(closedChat.closeReason, 'turizmo_manual_close');

  const replay = await request('/api/integrations/turizmo/commands', {
    method: 'POST', idempotencyKey: `turizmo-command:${close.commandId}`, body: close
  });
  assert.equal(replay.response.status, 202);
  assert.equal(replay.payload.duplicate, true);
  assert.equal(await adapter.countDocuments('integrationOutbox', {
    tenantId: 'tenant_a', eventType: 'attendance.closed', 'payload.data.commandId': close.commandId
  }), 1);
});

test('campanha rejeita lead ausente e template nao aprovado', async () => {
  const base = {
    tenantId: 'tenant_a', turizmoCampaignId: 'tur_campaign_invalid', name: 'Invalida',
    channel: 'whatsapp', templateId: 'template_approved', senderPhoneNumberId: 'sender_1',
    turizmoLeadIds: ['lead_missing'], values: {}, timezone: 'America/Sao_Paulo'
  };
  const missing = await request('/api/integrations/turizmo/campaigns', {
    method: 'POST', idempotencyKey: 'campaign:missing', body: base
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.code, 'turizmo_leads_not_synced');

  const pendingTemplate = await request('/api/integrations/turizmo/campaigns', {
    method: 'POST', idempotencyKey: 'campaign:pending-template',
    body: { ...base, turizmoCampaignId: 'tur_campaign_pending', templateId: 'template_pending', turizmoLeadIds: ['lead_1'] }
  });
  assert.equal(pendingTemplate.response.status, 400);
  assert.equal(pendingTemplate.payload.message, 'Somente templates aprovados podem ser enviados.');
});
