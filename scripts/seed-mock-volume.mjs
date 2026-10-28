#!/usr/bin/env node
/**
 * Enche o banco JSON do sandbox com uma empresa ficticia de volume
 * ("Mock - Pet Center"): centenas de contatos, conversas, campanhas, tarefas,
 * ligacoes, templates, logs... para testar paginacao e leitura das listas.
 *
 *   node scripts/seed-mock-volume.mjs            usa sandbox/data/db.json
 *   node scripts/seed-mock-volume.mjs --limpar   remove so a empresa mock
 *
 * So escreve em arquivo JSON dentro de sandbox/: nunca em banco remoto. Roda
 * de novo sem duplicar (apaga a empresa mock antes de recriar). Dados com
 * aleatoriedade fixa (mesma semente), telefones com DDD 00 para nunca
 * coincidirem com numero real.
 */
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcrypt';

const RAIZ = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ARQUIVO = path.resolve(RAIZ, process.env.MOCK_DB_PATH || 'sandbox/data/db.json');
if (!ARQUIVO.startsWith(path.join(RAIZ, 'sandbox'))) {
  console.error(`Recusado: ${ARQUIVO} fica fora de sandbox/.`);
  process.exit(1);
}

const T = 'tenant_mock_volume';
const MARCA = 'mock-volume-v1';
const LIMPAR = process.argv.includes('--limpar');

// Aleatorio com semente: rodar duas vezes gera os mesmos dados.
let semente = 20260919;
const rnd = () => { semente = (semente * 1664525 + 1013904223) % 4294967296; return semente / 4294967296; };
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
const AGORA = Date.parse('2026-09-19T12:00:00-03:00');
const iso = (msAtras) => new Date(AGORA - msAtras).toISOString();
const dias = (n) => n * 86400000;
const min = (n) => n * 60000;
let seq = 0;
const nid = (prefixo) => `${prefixo}_mock_${(++seq).toString(36).padStart(6, '0')}`;

const NOMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elaine', 'Fabio', 'Gabriela', 'Heitor', 'Isabela', 'Joao', 'Karina', 'Lucas', 'Mariana', 'Nicolas', 'Olivia', 'Paulo', 'Rafaela', 'Samuel', 'Tatiane', 'Vinicius', 'Yasmin', 'Wagner', 'Beatriz', 'Caio', 'Debora', 'Eduardo', 'Fernanda', 'Gustavo', 'Helena', 'Igor'];
const SOBRENOMES = ['Silva', 'Souza', 'Oliveira', 'Santos', 'Pereira', 'Lima', 'Carvalho', 'Ferreira', 'Rodrigues', 'Almeida', 'Costa', 'Gomes', 'Martins', 'Araujo', 'Ribeiro', 'Barbosa', 'Rocha', 'Dias', 'Moreira', 'Cardoso'];
const PETS = ['Thor', 'Luna', 'Mel', 'Bob', 'Nina', 'Fred', 'Belinha', 'Max', 'Pipoca', 'Toby', 'Amora', 'Zeus', 'Lola', 'Bidu', 'Chico'];
const nomePessoa = () => `${pick(NOMES)} ${pick(SOBRENOMES)}`;
const telefone = () => `5500${int(90000, 99999)}${int(1000, 9999)}`;

const FILAS = ['RECEPCAO', 'BANHO E TOSA', 'VETERINARIO', 'VENDAS', 'FARMACIA PET', 'HOTELZINHO', 'ADESTRAMENTO', 'ENTREGAS', 'FINANCEIRO', 'POS-VENDA', 'RECLAMACOES', 'VIP'];
const CLIENTE_DIZ = ['Oi, queria agendar um banho pro {pet}', 'Qual o valor da tosa?', 'Vocês abrem sábado?', 'O {pet} pode ir amanhã às 10h?', 'Quanto custa a ração premium 15kg?', 'Preciso remarcar o horário', 'Vocês buscam em casa?', 'O {pet} está com coceira, tem veterinário hoje?', 'Obrigado!', 'Pode confirmar meu horário?', 'Tem vaga no hotelzinho no feriado?', 'Aceitam pix?'];
const BOT_DIZ = ['Olá! Sou o assistente do Pet Center. Como posso ajudar?', 'Escolha uma opção: 1) Banho e tosa 2) Veterinário 3) Produtos', 'Perfeito! Vou te passar para a equipe.', 'Temos horários amanhã às 9h, 10h30 e 14h.', 'Seu horário foi confirmado ✅'];
const AGENTE_DIZ = ['Oi! Aqui é da equipe, já vejo pra você.', 'Temos sim! Posso reservar?', 'O banho completo fica R$ 65 e a tosa R$ 80.', 'Agendado! Te esperamos 🐾', 'Vou verificar com o veterinário e já te retorno.'];

