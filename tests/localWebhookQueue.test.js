import test from 'node:test';
import assert from 'node:assert/strict';

// Fila em memoria do webhook sem Redis: uma rajada nao pode rodar tudo de uma vez
// (estourava o pool do banco e perdia mensagem) e falha transitoria tenta de novo.

const { createLocalQueue, isTransientDbError } = await import('../src/services/localWebhookQueue.js');

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ate = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado');
    await esperar(5);
  }
};

test('rajada de 200 roda no maximo 5 por vez e processa todas', async () => {
  let ativos = 0;
  let pico = 0;
  let feitos = 0;
  const fila = createLocalQueue({
    concurrency: 5,
    handler: async () => {
      ativos += 1;
      pico = Math.max(pico, ativos);
      await esperar(2);
      ativos -= 1;
      feitos += 1;
    }
  });
  for (let i = 0; i < 200; i += 1) fila.push({ i });
  await ate(() => feitos === 200);
  assert.equal(pico, 5);
  assert.deepEqual(fila.stats(), { active: 0, pending: 0, concurrency: 5 });
});

test('timeout de conexao com o banco tenta de novo e nao perde a mensagem', async () => {
  let tentativas = 0;
  let ok = false;
  const falhas = [];
  const fila = createLocalQueue({
    concurrency: 1,
    retryDelayMs: 1,
    handler: async () => {
      tentativas += 1;
      if (tentativas < 3) throw new Error('timeout exceeded when trying to connect');
      ok = true;
    },
    onFailure: (error) => falhas.push(error)
  });
  fila.push({});
  await ate(() => ok);
  assert.equal(tentativas, 3);
  assert.equal(falhas.length, 0);
});

test('erro que nao e de conexao nao repete e e reportado', async () => {
  let tentativas = 0;
  const falhas = [];
  const fila = createLocalQueue({
    concurrency: 1,
    retryDelayMs: 1,
    handler: async () => {
      tentativas += 1;
      throw new Error('Chat nao encontrado');
    },
    onFailure: (error, job, attempts) => falhas.push({ message: error.message, attempts })
  });
  fila.push({});
  await ate(() => falhas.length === 1);
  assert.equal(tentativas, 1);
  assert.deepEqual(falhas, [{ message: 'Chat nao encontrado', attempts: 1 }]);
});

test('reconhece os erros transitorios do pool', () => {
  assert.equal(isTransientDbError(new Error('timeout exceeded when trying to connect')), true);
  assert.equal(isTransientDbError(new Error('(EMAXCONNSESSION) max clients reached')), true);
  assert.equal(isTransientDbError(new Error('duplicate key value')), false);
});
