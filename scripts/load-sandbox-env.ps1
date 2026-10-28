$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$EnvFile = Join-Path $Root '.env.sandbox'

if (!(Test-Path -LiteralPath $EnvFile)) {
  throw "Arquivo .env.sandbox nao encontrado em $EnvFile"
}

Get-Content -LiteralPath $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (!$line -or $line.StartsWith('#')) { return }
  $separatorIndex = $line.IndexOf('=')
  if ($separatorIndex -lt 1) { return }
  $name = $line.Substring(0, $separatorIndex).Trim()
  $value = $line.Substring($separatorIndex + 1).Trim()
  [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}