const db = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
const backup = ARQUIVO.replace(/\.json$/, `.antes-mock-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.json`);
fs.copyFileSync(ARQUIVO, backup);

// Tira tudo que for da empresa mock (e o que a referencia) antes de recriar.
let removidos = 0;
for (const [colecao, lista] of Object.entries(db)) {
  if (!Array.isArray(lista)) continue;
  const antes = lista.length;
  db[colecao] = lista.filter((doc) => doc?.tenantId !== T && doc?.id !== T && doc?.mockSeed !== MARCA);
  removidos += antes - db[colecao].length;
}
if (LIMPAR) {
  fs.writeFileSync(ARQUIVO, JSON.stringify(db));
  console.log(`empresa mock removida (${removidos} registros). backup: ${path.basename(backup)}`);
  process.exit(0);
}

const colecoes = {};
const add = (colecao, doc) => { (colecoes[colecao] ||= []).push({ tenantId: T, ...doc }); return doc; };

/* ---------------- empresa, filas, pessoas ---------------- */
add('tenants', {
  id: T, tenantId: undefined, name: 'Mock - Pet Center', slug: 'mock-pet-center', plan: 'pro', status: 'active',
  environment: 'development', mockSeed: MARCA,
  settings: { maxUsers: 100, maxFlows: 200, maxChatsPerDay: 10000 },
  billing: { paymentStatus: 'paid', blocked: false, dueDay: 10 },
  createdAt: iso(dias(120)), updatedAt: iso(dias(1))
});
const filas = FILAS.map((nome, i) => add('queues', {
  id: nid('queue'), name: nome, color: ['#155DFC', '#16A34A', '#DC2626', '#9333EA', '#EA580C', '#0891B2'][i % 6], active: i !== 11,
  description: `Fila de ${nome.toLowerCase()}`, entryMessage: 'Você entrou na fila, já te atendemos.', waitingMessage: 'Continua na fila, já já é sua vez.',
  createdAt: iso(dias(100 - i)), updatedAt: iso(dias(i))
}));

const senha = await bcrypt.hash('sandbox123', 10);
const pessoa = (role, i) => {
  const nome = nomePessoa();
  return add('users', {
    id: nid('u'), name: nome.toUpperCase(), username: role === 'ADMIN' ? 'mock.admin' : role === 'MANAGER' ? `mock.gerente${i}` : `mock.agente${String(i).padStart(2, '0')}`,
    password: senha, role, queues: role === 'AGENT' ? [pick(FILAS), pick(FILAS)].filter((v, k, a) => a.indexOf(v) === k) : FILAS,
    permissions: [], status: chance(0.3) ? 'online' : 'offline', lastSeen: iso(min(int(1, 60 * 24 * 10))),
    ratingCount: int(0, 60), ratingSum: 0, ratingAvg: 0, mustChangePassword: false,
    createdAt: iso(dias(int(10, 120))), updatedAt: iso(dias(int(0, 9)))
  });
};
const admin = pessoa('ADMIN', 0);
[1, 2, 3].forEach((i) => pessoa('MANAGER', i));
const agentes = Array.from({ length: 36 }, (_, i) => pessoa('AGENT', i + 1));
for (const u of colecoes.users) { u.ratingSum = Math.round(u.ratingCount * (3.4 + rnd() * 1.6)); u.ratingAvg = u.ratingCount ? Number((u.ratingSum / u.ratingCount).toFixed(2)) : 0; }

