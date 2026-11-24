# 共端：用户与 Agent 的共享终端

共享 SSH 会话或 Windows 本地 PowerShell。浏览器供用户操作，MCP 供 Agent 操作，双方读取同一份终端画面和最多 2000 行滚动历史，并按输入权规则交接。

本文的本地终端和 SSH 启动目录说明适用于当前 Git 功能候选。已发布的 npm `shared-ssh-terminal@0.7.0` 提供 SSH 共享。项目采用 MIT 许可证。[功能范围与验收](docs/local-terminal.md) · [文档索引](docs/README.md) · [开发章程](AGENTS.md) · [MIT 许可证](LICENSE)

## 操作规则

- 新会话默认关闭私密。用户创建的会话由创建页面持有输入权；Agent 创建的会话输入锁初始空闲。
- 当前持有者可以输入。普通用户持锁时，已关联 Agent 可调用 `take_control` 取锁。用户可点击「接管输入权」，输入权转移会使旧 lease 失效。
- 用户点击「释放输入权」，Agent 调用 `release_control`。空闲时，用户打字或已关联 Agent 请求取锁均可获得输入权。
- 释放输入权须主动操作。命令输出结束、显示提示符、退格清空输入和暂时没有输出都保持当前锁。
- 释放和接管只改变输入权，不会结束 `top`、Vim 等程序，也不会清空未发送文字。
- 先观察实际画面，再发送命令或按键。运行中的程序继续接收原会话的按键。系统可报告本地终端进程退出码，交互 Shell 内单条命令的完成状态由用户或 Agent 通过画面判断。
- 共享会话的交互输入通过原 PTY 原样发送。共端不安装命令完成检测或 Shell 回调。

## 三个独立概念

| 概念 | 含义 |
| --- | --- |
| 画面与历史 | 一份共享缓冲区，无隐藏原始输出日志。各页面可以有不同滚动位置，但可访问的内容范围相同 |
| 私密 | Agent 无权观察、关联或输入；用户仍可操作。切换不清屏、不改变输入权、不停止程序 |
| 关联 Agent | 指定哪个 Agent 聊天／任务可以访问该会话；与当前输入权分开。一个 Agent 可关联多个会话，一个会话最多关联一个 Agent |

关闭私密后，当前保留的画面与历史会向已关联 Agent 开放，包括私密期间显示的内容。敏感内容需要先“清空全部历史”，再关闭私密。密码是否显示取决于远端程序的回显设置；MCP 不提供用户原始按键日志。

## 使用

Windows 10 1809+、Node.js 22/24、系统 OpenSSH。首次部署执行 `npm ci`。

1. 双击 `start.cmd` 启动或复用本地服务，并通过一次性链接打开浏览器配对。默认地址为 `http://127.0.0.1:43127/`，端口被占用时会打开实际分配的地址。
2. 添加服务器 Host、端口、用户及密码／私钥路径／系统 SSH Agent 认证方式。
3. 可从 `%USERPROFILE%\.ssh\config` 快速导入 Host，导入后独立维护。不会修改原配置；连接使用 `-F NUL`，不会隐式叠加其他配置。
4. 密钥可直接自动登录。密码认证可勾选“保存密码并自动登录”；不勾选时在终端手动输入。私钥口令和 `su - root` 密码仍由用户输入。
5. 用户会话复制 sessionId 给指定 Agent 认领。会话公开且处于普通状态时，已关联 Agent 可取锁操作。

