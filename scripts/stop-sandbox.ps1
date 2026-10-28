param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$SandboxDir = Join-Path $Root 'sandbox'
$PidFiles = @(
  (Join-Path $SandboxDir 'backend.pid'),
  (Join-Path $SandboxDir 'frontend.pid'),
  (Join-Path $SandboxDir 'tunnel-api.pid'),
  (Join-Path $SandboxDir 'tunnel-frontend.pid')
)

foreach ($pidFile in $PidFiles) {
  if (!(Test-Path -LiteralPath $pidFile)) { continue }
  $rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($rawPid -match '^\d+$') {
    $process = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force
      if (!$Quiet) { Write-Host "[SANDBOX] Processo encerrado: $($process.Id)" }
    }
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

$Ports = @(3101, 5174, 30999)
foreach ($port in $Ports) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($connection in $connections) {
    $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force
      if (!$Quiet) { Write-Host "[SANDBOX] Porta $port liberada pelo processo $($process.Id)" }
    }
  }
}

if (!$Quiet) {
  Write-Host '[SANDBOX] Stop finalizado.'
}