// WhatsApp "conectado" com token falso: libera as abas da Central do WhatsApp
// (alertas, chamadas). Qualquer chamada real a Meta falha com token invalido.
add('channelConfigs', {
  id: 'channel_config_mock_volume', telegram: null, createdAt: iso(dias(100)), updatedAt: iso(dias(1)),
  whatsapp: {
    enabled: true, accessToken: 'mock_token_invalido', phoneNumberId: 'mock_phone', wabaId: 'mock_waba', flowId: null,
    webhookVerifyToken: 'mock_verify', appSecret: 'mock_secret', updatedAt: iso(dias(1)),
    senderNumbers: [{ id: 'wa_sender_mock', label: 'Pet Center', displayNumber: '+55 00 90000-0000', phoneNumberId: 'mock_phone', enabled: true, isDefault: true }]
  }
});

/* ---------------- contatos ---------------- */
const contatos = Array.from({ length: 620 }, (_, i) => {
  const nome = nomePessoa();
  const numero = telefone();
  return add('contacts', {
    id: nid('contact'), name: nome, agentDefinedName: chance(0.3) ? `${nome} (tutor do ${pick(PETS)})` : null,
    tags: chance(0.4) ? [pick(['vip', 'banho-mensal', 'hotel', 'inadimplente', 'novo', 'gato', 'cao'])] : [],
    email: chance(0.35) ? `${nome.toLowerCase().replace(/\s/g, '.')}${i}@exemplo.com` : null, notes: chance(0.15) ? 'Cliente prefere horário de manhã.' : null, company: null,
    phones: [{ id: nid('phone'), waId: numero, label: null, number: numero, channel: 'whatsapp', isPrimary: true, normalizedNumber: numero }],
    primaryPhone: numero, normalizedPrimaryPhone: numero, primaryChannel: 'whatsapp', primaryIdentifier: numero, lastPhoneUsed: numero,
    channelIdentities: [{ id: nid('ident'), channel: 'whatsapp', identifier: numero, normalizedIdentifier: numero, displayValue: `+${numero}`, isPrimary: true, optedIn: chance(0.8), firstSeenAt: iso(dias(int(20, 200))), lastSeenAt: iso(dias(int(0, 20))) }],
    autoCreated: chance(0.7), createdBy: 'system', updatedBy: 'system',
    lastContactAt: iso(min(int(5, 60 * 24 * 60))), lastContactChannel: 'whatsapp',
    createdAt: iso(dias(int(10, 200))), updatedAt: iso(dias(int(0, 10)))
  });
});

/* ---------------- conversas, mensagens e eventos ---------------- */
const STATUS = [['closed', 0.62], ['open', 0.14], ['waiting', 0.1], ['bot', 0.1], ['parked', 0.04]];
const statusAleatorio = () => { let r = rnd(); for (const [s, p] of STATUS) { if ((r -= p) < 0) return s; } return 'closed'; };
for (let i = 0; i < 480; i += 1) {
  const contato = pick(contatos);
  const status = statusAleatorio();
  const agente = ['closed', 'open', 'parked'].includes(status) ? pick(agentes) : null;
  const fila = pick(filas).name;
  const pet = pick(PETS);
  const inicio = int(10, 60 * 24 * 75);
  const chatId = `chat_mock_${(i + 1).toString().padStart(4, '0')}`;
  const falas = [];
  const total = int(3, 14);
  for (let k = 0; k < total; k += 1) {
    const sender = k === 0 ? 'user' : k < 3 ? (k % 2 ? 'bot' : 'user') : (agente ? pick(['user', 'agent']) : pick(['user', 'bot']));
    const texto = (sender === 'user' ? pick(CLIENTE_DIZ) : sender === 'bot' ? pick(BOT_DIZ) : pick(AGENTE_DIZ)).replace('{pet}', pet);
    const ts = iso(min(inicio - k * int(1, 6)));
    const msg = { id: nid('msg'), messageId: nid('wamid'), chatId, sender, text: texto, media: null, buttons: null, replyTo: null, deliveryStatus: sender === 'user' ? null : pick(['sent', 'delivered', 'read', 'read']), timestamp: ts, createdAt: ts, updatedAt: ts };
    falas.push(msg);
    add('chatMessages', msg);
  }
  const ultima = falas.at(-1);
  add('activeChats', {
    id: chatId, channel: 'whatsapp', channelUserId: contato.primaryPhone, channelChatId: contato.primaryPhone, contactId: contato.id,
    queue: fila, status, agentId: agente?.id || null, agentName: agente?.name || null, flowStarted: true,
    vars: { NOME_PET: pet, SERVICO: pick(['banho', 'tosa', 'consulta', 'racao']) }, variables: {}, secureVars: {}, secureVarNames: [], inputAttempts: {},
    messages: [], messageCount: falas.length, lastMessage: ultima, lastMessageAt: ultima.timestamp,
    unreadByAgentCount: status === 'open' ? int(0, 4) : 0, waitingSince: status === 'waiting' ? iso(min(int(1, 90))) : null,
    assignedAt: agente ? iso(min(inicio - 3)) : null, closedAt: status === 'closed' ? iso(min(Math.max(1, inicio - total * 4))) : null,
    whatsappSenderLabel: 'Pet Center', createdAt: iso(min(inicio)), updatedAt: ultima.timestamp
  });
  const evento = (type, deltaMin, extra = {}) => add('chatEvents', { id: nid('evt'), chatId, type, timestamp: iso(min(inicio - deltaMin)), actor: { kind: 'system' }, context: { queue: fila }, ...extra });
  evento('FLOW_STARTED', 0);
  if (status !== 'bot') evento('QUEUE_ENTERED', 2);
  if (agente) evento('AGENT_ASSUMED', 3, { actor: { kind: 'agent', id: agente.id, name: agente.name } });
  if (status === 'closed') {
    evento('CHAT_CLOSED', total * 4, { actor: agente ? { kind: 'agent', id: agente.id, name: agente.name } : { kind: 'system' } });
    if (agente && chance(0.45)) evento('RATING_SUBMITTED', total * 4 + 1, { context: { queue: fila, value: pick([5, 5, 5, 4, 4, 3, 2, 1]), agentId: agente.id, agentName: agente.name, variableName: 'nota' } });
  }
}

