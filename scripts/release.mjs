#!/usr/bin/env node
/**
 * Empacotador local de releases. Etapa 2 do pipeline.
 *
 * NAO PUBLICA NADA. Nao fala com o servidor, nao commita, nao altera o projeto.
 * So le a fonte, calcula o que mudou desde a release anterior e arquiva.
 *
 * O que ele produz, em .releases/<id>/ :
 *   manifest.json    quem, quando, git, contagem de mudancas
 *   inventario.json  caminho + sha256 de cada arquivo considerado
 *   mudancas.json    adicionados / alterados / removidos contra a release anterior
 *   diff-git.patch   diff de conteudo, quando os dois lados tem SHA de git
 *   artefato.tar.gz  exatamente o que subiria para a Oracle
 *
 * E regenera .releases/historico.html, a pagina para abrir no navegador.
 *
 * DUAS LISTAS DE ARQUIVOS, DE PROPOSITO
 *
 *   ESCOPO_DIFF      o que conta como "mudou": backend + client/src.
 *                    Frontend e backend sobem para lugares diferentes (Vercel e
 *                    Oracle), mas quem publica quer ver as duas coisas juntas.
 *
 *   ESCOPO_ARTEFATO  o que vai no tar.gz: so o backend, que e o que roda na
 *                    Oracle. Sem node_modules (reconstruivel pelo package-lock),
 *                    sem .env (segredo, e a partir de agora mora em shared/),
 *                    sem docs/ (167 MB de PDF e .venv que nao sao runtime).
 *
 * Uso:
 *   node scripts/release.mjs criar "descricao-curta"
 *   node scripts/release.mjs listar
 *   node scripts/release.mjs historico
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RAIZ = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DESTINO = path.join(RAIZ, '.releases');

// Backend: o que existe dentro de /opt/onion-flows/current e importa em runtime.
const ESCOPO_ARTEFATO = [
  'index.js', 'package.json', 'package-lock.json', '.env.example',
  'src', 'db', 'scripts', 'tests', '.githooks'
];

// Diff cobre tambem o frontend, porque publicar envolve os dois. E o .gitignore,
// que nao roda em lugar nenhum mas define o que entra no pacote: mudou ele,
// mudou o que sobe.
const ESCOPO_DIFF = [...ESCOPO_ARTEFATO, 'client/src', 'client/index.html', 'client/package.json', '.gitignore'];

const IGNORAR = new Set(['node_modules', '.git', '.releases', 'dist', '.venv', '__pycache__']);

/* ------------------------------------------------------------------ */

const listarArquivos = (relativo) => {
  const absoluto = path.join(RAIZ, relativo);
  if (!fs.existsSync(absoluto)) return [];
  if (fs.statSync(absoluto).isFile()) return [relativo.split(path.sep).join('/')];

  const encontrados = [];
  const andar = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORAR.has(entrada.name)) continue;
      const cheio = path.join(dir, entrada.name);
      if (entrada.isDirectory()) andar(cheio);
      else if (entrada.isFile()) {
        encontrados.push(path.relative(RAIZ, cheio).split(path.sep).join('/'));
      }
    }
  };
  andar(absoluto);
  return encontrados;
};

const inventariar = (escopo) => {
  const inventario = {};
  for (const alvo of escopo) {
    for (const arquivo of listarArquivos(alvo)) {
      const conteudo = fs.readFileSync(path.join(RAIZ, arquivo));
      inventario[arquivo] = {
        sha: createHash('sha256').update(conteudo).digest('hex').slice(0, 16),
        bytes: conteudo.length
      };
    }
  }
  return inventario;
};

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};

const infoGit = () => {
  const sujos = (git('status', '--porcelain') || '').split('\n').filter(Boolean);
  return {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    sha: git('rev-parse', 'HEAD'),
    limpo: sujos.length === 0,
    // Numero, nao a lista: com 447 arquivos fora do git a lista viraria ruido.
    pendentes: sujos.length
  };
};

const releasesExistentes = () => {
  if (!fs.existsSync(DESTINO)) return [];
  return fs.readdirSync(DESTINO, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
};

const lerManifesto = (id) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DESTINO, id, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
};

const compararInventarios = (antes, agora) => {
  const adicionados = [];
  const alterados = [];
  const removidos = [];
  for (const [arquivo, dados] of Object.entries(agora)) {
    if (!antes[arquivo]) adicionados.push(arquivo);
    else if (antes[arquivo].sha !== dados.sha) alterados.push(arquivo);
  }
  for (const arquivo of Object.keys(antes)) {
    if (!agora[arquivo]) removidos.push(arquivo);
  }
  return { adicionados, alterados, removidos };
};

/* ------------------------------------------------------------------ */

