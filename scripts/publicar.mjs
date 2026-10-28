#!/usr/bin/env node
/**
 * Etapa 3 do pipeline: publicar e voltar, por SSH.
 *
 * NADA AQUI RODA SOZINHO. Todo comando que altera o servidor exige que voce
 * chame explicitamente, e todos aceitam --dry-run, que imprime exatamente o que
 * seria executado sem executar.
 *
 * COMO O SERVIDOR JA ESTA MONTADO
 *
 *   /opt/onion-flows/releases/<id>/   uma pasta por versao
 *   /opt/onion-flows/current -> releases/<id>
 *   systemd: WorkingDirectory=/opt/onion-flows/current
 *            EnvironmentFile=/opt/onion-flows/current/.env
 *
 * O PROBLEMA DO .env (leia antes de publicar a primeira vez)
 *
 * Hoje o .env mora DENTRO de cada release. Isso faz o rollback voltar codigo e
 * configuracao juntos: voltar para uma release antiga restaura um .env antigo,
 * que pode nao ter variaveis que o codigo de hoje exige — e ai o servico nem
 * sobe, exatamente quando voce precisa dele de volta.
 *
 * O comando `migrar-env` resolve isso de uma vez: move o .env para
 * /opt/onion-flows/shared/.env, aponta o systemd para la e deixa um symlink em
 * cada release. Depois disso codigo e configuracao versionam separado.
 *
 * Enquanto a migracao nao acontecer, `publicar` copia o .env da release atual
 * para a nova e avisa. Funciona, mas mantem o rollback fragil.
 *
 * Uso:
 *   node scripts/publicar.mjs estado
 *   node scripts/publicar.mjs migrar-env --dry-run
 *   node scripts/publicar.mjs publicar --ultima --dry-run
 *   node scripts/publicar.mjs publicar 20260909-1152-alguma-coisa
 *   node scripts/publicar.mjs voltar
 *   node scripts/publicar.mjs voltar 20260907-tenant-scope
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LOCAL_RELEASES = path.join(RAIZ, '.releases');

const exigirEnv = (nome) => {
  const valor = process.env[nome];
  if (!valor) { console.error(`Defina ${nome} antes de publicar.`); process.exit(1); }
  return valor;
};
const HOST = exigirEnv('ONION_SSH_HOST');
const CHAVE = exigirEnv('ONION_SSH_KEY');
const BASE = '/opt/onion-flows';
const SERVICO = 'onion-flows';
const MANTER = Number(process.env.ONION_MANTER_RELEASES || 15);
const TENTATIVAS_SAUDE = 12;   // 12 x 5s = 60s de tolerancia para o boot

const DRY = process.argv.includes('--dry-run');

/* ------------------------------------------------------------------ */

const ssh = (comando, { silencioso = false } = {}) => {
  if (DRY) {
    console.log(`  [dry-run] ssh: ${comando}`);
    return '';
  }
  try {
    return execFileSync('ssh', ['-i', CHAVE, '-o', 'ConnectTimeout=20', HOST, comando], {
      encoding: 'utf8', stdio: silencioso ? 'pipe' : ['pipe', 'pipe', 'inherit']
    }).trim();
  } catch (erro) {
    const saida = String(erro.stdout || '') + String(erro.stderr || '');
    const e = new Error(`falhou no servidor: ${comando}\n${saida.slice(0, 500)}`);
    e.remoto = true;
    throw e;
  }
};

const scp = (local, remoto) => {
  if (DRY) {
    console.log(`  [dry-run] scp: ${path.basename(local)} -> ${remoto}`);
    return;
  }
  execFileSync('scp', ['-i', CHAVE, '-o', 'ConnectTimeout=20', local, `${HOST}:${remoto}`], { stdio: 'inherit' });
};

const passo = (texto) => console.log(`\n▸ ${texto}`);

/* ------------------------------------------------------------------ */

const releaseAtual = () => path.basename(ssh(`readlink -f ${BASE}/current`, { silencioso: true }) || '');

const releasesNoServidor = () => (ssh(`ls -1 ${BASE}/releases`, { silencioso: true }) || '')
  .split('\n').map((s) => s.trim()).filter(Boolean).sort();

const envCompartilhado = () => ssh(`test -f ${BASE}/shared/.env && echo sim || echo nao`, { silencioso: true }) === 'sim';

/**
 * Consulta o /health/ready de dentro do proprio servidor, sem passar pelo
 * Cloudflare. Se o tunel estiver com problema mas o app estiver de pe, queremos
 * saber que o app esta de pe.
 */
