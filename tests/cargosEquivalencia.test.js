import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Etapa 2 dos cargos: cada rota ganhou uma permissao do catalogo. Este teste le
// as rotas e confere, uma a uma, que os niveis equivalentes aos papeis de hoje
// (atendente A4, gestor B1 e gestor com cada permissao extra, admin C6) liberam
// exatamente o que o papel libera. Se alguem mudar uma rota ou um nivel e
// quebrar a equivalencia, falha aqui.

const { NIVEIS, cargoLegado } = await import('../src/services/cargos.js');

const ROTAS = path.resolve('src/routes');
const CHAMADA = /authorize\((\[[^\]]*\]|[A-Za-z_]+), \{ (?:manager: '([a-z]+)', )?permission: ('[a-z.]+'|\[[^\]]*\]) \}\)/g;
const ROTA = /router\.(get|post|put|patch|delete)\((['`])([^'`]*)\2/;

// Diferencas de proposito: o nivel novo e mais restrito que o papel antigo.
const DIFERENCAS = {
  'contacts.js delete /': { AGENT: 'apagar a base inteira de contatos sai do atendente e fica com o admin (LGPD)' }
};

const lerPapeis = (fonte, expressao) => {
  if (expressao.startsWith('[')) return expressao.match(/'([A-Z_]+)'/g).map((p) => p.slice(1, -1));
  const definicao = fonte.match(new RegExp(`const ${expressao} = (\\[[^\\]]*\\])`));
  if (!definicao) throw new Error(`lista de papeis ${expressao} nao encontrada`);
  return definicao[1].match(/'([A-Z_]+)'/g).map((p) => p.slice(1, -1));
};

const chamadas = fs.readdirSync(ROTAS).filter((f) => f.endsWith('.js')).flatMap((arquivo) => {
  const fonte = fs.readFileSync(path.join(ROTAS, arquivo), 'utf8');
  return fonte.split('\n').flatMap((linha) => [...linha.matchAll(CHAMADA)].map((m) => {
    const rota = linha.match(ROTA);
    return {
      id: `${arquivo} ${rota ? `${rota[1]} ${rota[3]}` : '(use)'}`,
      papeis: lerPapeis(fonte, m[1]),
      extra: m[2] || null,
      permissoes: m[3].match(/'([a-z.]+)'/g).map((p) => p.slice(1, -1))
    };
  }));
});

const libera = (lista, permissoes) => permissoes.some((p) => lista.includes('*') || lista.includes(p));

test('as rotas tem permissao anotada', () => {
  assert.ok(chamadas.length >= 170, `so ${chamadas.length} rotas com permissao`);
});

test('A4, B1 e C6 liberam o mesmo que atendente, gestor e admin de hoje', () => {
  const casos = [['AGENT', NIVEIS.A4], ['MANAGER', NIVEIS.B1], ['ADMIN', NIVEIS.C6]];
  const erros = [];
  for (const chamada of chamadas) {
    for (const [papel, nivel] of casos) {
      const antes = chamada.papeis.includes(papel);
      const depois = libera(nivel, chamada.permissoes);
      if (antes === depois) continue;
      const motivo = DIFERENCAS[chamada.id.replace(/ (get|post|put|patch|delete) /, ' $1 ')]?.[papel];
      if (motivo && antes && !depois) continue;
      erros.push(`${chamada.id} [${chamada.permissoes}]: ${papel} ${antes ? 'passava' : 'nao passava'} e agora ${depois ? 'passa' : 'nao passa'}`);
    }
  }
  assert.deepEqual(erros, []);
});

test('gestor com permissao extra marcada continua passando nas mesmas rotas', () => {
  const erros = [];
  for (const extra of ['conversas', 'equipe', 'fluxos', 'respostas', 'contatos']) {
    const nivel = cargoLegado({ role: 'MANAGER', managerPermissions: [extra] }).permissoes;
    for (const chamada of chamadas) {
      const antes = chamada.papeis.includes('MANAGER') || chamada.extra === extra;
      const depois = libera(nivel, chamada.permissoes);
      if (antes !== depois) erros.push(`${chamada.id} com "${extra}": ${antes ? 'passava' : 'nao passava'} e agora ${depois ? 'passa' : 'nao passa'}`);
    }
  }
  assert.deepEqual(erros, []);
});

test('as diferencas de proposito estao documentadas e existem', () => {
  for (const id of Object.keys(DIFERENCAS)) {
    assert.ok(chamadas.some((c) => c.id === id.replace(' delete ', ' delete ')), `${id} nao encontrada`);
  }
});
