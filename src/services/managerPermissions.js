// Permissoes extras do MANAGER, marcadas pelo ADMIN no cadastro do usuario.
// So somam acesso: um MANAGER sem nenhuma marcada fica exatamente como antes
// (leitura). Conectar WhatsApp, plano, canais e criar ADMIN/MANAGER nao entram
// no catalogo de proposito, entao nao ha como liberar.
//
// Fica num campo proprio (managerPermissions) e nao em `permissions`, que e do
// SUPER_ADMIN e aceita curinga '*'.

export const MANAGER_PERMISSIONS = Object.freeze({
  conversas: 'Transferir e encerrar conversas',
  equipe: 'Gerenciar atendentes e filas',
  fluxos: 'Editar e publicar fluxos',
  respostas: 'Respostas rápidas e etiquetas',
  contatos: 'Criar, editar e importar contatos'
});

export const normalizeManagerPermissions = (list) => [...new Set(
  (Array.isArray(list) ? list : [])
    .map((item) => String(item || '').trim())
    .filter((item) => Object.prototype.hasOwnProperty.call(MANAGER_PERMISSIONS, item))
)];

export const managerCan = (user, permission) => (
  user?.role === 'MANAGER' && normalizeManagerPermissions(user.managerPermissions).includes(permission)
);
