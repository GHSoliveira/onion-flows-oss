// Permissoes do cargo de quem esta logado. A regra de verdade e do backend
// (src/services/cargos.js); aqui a tela so esconde ou mostra botoes.
//
// O login e o heartbeat mandam user.cargoEfetivo.permissoes. Enquanto um
// usuario antigo nao recebe isso (sessao aberta antes da atualizacao), vale a
// traducao do papel, igual a do backend.
const LEGADO = {
  AGENT: ['atendimento.historico', 'atendimento.fila', 'atendimento.ativo', 'contatos.editar'],
  MANAGER: ['atendimento.historico', 'operacao.ver', 'fluxos.ver']
};
const EXTRA_DO_GESTOR = {
  conversas: ['operacao.intervir'],
  equipe: ['equipe.atendentes', 'equipe.filas'],
  fluxos: ['fluxos.editar'],
  respostas: ['respostas.editar'],
  contatos: ['contatos.editar']
};

export const permissoesDe = (user) => {
  if (!user) return [];
  if (user.role === 'SUPER_ADMIN' || user.actingAsPartner) return ['*'];
  if (Array.isArray(user.cargoEfetivo?.permissoes)) return user.cargoEfetivo.permissoes;
  if (user.role === 'ADMIN') return ['*'];
  if (user.role === 'MANAGER') {
    const extras = (user.managerPermissions || []).flatMap((chave) => EXTRA_DO_GESTOR[chave] || []);
    return [...new Set([...LEGADO.MANAGER, ...extras])];
  }
  return LEGADO[user.role] || [];
};

export const can = (user, permissao) => {
  const lista = permissoesDe(user);
  return lista.includes('*') || lista.includes(permissao);
};

// Nome antigo das caixas do gestor -> permissao do catalogo de cargos.
const CHAVE_ANTIGA = {
  conversas: 'operacao.intervir',
  equipe: 'equipe.atendentes',
  fluxos: 'fluxos.editar',
  respostas: 'respostas.editar',
  contatos: 'contatos.editar'
};

export const hasManagerPermission = (user, key) => can(user, CHAVE_ANTIGA[key] || key);
