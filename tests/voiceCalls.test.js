import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Chamadas de voz recebidas pelo WhatsApp: o webhook "connect" faz tocar para um
// atendente online da fila de cada vez (rodizio fixo), quem atende responde a
// oferta SDP pela Meta, e o "terminate" fecha como atendida ou perdida.

const dbPath = path.join(os.tmpdir(), `voice-calls-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'voice-calls-test-only';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.AI_CLASSIFICATION_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const voice = await import('../src/services/voiceCalls.js');
const { handleWhatsAppWebhook } = await import('../src/services/whatsappHandler.js');
const { markOnline, markOffline } = await import('../src/services/userStatus.js');
const { setIo } = await import('../src/services/logs.js');

const T = 'tenant_voz';
const PHONE_ID = 'phone_voz';
const CLIENTE = '5511999990001';
const OFERTA = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const RESPOSTA = 'v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

const agente = (id, name, queues = ['Recepção']) => ({ id, tenantId: T, username: id, name, role: 'AGENT', queues, active: true });

const webhook = (calls, contacts = [{ wa_id: CLIENTE, profile: { name: 'Mariana' } }]) => ({
  payload: {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba_voz', changes: [{ field: 'calls', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE_ID }, contacts, calls } }] }]
  }
});

const liga = (callId) => webhook([{ id: callId, from: CLIENTE, to: '5511900000000', event: 'connect', direction: 'USER_INITIATED', timestamp: String(Math.floor(Date.now() / 1000)), session: { sdp_type: 'offer', sdp: OFERTA } }]);
const encerra = (callId, extra = {}) => webhook([{ id: callId, from: CLIENTE, to: '5511900000000', event: 'terminate', direction: 'USER_INITIATED', timestamp: String(Math.floor(Date.now() / 1000)), status: 'Completed', ...extra }]);

const chamada = (callId) => adapter.findOne(voice.VOICE_CALLS, { id: `voice_${callId}` });
const acoes = (action) => voice.fakeCallActions.filter((item) => item.action === action);

before(async () => {
  await adapter.init();
});

beforeEach(async () => {
  voice.resetVoiceCallRuntime();
  for (const collection of ['users', 'queues', 'channelConfigs', 'tenants', 'activeChats', 'chatEvents', 'chatMessages', voice.VOICE_CALLS, voice.VOICE_SETTINGS, voice.VOICE_ROTATION]) {
    await adapter.deleteMany(collection, {});
  }
  for (const id of ['u_ana', 'u_bruno', 'u_carla', 'u_davi']) markOffline(id);
  await adapter.insertOne('tenants', { id: T, name: 'Clínica Voz', plan: 'pro', status: 'active' });
  await adapter.insertOne('channelConfigs', { id: `channels_${T}`, tenantId: T, whatsapp: { enabled: true, accessToken: 'token', wabaId: 'waba_voz', phoneNumberId: PHONE_ID } });
  await adapter.insertOne('queues', { id: 'q_recepcao', tenantId: T, name: 'Recepção' });
  await adapter.insertOne('queues', { id: 'q_financeiro', tenantId: T, name: 'Financeiro' });
  // Ordem fixa do rodizio e alfabetica: Ana, Bruno, Carla.
  await adapter.insertOne('users', agente('u_carla', 'Carla'));
  await adapter.insertOne('users', agente('u_ana', 'Ana'));
  await adapter.insertOne('users', agente('u_bruno', 'Bruno'));
  await adapter.insertOne('users', agente('u_davi', 'Davi', ['Financeiro']));
  for (const id of ['u_ana', 'u_bruno', 'u_carla', 'u_davi']) markOnline(id);
  await voice.saveVoiceSettings(T, { enabled: true, queueName: 'Recepção', ringSeconds: 10, missedMessage: { enabled: true, text: 'Perdemos sua ligação, fala por aqui!' } });
});

after(async () => {
  voice.resetVoiceCallRuntime();
  await adapter.close?.();
  fs.rmSync(dbPath, { force: true });
});

test('webhook de chamada e lido com numero, nome, oferta e duracao', () => {
  const [connect] = voice.parseCallEvents(liga('wacid.1').payload);
  assert.equal(connect.event, 'connect');
  assert.equal(connect.callId, 'wacid.1');
  assert.equal(connect.from, CLIENTE);
  assert.equal(connect.contactName, 'Mariana');
  assert.equal(connect.sdp, OFERTA);
  assert.equal(connect.phoneNumberId, PHONE_ID);

  const [fim] = voice.parseCallEvents(encerra('wacid.1', { status: ['Completed'], duration: 95, start_time: '1758200000', end_time: '1758200095' }).payload);
  assert.equal(fim.event, 'terminate');
  assert.equal(fim.status, 'Completed');
  assert.equal(fim.duration, 95);
  assert.ok(fim.startTime.startsWith('2025-'));
});

test('ligacao toca so para quem esta online na fila, em ordem fixa, e o rodizio avanca', async () => {
  markOffline('u_bruno');
  await handleWhatsAppWebhook(liga('wacid.a'));
  const primeira = await chamada('wacid.a');
  assert.equal(primeira.status, 'ringing');
  assert.deepEqual(primeira.ringOrder.map((a) => a.id), ['u_ana', 'u_carla'], 'Bruno offline e Davi de outra fila ficam fora');
  assert.equal(primeira.currentAgentId, 'u_ana');
  assert.ok(primeira.chatId, 'a ligacao fica na conversa do cliente');

  markOnline('u_bruno');
  await handleWhatsAppWebhook(liga('wacid.b'));
  const segunda = await chamada('wacid.b');
  assert.equal(segunda.currentAgentId, 'u_bruno', 'depois da Ana, o proximo da ordem fixa');
  assert.deepEqual(segunda.ringOrder.map((a) => a.id), ['u_bruno', 'u_carla'], 'Ana esta tocando para a outra ligacao');
});

test('atender: so quem foi chamado, e a resposta vai para a Meta com pre_accept e accept', async () => {
  await handleWhatsAppWebhook(liga('wacid.c'));

  await assert.rejects(
    voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.c', user: { id: 'u_carla', name: 'Carla' }, sdp: RESPOSTA }),
    (error) => error.code === 'voice_call_not_offered'
  );

  const aceito = await voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.c', user: { id: 'u_ana', name: 'Ana' }, sdp: RESPOSTA });
  assert.equal(aceito.status, 'active');
  assert.deepEqual(voice.fakeCallActions.map((item) => item.action), ['pre_accept', 'accept']);
  assert.equal(acoes('accept')[0].session.sdp, RESPOSTA);
  assert.equal(acoes('accept')[0].session.sdp_type, 'answer');
  assert.equal(acoes('accept')[0].phoneNumberId, PHONE_ID);

  const salva = await chamada('wacid.c');
  assert.equal(salva.answeredBy.name, 'Ana');

  await assert.rejects(
    voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.c', user: { id: 'u_ana', name: 'Ana' }, sdp: RESPOSTA }),
    (error) => error.code === 'voice_call_not_ringing',
    'nao atende duas vezes'
  );
});

test('dois cliques ao mesmo tempo: so um atende', async () => {
  await handleWhatsAppWebhook(liga('wacid.d'));
  await voice.declineVoiceCall({ tenantId: T, callId: 'wacid.d', user: { id: 'u_ana' } });
  // Ana recusou e o toque foi para o Bruno; os dois ja foram chamados.
  const [a, b] = await Promise.allSettled([
    voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.d', user: { id: 'u_bruno', name: 'Bruno' }, sdp: RESPOSTA }),
    voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.d', user: { id: 'u_bruno', name: 'Bruno' }, sdp: RESPOSTA })
  ]);
  assert.equal([a, b].filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(acoes('accept').length, 1);
});

test('quem recusou nao atende depois', async () => {
  await handleWhatsAppWebhook(liga('wacid.d2'));
  await voice.declineVoiceCall({ tenantId: T, callId: 'wacid.d2', user: { id: 'u_ana' } });
  await assert.rejects(
    voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.d2', user: { id: 'u_ana', name: 'Ana' }, sdp: RESPOSTA }),
    (error) => error.code === 'voice_call_declined'
  );
});

test('encerrada depois de atendida: completa, com duracao, na linha do tempo', async () => {
  await handleWhatsAppWebhook(liga('wacid.e'));
  await voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.e', user: { id: 'u_ana', name: 'Ana' }, sdp: RESPOSTA });
  await handleWhatsAppWebhook(encerra('wacid.e', { duration: 125 }));

  const salva = await chamada('wacid.e');
  assert.equal(salva.status, 'completed');
  assert.equal(salva.duration, 125);

  const eventos = await adapter.findMany('chatEvents', { query: { tenantId: T, chatId: salva.chatId }, sort: { timestamp: 1 } });
  const tipos = eventos.map((e) => e.type);
  assert.ok(tipos.includes('VOICE_CALL_RECEIVED'));
  assert.ok(tipos.includes('VOICE_CALL_ANSWERED'));
  assert.ok(tipos.includes('VOICE_CALL_ENDED'));
  assert.equal(eventos.find((e) => e.type === 'VOICE_CALL_ENDED').context.duration, 125);
  assert.equal(voice.fakeCallActions.filter((item) => item.action === 'reject').length, 0);
});

test('ninguem atendeu: perdida, com a mensagem opcional no WhatsApp e na conversa', async () => {
  await handleWhatsAppWebhook(liga('wacid.f'));
  await handleWhatsAppWebhook(encerra('wacid.f', { status: 'Failed' }));

  const salva = await chamada('wacid.f');
  assert.equal(salva.status, 'missed');
  assert.ok(salva.missedMessageSentAt, 'mensagem de perdida enviada');

  const mensagens = await adapter.findMany('chatMessages', { query: { tenantId: T, chatId: salva.chatId } });
  assert.ok(mensagens.some((m) => m.sender === 'bot' && m.text === 'Perdemos sua ligação, fala por aqui!'));

  const perdida = (await adapter.findMany('chatEvents', { query: { tenantId: T, chatId: salva.chatId } })).find((e) => e.type === 'VOICE_CALL_MISSED');
  assert.deepEqual(perdida.context.ringedAgents, ['Ana']);

  // Reenvio do mesmo webhook nao manda a mensagem de novo.
  await handleWhatsAppWebhook(encerra('wacid.f', { status: 'Failed' }));
  const depois = await adapter.findMany('chatMessages', { query: { tenantId: T, chatId: salva.chatId } });
  assert.equal(depois.filter((m) => m.text === 'Perdemos sua ligação, fala por aqui!').length, 1);
});

test('mensagem de perdida desligada: so registra', async () => {
  await voice.saveVoiceSettings(T, { missedMessage: { enabled: false } });
  await handleWhatsAppWebhook(liga('wacid.g'));
  await handleWhatsAppWebhook(encerra('wacid.g', { status: 'Failed' }));
  const salva = await chamada('wacid.g');
  assert.equal(salva.status, 'missed');
  assert.equal(salva.missedMessageSentAt ?? null, null);
});

test('recusar passa para o proximo; se todos recusam, a ligacao e recusada na Meta', async () => {
  await handleWhatsAppWebhook(liga('wacid.h'));
  await voice.declineVoiceCall({ tenantId: T, callId: 'wacid.h', user: { id: 'u_ana' } });
  assert.equal((await chamada('wacid.h')).currentAgentId, 'u_bruno');
  await voice.declineVoiceCall({ tenantId: T, callId: 'wacid.h', user: { id: 'u_bruno' } });
  assert.equal((await chamada('wacid.h')).currentAgentId, 'u_carla');
  await voice.declineVoiceCall({ tenantId: T, callId: 'wacid.h', user: { id: 'u_carla' } });

  const salva = await chamada('wacid.h');
  assert.equal(salva.status, 'unanswered');
  assert.equal(salva.endReason, 'all_declined');
  assert.equal(acoes('reject').length, 1);

  // Quem nao esta sendo chamado nao consegue "recusar" por outro.
  await handleWhatsAppWebhook(liga('wacid.h2'));
  const tocando = await chamada('wacid.h2');
  await voice.declineVoiceCall({ tenantId: T, callId: 'wacid.h2', user: { id: 'u_davi' } });
  assert.equal((await chamada('wacid.h2')).currentAgentId, tocando.currentAgentId);
});

test('ninguem online: a ligacao continua chamando e toca para quem abrir o painel no meio', async (t) => {
  for (const id of ['u_ana', 'u_bruno', 'u_carla']) markOffline(id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const esperar = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

  await handleWhatsAppWebhook(liga('wacid.i'));
  const esperando = await chamada('wacid.i');
  assert.equal(esperando.status, 'ringing', 'nao recusa mais na hora');
  assert.equal(esperando.currentAgentId, null);
  assert.ok(esperando.waitingSince);
  assert.equal(acoes('reject').length, 0);

  t.mock.timers.tick(2000);
  await esperar();
  assert.equal((await chamada('wacid.i')).currentAgentId, null, 'continua esperando');

  markOnline('u_carla');
  t.mock.timers.tick(2000);
  await esperar();
  const tocando = await chamada('wacid.i');
  assert.equal(tocando.currentAgentId, 'u_carla', 'quem entrou no meio recebe o toque');
  assert.equal(tocando.waitingSince, null);
  t.mock.timers.reset();
});

test('ninguem apareceu ate o fim: perdida com motivo "ninguem online" e a mensagem', async (t) => {
  for (const id of ['u_ana', 'u_bruno', 'u_carla']) markOffline(id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const esperar = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  await handleWhatsAppWebhook(liga('wacid.i2'));
  t.mock.timers.tick(55000);
  await esperar();
  t.mock.timers.reset();
  assert.equal((await chamada('wacid.i2')).status, 'unanswered');
  await handleWhatsAppWebhook(encerra('wacid.i2', { status: 'Failed' }));
  const perdida = await chamada('wacid.i2');
  assert.equal(perdida.status, 'missed');
  assert.equal(perdida.endReason, 'no_agents');
  assert.ok(perdida.missedMessageSentAt);
});

test('ligacoes desligadas: recusa na hora', async () => {
  await voice.saveVoiceSettings(T, { enabled: false });
  await handleWhatsAppWebhook(liga('wacid.j'));
  assert.equal((await chamada('wacid.j')).endReason, 'voice_disabled');
  assert.equal(acoes('reject').length, 1);
});

test('quem fecha o painel no meio da ligacao sai do rodizio', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const esperar = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  await handleWhatsAppWebhook(liga('wacid.s'));
  assert.equal((await chamada('wacid.s')).currentAgentId, 'u_ana');
  markOffline('u_bruno');
  t.mock.timers.tick(10000);
  await esperar();
  assert.equal((await chamada('wacid.s')).currentAgentId, 'u_carla', 'Bruno saiu, pula para a Carla');
  t.mock.timers.reset();
});

test('atendente em outra ligacao nao recebe toque', async () => {
  await handleWhatsAppWebhook(liga('wacid.k'));
  await voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.k', user: { id: 'u_ana', name: 'Ana' }, sdp: RESPOSTA });
  await handleWhatsAppWebhook(liga('wacid.l'));
  assert.ok(!(await chamada('wacid.l')).ringOrder.some((a) => a.id === 'u_ana'));
});

test('desligar: so quem atendeu, e manda terminate para a Meta', async () => {
  await handleWhatsAppWebhook(liga('wacid.m'));
  await voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.m', user: { id: 'u_ana', name: 'Ana' }, sdp: RESPOSTA });
  await assert.rejects(
    voice.hangupVoiceCall({ tenantId: T, callId: 'wacid.m', user: { id: 'u_bruno' } }),
    (error) => error.code === 'voice_call_not_owner'
  );
  await voice.hangupVoiceCall({ tenantId: T, callId: 'wacid.m', user: { id: 'u_ana' } });
  assert.equal(acoes('terminate').length, 1);
  await handleWhatsAppWebhook(encerra('wacid.m', { duration: 40 }));
  assert.equal((await chamada('wacid.m')).endReason, 'agent_hangup');
});

test('configuracao: ativar exige fila existente e os limites de tempo sao respeitados', async () => {
  await assert.rejects(voice.saveVoiceSettings(T, { queueName: 'Não existe' }), (error) => error.code === 'voice_queue_not_found');
  await assert.rejects(voice.saveVoiceSettings(T, { queueName: null, enabled: true }), (error) => error.code === 'voice_queue_required');
  const salvo = await voice.saveVoiceSettings(T, { ringSeconds: 99, maxRingSeconds: 3 });
  assert.equal(salvo.ringSeconds, 25);
  assert.equal(salvo.maxRingSeconds, 10);
  assert.equal((await voice.saveVoiceSettings(T, { maxRingSeconds: 99 })).maxRingSeconds, 58, 'nunca passa do prazo da Meta');
});

test('painel recarregado recupera a ligacao tocando ou em andamento', async () => {
  await handleWhatsAppWebhook(liga('wacid.n'));
  const tocando = await voice.getCurrentCallForUser({ tenantId: T, user: { id: 'u_ana' } });
  assert.equal(tocando.state, 'ringing');
  assert.equal(tocando.call.sdp, OFERTA);
  assert.equal((await voice.getCurrentCallForUser({ tenantId: T, user: { id: 'u_bruno' } })).state, 'idle');

  await voice.acceptVoiceCall({ tenantId: T, callId: 'wacid.n', user: { id: 'u_ana', name: 'Ana' }, sdp: RESPOSTA });
  assert.equal((await voice.getCurrentCallForUser({ tenantId: T, user: { id: 'u_ana' } })).state, 'active');

  const lista = await voice.listVoiceCalls({ tenantId: T });
  assert.equal(lista.items[0].offerSdp, undefined, 'SDP nao vaza na listagem');
  assert.equal(lista.pagination.total, lista.items.length);
  // Historico pagina no servidor: pagina 1 com uma so traz a mais recente, e a
  // ultima pagina + 1 volta vazia com o total certo.
  const primeira = await voice.listVoiceCalls({ tenantId: T, limit: 1, page: 1 });
  assert.deepEqual(primeira.items.map((call) => call.id), [lista.items[0].id]);
  assert.equal(primeira.pagination.pages, lista.pagination.total);
  const alem = await voice.listVoiceCalls({ tenantId: T, limit: 1, page: lista.pagination.total + 1 });
  assert.deepEqual(alem.items, []);
});

test('rodizio por tempo: passa para o proximo sozinho e para antes do prazo da Meta', async (t) => {
  await voice.saveVoiceSettings(T, { ringSeconds: 5, maxRingSeconds: 12 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const esperar = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

  await handleWhatsAppWebhook(liga('wacid.o'));
  assert.equal((await chamada('wacid.o')).currentAgentId, 'u_ana');

  t.mock.timers.tick(5000);
  await esperar();
  assert.equal((await chamada('wacid.o')).currentAgentId, 'u_bruno');

  t.mock.timers.tick(5000);
  await esperar();
  assert.equal((await chamada('wacid.o')).currentAgentId, 'u_carla');

  t.mock.timers.tick(2000);
  await esperar();
  const expirada = await chamada('wacid.o');
  assert.equal(expirada.status, 'unanswered');
  assert.equal(expirada.currentAgentId, null);
  assert.equal(acoes('reject').length, 0, 'deixa a Meta encerrar como nao atendida');

  // O terminate da Meta fecha como perdida e registra quem foi chamado.
  t.mock.timers.reset();
  await handleWhatsAppWebhook(encerra('wacid.o', { status: 'Failed' }));
  const perdida = await chamada('wacid.o');
  assert.equal(perdida.status, 'missed');
  const evento = (await adapter.findMany('chatEvents', { query: { tenantId: T, chatId: perdida.chatId } })).find((e) => e.type === 'VOICE_CALL_MISSED');
  assert.deepEqual(evento.context.ringedAgents, ['Ana', 'Bruno', 'Carla']);
});


test('sem conversa aberta: registro ja encerrado, sem fluxo rodando nem monitoramento', async () => {
  await handleWhatsAppWebhook(liga('wacid.p'));
  const call = await chamada('wacid.p');
  const chat = await adapter.findOne('activeChats', { id: call.chatId });
  assert.equal(chat.status, 'closed');
  assert.equal(chat.origin, 'voice_call');
  assert.equal(chat.currentNodeId, null, 'nenhum fluxo comecou');
  assert.equal(chat.customerName, 'Mariana');
  assert.equal(chat.queue, 'Recepção');
});

test('com conversa aberta: a ligacao entra nela', async () => {
  await adapter.insertOne('activeChats', {
    id: 'chat_aberta', tenantId: T, channel: 'whatsapp', channelUserId: CLIENTE, status: 'open',
    createdAt: new Date(Date.now() - 60000).toISOString(), updatedAt: new Date().toISOString()
  });
  await handleWhatsAppWebhook(liga('wacid.q'));
  assert.equal((await chamada('wacid.q')).chatId, 'chat_aberta');
  assert.equal((await adapter.findMany('activeChats', { query: { tenantId: T } })).length, 1, 'nao cria outra conversa');
});

test('todo evento de ligacao que o servidor manda ao painel e repassado pelo socket do painel', () => {
  // O painel so repassa eventos de uma lista fixa; foi o que fez o primeiro
  // toque real nunca aparecer na tela.
  const servidor = fs.readFileSync(new URL('../src/services/voiceCalls.js', import.meta.url), 'utf8');
  const painel = fs.readFileSync(new URL('../client/src/services/socket.js', import.meta.url), 'utf8');
  const doDock = fs.readFileSync(new URL('../client/src/components/voice/VoiceCallDock.jsx', import.meta.url), 'utf8');
  const emitidos = [...new Set([...servidor.matchAll(/emitirParaUsuario\([^,]+,\s*'([a-z_]+)'/g)].map((m) => m[1]))];
  assert.ok(emitidos.length >= 3, `eventos encontrados: ${emitidos.join(', ')}`);
  for (const evento of emitidos) {
    assert.ok(painel.includes(`'${evento}'`), `socket.js nao repassa ${evento}`);
    assert.ok(doDock.includes(`'${evento}'`), `VoiceCallDock nao escuta ${evento}`);
  }
});


test('quem esta com o painel aberto recebe o toque mesmo depois de o servidor reiniciar', async () => {
  // Reinicio: a lista de online do login zerou, mas o painel reconectou o socket.
  for (const id of ['u_ana', 'u_bruno', 'u_carla', 'u_davi']) markOffline(id);
  const avisos = [];
  const socketDe = (userId, extra = {}) => ({ userId, ...extra });
  setIo({
    sockets: { sockets: new Map([
      ['s1', socketDe('u_bruno')],
      ['s2', socketDe('u_carla', { isGenesysExtension: true })]
    ]) },
    to: (sala) => ({ emit: (evento, dados) => avisos.push({ sala, evento, callId: dados?.callId }) })
  });
  try {
    await handleWhatsAppWebhook(liga('wacid.r'));
    const call = await chamada('wacid.r');
    assert.deepEqual(call.ringOrder.map((a) => a.id), ['u_bruno'], 'so quem tem o painel aberto; a extensao do Genesys nao conta');
    assert.ok(avisos.some((a) => a.sala === 'user:u_bruno' && a.evento === 'voice_call_ringing' && a.callId === 'wacid.r'));
  } finally {
    setIo(null);
  }
});

test('rota de configuracao aceita o prazo novo de 55 s que a tela oferece', async () => {
  const { default: express } = await import('express');
  const { default: jwt } = await import('jsonwebtoken');
  const { default: voiceRouter } = await import('../src/routes/voiceCalls.js');
  const { JWT_SECRET_VALUE } = await import('../src/config/constants.js');
  await adapter.insertOne('users', { id: 'u_admin_voz', tenantId: T, username: 'admin_voz', role: 'ADMIN', permissions: ['*'] });
  const app = express();
  app.use(express.json());
  app.use('/voice-calls', voiceRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const token = jwt.sign({ userId: 'u_admin_voz' }, JWT_SECRET_VALUE, { expiresIn: 60 });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/voice-calls/settings`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ maxRingSeconds: 55, ringSeconds: 10 })
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.maxRingSeconds, 55);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
