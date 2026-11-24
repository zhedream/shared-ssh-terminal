# 共端使用说明

## 何时使用共端

- 普通任务走当前任务的执行环境。即使要运行 `npm run dev`，或机器上已有同名运行配置，也继续沿用默认环境，直到用户明确要求共享。
- 用户明确要求在共端共同查看、操作、接管或演示时，才使用共端。用户提供指定会话或主动把会话交给当前任务时，在获准的会话内操作。
- 继续已获准的共享任务时，沿用该会话查看输出、处理报错或继续交互。输入前照常核对当前画面、关联和输入权。
- 转到新的、没有明确共享意图的任务时，回到其正常执行环境。
- 遇到已开启私密的共享会话，等待用户关闭私密后再继续。禁止用另开的会话绕过私密，无论该会话是否仍关联当前任务。

## 浏览器配对

- 在共端主机运行 `shared-ssh-terminal pair`，打开实际回环端口的一次性链接。链接五分钟内有效，兑换成功后地址片段会消失。裸地址入口是「共端首页 → 配对此浏览器 → 配对码 → 配对」。码无效、过期或已用时重新运行 `pair`，可点击「重新检查连接」确认现有登录态。 `127.0.0.1` 和 `localhost` 各需配对。
- 在局域网使用 `shared-ssh-terminal status` 核对 `lan.origin`，再在共端主机运行 `shared-ssh-terminal pair --lan`。浏览器用可信证书访问签发时的 HTTPS 地址。已配对的回环和 LAN 浏览器共享 SSH 会话，Windows 本地终端和运行配置只在已配对的回环浏览器及本机 MCP 开放。[包内 HTTPS 设置](../docs/development.md#局域网-https)

## 启动和停止

- Windows 回环浏览器可从「本地终端 → 打开 PowerShell」「本地终端 → 运行一次性命令」或「本地终端 → 运行配置 → 启动」打开共享会话。填写启动目录时用已存在的本机绝对路径。
- Agent 在用户明确要求共享时先调用 `get_capabilities({})`。只有返回 `localTerminal: true` 时使用本地启动工具。`platform_not_supported` 表示当前平台不提供本地终端，Linux 回环仍可使用 SSH。npm `0.7.0` 的工具列表仅有 SSH 共享工具。
- 可调用 `open_local_shell({})` 打开服务用户主目录的 PowerShell。一次性命令示例为 `start_run({cwd:"C:/work/example",command:"Write-Output '共端测试'"})`，使用时把路径换为现有测试目录。运行配置使用 `list_run_configs` 获取标识，再调用 `start_run({configId})`。返回 `{sessionId,reused}`，复用不会改变既有会话权限。
- 已关联、非私密且持有有效 lease 的 Agent 可以调用 `stop_session({sessionId,lease})` 或 `restart_session({sessionId,lease})`。重启后需要重新取锁。页面的「停止」先发 Ctrl+C，超时后由服务清理该会话 Job。页面另有「强制停止」和「删除会话」。停止保留画面，删除会话清除画面。
- SSH 从「服务器 → 连接 ↗」打开，也可使用「连接选项 → 本次启动目录」覆盖当前连接。Agent 可在 `create_session({profileId,startupDir})` 提供同一可选参数。远端目录缺失时按终端提示继续使用登录目录。
- 浏览器关闭后同一服务仍保留会话。服务换实例后用 `list_sessions` 核对状态，再按明确共享意图重新打开。运行配置仍可手动启动。

## 认领和操作

1. 用户打开 SSH 或 Windows 本地终端后，通过会话工具栏的「复制 sessionId」把指定 ID 交给 Agent。Agent 用 `register_agent` 建立任务身份，后续传回它的 `agentId`，再用 `attach_session` 认领指定会话。
2. 先用 `read_screen` 判断屏幕上的程序和提示，再调用 `take_control`。已关联 Agent 可取公开会话的空闲锁或普通用户锁。Agent 持有输入权时，用户可点击「接管输入权」，旧 lease 随之失效。
3. 用 `send_input` 按当前程序的交互方式发送按键。用 `read_output` 看变化，需要时显式分页 `read_history`。原程序和 Shell 状态随输入权交接继续。等待时间没有命令完成含义。

## 释放、人工交接与交回

| 动作 | 行为 |
| --- | --- |
| 普通释放 | 持锁 Agent 调用 `release_control`，或持锁页面点击「释放输入权」。空闲后有权的一方可取锁，原程序继续。 |
| Agent 显式交接 | 用有效 lease 调用 `handoff_to_user`。旧 lease 失效，当前页签显示「已交给用户」。用户处理指纹、登录、二次验证或其他人工步骤。打字、超时、刷新和掉线保留交接保护。 |
| 用户明确交回 | 在该页签点击「交回 Agent」，或由当前持锁页面点击「释放输入权」。Agent 再调用 `take_control` 获得新 lease。另一页不能代当前持锁页面交回。 |

Agent 取锁遇到 `handed_to_user` 时，可用 `list_sessions` 查询交接、在授权范围内读屏，并用 `request_control_return` 更新「Agent 请求交回」说明。用户可通过「发消息给 Agent」单独留言。Agent 读取实际收到的留言并用 `acknowledge_messages` 确认。

## 解除关联

在「终端会话页签 → 工具栏 → 解除关联」点击后，原 Agent 的会话访问权被撤销，当前页面接管输入权，原程序继续运行。「Agent 请求交回」说明随关联清除，独立留言历史及其原接收者仍保留。

如果会话已有「已交给用户」状态，解除关联后交接保护继续生效。要结束交接保护，可重新关联后点击「交回 Agent」，或由当前持锁页面主动点击「释放输入权」。

## 私密操作

用户可用会话工具栏的「私密：关／开」切换权限。私密开启时，Agent 无法读取、认领、取锁或发送输入。显式交回保留私密。密码及确认提示由用户亲自处理。关闭私密前，如需移除仍保留的敏感画面或历史，可用「清空全部历史」。已读到的内容无法撤回。
