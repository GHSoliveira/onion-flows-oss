// Assistente do editor de fluxo: recebe um pedido em portugues ("depois da
// boas-vindas pergunta o CPF e guarda em cpf_cliente") e o resumo do fluxo, e
// devolve operacoes que o editor aplica (criar node, alterar, ligar, criar
// variavel). A IA so propoe: tudo e validado aqui e o editor so aplica quando
// a pessoa confirma.

const TIPOS = {
  messageNode: ['text'],
  inputNode: ['text', 'variableName', 'validationType', 'errorText', 'maxAttempts'],
  menuNode: ['text', 'options', 'setVarEnabled', 'variableName', 'invalidSelectionMessage', 'hasElse', 'optionsDisplay', 'optionsSource', 'optionsVariable', 'optionLabelPath', 'optionValuePath', 'optionDescriptionPath', 'listButtonText'],
  conditionNode: ['conditions', 'hasElse'],
  setValueNode: ['variableName', 'value'],
  delayNode: ['delay'],
  queueNode: ['queueName', 'queueMessage', 'sendQueueMessage', 'continueFlowAfterQueue'],
  ratingNode: ['text', 'variableName'],
  finalNode: ['text'],
  httpRequestNode: ['integrationId', 'method', 'path', 'url', 'body', 'mappings']
};
const COMUNS = ['customName'];
const VALIDACOES = ['none', 'email', 'phone', 'cpf', 'cnpj', 'number', 'date'];
const OPERADORES = ['==', '!=', '>', '<', 'contains'];
const METODOS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MAX_OPERACOES = 40;

const erro = (status, message) => Object.assign(new Error(message), { status });
const texto = (valor, max = 1000) => String(valor ?? '').slice(0, max);
const nomeVariavel = (valor) => String(valor || '').trim().replace(/[^\w]/g, '_').replace(/_+/g, '_').slice(0, 60);

