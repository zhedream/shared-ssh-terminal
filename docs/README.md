# 文档索引

共端的文档记录已实现的规则和边界；展望能力必须明确标为未实现。示例只使用 localhost、保留域名或文档地址，不使用真实服务器资料。

## 快速开始

- [项目说明与安装](../README.md)：用户必读，启动、连接、认证与 MCP 配置。
- [开发章程](../AGENTS.md)：维护者和 Agent 必读，代码职责和不可破坏的规则。
- [Agent 快速入口](../CLAUDE.md)：常用命令和文档入口。

## 产品与架构

- [背景与设计理念](product.md)：目标用户、场景、所见即所得、三种权限和取舍。
- [架构与数据流](architecture.md)：单例服务、stdio 适配、PTY、WS、认证与生命周期。
- [服务实例变化与重连](development.md#服务实例变化与重连)：浏览器重新同步、MCP 切换提示和手动新建 SSH。
- [人工交接](../README.md#人工交接)：输入锁、用户交回和 Agent 请求。
- [用户到 Agent 的消息](messaging.md)：独立通道、通知、确认、客户端差异和协议细节。
- [终端读取与预算](terminal-reading.md)：每任务变化基线、最新优先、备用屏幕、受限分页和升级。
- [设计决策记录](decisions.md)：Shell 检测的移除、原始输入和手动释放等决策。
- [本地终端设计（已定稿、尚未实施）](local-terminal.md)：Windows 原生 PTY/PowerShell、启动目录、按需启用共端，以及首版范围与验收分工。
- [v0.7 路线图](roadmap.md)：后续版本规划，已实现的本机启动和发现契约见架构与开发文档。

## 维护与发布

- [安全与公开发布](security.md)：私密资料边界、Git 忽略和暂存区检查。
- [开发、测试与运行](development.md)：命令、配置迁移、验证范围、调试、升级与限制。
- [Linux 回环](development.md#linux-回环)：原生依赖、CLI、验收结果、复跑命令和凭据边界。
- [技能安装和卸载](development.md#技能安装和卸载)：Codex、Claude Code 和 Cursor 的用户级技能与 MCP 登记。
- [局域网 HTTPS](development.md#局域网-https)：监听地址、证书、实际端口及浏览器配对。
- [Windows 旧入口隔离验收](development.md#windows-旧入口隔离验收)：在专用 PowerShell 使用临时目录复跑启动、复用与停止。

新维护者建议按“项目说明 → 产品理念 → 架构 → 开发章程 → 开发测试”阅读；修改消息时额外阅读消息协议，准备公开前阅读安全与公开发布。