/* ---------------- fluxos, variaveis, horarios ---------------- */
for (let i = 0; i < 38; i += 1) {
  const nome = `${pick(['Atendimento', 'Agendamento', 'Pesquisa', 'Promoção', 'Lembrete', 'Triagem', 'Pós-venda'])} ${pick(['banho', 'tosa', 'vacina', 'hotel', 'ração', 'consulta'])} ${i + 1}`;
  const nodes = [
    { id: 'start', type: 'startNode', position: { x: 0, y: 0 }, data: { label: '' } },
    { id: 'msg_1', type: 'messageNode', position: { x: 250, y: 0 }, data: { text: `Olá! Bem-vindo ao ${nome}.`, conditions: [], mappings: [] } },
    { id: 'fila_1', type: 'queueNode', position: { x: 520, y: 0 }, data: { queueName: pick(FILAS), queueMessage: 'Já te passo para a equipe.', conditions: [], mappings: [] } }
  ];
  const edges = [{ id: 'e1', source: 'start', target: 'msg_1', sourceHandle: 'default' }, { id: 'e2', source: 'msg_1', target: 'fila_1', sourceHandle: 'default' }];
  const publicado = chance(0.7);
  add('flows', {
    id: nid('f'), name: nome, description: chance(0.6) ? 'Fluxo gerado para teste de volume.' : '', status: publicado ? 'published' : 'draft',
    version: int(1, 12), nodes, edges, visualBlocks: [], draft: { nodes, edges, visualBlocks: [] },
    published: publicado ? { nodes, edges, visualBlocks: [], version: 1, publishedAt: iso(dias(int(1, 40))) } : null,
    publishHistory: [], createdBy: admin.id, createdAt: iso(dias(int(20, 110))), updatedAt: iso(dias(int(0, 19)))
  });
}
for (let i = 0; i < 90; i += 1) {
  add('variables', {
    id: nid('var'), name: `${pick(['NOME', 'PET', 'SERVICO', 'HORARIO', 'VALOR', 'RACA', 'PESO', 'ENDERECO'])}_${i + 1}`,
    type: pick(['string', 'number', 'boolean']), isRoot: false, enabled: chance(0.9), description: 'Variável de teste de volume', defaultValue: '',
    createdAt: iso(dias(int(5, 90))), updatedAt: iso(dias(int(0, 4)))
  });
}
const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
for (let i = 0; i < 16; i += 1) {
  add('schedules', {
    id: nid('sched'), name: `Horário ${pick(['Loja', 'Clínica', 'Banho', 'Hotel', 'Plantão'])} ${i + 1}`,
    rules: Object.fromEntries(DIAS.map((d, k) => [d, { active: k < 6 || chance(0.3), start: pick(['08:00', '09:00']), end: pick(['18:00', '19:00', '12:00']) }])),
    createdAt: iso(dias(int(5, 90))), updatedAt: iso(dias(int(0, 4)))
  });
}
for (let i = 0; i < 64; i += 1) {
  add('cannedResponses', { id: nid('canned'), name: `Resposta ${i + 1}`, shortcut: `/r${i + 1}`, message: pick(AGENTE_DIZ), createdAt: iso(dias(int(1, 60))), updatedAt: iso(dias(int(0, 1))) });
}

