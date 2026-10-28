import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'test-only-jwt-secret-with-at-least-32-characters';

const {
  blockWhatsAppUsers,
  isWhatsAppUserBlocked,
  unblockWhatsAppUsers
} = await import('../src/services/whatsappApi.js');

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

test('bloqueia usuario pela API oficial com payload normalizado', async () => {
  let request = null;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      messaging_product: 'whatsapp',
      block_users: { added_users: [{ input: '5511997001638', wa_id: '551197001638' }] }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await blockWhatsAppUsers({
    accessToken: 'token_test',
    phoneNumberId: 'phone_1',
    users: ['wa_5511997001638']
  });

  assert.match(request.url, /\/phone_1\/block_users$/);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer token_test');
  assert.deepEqual(JSON.parse(request.options.body), {
    messaging_product: 'whatsapp',
    block_users: [{ user: '5511997001638' }]
  });
  assert.equal(result.block_users.added_users[0].wa_id, '551197001638');
});

test('consulta paginas e reconhece canonicalizacao de numero brasileiro', async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        data: [{ messaging_product: 'whatsapp', wa_id: '5511999999999' }],
        paging: { cursors: { after: 'next_page' }, next: 'https://graph.facebook.com/next' }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      data: [{ messaging_product: 'whatsapp', wa_id: '551197001638' }],
      paging: { cursors: {} }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const status = await isWhatsAppUserBlocked({
    accessToken: 'token_test',
    phoneNumberId: 'phone_1',
    user: '5511997001638'
  });

  assert.equal(calls, 2);
  assert.deepEqual(status, { blocked: true, waId: '551197001638', complete: true });
});

test('desbloqueia usuario pela API oficial', async () => {
  let method = null;
  global.fetch = async (_url, options) => {
    method = options.method;
    return new Response(JSON.stringify({
      messaging_product: 'whatsapp',
      block_users: { removed_users: [{ input: '551197001638', wa_id: '551197001638' }] }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await unblockWhatsAppUsers({
    accessToken: 'token_test',
    phoneNumberId: 'phone_1',
    users: ['551197001638']
  });

  assert.equal(method, 'DELETE');
  assert.equal(result.block_users.removed_users[0].wa_id, '551197001638');
});
