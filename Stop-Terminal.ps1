$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot 'dist/cli.js'
if (-not (Test-Path -LiteralPath $cli)) { throw 'Build the terminal first: npm run build' }
& node $cli stop
exit $LASTEXITCODE