const criar = (slug) => {
  if (!slug) {
    console.error('Falta a descricao. Ex: node scripts/release.mjs criar "ajuste-fila-demo"');
    process.exit(1);
  }
  const limpo = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const agora = new Date();
  const carimbo = `${agora.getFullYear()}${String(agora.getMonth() + 1).padStart(2, '0')}${String(agora.getDate()).padStart(2, '0')}`
    + `-${String(agora.getHours()).padStart(2, '0')}${String(agora.getMinutes()).padStart(2, '0')}`;
  const id = `${carimbo}-${limpo}`;
  const pasta = path.join(DESTINO, id);

  if (fs.existsSync(pasta)) {
    console.error(`Ja existe uma release ${id}. Espere um minuto ou use outra descricao.`);
    process.exit(1);
  }
  fs.mkdirSync(pasta, { recursive: true });

  const anteriorId = releasesExistentes().filter((r) => r < id).pop() || null;
  const anterior = anteriorId ? lerManifesto(anteriorId) : null;

  console.log(`release  ${id}`);
  console.log(`anterior ${anteriorId || '(primeira)'}`);

  const inventario = inventariar(ESCOPO_DIFF);
  fs.writeFileSync(path.join(pasta, 'inventario.json'), JSON.stringify(inventario, null, 1));

  let mudancas = { adicionados: Object.keys(inventario), alterados: [], removidos: [] };
  if (anteriorId) {
    const antes = JSON.parse(fs.readFileSync(path.join(DESTINO, anteriorId, 'inventario.json'), 'utf8'));
    mudancas = compararInventarios(antes, inventario);
  }
  fs.writeFileSync(path.join(pasta, 'mudancas.json'), JSON.stringify(mudancas, null, 1));

  const gitAgora = infoGit();

  // Diff de conteudo so e possivel entre dois commits. Enquanto houver arquivo
  // fora do git, esta parte fica incompleta — e esse e um bom motivo para
  // fechar a etapa 1.
  let diffGit = null;
  if (anterior?.git?.sha && gitAgora.sha && anterior.git.sha !== gitAgora.sha) {
    const patch = git('diff', anterior.git.sha, gitAgora.sha);
    if (patch) {
      fs.writeFileSync(path.join(pasta, 'diff-git.patch'), patch);
      diffGit = { de: anterior.git.sha.slice(0, 8), para: gitAgora.sha.slice(0, 8), linhas: patch.split('\n').length };
    }
  }

  let artefato = null;
  try {
    const presentes = ESCOPO_ARTEFATO.filter((alvo) => fs.existsSync(path.join(RAIZ, alvo)));
    // --force-local: sem isso o GNU tar le o "C:" do caminho do Windows como
    // se fosse host remoto e tenta abrir conexao.
    execFileSync('tar', [
      '--force-local',
      '-czf', path.join(pasta, 'artefato.tar.gz'),
      '--exclude=node_modules', '--exclude=.env', '--exclude=dist',
      '-C', RAIZ, ...presentes
    ], { stdio: 'pipe' });
    artefato = { bytes: fs.statSync(path.join(pasta, 'artefato.tar.gz')).size, itens: presentes };
  } catch (erro) {
    console.warn('aviso: nao consegui gerar o tar.gz —', String(erro.message).slice(0, 120));
  }

  const manifest = {
    id,
    anterior: anteriorId,
    descricao: slug,
    criadoEm: agora.toISOString(),
    git: gitAgora,
    arquivos: Object.keys(inventario).length,
    mudancas: {
      adicionados: mudancas.adicionados.length,
      alterados: mudancas.alterados.length,
      removidos: mudancas.removidos.length
    },
    diffGit,
    artefato
  };
  fs.writeFileSync(path.join(pasta, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`arquivos ${manifest.arquivos}`);
  console.log(`mudancas +${manifest.mudancas.adicionados} ~${manifest.mudancas.alterados} -${manifest.mudancas.removidos}`);
  if (artefato) console.log(`artefato ${(artefato.bytes / 1024 / 1024).toFixed(2)} MB`);
  if (!gitAgora.limpo) console.log(`atencao  ${gitAgora.pendentes} arquivos fora do git ou modificados: o diff de conteudo fica incompleto`);

  historico();
  console.log(`\npagina   ${path.join(DESTINO, 'historico.html')}`);
};

/* ------------------------------------------------------------------ */

const escapar = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const historico = () => {
  const ids = releasesExistentes().reverse();
  const cartoes = ids.map((id) => {
    const m = lerManifesto(id);
    if (!m) return '';
    let mud = { adicionados: [], alterados: [], removidos: [] };
    try {
      mud = JSON.parse(fs.readFileSync(path.join(DESTINO, id, 'mudancas.json'), 'utf8'));
    } catch { /* release sem mudancas gravadas */ }

    const lista = (rotulo, arr, cor) => (arr.length ? `
      <details class="grupo">
        <summary><span class="tag ${cor}">${rotulo}</span> ${arr.length}</summary>
        <ul>${arr.slice(0, 400).map((f) => `<li>${escapar(f)}</li>`).join('')}</ul>
        ${arr.length > 400 ? `<p class="nota">... e mais ${arr.length - 400}</p>` : ''}
      </details>` : '');

    return `
    <article class="release">
      <header>
        <h2>${escapar(m.descricao || id)}</h2>
        <code>${escapar(id)}</code>
      </header>
      <dl>
        <div><dt>Quando</dt><dd>${new Date(m.criadoEm).toLocaleString('pt-BR')}</dd></div>
        <div><dt>Branch</dt><dd>${escapar(m.git?.branch || '-')}</dd></div>
        <div><dt>Commit</dt><dd><code>${escapar((m.git?.sha || '-').slice(0, 10))}</code></dd></div>
        <div><dt>Arquivos</dt><dd>${m.arquivos}</dd></div>
        <div><dt>Artefato</dt><dd>${m.artefato ? (m.artefato.bytes / 1024 / 1024).toFixed(2) + ' MB' : '—'}</dd></div>
        <div><dt>Anterior</dt><dd>${escapar(m.anterior || '—')}</dd></div>
      </dl>
      ${m.git?.limpo === false
        ? `<p class="alerta">${m.git.pendentes} arquivos fora do git nesta release — o diff de conteudo abaixo cobre so o que estava versionado.</p>`
        : ''}
      <div class="resumo">
        <span class="tag add">+${mud.adicionados.length}</span>
        <span class="tag chg">~${mud.alterados.length}</span>
        <span class="tag del">−${mud.removidos.length}</span>
        ${m.diffGit ? `<span class="tag git">diff ${escapar(m.diffGit.de)} → ${escapar(m.diffGit.para)} (${m.diffGit.linhas} linhas)</span>` : ''}
      </div>
      ${lista('adicionados', mud.adicionados, 'add')}
      ${lista('alterados', mud.alterados, 'chg')}
      ${lista('removidos', mud.removidos, 'del')}
    </article>`;
  }).join('');

  const html = `<!doctype html>
<meta charset="utf-8">
<title>Releases — Onion Flows</title>
<style>
  :root { color-scheme: light dark; --azul:#155DFC; --borda:#cbd5e1; --fundo:#f8fafc; --texto:#0f172a; --suave:#64748b; }
  @media (prefers-color-scheme: dark) { :root { --borda:#334155; --fundo:#0f172a; --texto:#e2e8f0; --suave:#94a3b8; } }
  body { margin:0; padding:32px 20px 80px; background:var(--fundo); color:var(--texto);
         font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; }
  .capa { max-width:920px; margin:0 auto 28px; }
  h1 { margin:0 0 4px; font-size:22px; }
  .capa p { margin:0; color:var(--suave); }
  .release { max-width:920px; margin:0 auto 16px; border:1px solid var(--borda); border-radius:10px;
             padding:18px 20px; background:color-mix(in srgb, var(--fundo) 88%, white); }
  .release header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
  h2 { margin:0; font-size:16px; }
  code { font:12px ui-monospace,Consolas,monospace; color:var(--suave); }
  dl { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin:0 0 12px; }
  dt { font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--suave); }
  dd { margin:2px 0 0; font-weight:600; }
  .resumo { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
  .tag { font:11px ui-monospace,monospace; padding:2px 7px; border-radius:5px; border:1px solid var(--borda); }
  .add { color:#059669; } .chg { color:#0369a1; } .del { color:#dc2626; } .git { color:var(--azul); }
  .grupo { margin-top:6px; }
  summary { cursor:pointer; font-size:12px; color:var(--suave); }
  .grupo ul { margin:8px 0 0; padding-left:18px; max-height:280px; overflow:auto; }
  .grupo li { font:12px ui-monospace,monospace; color:var(--texto); }
  .alerta { margin:0 0 10px; padding:8px 10px; border-radius:6px; font-size:12px;
            background:#fef3c7; color:#78350f; }
  @media (prefers-color-scheme: dark) { .alerta { background:#422006; color:#fde68a; } }
  .nota { font-size:11px; color:var(--suave); }
  .vazio { max-width:920px; margin:0 auto; color:var(--suave); }
</style>
<div class="capa">
  <h1>Releases — Onion Flows</h1>
  <p>${ids.length} ${ids.length === 1 ? 'release arquivada' : 'releases arquivadas'} · gerado em ${new Date().toLocaleString('pt-BR')}</p>
</div>
${cartoes || '<p class="vazio">Nenhuma release ainda. Rode <code>node scripts/release.mjs criar "descricao"</code>.</p>'}
`;

  fs.mkdirSync(DESTINO, { recursive: true });
  fs.writeFileSync(path.join(DESTINO, 'historico.html'), html);
};

/* ------------------------------------------------------------------ */

const listar = () => {
  const ids = releasesExistentes().reverse();
  if (!ids.length) return console.log('nenhuma release ainda.');
  for (const id of ids) {
    const m = lerManifesto(id);
    const c = m?.mudancas || {};
    console.log(`${id}  +${c.adicionados ?? '?'} ~${c.alterados ?? '?'} -${c.removidos ?? '?'}  ${m?.descricao || ''}`);
  }
};

const comando = process.argv[2];
if (comando === 'criar') criar(process.argv[3]);
else if (comando === 'listar') listar();
else if (comando === 'historico') { historico(); console.log(path.join(DESTINO, 'historico.html')); }
else {
  console.log('uso:\n  node scripts/release.mjs criar "descricao"\n  node scripts/release.mjs listar\n  node scripts/release.mjs historico');
  process.exit(1);
}
