import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// Audio gravado no painel vai como mensagem de voz: a Meta so mostra microfone e
// onda quando "voice": true esta dentro do objeto audio.

process.env.NODE_ENV = 'test';
process.env.WHATSAPP_FAKE_SEND = 'false';
process.env.JWT_SECRET = 'whatsapp-voice-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { sendWhatsAppMedia } = await import('../src/services/whatsappApi.js');

const originalFetch = global.fetch;
const pedidos = [];
global.fetch = async (url, options) => {
  pedidos.push(JSON.parse(options.body));
  return new Response(JSON.stringify({ messages: [{ id: `wamid.teste_${pedidos.length}` }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};
after(() => { global.fetch = originalFetch; });

const enviar = (extra) => sendWhatsAppMedia({
  accessToken: 'token-de-teste',
  phoneNumberId: 'numero_teste',
  to: '5511999990000',
  mediaUrl: 'https://exemplo.test/audio.ogg',
  ...extra
});

test('audio gravado no painel vai com voice: true dentro de audio', async () => {
  await enviar({ mediaType: 'audio', voice: true });
  const pedido = pedidos.at(-1);
  assert.equal(pedido.type, 'audio');
  assert.equal(pedido.audio.voice, true);
  assert.equal(pedido.audio.link, 'https://exemplo.test/audio.ogg');
});

test('audio comum e outras midias nao levam voice', async () => {
  await enviar({ mediaType: 'audio' });
  assert.equal(pedidos.at(-1).audio.voice, undefined);
  await enviar({ mediaType: 'document', voice: true, filename: 'a.pdf' });
  assert.equal(pedidos.at(-1).document.voice, undefined);
});
