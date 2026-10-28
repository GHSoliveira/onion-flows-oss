import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Menu com opcoes de verdade no WhatsApp: botoes (ate 3), lista (ate 10) ou
// texto numerado; menu dinamico com opcoes vindas de uma variavel. O envio
// passa pela validacao real do payload da Meta (modo de envio falso).

const dbPath = path.join(os.tmpdir(), `onion-menu-interativo-${process.pid}.json`);
process.env.NODE_ENV = 'test';
process.env.DB_ADAPTER = 'json';
process.env.JSON_DB_PATH = dbPath;
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.WHATSAPP_FAKE_SEND = 'true';
process.env.JWT_SECRET = 'menu-interativo-test-secret-not-for-production';

const { default: adapter } = await import('../db/DatabaseAdapter.js');
const { runFlow, applyUserInput, getChatById } = await import('../src/services/flowRunner.js');
const { getChatMessages } = await import('../src/services/chatMessages.js');
const menu = await import('../src/services/menuOptions.js');

const tenantId = 'tenant_menu';
const textosEnviados = [];
const sendMessage = async (texto) => { textosEnviados.push(texto); return null; };

const saida = (pai, handle) => ({ id: `child_${pai}_${handle}`, type: 'caseNode', data: { label: handle } });
const liga = (origem, destino, handle = null) => ({ id: `e_${origem}_${destino}_${handle || ''}`, source: origem, target: destino, sourceHandle: handle });

const fluxoFixo = (optionsDisplay, quantidade = 2) => {
  const options = Array.from({ length: quantidade }, (_, i) => ({ id: String(i + 1), label: `Opção número ${i + 1}`, value: `v${i + 1}` }));
  return {
    nodes: [
      { id: 'menu', type: 'menuNode', data: { text: 'Como posso ajudar?', options, hasElse: true, optionsDisplay, setVarEnabled: true, variableName: 'escolha' } },
      ...options.map((o) => saida('menu', o.id)),
      saida('menu', 'else'),
      ...options.map((o) => ({ id: `fim_${o.id}`, type: 'holderNode', data: { text: '' } }))
    ],
    edges: [
      ...options.map((o) => liga('menu', `child_menu_${o.id}`, o.id)),
      liga('menu', 'child_menu_else', 'else'),
      ...options.map((o) => liga(`child_menu_${o.id}`, `fim_${o.id}`))
    ]
  };
};

const fluxoDinamico = {
  nodes: [
    {
      id: 'menu', type: 'menuNode',
      data: { text: 'Escolha um horário:', optionsSource: 'variable', optionsVariable: 'agenda.horarios', optionLabelPath: 'rotulo', optionValuePath: 'id', variableName: 'horario_escolhido', hasElse: true }
    },
    saida('menu', 'selected'), saida('menu', 'empty'), saida('menu', 'else'),
    { id: 'marcado', type: 'holderNode', data: { text: '' } },
    { id: 'sem_horario', type: 'holderNode', data: { text: '' } }
  ],
  edges: [
    liga('menu', 'child_menu_selected', 'selected'),
    liga('menu', 'child_menu_empty', 'empty'),
    liga('menu', 'child_menu_else', 'else'),
    liga('child_menu_selected', 'marcado'),
    liga('child_menu_empty', 'sem_horario')
  ]
};

let seq = 0;
const novoChat = async (vars = {}, channel = 'whatsapp') => {
  seq += 1;
  const id = `chat_menu_${seq}`;
  await adapter.insertOne('activeChats', {
    id, tenantId, status: 'bot', channel, channelUserId: '5511988887777', whatsappPhoneNumberId: 'sender_menu',
    flowStarted: true, messages: [], vars
  });
  return id;
};

const ultimaDoBot = async (chatId) => (await getChatMessages(chatId)).filter((m) => m.sender === 'bot').at(-1);
const rodar = (flowData, chatId, nodeId = 'menu') => runFlow({ nodeId, flowData, currentVars: {}, chatId, templates: [], schedules: [], sendMessage });
const responder = async (flowData, chatId, { text, buttonId = null }) => applyUserInput({
  chat: await getChatById(chatId), flowData, text, buttonId, templates: [], schedules: [], sendMessage
});

before(async () => {
  fs.writeFileSync(dbPath, '{}\n', 'utf8');
  await adapter.init();
  await adapter.insertOne('tenants', { id: tenantId, name: 'Menu', status: 'active' });
  await adapter.insertOne('channelConfigs', { id: `channels_${tenantId}`, tenantId, whatsapp: { enabled: true, accessToken: 'tok', phoneNumberId: 'sender_menu' } });
});

after(async () => {
  await adapter.close();
  try { fs.unlinkSync(dbPath); } catch {}
});