配置和运行状态默认放在 `~/.shared-terminal/`。升级时可用环境变量接续旧配置目录，具体步骤见[本机配置与旧目录](docs/development.md#本机配置与旧目录)。

从本地包安装后使用 `shared-ssh-terminal server` 启动或复用服务，`shared-ssh-terminal status` 查看实际地址与端口，`shared-ssh-terminal mcp` 供 MCP 客户端启动 stdio 适配端。在源码目录构建后，可用 `node dist/cli.js` 加同样的子命令。`stop` 会停止当前运行目录的服务，结束该实例的 SSH 和本地终端会话。

Linux 本机回环已在非 root 的原生 Linux x86_64 上通过 Node.js 22 和 24 验收。使用 Node CLI 和系统 OpenSSH，运行 `pair` 生成配对链接并手动打开。登录可在终端输入密码或选择本机私钥。已有 Windows 保存密码的配置可保留，另建 Linux 登录配置。[Linux 环境、验收结果与复跑命令](docs/development.md#linux-回环)

本机浏览器可用 `shared-ssh-terminal pair` 重新获取五分钟有效的一次性链接。Windows 主机可配置 HTTPS 监听和证书，再运行 `shared-ssh-terminal pair --lan`。已配对的回环和 LAN 浏览器共享同一实例的 SSH 会话。Windows 本地终端与运行配置仅向已配对的回环浏览器及本机 MCP 开放。[局域网 HTTPS 配置](docs/development.md#局域网-https)

### 打开和停止 Windows 本地终端

- 「本地终端 → 打开 PowerShell → 启动」可直接打开本机 shell。「启动目录」留空使用服务用户的主目录，填写时使用存在的绝对路径。
- 「本地终端 → 运行一次性命令 → 启动」填写启动目录和命令。演示时可用 `Write-Output '共端测试'`，目录填本机已有的测试目录。
- 「本地终端 → 运行配置 → 添加运行配置」填写名称、启动目录和命令，点击「保存配置」，再从该配置行点击「启动」。正在使用同一配置时会打开已有会话。
- 选中本地终端页签后，工具栏提供「停止」「强制停止」「重启」和「删除会话」。「停止」先发送 Ctrl+C，等待 8 秒后清理仍在该会话 Job 中的进程。停止保留画面。重启保留页签并清空旧画面，删除会话同时丢弃画面。

### 设置 SSH 启动目录

在「服务器 → 添加服务器／编辑服务器 → 启动目录」保存远端目录。单次覆盖从该服务器的「连接选项 → 本次启动目录 → 连接 ↗」进入。远端目录不存在时，画面提示并继续使用登录目录。该功能依赖远端 POSIX 兼容登录 shell，支持字面空格与引号。[SSH 目录规则](docs/local-terminal.md#推荐方案)

两个输入按钮始终同时展示：

| 状态 | 接管输入权 | 释放输入权 |
| --- | --- | --- |
| 当前页面持锁 | 禁用 | 可点 |
| 锁空闲 | 可点 | 禁用 |
| 其他页面／Agent 持锁 | 可点 | 禁用 |
| 会话已关闭、界面离线、请求处理中 | 禁用 | 禁用 |

「解除关联」撤销 Agent 访问，并将输入权交给当前用户页面。另一 Agent 只能在原 Agent 放弃锁或用户接管后认领。已有的人工交接状态会保留，旧 Agent 的交回请求会清除。

### 人工交接

Agent 持锁时可以用 `handoff_to_user` 把运行中的终端交给用户。页面显示「已交给用户」。用户可以继续打字、处理登录或确认提示，结束后点击「交回 Agent」，或由当前持锁页面点击「释放输入权」。打字、刷新、断线和超时都会保留人工交接状态。私密时先由用户明确关闭私密，Agent 才能恢复读取与输入。

人工交接期间，Agent 取锁会收到 `handed_to_user`。当前关联 Agent 可用 `list_sessions` 查看交接状态，在授权范围内读屏，再用 `request_control_return` 留下至多 2000 字符的交回说明。页面显示最新一条，用户显式交回后 Agent 才能重新取锁。

## 所见即所得、关闭与恢复

- 关闭网页、刷新或网页暂时断线时，会话由本地服务继续维护。重新打开可恢复同一实例内保留的画面和历史。
- 关闭 SSH 后，保留页签的历史对用户和已关联 Agent 都只读。用户提供 sessionId 后，也允许只读认领已关闭且未移除的会话。
- 开启私密后，关闭会话的历史也禁止 Agent 读取。
- “清空全部历史”同步清空当前屏幕、滚动历史和备用屏幕，用户与 MCP 均不能再读取已清内容；不发送 Shell 清屏命令，不改变锁或私密状态。
- 清空不能撤回已进入 Agent 聊天上下文的内容，也不能阻止远端将同一内容重新输出。
- 已关闭页签点击 × 后，所有页面同步移除，服务不再提供该会话的历史；移除活动连接必须先关闭。
- 双击 `stop.cmd` 停止当前运行目录的本地服务。更换服务实例后，旧 SSH、本地会话和输出均无法恢复。可从「服务器 → 连接 ↗」建立新 SSH，或从「本地终端 → 运行配置 → 启动」手动启动已保存的配置。
- 页面会检测界面版本，在无待发送输入和编辑弹窗时刷新，保留选中页签。仅刷新网页不会结束 SSH。

## 保存密码与自动登录

密码认证下可勾选“保存密码并自动登录”。密码通过 Windows DPAPI CurrentUser 加密保存在本机配置中，不保存明文或独立解密密钥；复制配置到其他 Windows 账户后需要重新填写。此功能不保存私钥口令、二次验证码或 `su` 密码。

编辑配置时，密码框不会回填原密码：留空保留、填写新密码替换、取消勾选或切换认证方式删除已保存的密码。更改主机、端口或登录用户时必须重新填写，避免把旧密码发送给另一个端点。

自动登录通过系统 OpenSSH 的 askpass 认证通道提供密码，不通过终端按键输入或解析远端输出；不会把密码变成 Shell 命令、滚动历史或 MCP 返回值。首次连接仍须在终端确认主机指纹；指纹改变时仍由 OpenSSH 拒绝连接。保存的密码被拒绝后，终端显示提示并等待用户手动输入，输入不回显。

首次使用由 Windows PowerShell 将 askpass 助手编译到实例运行目录。需要支持 `SSH_ASKPASS_REQUIRE=force` 的 Windows OpenSSH（建议 8.6+）。自动保存仅支持标准 SSH 密码认证。仅接受 keyboard-interactive 或多因素认证的服务器应使用终端手动输入。

## MCP

本地安装后运行 `shared-ssh-terminal install-skill --agent codex|claude|cursor|all`，为所选客户端安装使用说明入口并登记 MCP。`shared-ssh-terminal skill` 打印与已安装版本一致的操作说明。用 `uninstall-skill --agent …` 撤销本工具管理的登记。已有配置变更前会先备份。[技能安装和卸载](docs/development.md#技能安装和卸载)

每个应用启动独立 stdio 适配进程，首次工具调用按同一运行目录查找服务，必要时启动后台实例。既有 `Register-MCP.ps1` 生成的 Codex 登记仍可使用。

同一适配进程发现服务实例已更换后，首次主动调用在提交前返回 `service_instance_changed` 和当前 `instanceId`。用 `list_sessions` 核对当前会话。需要继续共享时，可用 `create_session` 明确建立新 SSH，或在支持本地终端的实例手动启动本地会话。短暂断线时会话结局仍需确认。适配进程保留自己的任务身份，已经发出的输入不会自动重试。

同一应用的不同项目或聊天先 `register_agent`，保存 id，后续每次调用传 `agentId`。默认 `list_sessions` 只列出自己的会话；`scope=all` 只列元数据，不授予访问权限。用户会话必须获得用户提供的 sessionId 才能认领。

用户明确要求共享或正在继续已获准的共享任务时，才使用共端。需要新开本地终端时先调用 `get_capabilities` 并确认 `localTerminal` 为 `true`。命名配置复用只返回会话标识和复用状态，后续读屏与输入仍需现有授权。[按需共享和操作路径](skill/usage.md)

| 工具 | 功能 |
| --- | --- |
| `whoami` | 查看身份 |
| `register_agent` | 注册当前项目／聊天任务身份 |
| `list_profiles` | 列出服务器配置，不包含密码或私钥内容 |
| `list_sessions` | 列出会话元数据 |
| `create_session` | 新建当前任务的独立 SSH 会话，可用 `startupDir` 覆盖本次目录 |
| `get_capabilities` | 查询当前实例是否支持本地终端与保存 SSH 密码 |
| `list_run_configs` | 列出本机运行配置 |
| `open_local_shell` / `start_run` | 打开 PowerShell，或运行一次性命令／命名配置 |
| `stop_session` / `restart_session` | 关联任务凭当前 lease 请求优雅停止或重启本地终端 |
| `attach_session` | 认领用户明确指定的会话 |
| `take_control` | 获取空闲或普通用户的输入锁，返回新 lease |
| `send_input` | 持有效 lease 原样发送命令、文字或控制键 |
| `release_control` | 主动释放输入锁，原程序继续运行 |
| `handoff_to_user` | 持有效 lease 发起人工交接，用户显式交回前暂停 Agent 取锁 |
| `request_control_return` | 在人工交接期间请求用户交回，更新页面上的说明 |
| `read_screen` | 显式获取受限的当前屏幕快照与光标 |
| `read_output` | 按任务独立读取当前画面的变化，默认最新优先 |
| `read_history` | 显式读取普通历史，从最近内容向前分页 |
| `read_messages` | 从最新消息向前分页，可只读待收或等待 |
| `acknowledge_messages` | 确认已收到消息，不代表任务完成 |

0.6 起不再通过 `read_output` 返回整个保留缓冲区。首次只给当前受限画面，此后返回 `mode=terminal_delta` 的变化行；没有变化时 `lines=[]`。默认最多 4000 文本字符、40 行片段，支持 `maxChars`、`maxLines` 和 `nextCursor` 显式分页，不自动补读积压历史。进入 Vim/top 等备用屏幕时默认观察当前程序画面，旧 Shell 历史须显式调用 `read_history`，从最近处向前获取。用户也可点击“查看历史”，不退出当前程序。详见 [终端读取与预算](docs/terminal-reading.md)。

返回结构为带行位置和片段偏移的 `lines`，不再包含旧版 `chunks` 或整份 `text`。`after` 仅影响等待更新，不能请求无界历史。等待超时不代表程序结束，也不会释放锁或重发输入。客户端升级后需刷新 MCP 工具目录；上下文丢失时主动 `resync=true` 或读取当前屏幕。

普通操作：`read_screen` → `take_control` → `send_input` → 观察／继续交互 → `release_control`。没有自动完成检测、`enable_integration`、`execute_command` 或 `command_status` 接口。

## 向关联 Agent 发消息

点击“发消息给 Agent”，在独立面板发送普通文本或 `@agent 请解释刚才的错误`。消息不进入 SSH，不需要接管输入权，也不会打断 Vim 或密码提示。接收者固定为发送时关联的任务；关联变化须重新确认后发送。

MCP 标准通知只提示有新消息，正文通过任务身份读取；是否唤醒 Agent 取决于客户端，不能指定 Codex 的 Queue/Steer 模式。客户端忽略通知时，未确认消息会附在后续工具结果中，也能调用 `read_messages` 主动读取。用户可看到“待确认收到／Agent 已确认收到”；已确认消息仍保留，清空后不可再次读取。详见 [消息协议与兼容性](docs/messaging.md)。

消息每会话最多 100 条、每条最多 2000 字符，只保留在本机服务内存。普通工具仅自动附带最近最多两条、合计 2000 文本字符的待收消息；专用读取默认最多 5 条、4000 字符，用 nextCursor 作为 before 继续取更早消息。私密时禁止 Agent 接收消息。清空消息只影响消息；“清空全部历史”同时清空终端和消息。重启服务清除所有会话与消息。

读取不等于消费：未确认的消息会在后续普通共享终端 MCP 工具调用中重复附带，直到 Agent 显式确认收到。确认后停止自动附带，面板和专用历史工具仍可查看，无需清空历史来避免上下文冗余。只读取待收消息时使用 `read_messages(unreadOnly=true)`。Codex 实测目前应按留言通道使用，不能依赖自动唤醒；详见 [待收与确认规则](docs/messaging.md#待收确认与重复投递)。

## 验证与维护

- `node node_modules/typescript/bin/tsc`：构建。
- `node --import tsx --test test/*.test.ts`：权限、唯一锁、显式释放、无注入、私密、保留历史、清空、输入按钮状态和配置导入。
- `node scripts/e2e.mjs` 运行隔离的 Windows OpenSSH/SSH2/ConPTY/MCP 测试。覆盖密码和密钥登录、真实 Vim 增删改查保存、多页面逐字一致、网页全部离线、多个 Agent 的运行中交接，以及关闭／移除同步。
- Windows 原生本地终端、运行配置与回环/LAN 的权限分隔由定向夹具验证。[Windows 候选复跑命令](docs/development.md#windows-本地终端回归)
- `node scripts/linux-e2e.mjs` 在原生 Linux 运行回环验收，覆盖 Unix PTY、密码和私钥、终端缩放后输入及实例重启。[Linux 复跑命令](docs/development.md#原生复跑)
- `node scripts/shell-smoke.mjs`：本机原始终端测试。设置 `SST_TEST_ZSH` 可同时验证本地 Zsh；不安装任何 Shell 回调。

从旧版升级需要重新连接 SSH。旧 Shell 内曾安装的回调会随该 Shell 退出而消失；新版不再安装。已经写入服务器的旧命令历史不会自动删除。

## 提交与公开前检查

只提交源码、通用脚本、测试和文档。`data/`、`.runtime/`、密码密文、私钥、令牌、真实服务器信息、截图和个人配置不提交，即使仓库暂时为私有也是如此。提交前检查暂存内容并运行 `npm run check:publish`、`npm run check:docs`，详见 [安全与公开发布](docs/security.md)。
