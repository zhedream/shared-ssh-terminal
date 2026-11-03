$ErrorActionPreference = 'Stop'
$nodeExecutable = (& node -p 'process.execPath').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Node.js is required.' }
$mcpFile = Join-Path $PSScriptRoot 'dist/mcp.js'
if (-not (Test-Path -LiteralPath $mcpFile)) { throw 'Start the terminal once to build the MCP adapter.' }
$configDirectory = Join-Path $env:USERPROFILE '.codex'
$configFile = Join-Path $configDirectory 'config.toml'
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
$existing = if (Test-Path -LiteralPath $configFile) { [IO.File]::ReadAllText($configFile) } else { '' }
if ($existing -match '(?m)^\[mcp_servers\.shared_ssh_terminal\]\s*$') {
    Write-Output 'shared_ssh_terminal is already configured. Existing settings were preserved.'
    exit 0
}
if ($nodeExecutable.Contains("'") -or $mcpFile.Contains("'")) { throw 'A path contains a quote. Configure the MCP server manually.' }
$entry = @"

[mcp_servers.shared_ssh_terminal]
command = '$nodeExecutable'
args = ['$mcpFile']
startup_timeout_sec = 20
tool_timeout_sec = 30
"@
if (Test-Path -LiteralPath $configFile) {
    $backup = Join-Path $configDirectory ('config.toml.before-shared-ssh-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak')
    Copy-Item -LiteralPath $configFile -Destination $backup
}
[IO.File]::WriteAllText($configFile, $existing.TrimEnd() + "`n" + $entry + "`n", [Text.UTF8Encoding]::new($false))
Write-Output 'Registered shared_ssh_terminal in Codex MCP configuration. Reload MCP servers or restart Codex to load the new tools.'
