$ErrorActionPreference = 'Stop'
$nodeExecutable = (& node -p 'process.execPath').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22 or newer is required.' }
$cli = Join-Path $PSScriptRoot 'dist/cli.js'
if (-not (Test-Path -LiteralPath $cli)) {
    $compiler = Join-Path $PSScriptRoot 'node_modules/typescript/bin/tsc'
    if (-not (Test-Path -LiteralPath $compiler)) { throw 'Please install project dependencies first: npm ci' }
    & $nodeExecutable $compiler --project (Join-Path $PSScriptRoot 'tsconfig.json')
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
}
$serverArgs = @('server')
if ($env:SHARED_SSH_NO_BROWSER -ne '1') { $serverArgs += '--open' }
& $nodeExecutable $cli @serverArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Shared SSH terminal is running. Closing the browser keeps SSH sessions alive.'
Write-Output 'Run Stop-Terminal.ps1 to stop the service and close all SSH sessions.'
