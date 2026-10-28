import test from 'node:test';
import assert from 'node:assert/strict';
import { captureError, initErrorTracking, scrubEvent } from '../src/services/errorTracking.js';

// Erro vai para fora do servidor: nada de dado de cliente nem segredo junto.

test('evento sai sem corpo, cookies, cabecalhos de auth nem token na query', () => {
  const evento = scrubEvent({
    request: {
      url: 'https://api/x?hub.verify_token=segredo&hub.challenge=1',
      data: { telefone: '5511999990000', texto: 'oi' },
      cookies: { sessao: 'abc' },
      headers: { authorization: 'Bearer jwt', 'user-agent': 'Meta', cookie: 'a=b' },
      query_string: 'access_token=EAAG123&page=2'
    },
    user: { id: 'u1', email: 'x@y.com', ip_address: '1.2.3.4' },
    extra: { body: { a: 1 }, jobId: 'j1' },
    exception: { values: [{ value: 'Falha ao enviar para 5511999990000 (+5511988887777)' }] }
  });
  assert.equal(evento.exception.values[0].value, 'Falha ao enviar para *** (***)');
  assert.equal(evento.request.data, undefined);
  assert.equal(evento.request.cookies, undefined);
  assert.deepEqual(evento.request.headers, { 'user-agent': 'Meta' });
  assert.equal(evento.request.query_string, 'access_token=***&page=2');
  assert.equal(evento.request.url, 'https://api/x?hub.verify_token=***&hub.challenge=1');
  assert.deepEqual(evento.user, { id: 'u1' });
  assert.deepEqual(evento.extra, { jobId: 'j1' });
});

test('sem SENTRY_DSN fica desligado e capturar nao faz nada', async () => {
  delete process.env.SENTRY_DSN;
  assert.equal(await initErrorTracking(), false);
  assert.doesNotThrow(() => captureError(new Error('x'), { tags: { queue: 'q' } }));
});
