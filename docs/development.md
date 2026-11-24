# 开发、测试与运行

## 环境

Windows SSH 使用 Windows 10 1809+、Node.js 22/24 和系统 OpenSSH。保存密码建议用 OpenSSH 8.6+，并依赖 Windows PowerShell 和 DPAPI。Git 候选的本地终端需支持 ConPTY 的 Windows（当前能力检查要求系统构建号至少 18309），首次启动用系统 Windows PowerShell 编译监督器。前端为原生 JavaScript。

```powershell
npm ci
npm run build
npm test
npm run check:docs
npm run test:e2e
```

`start.cmd` 在首次缺少 CLI 构建产物时先构建，再启动或复用后台服务并打开默认浏览器。源码更新后可先运行 `npm run build`。`stop.cmd` 停止当前运行目录的服务，关闭该实例的 SSH 并清理本地会话 Job。构建文件在 dist，安装依赖在 node_modules，均不提交。

<a name="linux-回环候选"></a>

## Linux 回环

原生验收基线为 `59fafc0`，使用非 root 账户、Linux 6.12 x86_64、OpenSSH 9.6p1 和本机编译的 `node-pty` 1.1.0。两版 Node.js 均通过依赖安装、TypeScript 构建和文档索引检查。

| Node.js | 完整 `npm test` | 真实回环 SSH E2E |
| --- | --- | --- |
| 22.23.4 | 78 项，76 通过，0 失败，2 跳过 | 连续 10/10 通过 |
| 24.22.3 | 78 项，76 通过，0 失败，2 跳过 | 连续 10/10 通过 |

两版均按平台跳过 Windows 局域网双监听和 DPAPI 用例。Linux E2E 从另一个目录通过绝对 CLI 路径验证 `server`、`status`、`pair`、`stop` 和 `mcp`，覆盖手动密码与私钥登录、两路浏览器 WebSocket 同步、PTY 缩放后输入及实例重启。既有 Windows 保存密码配置的编辑被拒，配置和密文保持原样。

上表是既有 SSH 基线的实测。当前 Git 候选的 Linux 原生回归待云端按下节复跑。已更新的 Linux 夹具会核对 HTTP、WS 和 MCP 能力返回 `platform_not_supported`，旧 SSH 仍可连接，并验证保存目录、单次覆盖和缺失目录回退。LAN HTTPS 和原生本地终端首版限 Windows。

日常在本机用 `pair` 输出一次性链接，手动打开浏览器。首次确认主机指纹后，在终端输入密码或使用指定私钥。已有 Windows 保存密码配置仍可在原 Windows 账户使用。在 Linux 的「服务器 → 添加服务器」另建手动登录配置。Linux 仅支持回环，局域网 HTTPS、自动打开默认浏览器和保存密码的本机凭据提供者仍限于现有 Windows 实现。

### 原生复跑

在原生 Linux 准备 Node.js 22 或 24、npm、系统 OpenSSH、Python 3、`make`、C/C++ 编译器及可用的 Node 头文件。测试还使用 `/bin/sh`、`stty`、`/dev/pts` 和 IPv4 回环。从干净源码目录用非 root 账户在 Bash 中运行，分别切换两版 Node.js，复用下列命令。各测试使用自建的临时配置和回环夹具。

```bash
set -e
for name in ${!SHARED_SSH_LAN_@}; do unset "$name"; done
git rev-parse HEAD
uname -srmo
node --version
npm --version
ssh -V
npm ci
node -e 'const assert = require("node:assert/strict"); assert.equal(process.platform, "linux"); assert.equal(typeof require("node-pty").spawn, "function")'
npm run build
npm test
npm run check:docs
for attempt in {1..10}; do
  printf 'Linux E2E %s/10\n' "$attempt"
  node scripts/linux-e2e.mjs
done
```

仅排查配对、服务发现和配置时，可复跑定向测试。

```sh
node --import tsx --test test/local-network.test.ts test/service-runtime.test.ts test/profiles.test.ts test/pairing.test.ts
```

## 本机配置与旧目录

默认 SSH 配置、known_hosts 和 Windows 本地运行配置 `run-configs.json` 位于 `~/.shared-terminal/data/`。实例发现文件、后台日志、askpass 助手和 Windows Job 监督器位于 `~/.shared-terminal/runtime/`。`SHARED_SSH_DATA_DIR` 和 `SHARED_SSH_RUNTIME_DIR` 可分别覆盖，相对路径按调用时的工作目录解析。`SHARED_SSH_PORT` 配置首选端口，默认 43127，占用时使用系统分配的端口。一个运行目录对应一个后台实例，配置也应由同一个实例负责写入。

