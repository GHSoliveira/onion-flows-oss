$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$SandboxDir = Join-Path $Root 'sandbox'
$LogsDir = Join-Path $SandboxDir 'logs'
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $SandboxDir 'data') | Out-Null

& (Join-Path $PSScriptRoot 'stop-sandbox.ps1') -Quiet

$backendScript = Join-Path $PSScriptRoot 'run-backend-sandbox.ps1'
$frontendScript = Join-Path $PSScriptRoot 'run-frontend-sandbox.ps1'

$backend = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$backendScript`"" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput (Join-Path $LogsDir 'backend.out.log') `
  -RedirectStandardError (Join-Path $LogsDir 'backend.err.log')

Set-Content -LiteralPath (Join-Path $SandboxDir 'backend.pid') -Value $backend.Id

Start-Sleep -Seconds 3

$frontend = Start-Process -FilePath 'powershell.exe' `
  -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$frontendScript`"" `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput (Join-Path $LogsDir 'frontend.out.log') `
  -RedirectStandardError (Join-Path $LogsDir 'frontend.err.log')

Set-Content -LiteralPath (Join-Path $SandboxDir 'frontend.pid') -Value $frontend.Id

Write-Host '[SANDBOX] Backend:  http://localhost:3101'
Write-Host '[SANDBOX] Health:   http://localhost:3101/health'
Write-Host '[SANDBOX] Frontend: http://localhost:30999'
Write-Host '[SANDBOX] Login super-admin: admin / sandbox123'
Write-Host '[SANDBOX] Login agent:       agent / sandbox123'
Write-Host "[SANDBOX] Logs: $LogsDir"
