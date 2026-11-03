[AGENTS](AGENTS.md) @AGENTS.md
[文档索引](docs/README.md) @docs/README.md

# 共端 · Shared SSH Terminal

Windows 本地共享 SSH：同一画面、唯一输入权、主动交接、独立消息。

Node.js 22/24 + TypeScript + node-pty + xterm + MCP SDK；前端为原生 JavaScript。

常用命令：`npm ci`、`npm run build`、`npm test`、`npm run test:e2e`、`npm run check:docs`、`npm run check:publish`。

不注入 Shell 检测，不自动释放锁。私密资料仅存本机，禁止提交 `data/` 和 `.runtime/`。详细边界见 AGENTS.md。