升级时，旧项目目录的 `data/` 和 `.runtime/` 留在原处。旧版服务退出后，如需直接使用原配置，可在专用 PowerShell 中运行以下命令，并给 MCP 客户端设置同样的环境。如果要沿用原运行位置，再显式设置 `SHARED_SSH_RUNTIME_DIR` 为旧版 `.runtime` 的绝对路径。已有活动 SSH 时，先安排交接或保存并获得用户授权，再用旧版本的停止入口关闭旧服务。

```powershell
$env:SHARED_SSH_DATA_DIR = Join-Path (Get-Location).Path 'data'
& .\start.cmd
```

MCP 客户端可运行 `shared-ssh-terminal mcp`，源码安装也可用 `node` 加 `dist/mcp.js` 的绝对路径。已有 `Register-MCP.ps1` 配置可沿用该入口。首次工具调用会查找或启动同目录的服务。`status` 输出 `running`、`address`、`port`，运行时另有 `pid`。若无法确认实例身份，命令报错并提示核对目录和服务日志。

## 服务实例变化与重连

浏览器与本机服务失联时先等待重新同步。原地址持续不可达时，在共端主机运行 `shared-ssh-terminal status`，使用返回的回环地址或 `lan.origin`。收到 401 后使用现有浏览器配对入口。同一实例中的 SSH 和本地会话继续运行，重新同步可恢复保留画面和状态。确认实例变化后，从「服务器 → 连接 ↗」建立新 SSH，或在回环页面从「本地终端 → 运行配置 → 启动」手动开本地会话。

同一个 MCP 适配进程首次发现已确认的 `instanceId` 变化时，会在主动操作提交前返回 `service_instance_changed`，结果带当前实例 ID 与说明。下一次可用 `list_sessions` 核对会话，或用 `create_session` 明确建立新 SSH。本机服务暂不可达时仍按连接或启动失败报告。后台仅等候服务，轮询可重新注册原任务和从新实例起点读取消息状态，首次主动调用仍会收到切换提示。新实例只保留原本持久化的配置和凭据，旧会话、终端画面、消息、lease、分页游标和输入不随实例迁移。

## 技能安装和卸载

在安装本地包的机器上选择 `codex`、`claude`、`cursor` 或 `all`。源码构建后，在同样的参数前使用 `node <项目绝对路径>/dist/cli.js`。MCP 登记用 Node 和安装位置的绝对路径，换工作目录也可启动。旧版 `Register-MCP.ps1` 创建的同名条目由用户保管。如需迁移，请先备份并核对旧条目，再手动解除旧登记。

```text
shared-ssh-terminal install-skill --agent all
shared-ssh-terminal skill
shared-ssh-terminal uninstall-skill --agent all
```

| 客户端 | 用户级技能 | 默认 MCP 配置 |
| --- | --- | --- |
| Codex | `~/.agents/skills/shared-ssh-terminal/SKILL.md` | `~/.codex/config.toml` 的 `mcp_servers.shared_ssh_terminal`，支持 `CODEX_HOME` |
| Claude Code | `~/.claude/skills/shared-ssh-terminal/SKILL.md` | `~/.claude.json` 顶层 `mcpServers.shared_ssh_terminal`，使用用户级 stdio |
| Cursor | `~/.agents/skills/shared-ssh-terminal/SKILL.md` | `~/.cursor/mcp.json` 的 `mcpServers.shared_ssh_terminal` |

Codex 和 Cursor 共用两者都可发现的薄技能。各客户端分别登记 MCP，最后一个使用者卸载时移除薄技能。安装前校验所有选中的配置，修改现有配置前在同目录保存 `.before-shared-ssh-*.bak`。安装结果列出备份路径。安装器保留无关配置、手改内容和同名的外部登记。遇到冲突请核对错误指出的目标文件，必要时用备份恢复。手动把本工具的 Codex 登记转换成其他 TOML 布局后，请按提示核对原区块。

操作模拟验收时，把 `SHARED_SSH_INSTALL_HOME` 设为专用临时目录的绝对路径。此覆盖将所有客户端目标移入模拟目录，优先于客户端配置目录覆盖。用独立的 `SHARED_SSH_DATA_DIR` 和 `SHARED_SSH_RUNTIME_DIR` 启动包内 MCP 验证，再停止隔离实例。

