// Cargos em espectro: familia (A atendimento, B gestao, C administracao do
// cliente, H Parceiro, Z Onion) + nivel 1-9. A regra e a lista de permissoes;
// cada nivel e um pacote pronto dela, e o admin pode ajustar caixa por caixa.
//
// Usuario sem `cargo` gravado continua no modelo antigo (papel), e o cargo
// equivalente e so calculado (cargoLegado). Ninguem muda de acesso ate o admin
// escolher um nivel.

export const PERMISSOES = Object.freeze({
  'atendimento.historico': 'Ver o próprio histórico',
  'atendimento.fila': 'Atender a fila',
  'atendimento.ativo': 'Iniciar conversa (atendimento ativo)',
  'operacao.ver': 'Ver operação ao vivo e relatórios',
  'operacao.intervir': 'Transferir e encerrar conversa de outros',
  'fluxos.ver': 'Ver fluxos',
  'fluxos.editar': 'Editar e publicar fluxos',
  'respostas.editar': 'Respostas rápidas e etiquetas',
  'templates.meta': 'Templates da Meta',
  'catalogo.editar': 'Catálogo',
  'contatos.editar': 'Editar e importar contatos',
  'campanhas.gerenciar': 'Campanhas de disparo',
  'equipe.atendentes': 'Gerenciar atendentes',
  'equipe.gestores': 'Gerenciar gestores',
  'equipe.admins': 'Gerenciar administradores',
  'equipe.filas': 'Filas',
  'config.whatsapp': 'Conectar WhatsApp e canais',
  'config.empresa': 'Dados da empresa e regras',
  'dados.lgpd': 'LGPD: exportar e apagar dados'
});

export const FAMILIAS = Object.freeze({
  A: { role: 'AGENT', nome: 'Atendimento' },
  B: { role: 'MANAGER', nome: 'Gestão' },
  C: { role: 'ADMIN', nome: 'Administração' },
  H: { role: 'PARTNER', nome: 'Parceiro' },
  Z: { role: 'SUPER_ADMIN', nome: 'Onion' }
});

const TODAS_DO_CLIENTE = Object.keys(PERMISSOES);
const somar = (...listas) => [...new Set(listas.flat())];

const A2 = ['atendimento.historico', 'atendimento.fila'];
const B1 = ['atendimento.historico', 'operacao.ver', 'fluxos.ver'];
const B3 = somar(B1, ['operacao.intervir']);
const B5 = somar(B3, ['equipe.atendentes', 'equipe.filas', 'respostas.editar']);
const B7 = somar(B5, ['fluxos.editar']);

// Niveis definidos. Os que faltam (A5-A9, B2...) entram quando fizerem sentido.
export const NIVEIS = Object.freeze({
  A1: ['atendimento.historico'],
  A2,
  A3: somar(A2, ['operacao.ver']),
  A4: somar(A2, ['atendimento.ativo', 'contatos.editar']),
  B1,
  B3,
  B5,
  B7,
  B9: somar(B7, ['contatos.editar', 'campanhas.gerenciar', 'equipe.gestores']),
  C5: TODAS_DO_CLIENTE.filter((p) => !['config.whatsapp', 'dados.lgpd'].includes(p)),
  C6: TODAS_DO_CLIENTE,
  // Parceiro: a carteira dele; dentro de um cliente vale o C6 (authenticate).
  H5: [],
  // Onion: Z7 e o super admin de hoje; Z1-Z5 (dev) e Z9 entram na etapa da plataforma.
  Z7: ['*']
});

// Permissoes extras do gestor de hoje (managerPermissions) no catalogo novo.
const EXTRA_DO_GESTOR = {
  conversas: ['operacao.intervir'],
  equipe: ['equipe.atendentes', 'equipe.filas'],
  fluxos: ['fluxos.editar'],
  respostas: ['respostas.editar'],
  contatos: ['contatos.editar']
};

const mesmoConjunto = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

export const codigoValido = (codigo) => Object.prototype.hasOwnProperty.call(NIVEIS, String(codigo || ''));

// Cargo equivalente ao papel de hoje: ninguem perde nem ganha acesso.
export const cargoLegado = (user = {}) => {
  switch (user.role) {
    case 'AGENT': return { codigo: 'A4', permissoes: NIVEIS.A4, personalizado: false };
    case 'ADMIN': return { codigo: 'C6', permissoes: NIVEIS.C6, personalizado: false };
    case 'SUPER_ADMIN': return { codigo: 'Z7', permissoes: NIVEIS.Z7, personalizado: false };
    case 'PARTNER': return { codigo: 'H5', permissoes: NIVEIS.H5, personalizado: false };
    case 'MANAGER': {
      const extras = (Array.isArray(user.managerPermissions) ? user.managerPermissions : [])
        .flatMap((chave) => EXTRA_DO_GESTOR[chave] || []);
      const permissoes = somar(B1, extras);
      const nivel = ['B1', 'B3', 'B5', 'B7', 'B9'].find((codigo) => mesmoConjunto(NIVEIS[codigo], permissoes));
      return nivel
        ? { codigo: nivel, permissoes: NIVEIS[nivel], personalizado: false }
        : { codigo: 'B', permissoes, personalizado: true };
    }
    default: return { codigo: null, permissoes: [], personalizado: false };
  }
};