export const SYSTEM_PROMPT = `Voce edita fluxos de atendimento de WhatsApp de uma plataforma brasileira.
Recebe o pedido da pessoa e o fluxo atual (nodes, ligacoes, variaveis, filas, integracoes) e responde SO com JSON.

Formato da resposta:
{"reply": "frase curta em portugues dizendo o que vai fazer, ou a pergunta se faltar informacao",
 "needsClarification": false,
 "operations": [ ... ]}

Operacoes possiveis:
- {"op":"create_variable","name":"cpf_cliente"}  cria variavel que ainda nao existe
- {"op":"add_node","ref":"n1","type":"<tipo>","data":{...},"after":{"node":"<id existente ou ref>","branch":"<opcional>"}}
  cria um node ja ligado depois de outro. Se o node de origem ja tinha continuacao, o novo entra no meio.
- {"op":"update_node","id":"<id existente>","data":{...}}  altera campos de um node
- {"op":"connect","from":{"node":"<id ou ref>","branch":"<opcional>"},"to":"<id ou ref>"}  liga a um node que ja existe (inclusive um criado antes, pela ref)

"branch" so existe em node que se divide: menu (id da opcao ou "else"), condicional (id da regra ou "else"),
API HTTP ("success" ou "error"). Nos outros tipos nao use branch.

Tipos e campos de data:
- messageNode: text (mensagem enviada ao cliente; aceita *negrito*, _italico_ e variaveis como {nome})
- inputNode: text (pergunta), variableName (onde guardar a resposta), validationType (none, email, phone, cpf, cnpj, number, date), errorText
- menuNode: text (a pergunta; NAO liste as opcoes nele), optionsDisplay "auto" (opcoes viram botoes ate 3 ou lista ate 10 no WhatsApp), options [{"id":"1","label":"Agendar banho"}] com label de ate 24 caracteres (sem "value", a variavel guarda o label; use value so se precisar de outro valor), hasElse (true/false), setVarEnabled + variableName para guardar a escolha. Saidas: id de cada opcao e "else".
  Menu dinamico (opcoes vindas de uma lista numa variavel, ex.: resposta de API): optionsSource "variable", optionsVariable (nome ou caminho da variavel, ex.: horarios ou resposta.data.itens), optionLabelPath (campo do item mostrado, ex.: nome), optionValuePath (campo guardado, ex.: id), variableName (onde guardar a escolha). Saidas fixas: "selected" (escolheu), "empty" (lista vazia) e "else".
- conditionNode: conditions [{"id":"c1","variable":"nome_da_variavel","operator":"==|!=|>|<|contains","value":"..."}], hasElse
- setValueNode: variableName, value
- delayNode: delay (segundos)
- queueNode: queueName (nome de uma fila existente), queueMessage, sendQueueMessage, continueFlowAfterQueue (transfere para atendimento humano)
- ratingNode: text, variableName (nota de 1 a 5)
- finalNode: text (encerra o atendimento)
- httpRequestNode: integrationId (de uma integracao existente) + method + path, ou url completa; body; mappings [{"jsonPath":"data.nome","varName":"nome"}]
Todo node aceita customName (nome curto que aparece no canvas).

Regras:
- Use os ids exatos do fluxo para nodes existentes. Para nodes novos, invente refs (n1, n2...) e use-as nas operacoes seguintes.
- "Guardar/colocar a resposta em X" = inputNode com variableName X. Se X nao existir nas variaveis, crie com create_variable antes.
- Nomes de variavel: minusculas, sem acento, com _ (ex.: cpf_cliente).
- Quando o pedido nao disser onde, continue a partir do node selecionado (e da saida selectedBranch, se houver); sem selecao, a partir do fim do caminho principal.
- Textos para o cliente em portugues do Brasil, cordiais e curtos.
- Se faltar algo essencial (qual fila, qual integracao, onde inserir quando ha duvida real), nao invente: needsClarification true, operations [] e pergunte em reply.
- Nunca apague nodes nem ligacoes. Nao use tipos fora da lista.

Como montar fluxos grandes:
- Monte o caminho inteiro: cada node que nao encerra precisa de continuacao. Termine cada caminho num finalNode (ou numa fila).
- "after" sem branch num menu ou condicional liga TODAS as opcoes que ainda nao tem continuacao ao node novo: use isso quando varias opcoes seguem o mesmo caminho (ex.: depois do menu de porte, perguntar o dia). Para uma opcao especifica, informe o branch.
- Quando duas opcoes levam ao mesmo lugar, crie o node uma vez (add_node a partir da primeira) e ligue a outra com connect usando a ref. Nunca duplique o mesmo trecho.
- Quando o pedido mandar guardar a escolha de um menu, preencha variableName no menu.
- queueNode tambem precisa de continuacao: e o que acontece quando o atendente encerra a conversa. Se o pedido nao disser, ligue num finalNode agradecendo.
- Se a mesma fila serve para duas situacoes (ex.: "falar com atendente" e resposta invalida), crie uma fila so e ligue a outra saida a ela com connect.
- Os ids das opcoes devem ser simples ("1", "2", "3"...), na ordem em que aparecem.
- hasElse so true quando o pedido disser o que fazer com resposta que nao e uma opcao; nesse caso ligue o "else". Sem isso, use hasElse false (o menu pede de novo sozinho).
- Para avisar algo antes de transferir para a fila, use um messageNode antes do queueNode.`;

