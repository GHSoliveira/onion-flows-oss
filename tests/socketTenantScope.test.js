import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Log e mensagem enviada pela tela de contatos iam para todos os sockets
// conectados, de qualquer empresa. Agora cada aviso vai so para as salas de
// quem pode ver.

const dbPath = path.join(os.tmpdir(), `socket-tenant-scope-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'socket-tenant-scope-test-only';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

fs.writeFileSync(dbPath, '{}\n', 'utf8');

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { createLog, setIo } = await import('../src/services/logs.js');

const avisos = [];
const io = {
  to: (salas) => ({ emit: (evento, dados) => avisos.push({ salas: [].concat(salas), evento, dados }) }),
  emit: (evento, dados) => avisos.push({ salas: ['*'], evento, dados })
};

before(async () => { await adapter.init(); setIo(io); });
after(async () => { setIo(null); await adapter.close?.(); fs.rmSync(dbPath, { force: true }); });

test('log de empresa vai para a Supervisao e para a sala da empresa, nao para todos', async () => {
  avisos.length = 0;
  await createLog('ERROR', { text: 'falha no envio', tenantId: 'tenant_a' });
  const log = avisos.find((a) => a.evento === 'new_log');
  assert.ok(log);
  assert.deepEqual(log.salas.sort(), ['role:SUPER_ADMIN', 'tenant:tenant_a']);
});

test('log sem empresa fica so com a Supervisao', async () => {
  avisos.length = 0;
  await createLog('INFO', 'manutencao do sistema');
  const log = avisos.find((a) => a.evento === 'new_log');
  assert.deepEqual(log.salas, ['role:SUPER_ADMIN']);
});

test('nenhum servico avisa todos os sockets de uma vez', () => {
  const pasta = path.resolve('src/services');
  const soltos = fs.readdirSync(pasta)
    .filter((nome) => nome.endsWith('.js'))
    .filter((nome) => /\bio\.emit\(/.test(fs.readFileSync(path.join(pasta, nome), 'utf8')));
  assert.deepEqual(soltos, []);
});
