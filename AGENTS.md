# 共端开发章程

[快速入口](CLAUDE.md) · [文档索引](docs/README.md)

共端是 Windows 本机运行的用户与 Agent 协作 SSH 平台。Node.js、TypeScript、OpenSSH、ConPTY、xterm 和 MCP 构成主要技术栈。单例服务持有 SSH；浏览器和多个 stdio MCP 适配端连接同一服务。

## 不变量

1. 用户与 Agent 在授权范围内所见即所得：共同读取 canonical xterm 屏幕及最多 2000 行滚动历史，不另存可被 Agent 读取的原始输出日志。
2. 一个 SSH 会话同时只有一个输入持有者。页面和 Agent 的锁均由服务端校验；Agent 不得抢占。锁只主动释放，SSH 退出时清除。
3. 私密、Agent 关联和输入权是三个独立概念。私密阻止 Agent 读取、认领和输入，不清屏、不结束程序。
4. 不安装 Shell 回调、不注入完成检测、不推断准确命令退出码。所有运行中交接延续原程序。
5. 消息走独立本地通道，不解析 SSH 输出为用户指令，不把消息写进 PTY。接收者固定为发送时的 Agent 身份，不能因同 Host 或重新关联而转投。
6. MCP 通知为连接级提示，不保证唤醒聊天，不指定客户端的 Queue/Steer 模式。正文必须由对应任务身份读取；通知发送不等于已读。
   普通成功工具会重复附带当前任务有权读取的未确认消息。Agent 实际读到后应及时调用 acknowledge_messages；读取本身不消费，确认后仅停止自动附带，仍保留可读历史直到用户清空。
7. 密码通过 DPAPI 加密和 OpenSSH askpass 使用；禁止出现在工具结果、终端输入、命令参数或环境变量中。
8. 只提交通用源码、测试和文档。即使是密码密文也属于私密资料；`data/`、`.runtime/`、令牌、本机服务器地址、实际用户路径、截图及操作记录均不得提交。

## 目录与职责

```text
src/agents.ts          任务身份、独立 secret 与认证
src/profiles.ts        配置、脱敏返回、密码密文持久化
src/secrets.ts         Windows 当前账户 DPAPI
src/saved-password.ts  askpass 本机管道与认证提问
src/sessions.ts        共享终端、锁、私密、同一屏幕缓冲
src/messages.ts        有界内存消息历史、固定接收者、确认收到
src/server.ts          单例 HTTP/WS 服务、权限边界和消息路由
src/mcp.ts             stdio 适配、标准通知、待收消息兜底
src/ssh-config.ts      只读导入 SSH config 的允许字段
public/               无构建浏览器界面
scripts/              本机隔离端到端测试、认证助手、发布检查
test/                 权限、锁、画面、配置和消息测试
docs/                 产品、架构、维护和发布文档
data/                 本地配置与密码密文（不提交）
.runtime/             本机令牌、日志、认证助手及测试产物（不提交）
```

## 开发方式

- `npm ci` 安装，`npm run build` 构建，`npm test` 单元验证，`npm run test:e2e` 隔离本机 SSH 验证。
- 新 API 在 server schema 中定义并检查真实身份、会话关联、私密和 lease；不能仅依赖按钮禁用。
- 界面状态通过 WS 广播，并纳入首次同步及刷新恢复。消息文本使用 textContent，不作为 HTML 或终端控制序列。
- 涉及权限、认证、终端同步、消息路由的修改须验证失败路径。不要用业务服务器代替测试环境。
- 有活动 SSH 时，重启会造成连接和未保存工作丢失，需告知并获得用户授权。浏览器刷新无需重启 SSH。
- 文档和代码同步，更新 [docs/README.md](docs/README.md) 索引。
- 提交前检查暂存区，运行 `npm run check:publish` 与 `npm run check:docs`。发布扫描是辅助，不代替人工确认，也不能保证发现一切秘密。

## 关键决策

完整背景与取舍见 [产品理念](docs/product.md)、[架构](docs/architecture.md)、[消息协议](docs/messaging.md) 和 [安全与公开发布](docs/security.md)。新 Agent 应先读这些文档，避免重新引入已移除的 Shell 注入方案。