// Cargo efetivo: o gravado (nivel + ajustes) ou o equivalente ao papel.
export const resolverCargo = (user = {}) => {
  const gravado = user.cargo;
  if (!gravado || !codigoValido(gravado.nivel)) return { ...cargoLegado(user), modelo: 'legado' };
  const base = NIVEIS[gravado.nivel];
  const adicionadas = (gravado.adicionadas || []).filter((p) => PERMISSOES[p]);
  const removidas = new Set((gravado.removidas || []).filter((p) => PERMISSOES[p]));
  const permissoes = somar(base, adicionadas).filter((p) => !removidas.has(p));
  return { codigo: gravado.nivel, permissoes, personalizado: adicionadas.length > 0 || removidas.size > 0, modelo: 'cargo' };
};

export const temPermissao = (user, permissao) => {
  const { permissoes } = resolverCargo(user);
  return permissoes.includes('*') || permissoes.includes(permissao);
};

// Papel correspondente a um nivel (A4 -> AGENT): o campo role continua gravado
// para as telas e rotas que ainda olham o papel.
export const papelDoNivel = (codigo) => FAMILIAS[String(codigo || '').charAt(0)]?.role || null;

// Familias que a tela de usuarios atribui (Parceiro e Onion tem fluxo proprio).
export const FAMILIAS_DO_CLIENTE = ['A', 'B', 'C'];
const GERENCIA = { A: 'equipe.atendentes', B: 'equipe.gestores', C: 'equipe.admins' };

const falha = (message) => Object.assign(new Error(message), { status: 403 });

// Monta o cargo gravado a partir do pedido da tela, limpando o que nao for do
// catalogo. Lanca 400 se o nivel nao existir ou nao for de cliente.
export const normalizarCargo = (pedido = {}) => {
  const nivel = String(pedido.nivel || '');
  if (!codigoValido(nivel) || !FAMILIAS_DO_CLIENTE.includes(nivel.charAt(0))) {
    throw Object.assign(new Error('Nivel de cargo invalido'), { status: 400 });
  }
  const base = NIVEIS[nivel];
  const limpar = (lista) => [...new Set((Array.isArray(lista) ? lista : []).filter((p) => PERMISSOES[p]))];
  return {
    nivel,
    adicionadas: limpar(pedido.adicionadas).filter((p) => !base.includes(p)),
    removidas: limpar(pedido.removidas).filter((p) => base.includes(p))
  };
};

// Quem atribui precisa gerenciar a familia do cargo (A, B ou C) e nao pode dar
// permissao que ele mesmo nao tem. Vale tambem para o cargo atual de quem e
// editado: um gestor nao rebaixa nem edita um admin.
export const conferirAtribuicao = (ator, cargoNovo, cargoAtual = null) => {
  const doAtor = resolverCargo(ator).permissoes;
  if (doAtor.includes('*')) return;
  for (const codigo of [cargoNovo?.nivel || cargoNovo?.codigo, cargoAtual].filter(Boolean)) {
    const familia = String(codigo).charAt(0);
    if (!FAMILIAS_DO_CLIENTE.includes(familia) || !doAtor.includes(GERENCIA[familia])) {
      throw falha(`Seu cargo nao permite gerenciar cargos ${familia}.`);
    }
  }
  // Quem gerencia atendentes (ou gestores) pode dar o que os niveis daquela
  // familia dao, mesmo sem ter (um gestor nao atende a fila, mas cria
  // atendente). Fora disso, e sempre em cargo C, so o que o proprio ator tem:
  // um C5 nao cria C6 para ganhar a conexao do WhatsApp por tabela.
  const familia = String(cargoNovo?.nivel || '').charAt(0);
  const daFamilia = familia === 'C' ? [] : Object.entries(NIVEIS)
    .filter(([codigo]) => codigo.charAt(0) === familia)
    .flatMap(([, lista]) => lista);
  const pedidas = resolverCargo({ cargo: cargoNovo }).permissoes;
  const faltando = pedidas.filter((p) => !doAtor.includes(p) && !daFamilia.includes(p));
  if (faltando.length) throw falha(`Voce nao pode dar permissoes que nao tem: ${faltando.map((p) => PERMISSOES[p]).join(', ')}.`);
};

// Resumo do cargo para o painel (login, heartbeat, lista de usuarios).
export const resumoCargo = (user = {}) => {
  const { codigo, permissoes, personalizado, modelo } = resolverCargo(user);
  return { codigo, permissoes, personalizado, modelo };
};

// Nome de cada nivel na tela quando a empresa nao definiu o dela.
export const NOMES_PADRAO = Object.freeze({
  A1: 'Atendente (somente leitura)',
  A2: 'Atendente',
  A3: 'Atendente com visão da operação',
  A4: 'Atendente com atendimento ativo',
  B1: 'Gestor (somente leitura)',
  B3: 'Supervisor',
  B5: 'Coordenador',
  B7: 'Gerente',
  B9: 'Gerente geral',
  C5: 'Administrador',
  C6: 'Administrador total'
});

export const familiasQueGerencia = (ator) => {
  const permissoes = resolverCargo(ator).permissoes;
  if (permissoes.includes('*')) return [...FAMILIAS_DO_CLIENTE];
  return FAMILIAS_DO_CLIENTE.filter((familia) => permissoes.includes(GERENCIA[familia]));
};
