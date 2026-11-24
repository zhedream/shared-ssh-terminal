# 架构与数据流

## 组件

```text
Agent 应用 A ── stdio MCP ── 适配进程 A ─┐
Agent 应用 B ── stdio MCP ── 适配进程 B ─┼── HTTP ── 本机单例服务 ─┬── 本机 PTY + OpenSSH ── 远端 PTY
                                        │                         └── Windows ConPTY + Job ── 本地 PowerShell
本机浏览器 ─────── HTTP + WebSocket ────┤
局域网浏览器 ───── HTTPS + WSS ─────────┘     可选独立浏览器监听
```

每个运行目录对应一个后台实例，实例持有 SSH、本地终端和会话状态。默认优先绑定 `127.0.0.1:43127`，占用时申请系统分配的 IPv4 回环端口。各 MCP 客户端启动自己的 stdio 适配进程，与 CLI 共用本机服务发现和就绪检查。路径默认从用户目录计算，可通过环境覆盖。[本机配置与旧目录](development.md#本机配置与旧目录)

服务持有按实际运行目录区分的操作系统锁，进程退出时自动释放。Windows 使用命名管道，Linux 使用抽象 Unix 套接字。所有配置的监听就绪后，以同目录临时文件和原子重命名发布 `ui.json` 和 `connection.json`。后者的 `url`、`address`、`port` 指向回环，另含 `agentToken`、`pid`、`instanceId` 和可选的 `lan` 对象。`lan` 发布 HTTPS 绑定地址 `address`、实际 `port`、浏览器入口 `origin`。回环 `/agent/instance` 的认证探测核对服务类型、运行目录标识、PID、两路监听信息和实例 ID。旧版发现记录和探测同时缺少 `instanceId` 时可继续连接，实例代次未知。一侧缺失或 ID 不一致时拒绝该发现记录。

浏览器负责显示及人工输入，MCP 负责结构化工具调用。两种入口最终访问同一 Session；消息是独立的本机服务数据，不经过远端。

## 内容、同步与生命周期

每个 Session 有唯一 id、会话类型、创建来源、关联 Agent、私密状态、输入锁、人工交接状态、终端尺寸、状态修订和 historyEpoch。本地和 SSH 的 PTY 输出先进入同一个会话的 canonical headless xterm，再广播给页面。Agent 的屏幕快照排在同一渲染队列。每个会话最多保留 2000 行滚动历史。

新页面先完成鉴权，在 WS `hello` 收到与认证探测一致的 `instanceId`，接收会话快照和消息历史，再补发快照期间缓存的状态事件。此 ID 每个服务进程生成一次，是非秘密 UUID。同一浏览器页面在成功收到 `synced` 后才记录并比较实例 ID 和会话清单。revision 和 sequence 用于区别控制状态与终端输出。调整尺寸时，服务先更新 canonical xterm，广播新尺寸和新 revision，再回复该请求的成功回执。输入串行确认，冲突、断线或超时后不会自动重试，避免重复执行。

MCP 读取不再复用浏览器完整恢复快照。TerminalReader 为每个任务保留最近观察画面的行哈希，最多 64 个任务基线，超出后淘汰最旧基线并在下次重新给出受限快照；不保留旧正文。普通屏幕行标记辅助追踪滚动淘汰，备用屏幕按位置比较；无法可靠延续、清空或切屏时明确重同步。

分页游标由当前 Session 的随机密钥签名，绑定读取者、读取类型和当前 canonical 内容指纹；不缓存分页正文。内容变化或清空后拒绝旧游标。用户历史面板同样按需请求，页面内容替换显示而非累加日志；普通历史更新、清空、尺寸变化或关闭面板时清除过期页面。

输入锁的 lease 只给真实持有者，不在公开摘要中返回。用户输入带页面身份和最新 revision，Agent 输入带任务身份和有效 lease；会话、关联、私密和锁都在服务端校验。

普通用户锁可由已关联 Agent 接管。人工交接将锁置空并保留 `handoff`，随会话摘要和 WebSocket 状态同步。交接中取锁返回 HTTP 409 和 `handed_to_user`，MCP 保留同一错误码。交回请求的最新文字绑定当前关联，换绑和解除关联清除文字并保留交接。页面发送 `return-to-agent` 时校验关联、页面持有者及 revision。页面主动交回、持锁页面释放或终端进程退出会清除交接。

清空直接操作终端缓冲区。epoch 使并发读取不能返回被清空前的旧快照。SSH 关闭或本地停止后保留只读画面，移除页签删除内存对象并广播给有权查看的页面。浏览器断线期间后台实例继续维护会话。服务换实例后，旧会话、终端历史、输入权和消息均丢失。运行配置和 SSH 配置由新实例读取，可手动启动新会话。

## 本地终端进程

Windows ConPTY 启动本机 PowerShell。专用监督器挂起创建子进程，将它加入带 `KILL_ON_JOB_CLOSE` 的 Windows Job，再恢复执行。它通过专用控制管道监听 broker，管道断开时清理该 Job。停止先向目标 PTY 发 Ctrl+C，8 秒后由监督器终止仍存活的 Job 成员。回环页面也可立即请求强制停止。Job 按句柄操作，根先退出后仍跟踪余下成员。由外部系统代理另行启动的进程、预先存在的进程和服务不在这个 Job 的控制范围。

同一运行配置的并发启动复用活跃会话，空 shell 和一次性命令仅在显式 `startKey` 且发起方相同时去重。运行配置持久化到实例 data 的 `run-configs.json`，保存名称、目录、命令及备注。监督器编译产物位于实例 runtime。会话重启保留 ID，递增 `generation`，清空画面并使旧 lease、旧游标和旧代 PTY 事件失效。服务重启后由用户或获准 Agent 手动启动配置。[生命周期与协议](local-terminal.md#控制权与生命周期)

## 配对与监听权限

本机管理和 MCP 使用独立 bearer token。管理签发、停止、MCP 与实例探测仅在回环 HTTP 上处理。浏览器通过一次性配对码获取 HttpOnly、SameSite=Strict、host-only Cookie。Cookie 签名密钥留在运行目录，有效会话可在同一运行目录重启后复用。WebSocket 在升级时校验 Cookie，随后直接同步。CLI 状态与后台日志只显示公开运行信息。

回环监听按实际端口接受 `127.0.0.1` 和 `localhost`。局域网监听需要显式配置，采用 HTTPS／WSS，只接受配置的浏览器 Host 和实际端口。两路均要求浏览器写请求和 WebSocket Origin 同源。局域网 Cookie 带 Secure，配对码绑定签发时的完整 HTTPS Origin。两路共用一份 SSH 会话、SSH 配置、SSH 消息及输入权状态。

服务端以实际监听器和套接字两端的 IPv4 回环地址判定本地访问，代理转发头不能授予权限。配对认证继续独立校验。HTTP 能力和 WS `hello` 报告 `localTerminal`。LAN 的状态、会话查询、初始快照、同步排队及实时广播均排除本地会话与运行配置。LAN 的读屏、输入、取锁按未知会话处理，重复移除已关闭或不可见的页签保持空操作。MCP 只接受本机回环认证，仍逐请求校验任务身份、关联、私密、人工交接和 lease。

MCP 适配进程为每个项目或聊天 `register_agent`，产生独立任务 ID 和 secret。服务端按任务身份和 secret 认证。适配进程以主动调用认证发现的 ID 为比较依据。已确认的 ID 变化时，首次主动调用及等待同次发现的并发调用在发送业务操作前返回 `service_instance_changed` 和当前 `instanceId`。后台消息轮询独立切换注册和消息游标，保留主动调用的提示。下一次主动调用可在新实例正常执行。已经发出的操作最多发送一次，旧 SSH 连接随原进程结束。[服务实例变化与重连](development.md#服务实例变化与重连)

## SSH 配置与密码

profiles 独立维护，SSH config 导入只复制允许字段，不执行 Match exec 或 ProxyCommand。Windows 使用 ConPTY、`ssh.exe` 和 `-F NUL`。Linux 回环使用 Unix PTY，从 `PATH` 的绝对目录选择可执行的 `ssh`，并传入 `-F /dev/null`。两平台用显式参数传递连接信息并由用户确认首次主机指纹。Linux 在实例 data 目录打开 `./known_hosts`，全局已知主机文件指向 `/dev/null`。[Linux 原生验收范围](development.md#linux-回环)

可选的 `startupDir` 由会话实参覆盖保存值，按字面引用为 OpenSSH 的单个远端命令参数。支持 POSIX 兼容远端 shell，通过 `cd` 后进入账号的交互登录 shell。目录不可用时先提示，保留初始登录目录。两处都省略时延续普通 SSH 登录。[目录支持范围](local-terminal.md#推荐方案)

手动密码和密钥口令沿用 OpenSSH 的交互。已保存的密码通过 Windows DPAPI CurrentUser 加密；服务只在认证时解密，经随机能力令牌保护的本机命名管道交给 askpass 小组件。密码不进入环境变量、进程参数、原始 PTY 输入或工具返回。

askpass 仅对本次端点的标准密码提示自动提供一次保存值；主机确认和进一步提问仍交给用户，回答不回显。保存密码模式只请求标准 password 认证，不自动填写验证码。端点信息变化时必须重新保存密码，避免把凭据发给另一台服务器。

认证后的 WS `hello.capabilities.savePassword` 为 Windows `true`、Linux `false`。Linux 在服务端拒绝提交保存密码及密码字段，登录由 OpenSSH 在 PTY 中提示。Linux 对已有 Windows 密文的连接或编辑返回操作提示，保留现有配置和密文。Windows 编辑既有配置时省略两个凭据字段，仍保留同一端点的已保存密码。

## 消息与通知

Messages 模块只存有界内存数据，每会话最多 100 条。发送固定目标 Agent，读取需同时满足目标身份匹配、仍有关联且私密关闭。消息正文由身份校验后的工具读取；MCP 标准日志通知只携带消息存在提示与路由 ID。

每个已注册上下文使用认证的 HTTP 长轮询等待消息变化，stdio 适配端转成 `notifications/message`。通知不需要新端口。工具结果中的独立附加文本作为未确认消息的兜底，不改变既有工具的主结果结构。

## 部署边界

配对浏览器具备操作共享会话的权限，适合获准共同操作 SSH 的成员。Windows 的额外 HTTPS 监听面向可信局域网。Linux 只绑定回环，设置 `SHARED_SSH_LAN_*` 时会拒绝启动并提示如何启动回环实例。[私密资料与公开发布](security.md)
