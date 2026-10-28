import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// LGPD: localizar e apagar tudo de um titular pelo telefone, em qualquer
// formato, sem tocar em outro titular nem em outro tenant.

const dbPath = path.join(os.tmpdir(), `onion-data-subject-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'data-subject-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { buildPhoneVariants, eraseDataSubject, findDataSubjectRecords, previewDataSubject } = await import('../src/services/dataSubject.js');

const A = 'tenant_titular_a';
const B = 'tenant_titular_b';

const contato = (id, tenantId, number, extra = {}) => ({
  id,
  tenantId,
  name: `Contato ${id}`,
  normalizedPrimaryPhone: number,
  phones: [{ id: `ph_${id}`, channel: 'whatsapp', number: `+${number}`, normalizedNumber: number, waId: number }],
  ...extra
});

const conversa = (id, tenantId, channelUserId, channel = 'whatsapp') => ({
  id,
  tenantId,
  channel,
  channelUserId,
  customerCpf: channel === 'whatsapp' ? `wa_${channelUserId}` : null,
  status: 'closed',
  createdAt: new Date().toISOString()
});

const semear = async () => {
  // Titular: contato guardou 12 digitos (sem nono digito), a conversa guardou 13.
  await adapter.insertOne('contacts', contato('titular', A, '551198150000'));
  await adapter.insertOne('activeChats', conversa('chat_titular', A, '5511998150000'));
  await adapter.insertOne('chatMessages', { id: 'm1', tenantId: A, chatId: 'chat_titular', sender: 'user', text: 'oi' });
  await adapter.insertOne('chatMessages', { id: 'm2', tenantId: A, chatId: 'chat_titular', sender: 'bot', text: 'ola' });
  await adapter.insertOne('chatEvents', { id: 'e1', tenantId: A, chatId: 'chat_titular', type: 'CHAT_OPENED' });
  await adapter.insertOne('contactOutreachHistory', { id: 'h1', tenantId: A, contactId: 'titular' });

  // Numero dos EUA gravado com o "55" da regra antiga na conversa, e certo no contato.
  await adapter.insertOne('contacts', contato('eua', A, '16465894168', { phones: [], normalizedPrimaryPhone: '16465894168', channelIdentities: [{ channel: 'whatsapp', normalizedIdentifier: '16465894168', channelMeta: { waId: '5516465894168' } }] }));
  await adapter.insertOne('activeChats', conversa('chat_eua', A, '5516465894168'));

  // Nao podem ser tocados.
  await adapter.insertOne('contacts', contato('vizinho', A, '5511998150001'));
  await adapter.insertOne('activeChats', conversa('chat_vizinho', A, '5511998150001'));
  await adapter.insertOne('activeChats', conversa('chat_telegram', A, '5511998150000', 'telegram'));
  await adapter.insertOne('contacts', contato('outro_tenant', B, '5511998150000'));
  await adapter.insertOne('activeChats', conversa('chat_outro_tenant', B, '5511998150000'));
  await adapter.insertOne('chatMessages', { id: 'm3', tenantId: B, chatId: 'chat_outro_tenant', sender: 'user', text: 'oi' });
};

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await semear();
});

after(() => {
  try { fs.unlinkSync(dbPath); } catch {}
});

test('variacoes do telefone cobrem DDI, nono digito e o 55 da regra antiga', () => {
  const br = buildPhoneVariants('(11) 99815-0000');
  for (const esperado of ['11998150000', '5511998150000', '551198150000', '1198150000']) {
    assert.ok(br.includes(esperado), `faltou ${esperado}`);
  }
  assert.deepEqual(buildPhoneVariants('(11) 3025-1234').sort(), ['1130251234', '551130251234'].sort(), 'fixo nao ganha nono digito');
  assert.ok(buildPhoneVariants('+1 646 589 4168').includes('5516465894168'));
  assert.ok(buildPhoneVariants('5516465894168').includes('16465894168'));
  assert.deepEqual(buildPhoneVariants('123'), []);
});

test('busca pelo telefone digitado acha contato e conversa gravados em formatos diferentes', async () => {
  const r = await findDataSubjectRecords({ tenantId: A, phone: '(11) 99815-0000' });
  assert.deepEqual(r.contactIds, ['titular']);
  assert.deepEqual(r.chatIds, ['chat_titular'], 'nem o vizinho nem a conversa do Telegram');
});

test('previa conta sem apagar nada', async () => {
  const p = await previewDataSubject({ tenantId: A, phone: '5511998150000' });
  assert.deepEqual(p.counts, { contacts: 1, chats: 1, chatMessages: 2, chatEvents: 1 });
  assert.deepEqual(p.contacts, [{ id: 'titular', name: 'Contato titular' }]);
  assert.equal((await adapter.findDocuments('chatMessages', { tenantId: A })).length, 2);
});

test('eliminacao apaga tudo do titular so no tenant atual', async () => {
  const deleted = await eraseDataSubject({ tenantId: A, phone: '11 9815-0000' });
  assert.equal(deleted.contacts, 1);
  assert.equal(deleted.chats, 1);
  assert.equal(deleted.chatMessages, 2);
  assert.equal(deleted.chatEvents, 1);
  assert.equal(deleted.outreachHistory, 1);

  const contatosA = (await adapter.findDocuments('contacts', { tenantId: A })).map((c) => c.id).sort();
  assert.deepEqual(contatosA, ['eua', 'vizinho']);
  const chatsA = (await adapter.findDocuments('activeChats', { tenantId: A })).map((c) => c.id).sort();
  assert.deepEqual(chatsA, ['chat_eua', 'chat_telegram', 'chat_vizinho']);

  assert.equal((await adapter.findDocuments('contacts', { tenantId: B })).length, 1, 'outro tenant intacto');
  assert.equal((await adapter.findDocuments('chatMessages', { tenantId: B })).length, 1);
});

test('numero corrompido pela regra antiga apaga conversa e contato juntos', async () => {
  const deleted = await eraseDataSubject({ tenantId: A, phone: '5516465894168' });
  assert.equal(deleted.chats, 1);
  assert.equal(deleted.contacts, 1, 'o contato gravado sem 55 tambem sai');
});