test('menu antigo (sem escolha de exibicao) continua mandando so o texto', async () => {
  const chatId = await novoChat();
  textosEnviados.length = 0;
  await rodar(fluxoFixo(undefined), chatId);
  assert.deepEqual(textosEnviados, ['Como posso ajudar?']);
  const r = await responder(fluxoFixo(undefined), chatId, { text: '2' });
  assert.equal(r.reason, 'menuNode');
  assert.equal((await getChatById(chatId)).vars.escolha, 'v2');
});

test('ate 3 opcoes vao como botoes; o toque no botao e reconhecido pelo codigo', async () => {
  const fluxo = fluxoFixo('auto', 2);
  const chatId = await novoChat();
  await rodar(fluxo, chatId);
  const enviada = await ultimaDoBot(chatId);
  assert.equal(enviada.meta?.type, 'whatsapp_interactive');
  assert.equal(enviada.meta?.interactiveKind, 'button');
  assert.match(enviada.text, /1\. Opção número 1\n2\. Opção número 2/);
  // Titulo do botao vem cortado; vale o codigo.
  await responder(fluxo, chatId, { text: 'Opção número 2', buttonId: '2' });
  const depois = await getChatById(chatId);
  assert.equal(depois.vars.escolha, 'v2');
  assert.equal(depois.menuContext, null);
});

test('4 a 10 opcoes vao como lista; mais de 10 viram texto numerado', async () => {
  const chatLista = await novoChat();
  await rodar(fluxoFixo('auto', 6), chatLista);
  assert.equal((await ultimaDoBot(chatLista)).meta?.interactiveKind, 'list');

  const chatTexto = await novoChat();
  textosEnviados.length = 0;
  await rodar(fluxoFixo('auto', 12), chatTexto);
  assert.match(textosEnviados.at(-1), /^Como posso ajudar\?\n\n1\. Opção número 1/);
  assert.match(textosEnviados.at(-1), /12\. Opção número 12$/);
});

test('fora do WhatsApp (simulador) as opcoes vao numeradas no texto', async () => {
  const chatId = await novoChat({}, 'web');
  textosEnviados.length = 0;
  await rodar(fluxoFixo('auto', 2), chatId);
  assert.equal(textosEnviados.at(-1), 'Como posso ajudar?\n\n1. Opção número 1\n2. Opção número 2');
  await responder(fluxoFixo('auto', 2), chatId, { text: 'opcao numero 1' });
  assert.equal((await getChatById(chatId)).vars.escolha, 'v1');
});

test('menu dinamico: opcoes da variavel, escolha salva e saida "escolheu"', async () => {
  const horarios = [{ id: 'h1', rotulo: 'Seg 14h' }, { id: 'h2', rotulo: 'Ter 9h' }, { id: 'h3', rotulo: 'Qua 16h' }, { id: 'h4', rotulo: 'Qui 10h' }];
  const chatId = await novoChat();
  await runFlow({ nodeId: 'menu', flowData: fluxoDinamico, currentVars: { agenda: { horarios } }, chatId, templates: [], schedules: [], sendMessage });
  const enviada = await ultimaDoBot(chatId);
  assert.equal(enviada.meta?.interactiveKind, 'list');
  const r = await responder(fluxoDinamico, chatId, { text: 'Ter 9h', buttonId: '2' });
  assert.equal(r.reason, 'menuNode');
  const depois = await getChatById(chatId);
  assert.equal(depois.vars.horario_escolhido, 'h2');
  assert.equal(depois.currentNodeId, 'marcado');
});

test('menu dinamico sem itens segue pela saida "lista vazia" sem mandar nada', async () => {
  const chatId = await novoChat({ agenda: { horarios: [] } });
  textosEnviados.length = 0;
  await runFlow({ nodeId: 'menu', flowData: fluxoDinamico, currentVars: { agenda: { horarios: [] } }, chatId, templates: [], schedules: [], sendMessage });
  assert.equal((await getChatById(chatId)).currentNodeId, 'sem_horario');
  assert.deepEqual(textosEnviados, []);
});

test('regras puras: texto JSON, item simples, acento e corte dos titulos', () => {
  const opcoes = menu.resolveMenuOptions({ optionsSource: 'variable', optionsVariable: 'lista' }, { lista: '["Banho completo com hidratação", "Tosa"]' });
  assert.deepEqual(opcoes.map((o) => o.label), ['Banho completo com hidratação', 'Tosa']);
  const lista = menu.buildMenuInteractive({ bodyText: 'Escolha', options: opcoes, format: 'list' });
  assert.equal(lista.action.sections[0].rows[0].title.length <= 24, true);
  assert.equal(lista.action.sections[0].rows[0].description, 'Banho completo com hidratação');
  assert.equal(menu.matchMenuOption({ options: opcoes, text: 'TOSA' })?.id, '2');
  assert.equal(menu.matchMenuOption({ options: opcoes, text: 'banho completo com hidratacao' })?.id, '1');
  assert.equal(menu.resolveDisplayMode({ optionsSource: 'variable' }), 'auto');
  assert.equal(menu.resolveDisplayMode({}), 'text');
});