const limparData = (tipo, data = {}) => {
  const permitidos = new Set([...(TIPOS[tipo] || []), ...COMUNS]);
  const saida = {};
  Object.entries(data && typeof data === 'object' ? data : {}).forEach(([chave, valor]) => {
    if (!permitidos.has(chave)) return;
    saida[chave] = valor;
  });
  if ('text' in saida) saida.text = texto(saida.text, 1024);
  if ('customName' in saida) saida.customName = texto(saida.customName, 60);
  if ('variableName' in saida) saida.variableName = nomeVariavel(saida.variableName);
  if ('validationType' in saida && !VALIDACOES.includes(saida.validationType)) saida.validationType = 'none';
  if ('delay' in saida) saida.delay = Math.min(Math.max(parseInt(saida.delay, 10) || 1, 1), 3600);
  if ('method' in saida) saida.method = METODOS.includes(String(saida.method).toUpperCase()) ? String(saida.method).toUpperCase() : 'GET';
  if ('optionsDisplay' in saida && !['auto', 'numbered', 'text'].includes(saida.optionsDisplay)) saida.optionsDisplay = 'auto';
  if ('optionsSource' in saida) saida.optionsSource = saida.optionsSource === 'variable' ? 'variable' : 'fixed';
  ['optionsVariable', 'optionLabelPath', 'optionValuePath', 'optionDescriptionPath'].forEach((chave) => {
    if (chave in saida) saida[chave] = texto(saida[chave], 120).trim();
  });
  if ('listButtonText' in saida) saida.listButtonText = texto(saida.listButtonText, 20);
  if ('options' in saida) {
    saida.options = (Array.isArray(saida.options) ? saida.options : []).slice(0, 10).map((opcao, indice) => ({
      id: texto(opcao?.id ?? indice + 1, 20).replace(/[^\w-]/g, '') || String(indice + 1),
      label: texto(opcao?.label, 40),
      // Sem valor explicito, guarda o nome da opcao: e o que a mensagem
      // seguinte vai mostrar ("agendamento de {servico}").
      value: texto(opcao?.value ?? opcao?.label ?? opcao?.id ?? indice + 1, 40)
    }));
  }
  if ('conditions' in saida) {
    saida.conditions = (Array.isArray(saida.conditions) ? saida.conditions : []).slice(0, 10).map((regra, indice) => ({
      id: texto(regra?.id ?? `c${indice + 1}`, 20).replace(/[^\w-]/g, '') || `c${indice + 1}`,
      variable: nomeVariavel(regra?.variable),
      operator: OPERADORES.includes(regra?.operator) ? regra.operator : '==',
      value: texto(regra?.value, 200)
    }));
  }
  if ('mappings' in saida) {
    saida.mappings = (Array.isArray(saida.mappings) ? saida.mappings : []).slice(0, 20)
      .map((item) => ({ jsonPath: texto(item?.jsonPath, 120), varName: nomeVariavel(item?.varName) }))
      .filter((item) => item.varName);
  }
  ['hasElse', 'setVarEnabled', 'sendQueueMessage', 'continueFlowAfterQueue'].forEach((chave) => {
    if (chave in saida) saida[chave] = Boolean(saida[chave]);
  });
  if (tipo === 'menuNode' && saida.variableName) saida.setVarEnabled = true;
  ['path', 'url', 'body', 'queueMessage', 'queueName', 'integrationId', 'value', 'errorText', 'invalidSelectionMessage'].forEach((chave) => {
    if (chave in saida) saida[chave] = texto(saida[chave], 2000);
  });
  return saida;
};

const ref = (valor) => String(valor || '').trim().slice(0, 120);

