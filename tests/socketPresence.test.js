import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Monitoramento mostrava todo mundo offline depois de reiniciar o servidor: a
// lista de online vive em memoria e so o login/heartbeat preenchia. Agora o
// socket conectado marca online, simetrico ao offline da desconexao.

const dbPath = path.join(os.tmpdir(), `socket-presence-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'socket-presence-test-only';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { handleSocketConnected, handleSocketDisconnected } = await import('../src/services/socketPresence.js');
const { getOnlineUserIds, markOffline } = await import('../src/services/userStatus.js');

// io de mentira: sockets conectados + registro do que foi avisado a cada sala.
const criarIo = () => {
  const avisos = [];
  const sockets = new Map();
  return {
    avisos,
    sockets: { sockets },
    to: (sala) => ({ emit: (evento, dados) => avisos.push({ sala, evento, ...dados }) }),
    emit: (evento, dados) => avisos.push({ sala: '*', evento, ...dados }),
    conectar(socket) { sockets.set(socket.id, socket); return socket; },
    desconectar(socket) { sockets.delete(socket.id); }
  };
};

before(async () => { await adapter.init(); });
beforeEach(async () => {
  await adapter.deleteMany('users', {});
  await adapter.insertOne('users', { id: 'u_ana', tenantId: 't1', username: 'ana', role: 'AGENT', status: 'offline' });
  markOffline('u_ana');
});
after(async () => { await adapter.close?.(); fs.rmSync(dbPath, { force: true }); });

test('servidor reiniciado: o painel reconecta e o atendente volta a aparecer online na hora', async () => {
  // Lista em memoria vazia, como logo apos o reinicio; ninguem fez login.
  assert.equal(getOnlineUserIds().has('u_ana'), false);
  const io = criarIo();
  const socket = io.conectar({ id: 's1', userId: 'u_ana', tenantId: 't1' });

  await handleSocketConnected(io, socket);

  assert.equal(getOnlineUserIds().has('u_ana'), true);
  assert.equal((await adapter.findOne('users', { id: 'u_ana' })).status, 'online');
  assert.deepEqual(io.avisos, [{ sala: 'tenant:t1', evento: 'user_status', userId: 'u_ana', status: 'online' }]);
});

test('duas sessoes (painel + extensao): so a ultima a cair deixa offline', async () => {
  const io = criarIo();
  // Na pratica cada sessao conecta e avisa na sua vez.
  const painel = io.conectar({ id: 's1', userId: 'u_ana', tenantId: 't1' });
  await handleSocketConnected(io, painel);
  const extensao = io.conectar({ id: 's2', userId: 'u_ana', tenantId: 't1', isGenesysExtension: true });
  await handleSocketConnected(io, extensao);
  assert.equal(io.avisos.filter((a) => a.status === 'online').length, 1, 'a segunda sessao nao avisa de novo');

  io.desconectar(painel);
  await handleSocketDisconnected(io, painel);
  assert.equal(getOnlineUserIds().has('u_ana'), true, 'a extensao continua conectada');

  io.desconectar(extensao);
  await handleSocketDisconnected(io, extensao);
  assert.equal(getOnlineUserIds().has('u_ana'), false);
  assert.equal((await adapter.findOne('users', { id: 'u_ana' })).status, 'offline');
  assert.equal(io.avisos.filter((a) => a.status === 'offline').length, 1);
});

test('socket sem usuario nao mexe em ninguem', async () => {
  const io = criarIo();
  const anonimo = io.conectar({ id: 's9' });
  assert.equal(await handleSocketConnected(io, anonimo), false);
  assert.equal(io.avisos.length, 0);
});
