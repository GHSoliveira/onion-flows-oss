import test from 'node:test';
import assert from 'node:assert/strict';

// Etapa 1 dos cargos em espectro: os papeis de hoje viram niveis sem mudar o
// acesso de ninguem, e um nivel gravado (com ajustes) vale no lugar do papel.

const { NIVEIS, PERMISSOES, cargoLegado, resolverCargo, temPermissao, papelDoNivel } = await import('../src/services/cargos.js');

test('papeis de hoje viram os niveis combinados', () => {
  assert.equal(cargoLegado({ role: 'AGENT' }).codigo, 'A4');
  assert.equal(cargoLegado({ role: 'ADMIN' }).codigo, 'C6');
  assert.equal(cargoLegado({ role: 'SUPER_ADMIN' }).codigo, 'Z7');
  assert.equal(cargoLegado({ role: 'PARTNER' }).codigo, 'H5');
  assert.equal(cargoLegado({ role: 'MANAGER' }).codigo, 'B1');
});

test('gestor com permissoes marcadas cai no nivel B que bate, ou fica personalizado', () => {
  assert.equal(cargoLegado({ role: 'MANAGER', managerPermissions: ['conversas'] }).codigo, 'B3');
  assert.equal(cargoLegado({ role: 'MANAGER', managerPermissions: ['conversas', 'equipe', 'respostas'] }).codigo, 'B5');
  assert.equal(cargoLegado({ role: 'MANAGER', managerPermissions: ['conversas', 'equipe', 'respostas', 'fluxos'] }).codigo, 'B7');
  const solto = cargoLegado({ role: 'MANAGER', managerPermissions: ['conversas', 'equipe'] });
  assert.equal(solto.codigo, 'B');
  assert.equal(solto.personalizado, true);
  assert.ok(solto.permissoes.includes('equipe.atendentes'));
  assert.ok(!solto.permissoes.includes('respostas.editar'));
});

test('niveis so usam permissoes do catalogo e crescem dentro da familia', () => {
  for (const [codigo, lista] of Object.entries(NIVEIS)) {
    for (const p of lista) assert.ok(p === '*' || PERMISSOES[p], `${codigo} usa ${p}`);
  }
  const contem = (maior, menor) => NIVEIS[menor].every((p) => NIVEIS[maior].includes(p));
  for (const [maior, menor] of [['A2', 'A1'], ['A3', 'A2'], ['A4', 'A2'], ['B3', 'B1'], ['B5', 'B3'], ['B7', 'B5'], ['B9', 'B7'], ['C6', 'C5']]) {
    assert.ok(contem(maior, menor), `${maior} contem ${menor}`);
  }
  assert.ok(!NIVEIS.C5.includes('config.whatsapp'));
  assert.ok(!NIVEIS.A3.includes('operacao.intervir'), 'A3 so ganha leitura');
});

test('nivel gravado vale no lugar do papel, com caixas a mais e a menos', () => {
  const user = { role: 'AGENT', cargo: { nivel: 'A2', adicionadas: ['respostas.editar'], removidas: ['atendimento.historico'] } };
  const cargo = resolverCargo(user);
  assert.equal(cargo.modelo, 'cargo');
  assert.equal(cargo.codigo, 'A2');
  assert.equal(cargo.personalizado, true);
  assert.ok(temPermissao(user, 'respostas.editar'));
  assert.ok(temPermissao(user, 'atendimento.fila'));
  assert.ok(!temPermissao(user, 'atendimento.historico'));
  assert.ok(!temPermissao(user, 'atendimento.ativo'));
});

test('lixo gravado no cargo nao vira permissao', () => {
  const user = { role: 'AGENT', cargo: { nivel: 'A2', adicionadas: ['*', 'plataforma.tudo'] } };
  assert.ok(!temPermissao(user, 'config.whatsapp'));
  assert.equal(resolverCargo({ role: 'AGENT', cargo: { nivel: 'X9' } }).modelo, 'legado');
});

test('super admin tem tudo e o papel acompanha a familia', () => {
  assert.ok(temPermissao({ role: 'SUPER_ADMIN' }, 'dados.lgpd'));
  assert.equal(papelDoNivel('A4'), 'AGENT');
  assert.equal(papelDoNivel('B9'), 'MANAGER');
  assert.equal(papelDoNivel('C5'), 'ADMIN');
  assert.equal(papelDoNivel('Q1'), null);
});
