# Onion Flows Load Tests

Suite isolada de testes de carga com k6 para medir quanto o backend aguenta sem o usuario perceber lentidao.

## Instalar k6 no Windows

```powershell
winget install k6.k6
k6 version
```

## Configurar variaveis

Crie uma copia do arquivo de exemplo:

```powershell
Copy-Item .\load-tests\.env.k6.example .\load-tests\.env.k6.ps1
```

Edite `load-tests/.env.k6.ps1` com seu login e tenant.

Carregue as variaveis:

```powershell
.\load-tests\.env.k6.ps1
```

O backend usa `username`, nao email. Entao preencha `USERNAME` com o usuario usado no login da plataforma.

## Rodar teste principal

```powershell
k6 run .\load-tests\api-smoke-load.js
```

## Rodar teste dedicado sem rate limit global

Este teste usa `/api/load-test/smoke`, uma rota autenticada e read-only feita para medir API + banco sem bater no limite global de 200 req/min por IP.

```powershell
k6 run .\load-tests\load-test-route.js
```

## Rodar teste de chats e monitoramento

```powershell
k6 run .\load-tests\chat-monitoring-load.js
```

## Rodar teste de webhook WhatsApp fake

Use apenas se souber que o ambiente suporta eventos fake sem afetar producao.

```powershell
k6 run .\load-tests\whatsapp-webhook-load.js
```

## Ajustar carga

Voce pode sobrescrever o perfil por env:

```powershell
$env:K6_TARGET="50"
$env:K6_RAMP_UP="1m"
$env:K6_HOLD="2m"
$env:K6_RAMP_DOWN="30s"
k6 run .\load-tests\api-smoke-load.js
```

## Interpretacao rapida

- `http_req_duration p(95) < 300ms`: excelente.
- `http_req_duration p(95) < 800ms`: aceitavel para dashboard/listagens.
- `http_req_duration p(95) > 1500ms`: usuario comeca a perceber lentidao.
- `http_req_failed > 1%`: problema real.

Comece com 10 ou 20 VUs. Depois suba para 50 e 100. Evite testar 500 direto em producao.