/* ---------------- templates ---------------- */
const templates = Array.from({ length: 44 }, (_, i) => {
  const nome = `${pick(['lembrete', 'promo', 'confirmacao', 'retorno', 'aniversario_pet', 'vacina'])}_${i + 1}`;
  const status = pick(['APPROVED', 'APPROVED', 'APPROVED', 'PENDING', 'REJECTED', 'PAUSED']);
  const corpo = `Olá {{1}}! ${pick(['O banho do seu pet está chegando.', 'Temos 15% off na tosa esta semana.', 'Sua vacina vence em 7 dias.', 'Sentimos falta do seu pet por aqui!'])}`;
  return add('whatsappTemplates', {
    id: `wa_tpl_${T}_${1000 + i}`, name: nome, status, category: pick(['MARKETING', 'UTILITY']), language: 'pt_BR', channel: 'whatsapp', provider: 'meta',
    bodyText: corpo, headerText: '', footerText: 'Pet Center', headerFormat: 'NONE', buttons: [], buttonCount: 0, placeholderCount: 1,
    components: [{ type: 'BODY', text: corpo, format: 'TEXT' }], qualityScore: pick(['GREEN', 'GREEN', 'YELLOW', 'UNKNOWN']),
    rejectedReason: status === 'REJECTED' ? 'INVALID_FORMAT' : 'NONE', metaTemplateId: String(9000000 + i), wabaId: 'mock_waba', phoneNumberId: 'mock_phone',
    lastSyncedAt: iso(dias(1)), createdAt: iso(dias(int(5, 90))), updatedAt: iso(dias(int(0, 4)))
  });
});
for (let i = 0; i < 32; i += 1) {
  add('whatsappInteractiveTemplates', {
    id: nid('wit'), name: `Menu ${pick(['principal', 'serviços', 'horários', 'pagamento'])} ${i + 1}`, kind: 'buttons', type: 'button', channel: 'whatsapp',
    bodyText: 'Escolha uma opção:', headerText: '', footerText: 'Pet Center', actionTitle: 'Ver opções', sections: [], productSections: [],
    buttons: [{ id: 'b1', title: 'Banho' }, { id: 'b2', title: 'Tosa' }, { id: 'b3', title: 'Falar com alguém' }],
    createdAt: iso(dias(int(5, 90))), updatedAt: iso(dias(int(0, 4)))
  });
}

