# v0.7 路线图

本文件记录 v0.7 的规划及完成状态。标为计划的章节包含待交付项目。已实现的规则见 [产品理念](product.md)、[架构](architecture.md) 和 [开发章程](../AGENTS.md)。

## 1 打包与分发（本地打包已实现，发布待批准）

- 发布 npm 包，使用方式为 `npx <包名> <子命令>`。
- 本地包的 `bin` 和文件白名单已包含 CLI、浏览器资源和 skill。xterm 浏览器资源由运行时依赖提供。取消 `private` 与 npm 发布须另行批准。
- 程序文件留在 npm 的安装位置，不再依赖项目目录。
- 配置、会话数据、运行时文件和日志统一放在 `~/.shared-terminal/`（配置如 `config.json`）。现有环境变量 `SHARED_SSH_DATA_DIR`、`SHARED_SSH_RUNTIME_DIR`、`SHARED_SSH_PORT` 仍可覆盖。
- 发布前必须验证 `node-pty` 的预编译包在目标平台可用。
- 子命令：

| 子命令 | 作用 |
| --- | --- |
| `server` | 手动后台启动服务，用于调试 |
| `status` | 查看服务运行状态、实际端口和绑定地址 |
| `pair` | 生成一次性短期配对链接或码，供浏览器接入 |
| `stop` | 停止服务（会关闭所有 SSH 会话，需先提示） |
| `install-skill` | 安装 skill 并登记 MCP |
| `uninstall-skill` | 撤销安装，撤销前先备份 |
| `skill` | 打印当前版本的使用说明 |

## 2 主程序 + skill（已实现）

- skill 保持很薄，只让 Agent 运行 `<命令> skill` 读取说明；说明随主程序版本走，避免 skill 与程序版本不一致。参考 ego-lite 的做法：[skill 命令说明](https://github.com/citrolabs/ego-lite/blob/main/docs/ego-browser-skill-command.md)。
- `install-skill --agent codex|claude|cursor|all` 写入所选客户端的 skill 并登记 MCP。[技能安装和卸载](development.md#技能安装和卸载)
- `uninstall-skill` 撤销 skill 和 MCP 登记，撤销前先备份原配置。
- 安装与卸载都必须幂等，重复运行不产生重复登记。

## 3 后台服务与 MCP（计划）

- 服务以后台单例运行，不需要占用前台终端。
- 服务与 MCP 适配进程分离，每个 Agent 一个适配进程。
- 第一个 Agent 连接时，如果服务未运行，自动后台启动；之后的 Agent 连接同一服务。
- 防止重复拉起：使用锁文件加端口检测。
- 服务重启后适配进程重新登记原任务，检测到新实例时首次主动操作返回 `service_instance_changed`。[服务实例变化与重连](development.md#服务实例变化与重连)

## 4 网络（已实现）

- 默认只监听 `127.0.0.1`。
- 端口默认 43127，可配置；零配置即可启动；端口被占用时自动换一个空闲端口。
- 实际端口写入 `~/.shared-terminal/` 下的运行时文件（现为 `connection.json`），MCP、`status`、`pair` 都从中读取。
- Host 校验按实际端口进行。
- 本机模式下 `localhost` 与 `127.0.0.1` 都可配对。
- 显式配置局域网接口与证书后开启 HTTPS／WSS 浏览器监听。启动提示可访问地址，MCP 与管理路径保持回环。[局域网 HTTPS](development.md#局域网-https)
- 不建议暴露到公网。
- 参考：T3 Code 的 [后台服务与本地网络访问](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md) 和 [远程访问与配对](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)。

## 5 浏览器访问与认证（已实现）

- 所有浏览器看到同一画面、同一状态，不按浏览器分会话。
- 浏览器通过 `pair` 或 `pair --lan` 签发的一次性短期配对链接或码接入。
- 浏览器写操作和 WebSocket 要求同源。Cookie 使用 HttpOnly、SameSite=Strict，局域网额外使用 Secure。
- 同一运行目录重启后，签名密钥允许有效 Cookie 恢复。无效时可在首页重新输入新配对码。

## 6 控制权与交接（已实现）

| 行为 | 状态 |
| --- | --- |
| 普通用户持锁 | 已关联 Agent 默认可取锁，服务端使旧输入凭据失效 |
| Agent 显式交给用户处理登录、2FA、主机指纹或 `su` | 服务端保留「已交给用户」状态并明确拒绝 Agent 取锁。Agent 可按既有授权查询、读屏和留言请求交回 |
| 用户明确交回 | 点击「交回 Agent」或主动释放自己持有的锁解除交接。打字、超时和刷新均不算交回，SSH 退出同时清除锁和交接 |
| 私密模式 | 优先于交接。用户明确关闭前，Agent 不能读取、认领、取锁或输入 |
| Agent 持锁时，用户打字不自动抢回，必须点「接管输入权」 | 已有，保持 |
| 锁空闲时，用户打字自动获取 | 已有，保持 |

界面提供「已交给用户」状态和「交回 Agent」按钮。输入权和交接校验在服务端执行，原 SSH 与 PTY 持续运行。

<a id="7-稳定性计划"></a>

## 7 实例识别与重新连接（已实现）

- 已认证的浏览器和 MCP 用每次启动生成的实例 ID 识别服务切换。仅浏览器掉线时可恢复同一实例里的原会话；服务更换实例后，用户明确发起新 SSH。会话、画面和消息仍随服务进程退出而消失。[服务实例变化与重连](development.md#服务实例变化与重连)

## 8 跨平台（计划）

- Windows 继续使用 ConPTY、`ssh.exe`、DPAPI/askpass 和旧入口。Linux 回环候选复用 Node CLI、Unix PTY 和原生 `ssh`，覆盖手动密码及私钥，等待云端原生运行验收。[Linux 复跑命令](development.md#linux-回环候选)
- macOS、本机凭据提供者、Linux 默认浏览器及 LAN/HTTPS 留待独立排期。

## 暂不做

- 多空间（每个 Agent 一个独立面板）。

## 文档自承未完成项（来自现有文档，仍未实现）

1. 网页资产快照或版本目录：现在页面资产从磁盘读取，`uiVersion` 在服务启动时计算；见 [开发、测试与运行](development.md)。
2. 开源许可证：尚未选择，由仓库所有者决定。
3. CI 未运行端到端测试：当前工作流只跑 build、test、check:docs、check:publish；`test:e2e` 依赖本机 OpenSSH 和 Git Bash/Vim，尚未接入。

## 参考

- ego-lite：[skill 命令说明](https://github.com/citrolabs/ego-lite/blob/main/docs/ego-browser-skill-command.md)
- T3 Code：[安装](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md)、[后台服务](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md)、[远程访问](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)
