$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
. (Join-Path $PSScriptRoot 'load-sandbox-env.ps1')

$env:VITE_API_URL = "http://localhost:$($env:PORT)"
$env:VITE_SOCKET_URL = "http://localhost:$($env:PORT)"
$env:VITE_NODE_ENV = 'sandbox'

Set-Location -LiteralPath (Join-Path $Root 'client')
& .\node_modules\.bin\vite.cmd --host 127.0.0.1 --port 30999
