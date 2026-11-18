# v0.7 路线图（计划，未实现）

本文件记录下一版本的新需求。**以下所有条目均为计划，当前代码尚未实现**；其中标注“现状”的是已有行为，计划只在需要时调整。已实现的规则见 [产品理念](product.md)、[架构](architecture.md) 和 [开发章程](../AGENTS.md)。

## 1 打包与分发（计划）

- 发布 npm 包，使用方式为 `npx <包名> <子命令>`。
- `package.json` 去掉 `private`，增加 `bin`；`files` 包含 `dist`、`public`、xterm 静态资源和 skill。
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

## 2 主程序 + skill（计划）

- skill 保持很薄，只让 Agent 运行 `<命令> skill` 读取说明；说明随主程序版本走，避免 skill 与程序版本不一致。参考 ego-lite 的做法：[skill 命令说明](https://github.com/citrolabs/ego-lite/blob/main/docs/ego-browser-skill-command.md)。
- `install-skill --agent codex|claude|cursor|all`：写入对应 Agent 的 skill，并登记 MCP；取代只支持 Codex 的 `Register-MCP.ps1`。
- `uninstall-skill` 撤销 skill 和 MCP 登记，撤销前先备份原配置。
- 安装与卸载都必须幂等，重复运行不产生重复登记。

## 3 后台服务与 MCP（计划）

- 服务以后台单例运行，不需要占用前台终端。
- 服务与 MCP 适配进程分离，每个 Agent 一个适配进程。
- 第一个 Agent 连接时，如果服务未运行，自动后台启动；之后的 Agent 连接同一服务。
- 防止重复拉起：使用锁文件加端口检测。
- 服务重启后适配进程自动重连（现状已有，需保留）。

## 4 网络（计划）

- 默认只监听 `127.0.0.1`。
- 端口默认 43127，可配置；零配置即可启动；端口被占用时自动换一个空闲端口。
- 实际端口写入 `~/.shared-terminal/` 下的运行时文件（现为 `connection.json`），MCP、`status`、`pair` 都从中读取。
- Host 校验按实际端口进行。
- 本机模式下 `localhost` 与 `127.0.0.1` 都可用（现状只接受 `127.0.0.1`）。
- 可显式配置其他绑定地址（例如局域网）：启动时给出警告；非本机绑定必须先配对；Host 和 Origin 白名单随绑定地址调整。
- 不建议暴露到公网。
- 参考：T3 Code 的 [后台服务与本地网络访问](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md) 和 [远程访问与配对](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)。

## 5 浏览器访问与认证（计划）

- 所有浏览器看到同一画面、同一状态，不按浏览器分会话。
- 任何浏览器通过 `pair` 生成的一次性短期配对链接或码接入，不再要求从启动链接进入。
- 凭据保存在 HttpOnly、SameSite=Strict 的 cookie 中；保留现有的 Origin 校验。
- 服务重启后，已配对的浏览器无需重新配对：持久化签名密钥。若做不到，则在页面上提示应执行的命令。

## 6 控制权与交接（部分为计划）

| 行为 | 状态 |
| --- | --- |
| 用户持锁时，Agent 默认可直接拿走 | 计划（现状：必须用户先释放） |
| 隐私模式下 Agent 不能拿锁、不能看 | 已有，保持 |
| Agent 持锁时，用户打字不自动抢回，必须点「接管输入权」 | 已有，保持 |
| 锁空闲时，用户打字自动获取 | 已有，保持 |
| 明确的交出与接回接口：登录、2FA、主机指纹、`su` 等交给人处理，处理完再交回 | 计划 |

## 7 稳定性（计划）

- 服务重启后尽量恢复 SSH 会话和消息（现状：重启后全部丢失，见 [开发、测试与运行](development.md)）。

## 8 跨平台（计划）

- 终端层不绑定 ConPTY，SSH 不绑定 `ssh.exe`；启动、停止等脚本改为 Node CLI。
- 先保证 Windows，再支持 macOS 和 Linux。

## 暂不做

- 多空间（每个 Agent 一个独立面板）。

## 文档自承未完成项（来自现有文档，仍未实现）

1. 网页资产快照或版本目录：现在页面资产从磁盘读取，`uiVersion` 在服务启动时计算；见 [开发、测试与运行](development.md)。
2. 开源许可证：尚未选择，由仓库所有者决定。
3. CI 未运行端到端测试：当前工作流只跑 build、test、check:docs、check:publish；`test:e2e` 依赖本机 OpenSSH 和 Git Bash/Vim，尚未接入。

## 参考

- ego-lite：[skill 命令说明](https://github.com/citrolabs/ego-lite/blob/main/docs/ego-browser-skill-command.md)
- T3 Code：[安装](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md)、[后台服务](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md)、[远程访问](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)