const esperarSaude = () => {
  if (DRY) { console.log('  [dry-run] checaria /health/ready ate 60s'); return true; }
  const porta = ssh(`grep -E "^PORT=" ${BASE}/current/.env | head -1 | cut -d= -f2 | tr -d "\\"'"`, { silencioso: true }) || '3001';
  for (let i = 1; i <= TENTATIVAS_SAUDE; i += 1) {
    const codigo = ssh(`curl -s -o /dev/null -w "%{http_code}" -m 4 http://127.0.0.1:${porta}/health/ready || true`, { silencioso: true });
    if (codigo === '200') { console.log(`  saude ok na tentativa ${i} (porta ${porta})`); return true; }
    console.log(`  tentativa ${i}/${TENTATIVAS_SAUDE}: HTTP ${codigo || 'sem resposta'}`);
    execFileSync('node', ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore' });
  }
  return false;
};

const apontarPara = (id) => {
  // Symlink temporario + mv -T: a troca vira atomica, entao nunca existe um
  // instante em que `current` aponta para lugar nenhum.
  ssh(`ln -sfn ${BASE}/releases/${id} ${BASE}/.current-novo && mv -T ${BASE}/.current-novo ${BASE}/current`);
};

const reiniciar = () => ssh(`sudo systemctl restart ${SERVICO}`);

/* ------------------------------------------------------------------ */

const estado = () => {
  console.log(`servidor  ${HOST}`);
  const atual = releaseAtual();
  const lista = releasesNoServidor();
  const compartilhado = envCompartilhado();

  console.log(`current   ${atual}`);
  console.log(`releases  ${lista.length} no servidor`);
  console.log(`.env      ${compartilhado ? 'em shared/ (rollback seguro)' : 'DENTRO da release (rollback fragil — veja migrar-env)'}`);
  console.log(`servico   ${ssh(`systemctl is-active ${SERVICO} || true`, { silencioso: true })}`);

  console.log('\nultimas releases no servidor:');
  for (const id of lista.slice(-8).reverse()) {
    console.log(`  ${id === atual ? '→' : ' '} ${id}`);
  }

  const locais = fs.existsSync(LOCAL_RELEASES)
    ? fs.readdirSync(LOCAL_RELEASES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  console.log(`\nreleases locais empacotadas: ${locais.length}`);
  for (const id of locais.slice(-5).reverse()) console.log(`    ${id}`);
};

/* ------------------------------------------------------------------ */

const migrarEnv = () => {
  if (envCompartilhado()) {
    console.log('shared/.env ja existe. Nada a fazer.');
    return;
  }
  console.log('Move o .env para fora das releases e aponta o systemd para ele.');
  console.log('Exige um daemon-reload e um restart: alguns segundos de indisponibilidade.\n');

  // Releases antigas podem ter um .env diferente do atual. Antes de trocar
  // qualquer coisa, guarda cada um (e a unit do systemd) numa pasta de backup.
  const backup = `${BASE}/backups/env-antes-migracao-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  passo(`guardando o .env de cada release e a unit do systemd em ${backup}`);
  ssh(`mkdir -p ${backup} && chmod 700 ${backup} && for d in ${BASE}/releases/*/; do [ -f "$d.env" ] && [ ! -L "$d.env" ] && cp -a "$d.env" "${backup}/$(basename "$d").env"; done; sudo cp /etc/systemd/system/${SERVICO}.service ${backup}/${SERVICO}.service && sudo chown $(id -u):$(id -g) ${backup}/${SERVICO}.service && ls -1 ${backup} | wc -l`);

  passo('criando shared/ e copiando o .env atual');
  ssh(`mkdir -p ${BASE}/shared && cp -a ${BASE}/current/.env ${BASE}/shared/.env && chmod 600 ${BASE}/shared/.env`);

  passo('trocando o .env de cada release por um symlink para o compartilhado');
  ssh(`for d in ${BASE}/releases/*/; do rm -f "$d.env" && ln -sfn ${BASE}/shared/.env "$d.env"; done`);

  passo('apontando o systemd para o .env compartilhado');
  ssh(`sudo sed -i 's#^EnvironmentFile=${BASE}/current/.env$#EnvironmentFile=${BASE}/shared/.env#' /etc/systemd/system/${SERVICO}.service`);
  // sed nao reclama quando nao casa nada; confere de verdade antes de reiniciar.
  const unit = ssh(`systemctl cat ${SERVICO} | grep ^EnvironmentFile=`, { silencioso: true });
  if (!DRY && unit !== `EnvironmentFile=${BASE}/shared/.env`) {
    throw new Error(`a unit nao foi atualizada (ficou: ${unit || 'vazio'}). Nada foi reiniciado; backup em ${backup}`);
  }
  ssh('sudo systemctl daemon-reload');

  passo('reiniciando e conferindo saude');
  reiniciar();
  if (!esperarSaude()) {
    console.error('\nO servico nao respondeu depois da migracao. Confira: sudo journalctl -u onion-flows -n 80');
    process.exit(1);
  }
  console.log('\nMigracao concluida. A partir de agora rollback nao mexe em configuracao.');
};

/* ------------------------------------------------------------------ */

const publicar = (alvo) => {
  const locais = fs.existsSync(LOCAL_RELEASES)
    ? fs.readdirSync(LOCAL_RELEASES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const id = alvo === '--ultima' ? locais.at(-1) : alvo;

  if (!id || !locais.includes(id)) {
    console.error(`Release local "${id || ''}" nao encontrada. Empacote antes com scripts/release.mjs criar.`);
    process.exit(1);
  }
  const artefato = path.join(LOCAL_RELEASES, id, 'artefato.tar.gz');
  if (!fs.existsSync(artefato)) {
    console.error(`A release ${id} nao tem artefato.tar.gz.`);
    process.exit(1);
  }

  const anterior = releaseAtual();
  const compartilhado = envCompartilhado();

  console.log(`publicando ${id}`);
  console.log(`atual      ${anterior}`);
  if (!compartilhado) {
    console.log('\nATENCAO: o .env ainda mora dentro da release. Vou copiar o da atual para a nova,');
    console.log('mas o rollback continua fragil ate voce rodar `migrar-env`.\n');
  }

  passo('enviando o artefato');
  ssh(`mkdir -p ${BASE}/releases/${id}`);
  scp(artefato, `${BASE}/releases/${id}/artefato.tar.gz`);

  passo('extraindo');
  ssh(`cd ${BASE}/releases/${id} && tar -xzf artefato.tar.gz && rm -f artefato.tar.gz`);

  passo('ligando configuracao e uploads');
  if (compartilhado) ssh(`ln -sfn ${BASE}/shared/.env ${BASE}/releases/${id}/.env`);
  else ssh(`cp -a ${BASE}/current/.env ${BASE}/releases/${id}/.env`);
  ssh(`ln -sfn /var/lib/onion-flows/uploads ${BASE}/releases/${id}/uploads`);

  passo('instalando dependencias (npm ci)');
  ssh(`cd ${BASE}/releases/${id} && npm ci --omit=dev 2>&1 | tail -3`);

  passo('trocando o current e reiniciando');
  apontarPara(id);
  reiniciar();

  passo('conferindo saude');
  if (esperarSaude()) {
    console.log('\npublicado com sucesso.');
  } else {
    console.error('\nSAUDE FALHOU. Voltando sozinho para a release anterior.');
    if (anterior) {
      apontarPara(anterior);
      reiniciar();
      console.error(esperarSaude()
        ? `Rollback automatico concluido: ${anterior} esta no ar.`
        : `ROLLBACK TAMBEM FALHOU. Entre no servidor: sudo journalctl -u ${SERVICO} -n 80`);
    }
    process.exit(1);
  }

  passo(`podando releases antigas (mantendo ${MANTER})`);
  // `grep -v` protege a release ativa mesmo que ela caia fora da janela.
  ssh(`cd ${BASE}/releases && ls -1 | sort | head -n -${MANTER} | grep -v "^${id}$" | xargs -r rm -rf`);

  // Registra no manifesto local que esta release foi publicada, e quando.
  try {
    const arquivo = path.join(LOCAL_RELEASES, id, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    m.publicadoEm = new Date().toISOString();
    m.substituiu = anterior;
    if (!DRY) fs.writeFileSync(arquivo, JSON.stringify(m, null, 2));
  } catch { /* manifesto ausente nao impede a publicacao */ }

  console.log('\nRegenere a pagina: node scripts/release.mjs historico');
};

/* ------------------------------------------------------------------ */

const voltar = (alvo) => {
  const atual = releaseAtual();
  const lista = releasesNoServidor();
  const destino = alvo || lista.filter((r) => r !== atual).at(-1);

  if (!destino || !lista.includes(destino)) {
    console.error(`Release "${destino || ''}" nao existe no servidor. Veja com: node scripts/publicar.mjs estado`);
    process.exit(1);
  }
  if (destino === atual) {
    console.error(`${destino} ja e a release ativa.`);
    process.exit(1);
  }

  console.log(`voltando de ${atual}`);
  console.log(`         para ${destino}`);
  if (!envCompartilhado()) {
    console.log('\nATENCAO: o .env vive dentro da release. Voltar tambem volta a configuracao,');
    console.log('e se aquele .env nao tiver as variaveis que o codigo exige hoje, o servico nao sobe.\n');
  }

  passo('trocando o current e reiniciando');
  apontarPara(destino);
  reiniciar();

  passo('conferindo saude');
  if (esperarSaude()) console.log(`\n${destino} esta no ar.`);
  else {
    console.error(`\nA release ${destino} nao subiu. Investigue: sudo journalctl -u ${SERVICO} -n 80`);
    process.exit(1);
  }
};

/* ------------------------------------------------------------------ */

const comando = process.argv[2];
const argumento = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : null;

try {
  if (comando === 'estado') estado();
  else if (comando === 'migrar-env') migrarEnv();
  else if (comando === 'publicar') publicar(process.argv.includes('--ultima') ? '--ultima' : argumento);
  else if (comando === 'voltar') voltar(argumento);
  else {
    console.log('uso:');
    console.log('  node scripts/publicar.mjs estado');
    console.log('  node scripts/publicar.mjs migrar-env [--dry-run]');
    console.log('  node scripts/publicar.mjs publicar --ultima [--dry-run]');
    console.log('  node scripts/publicar.mjs publicar <id-da-release-local>');
    console.log('  node scripts/publicar.mjs voltar [id-da-release-no-servidor]');
    process.exit(1);
  }
} catch (erro) {
  console.error(`\n${erro.message}`);
  process.exit(1);
}
