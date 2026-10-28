import test from 'node:test';
import assert from 'node:assert/strict';

// Timer pontual do delay: respeita o lock do chat, nao duplica e tem limites.

process.env.NODE_ENV = 'test';
process.env.REDIS_ENABLED = 'false';

const { withChatLock } = await import('../src/services/chatLocks.js');
const {
  MAX_TIMER_DELAY_MS,
  scheduleDelayResume,
  setDelayResumeHandler
} = await import('../src/services/delayResumeScheduler.js');

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('timer agendado dentro do lock do chat espera o lock ser liberado', async () => {
  const eventos = [];
  setDelayResumeHandler((chatId) => withChatLock(chatId, async () => { eventos.push('retomou'); }));

  await withChatLock('chat_lock', async () => {
    assert.equal(scheduleDelayResume('chat_lock', 50), true);
    await espera(800);   // o timer vence (~300ms) com o lock ainda preso
    eventos.push('liberou');
  });
  await espera(100);

  assert.deepEqual(eventos, ['liberou', 'retomou']);
});

test('reagendar o mesmo chat substitui o timer anterior', async () => {
  const chamadas = [];
  setDelayResumeHandler(async (chatId) => { chamadas.push(chatId); });

  scheduleDelayResume('chat_repetido', 100);
  scheduleDelayResume('chat_repetido', 150);
  await espera(700);

  assert.deepEqual(chamadas, ['chat_repetido']);
});

test('nao agenda sem rotina registrada, sem chat ou fora do limite', () => {
  setDelayResumeHandler(async () => {});
  assert.equal(scheduleDelayResume(null, 1000), false);
  assert.equal(scheduleDelayResume('chat_x', 0), false);
  assert.equal(scheduleDelayResume('chat_x', MAX_TIMER_DELAY_MS + 1), false);

  setDelayResumeHandler(null);
  assert.equal(scheduleDelayResume('chat_x', 1000), false);
});