// Confere cada operacao contra o fluxo atual; o que nao fecha e descartado.
export const validarOperacoes = (operacoes, contexto = {}) => {
  const existentes = new Set((contexto.nodes || []).map((node) => String(node.id)));
  const refs = new Set();
  const descartadas = [];
  const validas = [];
  const avisos = [];
  const conhecido = (id) => existentes.has(id) || refs.has(id);
  const filas = (contexto.queues || []).map(String);
  // Nodes cuja saida Else e usada em alguma operacao do plano.
  const usamElse = new Set((Array.isArray(operacoes) ? operacoes : []).flatMap((op) => [
    op?.after?.branch === 'else' ? ref(op.after.node) : null,
    op?.from?.branch === 'else' ? ref(op.from.node) : null
  ]).filter(Boolean));
  const integracoes = contexto.integrations || [];
  // Fila e integracao precisam existir no cliente; grafia diferente so de
  // maiuscula/minuscula e corrigida, o resto fica em branco com aviso.
  const conferirReferencias = (data) => {
    if (typeof data.queueName === 'string' && data.queueName.trim()) {
      const achada = filas.find((fila) => fila.toLowerCase() === data.queueName.trim().toLowerCase());
      if (achada) data.queueName = achada;
      else {
        avisos.push(`A fila "${data.queueName}" não existe neste cliente; escolha a fila no node.`);
        data.queueName = '';
      }
    }
    if (data.integrationId && !integracoes.some((item) => item.id === data.integrationId)) {
      avisos.push('A integração indicada não existe; escolha uma no node HTTP.');
      delete data.integrationId;
    }
    return data;
  };

  (Array.isArray(operacoes) ? operacoes : []).slice(0, MAX_OPERACOES).forEach((op, indice) => {
    const tipoOp = op?.op;
    if (tipoOp === 'create_variable') {
      const name = nomeVariavel(op.name);
      if (name) validas.push({ op: 'create_variable', name });
      else descartadas.push(indice);
      return;
    }
    if (tipoOp === 'add_node') {
      const novaRef = ref(op.ref) || `n${indice + 1}`;
      const origem = ref(op.after?.node);
      if (!TIPOS[op.type] || !conhecido(origem) || refs.has(novaRef) || existentes.has(novaRef)) {
        descartadas.push(indice);
        return;
      }
      refs.add(novaRef);
      const data = conferirReferencias(limparData(op.type, op.data));
      if (op.type === 'menuNode' && !data.optionsDisplay) data.optionsDisplay = 'auto';
      // Sem dizer o que fazer com resposta invalida, o proprio menu pede de novo
      // ("Selecione uma opcao valida") em vez de criar uma saida Else solta.
      if (['menuNode', 'conditionNode'].includes(op.type) && !('hasElse' in data)) data.hasElse = usamElse.has(novaRef);
      validas.push({
        op: 'add_node',
        ref: novaRef,
        type: op.type,
        data,
        after: { node: origem, ...(op.after?.branch ? { branch: ref(op.after.branch) } : {}) }
      });
      return;
    }
    if (tipoOp === 'update_node') {
      const id = ref(op.id);
      const node = (contexto.nodes || []).find((item) => String(item.id) === id);
      if (!node || !TIPOS[node.type]) {
        descartadas.push(indice);
        return;
      }
      validas.push({ op: 'update_node', id, data: conferirReferencias(limparData(node.type, op.data)) });
      return;
    }
    if (tipoOp === 'connect') {
      const origem = ref(op.from?.node);
      const destino = ref(op.to);
      if (!conhecido(origem) || !conhecido(destino) || origem === destino) {
        descartadas.push(indice);
        return;
      }
      validas.push({ op: 'connect', from: { node: origem, ...(op.from?.branch ? { branch: ref(op.from.branch) } : {}) }, to: destino });
      return;
    }
    descartadas.push(indice);
  });
  return { operations: validas, discarded: descartadas.length, warnings: avisos };
};

// Resumo enxuto do fluxo para caber no pedido.
export const resumirContexto = (body = {}) => {
  const nodes = (Array.isArray(body.nodes) ? body.nodes : []).slice(0, 200).map((node) => ({
    id: ref(node.id),
    type: ref(node.type),
    ...(node.name ? { name: texto(node.name, 60) } : {}),
    ...(node.text ? { text: texto(node.text, 240) } : {}),
    ...(node.variableName ? { variableName: texto(node.variableName, 60) } : {}),
    ...(Array.isArray(node.options) ? { options: node.options.slice(0, 10).map((o) => ({ id: texto(o.id, 20), label: texto(o.label, 40) })) } : {}),
    ...(node.optionsSource === 'variable' ? { optionsSource: 'variable', optionsVariable: texto(node.optionsVariable, 120) } : {}),
    ...(Array.isArray(node.conditions) ? { conditions: node.conditions.slice(0, 10).map((c) => ({ id: texto(c.id, 20), variable: texto(c.variable, 60), operator: texto(c.operator, 10), value: texto(c.value, 60) })) } : {}),
    ...(node.queueName ? { queueName: texto(node.queueName, 60) } : {})
  }));
  const edges = (Array.isArray(body.edges) ? body.edges : []).slice(0, 400).map((edge) => ({
    from: ref(edge.source), to: ref(edge.target), ...(edge.branch ? { branch: texto(edge.branch, 20) } : {})
  }));
  const lista = (valor, max = 100) => (Array.isArray(valor) ? valor : []).slice(0, max).map((item) => texto(item, 60));
  return {
    nodes,
    edges,
    selectedNodeId: body.selectedNodeId ? ref(body.selectedNodeId) : null,
    ...(body.selectedBranch ? { selectedBranch: texto(body.selectedBranch, 20) } : {}),
    variables: lista(body.variables),
    queues: lista(body.queues),
    integrations: (Array.isArray(body.integrations) ? body.integrations : []).slice(0, 30).map((item) => ({ id: ref(item.id), name: texto(item.name, 60) }))
  };
};

