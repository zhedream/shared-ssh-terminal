# 独立会话消息协议

## 用户体验

点击“发消息给 Agent”打开独立面板。面板显示当前接收者、保留消息和确认状态。可输入普通文本，也可用 `@agent 请解释报错` 这样的文字表达意图；该标记只是消息内容，不会提交到 SSH。不会在 Vim 或密码提示下截获终端按键去猜测消息。

无需输入锁，用户可在 Agent 运行命令时留言；用户自己持锁时也能发。无关联时禁止发送，私密时禁止发送和读取。关联变化后草稿不会悄悄转投新 Agent，需重新打开面板确认接收者，服务端也校验发送时的 targetAgentId。

消息保留在本机内存，刷新和多页面可同步；服务重启会清除。关闭 SSH 但页签保留时仍可查看消息；移除页签后删除。每个会话最多保留 100 条，每条最多 2000 字符，满时明确拒绝，不能悄悄丢弃未读请求。

## 路由和权限

每条消息包含 id、sessionId、发送时 target 身份快照、source=user、text、createdAt、acknowledgedAt。接收者一经发送固定，不因重新关联而改变。A 的旧消息不会因为 B 接管会话而转投给 B。

用户面板显示该会话的保留消息；Agent 只能读取其中发给自己且仍在授权范围内的部分。已确认消息仍可读取，直到用户清空；通知和未读附加返回只包含未确认消息。清空消息不改变终端和锁，“清空全部历史”同时清空终端及消息，且向所有页面推送。

私密开启会阻止新的正文读取、待收返回和通知。关闭后仍保留的内容可以重新访问。已经进入客户端或模型上下文的数据无法撤回，这与终端画面的规则一致。

## MCP 工具

- `read_messages({agentId, sessionId, unreadOnly?, waitMs?})`：默认返回当前目标的保留历史。`unreadOnly=true` 只读待确认消息；没有符合条件的消息时可等待，最长 15 秒。
- `acknowledge_messages({agentId, sessionId, messageIds})`：显式确认收到，校验每条消息的目标及会话。幂等确认不代表任务执行完成。
- 其余工具的主结果结构保持原样。当有未确认消息时，在工具结果的额外文本块中附带 `type=user_messages`。客户端不展示通知时，Agent 下次工具调用仍能读取。

## 主动通知与兼容性

当前 SDK 通过 MCP 标准 `notifications/message` 发送 info 级日志通知，logger 为 `shared-ssh.user-message`，data.type 为 `user_message_available`。通知只有 targetAgentId、sessionId、messageId 和读取提示，没有正文。宿主需要接收并处理通知；可通过日志级别过滤它。

MCP 连接不是具体聊天地址。同一适配进程可能服务多个任务，客户端不能仅凭收到通知就把正文注入任意聊天。正确行为是比较当前任务身份后调用读取工具。本项目不会借日志通知伪装为顶层用户消息，不承诺客户端会自动唤醒模型。

标准 MCP 通知没有 Codex 的 Queue/Steer 模式字段。本项目不调用 Codex 私有接口、不指定这两种模式。Codex 官方说明区分了当前回复结束后处理的 Queue 与引导当前工作的 Steer，但这一设置不能推出 MCP 日志通知也会以相同方式进入聊天。

参考：[Codex Queue 与 Steer](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)、[MCP SDK 通知](https://ts.sdk.modelcontextprotocol.io/v2/servers/notifications)。本项目实际依赖的 SDK 为 package-lock.json 固定的 1.x 版本，通知调用应以该版本类型与集成测试为准。
