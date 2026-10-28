#!/usr/bin/env bash
# Roda NO SERVIDOR, chamado por scripts/deploy.mjs. Recebe o pacote do commit
# em $PACOTE e monta uma release nova ao lado da atual:
#
#   1. extrai, liga .env compartilhado e uploads
#   2. dependencias: reaproveita as da release atual se as de producao do
#      package-lock nao mudaram; senao npm ci
#   3. lista o que muda contra a release no ar (sem \r: producao antiga tem CRLF)
#   4. node --check em todo .js/.mjs alterado
#   5. troca o current (atomico), reinicia e espera o /health/ready
#   6. se a saude nao voltar, volta sozinho para a release anterior
#
# Com --dry-run faz 1 a 4 e apaga a pasta nova: nada no ar muda.
set -euo pipefail

ID="$1"; SHA="$2"; PACOTE="$3"; MODO="${4:-}"
BASE=/opt/onion-flows
SERVICO=onion-flows
NEW="$BASE/releases/$ID"
CUR="$(readlink -f "$BASE/current")"

passo() { printf '\n> %s\n' "$*"; }

[ -e "$NEW" ] && { echo "a release $ID ja existe no servidor"; exit 1; }
[ -f "$PACOTE" ] || { echo "pacote nao encontrado: $PACOTE"; exit 1; }

limpar_se_falhar() { [ "${PUBLICADO:-}" = sim ] || rm -rf "$NEW"; }
trap limpar_se_falhar EXIT

passo "extraindo $ID (commit ${SHA:0:10})"
mkdir -p "$NEW"
tar -xzf "$PACOTE" -C "$NEW"
ln -sfn "$BASE/shared/.env" "$NEW/.env"
ln -sfn /var/lib/onion-flows/uploads "$NEW/uploads"
echo "$SHA" > "$NEW/REVISION"

passo "dependencias"
# Impressao digital so das dependencias de producao: mudar devDependency (ou o
# CRLF do lock antigo) nao obriga a reinstalar.
digital() {
  node -e '
    const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const prod = Object.entries(lock.packages || {})
      .filter(([nome, p]) => nome && !p.dev && !p.devOptional)
      .map(([nome, p]) => `${nome}@${p.version}`).sort();
    console.log(require("crypto").createHash("sha256").update(prod.join("\n")).digest("hex"));
  ' "$1"
}
if [ -d "$CUR/node_modules" ] && [ "$(digital "$CUR/package-lock.json")" = "$(digital "$NEW/package-lock.json")" ]; then
  cp -a "$CUR/node_modules" "$NEW/node_modules"
  echo "iguais as da release atual: copiadas"
else
  echo "mudaram: npm ci --omit=dev"
  (cd "$NEW" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3)
fi

passo "o que muda contra $(basename "$CUR")"
hash_sem_cr() { tr -d '\r' < "$1" | sha256sum | cut -c1-16; }
ALTERADOS=()
while IFS= read -r arquivo; do
  if [ ! -f "$CUR/$arquivo" ]; then
    echo "  + $arquivo"; ALTERADOS+=("$arquivo")
  elif [ "$(hash_sem_cr "$NEW/$arquivo")" != "$(hash_sem_cr "$CUR/$arquivo")" ]; then
    echo "  ~ $arquivo"; ALTERADOS+=("$arquivo")
  fi
done < <(cd "$NEW" && find . -type f -not -path './node_modules/*' -not -name REVISION | sed 's#^\./##' | sort)
while IFS= read -r arquivo; do
  [ -f "$NEW/$arquivo" ] || echo "  - $arquivo"
done < <(cd "$CUR" && find . -type f -not -path './node_modules/*' -not -name REVISION | sed 's#^\./##' | sort)
[ ${#ALTERADOS[@]} -eq 0 ] && echo "  (nenhum arquivo muda)"

passo "node --check nos alterados"
for arquivo in "${ALTERADOS[@]}"; do
  case "$arquivo" in *.js|*.mjs) node --check "$NEW/$arquivo" ;; esac
done
echo "ok"

if [ "$MODO" = "--dry-run" ]; then
  passo "dry-run: nada foi publicado, pasta de teste apagada"
  exit 0
fi

PORTA="$(systemctl show "$SERVICO" -p Environment --value | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1)"
PORTA="${PORTA:-3101}"

apontar() { ln -sfn "$1" "$BASE/.current-novo" && mv -T "$BASE/.current-novo" "$BASE/current"; }
saude() {
  for i in $(seq 1 12); do
    codigo="$(curl -s -o /dev/null -w '%{http_code}' -m 4 "http://127.0.0.1:$PORTA/health/ready" || true)"
    if [ "$codigo" = 200 ]; then echo "  saude ok na tentativa $i"; return 0; fi
    echo "  tentativa $i/12: HTTP ${codigo:-sem resposta}"; sleep 5
  done
  return 1
}

passo "trocando o current e reiniciando"
PUBLICADO=sim
apontar "$NEW"
sudo systemctl restart "$SERVICO"

passo "conferindo saude"
if saude; then
  echo "$(date -Is) $ID ${SHA:0:10} substituiu $(basename "$CUR")" >> "$BASE/deploys.log"
  printf '\npublicado: %s\nrollback:  %s\n' "$ID" "$(basename "$CUR")"
  exit 0
fi

echo; echo "SAUDE FALHOU. Voltando para $(basename "$CUR")."
sudo journalctl -u "$SERVICO" -n 30 --no-pager | sed 's/^/  | /'
apontar "$CUR"
sudo systemctl restart "$SERVICO"
if saude; then echo "rollback concluido: $(basename "$CUR") esta no ar. A pasta $ID ficou para investigar."
else echo "ROLLBACK TAMBEM FALHOU: sudo journalctl -u $SERVICO -n 80"; fi
exit 1
