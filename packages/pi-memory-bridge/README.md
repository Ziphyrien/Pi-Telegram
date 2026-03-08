# pi-memory-bridge

Pi-Telegram 同仓库内部 bridge 扩展。

当前实现目标：

- `before_agent_start` 向本地 memory bridge API 请求 context
- `agent_end` 回传本轮 user / assistant 消息
- `session_before_switch` / `session_shutdown` 请求 flush

注意：

- 主记忆逻辑仍属于 Pi-Telegram 主程序
- 此扩展不持有长期数据库
- 此扩展不读取 `settings.json`
- 此扩展不注册 provider / tools / commands
