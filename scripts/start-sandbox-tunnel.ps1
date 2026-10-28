# Sobe sandbox local + 2 tunnels Cloudflare (frontend + API).
# Requer: cloudflared no PATH, node, deps instaladas.
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$SandboxDir = Join-Path $Root 'sandbox'
$LogsDir = Join-Path $SandboxDir 'logs'
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null

function Wait-HttpOk {
  param([string]$Url, [int]$TimeoutSec = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-TunnelUrl {
  param([string]$LogPath, [int]$TimeoutSec = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $LogPath) {
      $text = Get-Content -LiteralPath $LogPath -Raw -ErrorAction SilentlyContinue
      if ($text -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
        return $Matches[0]
      }
    }
    Start-Sleep -Seconds 1
  }
  return $null
}

Write-Host '[TUNNEL] Encerrando sandbox anterior...'
& (Join-Path $PSScriptRoot 'stop-sandbox.ps1') -Quiet
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

. (Join-Path $PSScriptRoot 'load-sandbox-env.ps1')

Write-Host '[TUNNEL] Backend...'
$backend = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location -LiteralPath '$Root'; . '.\scripts\load-sandbox-env.ps1'; node scripts/seed-sandbox-json.js; node index.js`"" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput (Join-Path $LogsDir 'backend.out.log') `
  -RedirectStandardError (Join-Path $LogsDir 'backend.err.log')
Set-Content -LiteralPath (Join-Path $SandboxDir 'backend.pid') -Value $backend.Id

if (-not (Wait-HttpOk -Url 'http://127.0.0.1:3101/health' -TimeoutSec 45)) {
  throw 'Backend nao subiu em http://127.0.0.1:3101/health'
}
Write-Host '[TUNNEL] Backend OK'

Write-Host '[TUNNEL] Tunnel da API...'
$apiLog = Join-Path $LogsDir 'tunnel-api.log'
Remove-Item $apiLog -ErrorAction SilentlyContinue
$apiTunnel = Start-Process -FilePath 'cloudflared' `
  -ArgumentList 'tunnel --url http://127.0.0.1:3101 --no-autoupdate --protocol http2' `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput $apiLog `
  -RedirectStandardError $apiLog
Set-Content -LiteralPath (Join-Path $SandboxDir 'tunnel-api.pid') -Value $apiTunnel.Id

$apiUrl = Get-TunnelUrl -LogPath $apiLog -TimeoutSec 60
if (-not $apiUrl) { throw 'Nao foi possivel obter URL do tunnel da API' }
Set-Content -LiteralPath (Join-Path $SandboxDir 'tunnel-api.url') -Value $apiUrl
Write-Host "[TUNNEL] API publica: $apiUrl"

Write-Host '[TUNNEL] Frontend (Vite)...'
$frontend = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command `"Set-Location -LiteralPath '$Root\client'; `$env:VITE_API_URL='$apiUrl'; `$env:VITE_SOCKET_URL='$apiUrl'; `$env:VITE_NODE_ENV='sandbox'; & '.\node_modules\.bin\vite.cmd' --host 127.0.0.1 --port 30999`"" `
  -WorkingDirectory (Join-Path $Root 'client') `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput (Join-Path $LogsDir 'frontend.out.log') `
  -RedirectStandardError (Join-Path $LogsDir 'frontend.err.log')
Set-Content -LiteralPath (Join-Path $SandboxDir 'frontend.pid') -Value $frontend.Id

if (-not (Wait-HttpOk -Url 'http://127.0.0.1:30999/' -TimeoutSec 45)) {
  throw 'Frontend nao subiu em http://127.0.0.1:30999'
}
Write-Host '[TUNNEL] Frontend OK'

Write-Host '[TUNNEL] Tunnel do frontend...'
$frontLog = Join-Path $LogsDir 'tunnel-frontend.log'
Remove-Item $frontLog -ErrorAction SilentlyContinue
$frontTunnel = Start-Process -FilePath 'cloudflared' `
  -ArgumentList 'tunnel --url http://127.0.0.1:30999 --no-autoupdate --protocol http2' `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput $frontLog `
  -RedirectStandardError $frontLog
Set-Content -LiteralPath (Join-Path $SandboxDir 'tunnel-frontend.pid') -Value $frontTunnel.Id

$frontUrl = Get-TunnelUrl -LogPath $frontLog -TimeoutSec 60
if (-not $frontUrl) { throw 'Nao foi possivel obter URL do tunnel do frontend' }
Set-Content -LiteralPath (Join-Path $SandboxDir 'tunnel-frontend.url') -Value $frontUrl

@(
  "FRONTEND=$frontUrl"
  "API=$apiUrl"
  "LOCAL_FRONTEND=http://127.0.0.1:30999"
  "LOCAL_API=http://127.0.0.1:3101"
  "LOGIN_ADMIN=admin / sandbox123"
  "LOGIN_AGENT=agent / sandbox123"
) | Set-Content -LiteralPath (Join-Path $SandboxDir 'tunnel-urls.txt')

Write-Host ''
Write-Host '========================================'
Write-Host " Frontend publico: $frontUrl"
Write-Host " API publica:      $apiUrl"
Write-Host ' Login: admin / sandbox123'
Write-Host '        agent / sandbox123'
Write-Host '========================================'
Write-Host " URLs salvas em: sandbox\tunnel-urls.txt"
Write-Host ' Para parar: scripts\stop-sandbox.ps1 (e mate os cloudflared se necessario)'
Write-Host ''