const lerJson = (conteudo) => {
  const bruto = String(conteudo || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(bruto);
  } catch {
    throw erro(503, 'A IA respondeu num formato inesperado. Tente de novo.');
  }
};

// O modelo de raciocinio passava de 45s por pedido; o flash responde em ~12s
// e pergunta quando falta informacao em vez de inventar. Se o Gemini estiver
// sobrecarregado, tenta o modelo leve antes de desistir.
const modelos = () => [...new Set([
  process.env.FLOW_ASSISTANT_MODEL || 'gemini-3.5-flash',
  process.env.FLOW_ASSISTANT_FALLBACK_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'
].map((nome) => String(nome || '').trim()).filter(Boolean))];

// Sobrecarga e limite do provedor valem nova tentativa com outro modelo.
const tentarDeNovo = (status) => [429, 500, 503].includes(Number(status));

const pedirGemini = async ({ instruction, contexto }) => {
  const apiKey = String(process.env.GEMINI_API_KEY || '');
  if (!apiKey) throw erro(503, 'Assistente de IA não configurado neste servidor.');
  const lista = modelos();
  for (let indice = 0; indice < lista.length; indice += 1) {
    try {
      return await pedirAoModelo({ apiKey, model: lista[indice], instruction, contexto });
    } catch (error) {
      const ultimo = indice === lista.length - 1;
      if (ultimo || !tentarDeNovo(error.providerStatus)) throw error;
    }
  }
  throw erro(503, 'A IA não respondeu agora. Tente de novo em instantes.');
};

const pedirAoModelo = async ({ apiKey, model, instruction, contexto }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.FLOW_ASSISTANT_TIMEOUT_MS || 30_000));
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ pedido: instruction, fluxo: contexto }) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      console.warn('[FLOW_ASSISTANT] Gemini falhou', { model, status: response.status, error: body?.error?.message?.slice(0, 200) });
      throw Object.assign(erro(503, 'A IA está sobrecarregada agora. Tente de novo em instantes.'), { providerStatus: response.status });
    }
    const conteudo = body?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('');
    return { resposta: lerJson(conteudo), model };
  } catch (error) {
    if (error?.name === 'AbortError') throw erro(503, 'A IA demorou demais para responder. Tente um pedido mais curto.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const planFlowChanges = async ({ instruction, body }) => {
  const pedido = texto(instruction, 1500).trim();
  if (!pedido) throw erro(400, 'Escreva o que você quer fazer no fluxo.');
  const contexto = resumirContexto(body);
  const { resposta, model } = await pedirGemini({ instruction: pedido, contexto });
  const { operations, discarded, warnings } = validarOperacoes(resposta?.operations, contexto);
  return {
    reply: texto(resposta?.reply, 600) || (operations.length ? 'Pronto, revise as mudanças.' : 'Não entendi o que mudar.'),
    needsClarification: Boolean(resposta?.needsClarification) && !operations.length,
    operations,
    discarded,
    warnings,
    model
  };
};
