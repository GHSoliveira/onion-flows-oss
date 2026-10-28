$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
. (Join-Path $PSScriptRoot 'load-sandbox-env.ps1')

Set-Location -LiteralPath $Root

node scripts/seed-sandbox-json.js
npm start