/* ---------------- campanhas e itens ---------------- */
for (let c = 0; c < 48; c += 1) {
  const tpl = pick(templates.filter((t) => t.status === 'APPROVED'));
  const alvo = Array.from({ length: int(8, 40) }, () => pick(contatos)).filter((v, k, a) => a.indexOf(v) === k);
  const status = pick(['completed', 'completed', 'completed', 'processing', 'paused', 'cancelled', 'completed_with_errors', 'scheduled']);
  const campanhaId = nid('campaign');
  const criada = int(1, 90);
  const cont = { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, positive: 0, negative: 0, optOut: 0 };
  alvo.forEach((contato, k) => {
    const falhou = chance(0.06);
    const pendente = ['processing', 'paused', 'scheduled'].includes(status) && chance(0.4);
    const itemStatus = pendente ? 'pending' : falhou ? 'failed' : 'sent';
    const respondeu = itemStatus === 'sent' && chance(0.22);
    const sentimento = respondeu ? pick(['positive', 'positive', 'neutral', 'negative']) : null;
    if (itemStatus === 'sent') { cont.sent += 1; if (chance(0.9)) cont.delivered += 1; if (chance(0.6)) cont.read += 1; }
    if (falhou) cont.failed += 1;
    if (respondeu) cont.replied += 1;
    if (sentimento === 'positive') cont.positive += 1;
    if (sentimento === 'negative') { cont.negative += 1; if (chance(0.4)) cont.optOut += 1; }
    add('outreachCampaignItems', {
      id: nid('item'), campaignId: campanhaId, contactId: contato.id, contactName: contato.name, to: contato.primaryPhone, phoneNumber: contato.primaryPhone,
      sortIndex: k, status: itemStatus, deliveryStatus: itemStatus === 'sent' ? pick(['delivered', 'read', 'read']) : null, templateId: tpl.id,
      sentAt: itemStatus === 'sent' ? iso(dias(criada) - min(k)) : null, repliedAt: respondeu ? iso(dias(criada) - min(k + 30)) : null,
      intent: respondeu ? pick(['pediu_preco', 'pediu_demo', 'duvida', 'sem_interesse', 'opt_out']) : null, sentiment: sentimento,
      confidence: respondeu ? Number((0.55 + rnd() * 0.44).toFixed(2)) : null, failureCode: falhou ? 131026 : null, failureReason: falhou ? 'Mensagem não entregue' : null,
      error: null, createdAt: iso(dias(criada)), updatedAt: iso(dias(Math.max(0, criada - 1)))
    });
  });
  add('outreachCampaigns', {
    id: campanhaId, name: `${pick(['Reativação', 'Promo banho', 'Vacinas', 'Hotel feriado', 'Aniversário', 'Clientes sumidos'])} ${pick(['setembro', 'agosto', 'julho', 'semana 1', 'semana 2'])} #${c + 1}`,
    channel: 'whatsapp', status, templateId: tpl.id, templateName: tpl.name, templateLanguage: 'pt_BR', senderLabel: 'Pet Center', timezone: 'America/Sao_Paulo',
    items: [], values: {}, cadenceId: null, scheduledAt: status === 'scheduled' ? iso(-dias(2)) : null, qualityAck: [], qualityPause: null,
    totalContacts: alvo.length, sentCount: cont.sent, successCount: cont.sent, deliveredCount: cont.delivered, readCount: cont.read, repliedCount: cont.replied,
    failedCount: cont.failed, positiveCount: cont.positive, negativeCount: cont.negative, neutralCount: Math.max(0, cont.replied - cont.positive - cont.negative),
    optOutCount: cont.optOut, qualifiedCount: cont.positive, classifiedCount: cont.replied, conversionCount: Math.floor(cont.positive / 2), demoRequestedCount: 0,
    pendingCount: alvo.length - cont.sent - cont.failed, processedCount: cont.sent + cont.failed,
    progressPercent: Math.round(((cont.sent + cont.failed) / alvo.length) * 100),
    createdBy: { id: admin.id, name: admin.name, role: 'ADMIN' }, createdAt: iso(dias(criada)), startedAt: status === 'scheduled' ? null : iso(dias(criada)),
    finishedAt: status === 'completed' ? iso(dias(Math.max(0, criada - 1))) : null, updatedAt: iso(dias(Math.max(0, criada - 1)))
  });
}

