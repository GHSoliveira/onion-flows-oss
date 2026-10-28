#!/usr/bin/env node
/**
 * Publica o backend na Oracle a partir de um COMMIT, nao da pasta de trabalho.
 *
 *   node scripts/deploy.mjs <tag> --dry-run   monta a release no servidor, mostra
 *                                              o que muda, roda node --check e apaga
 *   node scripts/deploy.mjs <tag>             publica (com rollback automatico)
 *   node scripts/deploy.mjs <tag> --front     publica e depois sobe o painel no servidor (nginx)
 *
 * Por que commit: o pacote sai de `git archive HEAD`, entao nao leva arquivo
 * esquecido fora do git, nem alteracao nao commitada, nem o CRLF do Windows.
 * Antes de empacotar exige a arvore limpa nos caminhos do backend e roda a
 * suite de testes (pule com --sem-testes so se souber o motivo).
 *
 * O trabalho no servidor fica em scripts/deploy/remote-deploy.sh.
 * Voltar para uma release anterior: node scripts/publicar.mjs voltar [id]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RAIZ = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const exigirEnv = (nome) => {
  const valor = process.env[nome];
  if (!valor) { console.error(`Defina ${nome} antes de publicar.`); process.exit(1); }
  return valor;
};
const HOST = exigirEnv('ONION_SSH_HOST');
const CHAVE = exigirEnv('ONION_SSH_KEY');
const ENTRADA = '/opt/onion-flows/incoming';

// O que roda na Oracle. Igual ao ESCOPO_ARTEFATO do scripts/release.mjs.
const BACKEND = ['index.js', 'database.js', 'package.json', 'package-lock.json', '.env.example',
  'src', 'db', 'scripts', 'tests', '.githooks'];

const args = process.argv.slice(2);
const tag = args.find((a) => !a.startsWith('--'));
const DRY = args.includes('--dry-run');
const SEM_TESTES = args.includes('--sem-testes');
const FRONT = args.includes('--front');

const passo = (texto) => console.log(`\n▸ ${texto}`);
const rodar = (cmd, argv, opcoes = {}) => execFileSync(cmd, argv, { cwd: RAIZ, encoding: 'utf8', ...opcoes });
const git = (...argv) => rodar('git', argv).trim();
const ssh = (comando, stdio = 'inherit') => rodar('ssh', ['-i', CHAVE, '-o', 'ConnectTimeout=20', HOST, comando], { stdio });
const scp = (local, remoto) => rodar('scp', ['-q', '-i', CHAVE, '-o', 'ConnectTimeout=20', local, `${HOST}:${remoto}`], { stdio: 'inherit' });

if (!tag || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(tag)) {
  console.error('uso: node scripts/deploy.mjs <tag-curta-em-minusculas> [--dry-run] [--front] [--sem-testes]');
  process.exit(1);
}

const sujos = git('status', '--porcelain', '--', ...BACKEND).split('\n').filter(Boolean);
if (sujos.length) {
  console.error('Tem alteracao fora de commit no backend. Commite antes de publicar:');
  for (const linha of sujos.slice(0, 20)) console.error(`  ${linha}`);
  process.exit(1);
}

const sha = git('rev-parse', 'HEAD');
const agora = new Date();
const dois = (n) => String(n).padStart(2, '0');
const id = `${agora.getFullYear()}${dois(agora.getMonth() + 1)}${dois(agora.getDate())}-${dois(agora.getHours())}${dois(agora.getMinutes())}-${tag}`;
console.log(`release  ${id}`);
console.log(`commit   ${sha.slice(0, 10)} ${git('log', '-1', '--format=%s')}`);
if (DRY) console.log('modo     dry-run (nada no ar muda)');

if (!SEM_TESTES) {
  passo('testes');
  try {
    const saida = rodar('npm', ['test'], { stdio: 'pipe', shell: process.platform === 'win32' });
    console.log(saida.split('\n').filter((l) => /^# (pass|fail)/.test(l)).join('\n'));
  } catch (erro) {
    const saida = String(erro.stdout || '');
    console.error(saida.split('\n').filter((l) => /^not ok|^# (pass|fail)/.test(l)).join('\n'));
    console.error('\nTestes falharam. Nada foi enviado.');
    process.exit(1);
  }
}

passo('empacotando o commit');
const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'onion-deploy-'));
const pacote = path.join(pasta, `${id}.tar.gz`);
// autocrlf=false: sem isso o git archive no Windows converte para CRLF.
rodar('git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar.gz', '-o', pacote, 'HEAD', '--', ...BACKEND]);
console.log(`${(fs.statSync(pacote).size / 1024).toFixed(0)} KB`);

passo('enviando');
ssh(`mkdir -p ${ENTRADA}`);
scp(pacote, `${ENTRADA}/${id}.tar.gz`);
scp(path.join(RAIZ, 'scripts', 'deploy', 'remote-deploy.sh'), `${ENTRADA}/remote-deploy.sh`);
fs.rmSync(pasta, { recursive: true, force: true });

let ok = true;
try {
  ssh(`bash ${ENTRADA}/remote-deploy.sh ${id} ${sha} ${ENTRADA}/${id}.tar.gz ${DRY ? '--dry-run' : ''}`);
} catch {
  ok = false;
} finally {
  try { ssh(`rm -f ${ENTRADA}/${id}.tar.gz ${ENTRADA}/remote-deploy.sh`, 'pipe'); } catch { /* limpeza nao muda o resultado */ }
}

if (!ok) {
  console.error('\nO deploy nao terminou. Veja a saida acima.');
  process.exit(1);
}
if (FRONT && !DRY) {
  passo('frontend (servidor da Oracle)');
  rodar('bash', ['deploy-frontend.sh'], { stdio: 'inherit' });
}
