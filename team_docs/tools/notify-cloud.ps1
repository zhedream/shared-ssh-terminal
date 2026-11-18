function Notify-Cloud {
  param(
    [Parameter(Mandatory)][ValidateSet("完成","阻塞","决策","待审","测试")][string]$Type,
    [Parameter(Mandatory)][string]$Message,
    [string]$Path = "",
    [string]$Role = $(if ($env:T3_AGENT_ROLE) { $env:T3_AGENT_ROLE } else { "经理" }),
    [string]$Project = "共端",
    [string]$ThreadId = $env:T3_THREAD_ID
  )
  $url = $env:T3_WEBHOOK_URL; if (-not $url) { $url = [Environment]::GetEnvironmentVariable("T3_WEBHOOK_URL", "User") }
  $key = $env:T3_WEBHOOK_KEY; if (-not $key) { $key = [Environment]::GetEnvironmentVariable("T3_WEBHOOK_KEY", "User") }
  if (-not $url -or -not $key) { throw "缺少 T3_WEBHOOK_URL 或 T3_WEBHOOK_KEY 环境变量" }
  $text = "[$Type][$Project/$Role] $Message" + $(if ($Path) { " → $Path" } else { "" })
  $body = [ordered]@{
    text = $text
    type = $Type; message = $Message; path = $Path
    sender = [ordered]@{ role = $Role; project = $Project; threadId = $ThreadId; host = $env:COMPUTERNAME }
    sentAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Depth 4
  $ok = $false
  for ($i = 1; $i -le 3 -and -not $ok; $i++) {
    try {
      Invoke-RestMethod -Method Post -Uri $url -Headers @{ Authorization = "Bearer $key" } `
        -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 15 | Out-Null
      $ok = $true; "已通知云端：$text"
    } catch {
      if ($i -lt 3) { Start-Sleep -Seconds 2 } else { "通知失败（已重试 3 次）：$($_.Exception.Message)" }
    }
  }
}