/* ---------------- tarefas, ligacoes, alertas, catalogo ---------------- */
for (let i = 0; i < 210; i += 1) {
  const contato = pick(contatos);
  const agente = chance(0.7) ? pick(agentes) : null;
  const status = pick(['open', 'open', 'in_progress', 'done', 'cancelled']);
  add('commercialTasks', {
    id: nid('ctask'), title: pick(['Retornar orçamento de tosa', 'Confirmar hotelzinho', 'Enviar valores', 'Ligar para tutor', 'Follow-up de campanha']) + ` — ${contato.name}`,
    description: 'Tarefa gerada a partir de resposta de campanha.', status, priority: pick(['low', 'normal', 'high', 'urgent']),
    queueId: pick(filas).id, queueName: pick(FILAS), assignedTo: agente?.id || null, assignedToName: agente?.name || null, contactId: contato.id,
    dueAt: iso(dias(int(-5, 10))), completedAt: status === 'done' ? iso(dias(int(0, 5))) : null, createdAt: iso(dias(int(1, 40))), updatedAt: iso(dias(int(0, 1)))
  });
}
for (let i = 0; i < 160; i += 1) {
  const status = pick(['pending', 'pending', 'in_progress', 'completed', 'cancelled']);
  add('internalTasks', {
    id: nid('itask'), title: pick(['Repor estoque de shampoo', 'Revisar escala do sábado', 'Atualizar preços da tabela', 'Treinar novo atendente', 'Conferir caixa']) + ` ${i + 1}`,
    description: 'Tarefa interna de teste.', status, priority: pick(['low', 'normal', 'high']), version: 1,
    assignedTo: chance(0.8) ? pick(agentes).id : null, queueId: null, createdBy: admin.id, updatedBy: admin.id, claimedAt: status !== 'pending' ? iso(dias(int(0, 10))) : null,
    completedAt: status === 'completed' ? iso(dias(int(0, 5))) : null, cancelledAt: status === 'cancelled' ? iso(dias(int(0, 5))) : null, dueAt: null,
    createdAt: iso(dias(int(1, 60))), updatedAt: iso(dias(int(0, 1)))
  });
}
for (let i = 0; i < 260; i += 1) {
  const contato = pick(contatos);
  const status = pick(['completed', 'completed', 'completed', 'missed', 'unanswered', 'rejected']);
  const agente = status === 'completed' ? pick(agentes) : null;
  const recebida = int(10, 60 * 24 * 45);
  const duracao = status === 'completed' ? int(20, 900) : 0;
  add('voiceCalls', {
    id: nid('call'), callId: nid('wacid'), direction: 'inbound', from: contato.primaryPhone, contactId: contato.id, contactName: contato.name, phoneNumberId: 'mock_phone',
    queueName: pick(FILAS), status, endReason: status === 'completed' ? 'hangup' : status === 'missed' ? pick(['no_agents', 'timeout']) : status === 'unanswered' ? 'all_declined' : 'voice_disabled',
    ringOrder: [], ringIndex: 0, offeredTo: agente ? [agente.id] : [], answeredBy: agente ? { id: agente.id, name: agente.name } : null, currentAgentId: null,
    receivedAt: iso(min(recebida)), answeredAt: agente ? iso(min(recebida) - 12000) : null, startedAt: agente ? iso(min(recebida) - 12000) : null,
    endedAt: iso(min(recebida) - 12000 - duracao * 1000), duration: duracao, createdAt: iso(min(recebida)), updatedAt: iso(min(recebida))
  });
}
for (let i = 0; i < 70; i += 1) {
  const kind = pick(['template_quality', 'phone_quality', 'template_status', 'account_update']);
  add('whatsappAccountAlerts', {
    id: nid('alert'), kind, source: 'webhook', severity: pick(['info', 'warning', 'critical']), title: pick(['Qualidade do template caiu', 'Template aprovado', 'Número com qualidade média', 'Atualização da conta']),
    message: 'Alerta gerado para teste de volume.', entity: { id: String(9000000 + i), name: `template_${i}`, type: 'template', language: 'pt_BR' },
    dedupKey: `${kind}:${i}`, readAt: chance(0.5) ? iso(dias(int(0, 5))) : null, createdAt: iso(dias(int(0, 60)))
  });
}
for (let i = 0; i < 320; i += 1) {
  const preco = int(15, 600) + 0.9;
  add('catalogItems', {
    id: nid('item'), sku: `PET-${String(i + 1).padStart(4, '0')}`, name: `${pick(['Ração', 'Shampoo', 'Coleira', 'Brinquedo', 'Cama', 'Petisco', 'Antipulgas', 'Areia'])} ${pick(['Premium', 'Plus', 'Natural', 'Filhote', 'Sênior'])} ${i + 1}`,
    brand: pick(['PetLife', 'Au&Miau', 'NutriPet', 'Dog Chow', 'Whiskas']), category: pick(['Alimentação', 'Higiene', 'Acessórios', 'Farmácia']),
    description: 'Produto de teste de volume.', price: preco, currency: 'BRL', active: chance(0.85), availability: pick(['in stock', 'in stock', 'out of stock']), condition: 'new',
    mediaUrl: '', productUrl: '', metaSyncStatus: pick(['synced', 'pending', 'error', 'not_synced']), metaSyncError: null,
    createdAt: iso(dias(int(5, 90))), updatedAt: iso(dias(int(0, 4)))
  });
}
for (let i = 0; i < 130; i += 1) {
  const nome = `${pick(['banner', 'video_demo', 'tabela_precos', 'foto_loja'])}_${i + 1}.${pick(['jpg', 'png', 'mp4', 'pdf'])}`;
  add('mediaAssets', { id: nid('media'), fileName: nome, originalName: nome, url: `/uploads/mock/${nome}`, size: int(20000, 9000000), mimeType: nome.endsWith('mp4') ? 'video/mp4' : nome.endsWith('pdf') ? 'application/pdf' : 'image/jpeg', createdBy: admin.id, createdAt: iso(dias(int(0, 90))) });
}
for (let i = 0; i < 45; i += 1) {
  const contato = pick(contatos);
  add('contactSuppression', { id: nid('suppression'), contactId: contato.id, channel: 'whatsapp', normalizedIdentifier: contato.primaryPhone, reason: pick(['opt_out', 'manual', 'invalid_number', 'complaint']), source: pick(['classification', 'manual']), global: false, createdAt: iso(dias(int(0, 80))), createdBy: admin.id });
}

