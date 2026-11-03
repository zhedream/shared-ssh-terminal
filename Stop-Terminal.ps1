$ErrorActionPreference = 'Stop'
$connection = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.runtime/ui.json') -Raw | ConvertFrom-Json
$uri = [Uri]$connection.url
if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -ne 'http') { throw 'Invalid local service address.' }
$headers = @{ Authorization = 'Bearer ' + $uri.Fragment.TrimStart('#') }
$null = Invoke-RestMethod -Method Post -Uri ($uri.GetLeftPart([UriPartial]::Authority) + '/api/shutdown') -Headers $headers -TimeoutSec 5
Write-Output 'Shared SSH service stopped. All SSH sessions have been closed.'