客户端格式依据为当前用户级技能及 stdio MCP 文档。[Codex 技能](https://developers.openai.com/codex/skills) · [Codex MCP](https://developers.openai.com/codex/mcp) · [Claude Code 技能](https://code.claude.com/docs/en/skills) · [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Cursor 技能](https://cursor.com/docs/skills) · [Cursor MCP](https://cursor.com/docs/mcp)

## 局域网 HTTPS

默认只在 IPv4 回环提供本机入口。Windows 可在同一个后台实例上增加局域网浏览器入口，由启动者在环境中同时设置以下五项。证书和私钥的相对路径按启动调用时的工作目录解析。

| 环境变量 | 值 |
| --- | --- |
| `SHARED_SSH_LAN_BIND` | 此机器上具体的私有或链路本地 IPv4 地址，支持 RFC 1918 和 `169.254.0.0/16` |
| `SHARED_SSH_LAN_PORT` | 首选 HTTPS 端口，取值 1 至 65535，占用时使用系统分配的端口 |
| `SHARED_SSH_LAN_HOST` | 浏览器实际访问的局域网 IPv4 地址或 DNS 名，不含协议、端口或路径。使用 DNS 时请确保客户端解析到监听机器 |
| `SHARED_SSH_LAN_CERT` | PEM 证书或证书链。首张证书须有效，SAN 须包含浏览器使用的 IP 或 DNS 名 |
| `SHARED_SSH_LAN_KEY` | 与首张证书匹配的未加密 PEM 私钥文件，存放在仅授权账户可读的位置 |

已有服务会继续使用启动时的配置。变更监听或证书前，先安排活动会话的保存或交接，再停止并启动目标实例。`status` 报告回环地址和可选的 `lan.address`、`lan.port`、`lan.origin`。`pair --lan` 只为该 HTTPS Origin 签发五分钟有效的一次性配对链接。命令 `pair`、`server --open` 和 `start.cmd` 继续打开或签发回环入口。

局域网浏览器须信任证书并按 `lan.origin` 访问。配对后，Cookie 绑定浏览器主机名和实例，重启后仍可使用有效 Cookie。如果端口发生回退，使用 `status` 公布的新端口访问。只把配对链接交给有权查看及操作这些 SSH 会话的人。管理签发、停止及 MCP 走独立的回环入口。

LAN 配对授权在同一实例查看和操作 SSH。回环上的 Windows 本地会话和运行配置不会进入 LAN 列表、快照或广播。权限由实际监听器、套接字地址和配对决定，代理头不改变访问范围。[服务端门控](architecture.md#配对与监听权限)

## Windows 旧入口隔离验收

在项目根目录打开一个专用 PowerShell，先构建，再设置三个覆盖。`start.cmd` 打开 `127.0.0.1` 的实际端口。脚本自动化验证可在两次启动前加 `$env:SHARED_SSH_NO_BROWSER = '1'`。

```powershell
npm run build
$fixturePrefix = Join-Path ([IO.Path]::GetTempPath()) 'sst-legacy-'
$fixtureRoot = $fixturePrefix + [guid]::NewGuid().ToString('N')
$null = New-Item -ItemType Directory -Path $fixtureRoot
$env:SHARED_SSH_DATA_DIR = Join-Path $fixtureRoot 'data'
$env:SHARED_SSH_RUNTIME_DIR = Join-Path $fixtureRoot 'runtime'
$env:SHARED_SSH_PORT = '43219'

& .\start.cmd
$first = node dist/cli.js status | ConvertFrom-Json
& .\start.cmd
$second = node dist/cli.js status | ConvertFrom-Json
if (-not $first.running -or -not $second.running -or $first.pid -ne $second.pid -or $first.port -ne $second.port) {
    throw 'Startup did not reuse the isolated instance.'
}
```

首个本机主机名配对后，如需用 `localhost` 打开同一实例，签发另一个一次性码。在隔离浏览器中打开以下 `$localhostPage`，将 `$localhostCode` 粘贴到「配对码」并点击「配对」。

```powershell
$launchText = node dist/cli.js pair
$launch = [Uri]$launchText
$localhostPage = 'http://localhost:' + $launch.Port + '/'
$localhostCode = $launch.Fragment.Substring('#pair='.Length)
```

保持上述环境，在验收结束后调用 `stop.cmd`。这会关闭本轮创建的所有测试 SSH。确认实例停止再移除仅用于本轮的临时目录，随后关闭这个 PowerShell。

```powershell
& .\stop.cmd
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the isolated instance.' }
$after = node dist/cli.js status | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $after.running) { throw 'The isolated instance is still active.' }
$resolvedFixture = (Resolve-Path -LiteralPath $fixtureRoot).Path
if ($resolvedFixture.StartsWith($fixturePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
```

## 验证分层

| 命令 | 覆盖 |
| --- | --- |
| npm run build | TypeScript 类型和输出 |
| npm test | 端口、发现、配对、会话与按钮、权限、并发、重连。候选含 Windows ConPTY Job 和 LAN 本地功能隔离，用临时证书及具体私有 IPv4 接口 |
| npm run test:e2e | Windows 本机 OpenSSH/SSH2/ConPTY、密码/密钥/保存密码、真实 Vim、跨页面、多个 MCP 进程、独立消息与标准通知、同实例浏览器重连和服务重启后显式新建 SSH |
| node scripts/linux-e2e.mjs | 原生 Linux 的回环 CLI、配对、Unix PTY、手动密码/测试私钥、两路 WS/MCP、缩放后输入、进程退出及重启。候选追加平台能力和 SSH 启动目录断言 |
| node scripts/shell-smoke.mjs | 本机 Bash 原始输入；设置 SST_TEST_ZSH 可加测 Zsh |
| npm run check:docs | 所有文档索引和相对引用 |
| npm run check:publish | Git 暂存版本中的私密目录、主机、本机路径和常见凭据 |

端到端测试使用系统临时目录和动态本机 SSH 端口。Windows E2E 还覆盖首选服务端口被占用时的回退，并使用 Git for Windows 的 Bash／Vim。ConPTY 测试清理时偶尔会出现 node-pty 的 AttachConsole 错误输出，需结合断言与退出码判断。

### Windows 本地终端回归

在独立的候选源码副本运行。准备 Node.js、系统 Windows PowerShell、OpenSSH 和 Git for Windows，双监听测试还使用 OpenSSL 和实际私有 IPv4 接口。浏览器联调使用独立 profile 及临时 data/runtime，可复用[旧入口隔离验收](#windows-旧入口隔离验收)的目录设置。构建完成后保持该副本的 `dist/` 与 `public/` 一致，另一轮构建使用单独目录。

```powershell
git rev-parse HEAD
node --version
npm ci
npm run build
node --import tsx --test test/local-terminal.test.ts test/run-configs.test.ts test/sessions.test.ts test/profiles.test.ts test/lan-network.test.ts test/local-network.test.ts
npm test
npm run check:docs
npm run test:e2e
```

定向用例核对 ConPTY 的工作目录、Job 清理、旧代事件、配置写入和双监听授权。旧 Windows SSH E2E 使用回环 SSH 夹具，按名称核对既有和新增 MCP 工具。Linux 候选使用[原生复跑](#原生复跑)，并按 [SSH 目录兼容范围](local-terminal.md#推荐方案)判断失败。

## 修改入口

增加工具需同时更新 MCP schema、broker schema、服务端权限验证、工具文档和集成测试。不要依靠 MCP 提示文字代替服务端检查。增加 UI 状态需处理刷新、首次快照、多个页面和离线恢复。

消息仅存在内存。通知后的确认是独立动作，不能在发出通知时自动标记已读；客户端忽略通知时必须仍能显式读出和在工具结果中获得待收消息。

## 升级与已知限制

重启服务会断开该实例的 SSH、停止本地终端 Job，并清除会话、画面和消息。SSH 配置、密码密文和命名运行配置仍留本机。有活动会话时先告知用户并取得授权。增加 MCP 工具后，客户端可能需要重新加载 MCP 或重启应用才能刷新工具目录。

当前网页资产从磁盘读取，uiVersion 在服务启动时计算。开发时修改 public 但暂不重启，可能让旧服务临时返回新页面；上线应在测试后及时加载同一版本，并在旧客户端不能自动同步时刷新页面。未来可以改为资产快照或版本目录，此项尚未实现。

项目采用 [MIT 许可证](../LICENSE)。Git 候选功能与已发布 npm 版本的范围见[本地终端状态](local-terminal.md)。
