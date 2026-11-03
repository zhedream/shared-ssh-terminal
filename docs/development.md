# 开发、测试与运行

## 环境

Windows 10 1809+、Node.js 22/24、系统 OpenSSH；保存密码建议使用 OpenSSH 8.6+，依赖 Windows PowerShell 和 DPAPI。前端为原生 JavaScript，无前端构建器。

```powershell
npm ci
npm run build
npm test
npm run check:docs
npm run test:e2e
```

`start.cmd` 构建并启动隐藏后台服务，然后打开浏览器；已有健康服务会复用。`stop.cmd` 会关闭所有 SSH。构建文件在 dist，安装依赖在 node_modules，均不提交。

## 本机配置

`SHARED_SSH_PORT` 控制监听端口，默认 43127；`SHARED_SSH_DATA_DIR` 和 `SHARED_SSH_RUNTIME_DIR` 可分别覆盖数据和运行目录。相同数据目录不应由多个服务并发写入。

MCP 应用配置为启动 `node` 并传入本机 `dist/mcp.js` 绝对路径。可运行通用的 Register-MCP.ps1 生成当前路径并备份原 Codex 配置；不要把生成后的个人配置纳入仓库。

## 验证分层

| 命令 | 覆盖 |
| --- | --- |
| npm run build | TypeScript 类型和输出 |
| npm test | 唯一输入锁、任务权限、私密、历史覆盖/清空、密码保存/移除、消息路由/确认和按钮状态 |
| npm run test:e2e | 本机 OpenSSH/SSH2/ConPTY、密码/密钥/保存密码、真实 Vim、跨页面、多个 MCP 进程、独立消息与标准通知 |
| node scripts/shell-smoke.mjs | 本机 Bash 原始输入；设置 SST_TEST_ZSH 可加测 Zsh |
| npm run check:docs | 所有文档索引和相对引用 |
| npm run check:publish | Git 暂存版本中的私密目录、主机、本机路径和常见凭据 |

端到端测试默认用临时端口 43128，独立 data/runtime，动态本机 SSH 端口，不连接业务服务器。完整测试还需 Git for Windows 的 Bash/Vim。ConPTY 测试清理时偶尔会出现 node-pty 的 AttachConsole 错误输出；需结合断言与退出码判断，不应将其隐藏成“无错误输出”。

## 修改入口

增加工具需同时更新 MCP schema、broker schema、服务端权限验证、工具文档和集成测试。不要依靠 MCP 提示文字代替服务端检查。增加 UI 状态需处理刷新、首次快照、多个页面和离线恢复。

消息仅存在内存。通知后的确认是独立动作，不能在发出通知时自动标记已读；客户端忽略通知时必须仍能显式读出和在工具结果中获得待收消息。

## 升级与已知限制

重启服务会断开所有 SSH、清除终端及消息内存；配置和密码密文仍留本机。有活动连接先告知用户并获得授权。增加 MCP 工具后，客户端可能需要重新加载 MCP 或重启应用才能刷新工具目录。

当前网页资产从磁盘读取，uiVersion 在服务启动时计算。开发时修改 public 但暂不重启，可能让旧服务临时返回新页面；上线应在测试后及时加载同一版本，并在旧客户端不能自动同步时刷新页面。未来可以改为资产快照或版本目录，此项尚未实现。

默认未指定开源许可证；公开前由仓库所有者决定。不要把私有仓库误称为已经开源发布。
