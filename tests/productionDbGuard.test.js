import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// O .env local aponta para o banco de producao. Fora do servidor o adaptador
// remoto so carrega com ALLOW_PRODUCTION_DB=true. Roda em processo separado
// porque a escolha do adaptador acontece no import.

const carregar = (env) => spawnSync(process.execPath, ['--input-type=module', '-e',
  "await import('./db/DatabaseAdapter.js'); console.log('carregou');"], {
  cwd: new URL('..', import.meta.url),
  // Sem herdar o .env: DOTENV nao roda aqui, so o que o teste passa.
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  encoding: 'utf8'
});

test('maquina local com adaptador remoto nao carrega', () => {
  for (const DB_ADAPTER of ['supabase', 'postgres']) {
    const r = carregar({ DB_ADAPTER, NODE_ENV: 'development' });
    assert.notEqual(r.status, 0, DB_ADAPTER);
    assert.match(r.stderr, /banco remoto bloqueado/);
  }
  assert.match(carregar({ DB_ADAPTER: 'postgres' }).stderr, /NODE_ENV=\(vazio\)/);
});

test('servidor, pedido explicito e JSON continuam carregando', () => {
  assert.match(carregar({ DB_ADAPTER: 'postgres', NODE_ENV: 'production' }).stdout, /carregou/);
  assert.match(carregar({ DB_ADAPTER: 'supabase', NODE_ENV: 'development', ALLOW_PRODUCTION_DB: 'true' }).stdout, /carregou/);
  assert.match(carregar({ DB_ADAPTER: 'json', NODE_ENV: 'development' }).stdout, /carregou/);
});
