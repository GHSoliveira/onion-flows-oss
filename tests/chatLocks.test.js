import test from 'node:test';
import assert from 'node:assert/strict';
import { withChatLock } from '../src/services/chatLocks.js';

test('withChatLock serializa execucoes do mesmo chat', async () => {
  const order = [];

  const first = withChatLock('chat_a', async () => {
    order.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push('first:end');
  });

  const second = withChatLock('chat_a', async () => {
    order.push('second:start');
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push('second:end');
  });

  await Promise.all([first, second]);

  assert.deepEqual(order, [
    'first:start',
    'first:end',
    'second:start',
    'second:end'
  ]);
});

test('withChatLock permite execucao paralela entre chats diferentes', async () => {
  const started = [];

  await Promise.all([
    withChatLock('chat_a', async () => {
      started.push('a');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }),
    withChatLock('chat_b', async () => {
      started.push('b');
      await new Promise((resolve) => setTimeout(resolve, 20));
    })
  ]);

  assert.equal(started.length, 2);
  assert.ok(started.includes('a'));
  assert.ok(started.includes('b'));
});

test('withChatLock permite reentrada no mesmo contexto assincrono', async () => {
  const order = [];

  await withChatLock('chat_reentrant', async () => {
    order.push('outer:start');
    await withChatLock('chat_reentrant', async () => {
      order.push('inner');
    });
    order.push('outer:end');
  });

  assert.deepEqual(order, [
    'outer:start',
    'inner',
    'outer:end'
  ]);
});
