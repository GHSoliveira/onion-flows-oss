#!/usr/bin/env bash
# deploy-frontend.sh — build do client e publicacao no servidor da Oracle
# (nginx em 127.0.0.1:8080, exposto por um Cloudflare Tunnel).
#
#   bash deploy-frontend.sh            publica no servidor
#   bash deploy-frontend.sh --vercel   publica no servidor e tambem na Vercel
#
# As variaveis de producao (VITE_*) ficam em client/.env.production.local, fora
# do git. Sem elas o build usaria o client/.env local, que aponta para outra API.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")" && pwd)"
CLIENT_DIR="$RAIZ/client"
HOST="${ONION_SSH_HOST:?defina ONION_SSH_HOST (usuario@servidor)}"
CHAVE="${ONION_SSH_KEY:?defina ONION_SSH_KEY (caminho da chave SSH)}"
BASE="/var/www/onion-painel"
API_ESPERADA="${ONION_API_HOST:?defina ONION_API_HOST (ex.: api.seudominio.com)}"
VERCEL=0
[[ "${1:-}" == "--vercel" ]] && VERCEL=1

cd "$CLIENT_DIR"
if ! grep -q "^VITE_API_URL=.*${API_ESPERADA}" .env.production.local 2>/dev/null; then
  echo "✗ client/.env.production.local sem VITE_API_URL de producao (${API_ESPERADA})."
  echo "  Crie o arquivo com as variaveis VITE_ de producao (veja client/.env.example)."
  exit 1
fi

BUILD_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo n/d)"
ID="$(date +%Y%m%d-%H%M%S)-${BUILD_COMMIT}"
echo "▶ Build (commit ${BUILD_COMMIT})..."
VITE_BUILD_COMMIT="$BUILD_COMMIT" node_modules/.bin/vite build --mode production

# Conferencia: o pacote tem que falar com a API de producao.
if ! grep -rqs "$API_ESPERADA" dist/assets; then
  echo "✗ O build nao aponta para ${API_ESPERADA}. Nada foi publicado."
  exit 1
fi

PACOTE="$(mktemp -t painel-XXXXXX).tar.gz"
tar -czf "$PACOTE" -C dist .
echo "▶ Enviando ${ID}..."
scp -q -i "$CHAVE" -o ConnectTimeout=20 "$PACOTE" "$HOST:/tmp/painel-${ID}.tar.gz"
rm -f "$PACOTE"

ssh -i "$CHAVE" -o ConnectTimeout=20 "$HOST" "bash -s" <<REMOTO
set -euo pipefail
NOVA="${BASE}/releases/${ID}"
mkdir -p "\$NOVA"
tar -xzf "/tmp/painel-${ID}.tar.gz" -C "\$NOVA"
rm -f "/tmp/painel-${ID}.tar.gz"
# Arquivos da versao anterior continuam servidos: aba aberta nao quebra.
if [ -d "${BASE}/current/assets" ]; then cp -rn "${BASE}/current/assets/." "\$NOVA/assets/"; fi
test -f "\$NOVA/index.html"
ln -sfn "\$NOVA" "${BASE}/current.tmp" && mv -Tf "${BASE}/current.tmp" "${BASE}/current"
# Guarda as 5 ultimas.
ls -1dt ${BASE}/releases/*/ | tail -n +6 | xargs -r rm -rf
curl -fsS -o /dev/null -w "  servidor responde: %{http_code}\n" http://127.0.0.1:8080/
REMOTO

if [[ $VERCEL == 1 ]]; then
  echo "▶ Deploy Vercel (prod)..."
  vercel --prod --build-env "VITE_BUILD_COMMIT=$BUILD_COMMIT"
fi

echo "✓ Deploy concluído (${ID})."