/* ---------------- logs, auditoria, incidentes ---------------- */
for (let i = 0; i < 900; i += 1) {
  add('systemLogs', { id: nid('log'), type: pick(['LOGIN', 'FLOW_PUBLISH', 'CHAT_CLOSE', 'TEMPLATE_SYNC', 'USER_UPDATE', 'CAMPAIGN_CREATE']), userId: pick(colecoes.users).id, message: 'Evento de teste de volume', timestamp: iso(min(int(1, 60 * 24 * 90))) });
}
for (let i = 0; i < 520; i += 1) {
  add('tenantAuditEvents', { id: nid('audit'), type: pick(['chat.closed', 'user.updated', 'flow.published', 'queue.updated', 'contact.updated']), actorId: pick(colecoes.users).id, summary: 'Alteração registrada para teste de volume', metadata: {}, timestamp: iso(min(int(1, 60 * 24 * 90))) });
}
for (let i = 0; i < 65; i += 1) {
  add('tenantIncidents', {
    id: nid('incident'), type: pick(['whatsapp_send_failed', 'flow_node_error', 'webhook_timeout']), title: pick(['Falha ao enviar mensagem', 'Erro em nó do fluxo', 'Webhook demorou']),
    message: 'Incidente de teste de volume', source: 'runtime', status: pick(['open', 'open', 'resolved', 'ignored']), severity: pick(['warning', 'error', 'critical']),
    metadata: { channel: 'whatsapp', code: pick([131026, 131047, 500]) }, fingerprint: `mock:${i % 20}`, occurrenceCount: int(1, 40), createdBy: 'system',
    firstSeenAt: iso(dias(int(5, 60))), lastSeenAt: iso(dias(int(0, 5))), createdAt: iso(dias(int(5, 60))), updatedAt: iso(dias(int(0, 5)))
  });
}

/* ---------------- grava ---------------- */
for (const [colecao, docs] of Object.entries(colecoes)) {
  for (const doc of docs) { if (doc.tenantId === undefined) delete doc.tenantId; }
  db[colecao] = [...(db[colecao] || []), ...docs];
}
// tenants: o proprio registro nao leva tenantId.
db.tenants = db.tenants.map((t) => (t.id === T ? (({ tenantId, ...rest }) => rest)(t) : t));
fs.writeFileSync(ARQUIVO, JSON.stringify(db));

const resumo = Object.fromEntries(Object.entries(colecoes).map(([k, v]) => [k, v.length]));
console.log('empresa Mock - Pet Center criada:', resumo);
console.log(`total: ${Object.values(resumo).reduce((a, b) => a + b, 0)} registros. backup: ${path.basename(backup)}`);
console.log('login: mock.admin / sandbox123 (admin da empresa), mock.agente01..36 / sandbox123; super admin do sandbox: admin / sandbox123');
