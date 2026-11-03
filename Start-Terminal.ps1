$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

function Get-TerminalUrl {
    try {
        $connection = Get-Content -LiteralPath (Join-Path $runtimeDirectory 'ui.json') -Raw | ConvertFrom-Json
        $uri = [Uri]$connection.url
        if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -ne 'http') { return $null }
        $headers = @{ Authorization = 'Bearer ' + $uri.Fragment.TrimStart('#') }
        $null = Invoke-RestMethod -Uri ($uri.GetLeftPart([UriPartial]::Authority) + '/api/state') -Headers $headers -TimeoutSec 2
        return $connection.url
    } catch { return $null }
}

$terminalUrl = Get-TerminalUrl
if (-not $terminalUrl) {
    $nodeExecutable = (& node -p 'process.execPath').Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Node.js is required.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) { throw 'Please install project dependencies first: npm ci' }
    & $nodeExecutable (Join-Path $projectRoot 'node_modules/typescript/bin/tsc') --project (Join-Path $projectRoot 'tsconfig.json')
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    $serverFile = Join-Path $projectRoot 'dist/server.js'
    $serverProcess = Start-Process -FilePath $nodeExecutable -ArgumentList @('"' + $serverFile + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDirectory 'service.stdout.log') -RedirectStandardError (Join-Path $runtimeDirectory 'service.stderr.log')
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        Start-Sleep -Milliseconds 100
        if ($serverProcess.HasExited) { throw ('Service failed. See ' + (Join-Path $runtimeDirectory 'service.stderr.log')) }
        $terminalUrl = Get-TerminalUrl
        if ($terminalUrl) { break }
    }
    if (-not $terminalUrl) { throw 'Service startup timed out. Check .runtime/service.stderr.log' }
}
Start-Process $terminalUrl
Write-Output 'Shared SSH terminal is running. Closing the browser keeps SSH sessions alive.'
Write-Output 'Run Stop-Terminal.ps1 to stop the service and close all SSH sessions.'
