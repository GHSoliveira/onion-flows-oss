import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// O wa_id da Meta vem sem o nono digito e o contato foi salvo com ele. Antes,
// a comparacao exata nunca casava: o cliente aparecia como nao identificado e
// o upsert criava um contato duplicado a cada conversa.

const dbPath = path.join(os.tmpdir(), `onion-contact-identity-${process.pid}.json`);

process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.JWT_SECRET = 'contact-identity-test-secret-not-for-production';
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { attachContactNames, findContactByIdentity, upsertContactFromChannel } = await import('../src/services/contactIdentity.js');
const { buildPhoneVariants, contactMatchesPhone } = await import('../src/utils/phoneVariants.js');

const T = 'tenant_teste';
const SEM_NONO = '551197100001';
const COM_NONO = '5511997100001';

const contato = (id, nome, identificador, extra = {}) => ({
  id,
  tenantId: T,
  name: nome,
  agentDefinedName: nome,
  phones: [{ number: identificador, normalizedNumber: identificador }],
  channelIdentities: [{ channel: 'whatsapp', identifier: identificador, normalizedIdentifier: identificador, isPrimary: true }],
  primaryChannel: 'whatsapp',
  primaryIdentifier: identificador,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...extra
});

const reset = async () => {
  for (const nome of ['contacts', 'activeChats']) await adapter.deleteMany(nome, {});
  await adapter.insertOne('contacts', contato('contact_maria', 'Maria Souza', SEM_NONO));
  await adapter.insertOne('contacts', contato('contact_joao', 'João Lima', '5511988887777'));
};

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
});
beforeEach(reset);
after(() => { try { fs.unlinkSync(dbPath); } catch {} });

test('variacoes: com e sem o nono digito descrevem o mesmo numero', () => {
  assert.ok(buildPhoneVariants(COM_NONO).includes(SEM_NONO));
  assert.ok(buildPhoneVariants(SEM_NONO).includes(COM_NONO));
  assert.ok(contactMatchesPhone(contato('x', 'x', SEM_NONO), COM_NONO));
  assert.equal(contactMatchesPhone(contato('x', 'x', SEM_NONO), '5511988887777'), false);
});

test('busca por identidade acha o contato salvo sem o nono digito', async () => {
  const achado = await findContactByIdentity({ tenantId: T, channel: 'whatsapp', identifier: COM_NONO });
  assert.equal(achado?.id, 'contact_maria');

  const pelaFormaExata = await findContactByIdentity({ tenantId: T, channel: 'whatsapp', identifier: SEM_NONO });
  assert.equal(pelaFormaExata?.id, 'contact_maria');

  const outroNumero = await findContactByIdentity({ tenantId: T, channel: 'whatsapp', identifier: '5511999990000' });
  assert.equal(outroNumero, null);

  const outroTenant = await findContactByIdentity({ tenantId: 'tenant_vizinho', channel: 'whatsapp', identifier: COM_NONO });
  assert.equal(outroTenant, null);
});

test('mensagem recebida nao duplica contato e guarda a forma usada pelo canal', async () => {
  const r = await upsertContactFromChannel({ tenantId: T, channel: 'whatsapp', rawIdentifier: COM_NONO, channelDisplayName: 'Maria' });
  assert.equal(r?.created, false, 'reaproveita o contato existente');
  assert.equal(r?.contact?.id, 'contact_maria');

  const contatos = await adapter.findDocuments('contacts', { tenantId: T });
  assert.equal(contatos.length, 2, 'nao criou contato novo');

  const maria = contatos.find((c) => c.id === 'contact_maria');
  const formas = maria.channelIdentities.map((i) => i.normalizedIdentifier);
  assert.ok(formas.includes(SEM_NONO) && formas.includes(COM_NONO), 'guarda as duas formas');
  assert.equal(maria.agentDefinedName, 'Maria Souza', 'nome definido pelo atendente nao e sobrescrito');
});

test('numero desconhecido continua criando contato novo', async () => {
  const r = await upsertContactFromChannel({ tenantId: T, channel: 'whatsapp', rawIdentifier: '5511912345678', channelDisplayName: 'Novo' });
  assert.equal(r?.created, true);
  assert.equal((await adapter.findDocuments('contacts', { tenantId: T })).length, 3);
});

test('historico: conversa sem nome recebe o nome do contato salvo', async () => {
  const chats = [
    { id: 'chat_1', tenantId: T, channelUserId: COM_NONO, customerName: null },
    { id: 'chat_2', tenantId: T, channelUserId: '5511988887777', customerName: 'Nome ja gravado' },
    { id: 'chat_3', tenantId: T, channelUserId: '5511900000000', customerName: null }
  ];
  await attachContactNames(T, chats);
  assert.equal(chats[0].customerName, 'Maria Souza');
  assert.equal(chats[0].contactId, 'contact_maria');
  assert.equal(chats[1].customerName, 'Nome ja gravado', 'nao sobrescreve o que ja veio');
  assert.equal(chats[2].customerName, null, 'numero sem contato continua sem nome');
});

test('contato sem nome de verdade nao vira "Visitante" na tela', async () => {
  await adapter.insertOne('contacts', {
    ...contato('contact_sem_nome', null, '5511911112222'),
    name: null,
    agentDefinedName: null,
    channelIdentities: [{ channel: 'whatsapp', identifier: '5511911112222', normalizedIdentifier: '5511911112222', isPrimary: true }]
  });
  const chats = [{ id: 'chat_4', tenantId: T, channelUserId: '5511911112222', customerName: null }];
  await attachContactNames(T, chats);
  assert.equal(chats[0].customerName, null);
});
