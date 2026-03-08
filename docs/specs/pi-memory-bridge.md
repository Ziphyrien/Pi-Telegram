# pi-memory Bridge Spec

Status: Draft
Related Specs:
- `docs/specs/README.md`
- `docs/specs/pi-telegram-pre-memory-prep.md`
- `docs/specs/pi-telegram-refactor-automation.md`
- `docs/specs/pi-memory.md`
- `docs/specs/pi-memory-prompts.md`
- `docs/specs/pi-memory-related-work.md`
Last Updated: 2026-03-08

## 1. Purpose

`pi-memory-bridge` 是一个**轻量 bridge 扩展**，运行在 pi 进程内，用于把 pi 生命周期事件桥接给 `Pi-Telegram` 的 Memory Core。

它位于 `Pi-Telegram` **同一仓库**中，是 `Pi-Telegram` 产品内部的一部分，而不是独立产品或独立仓库。

它的职责只有两类：

1. **上行桥接**
   - 把 pi 进程中的 turn/session 生命周期信息发给 Pi-Telegram
2. **下行注入**
   - 从 Pi-Telegram 获取 memory context，并在 `before_agent_start` 注入回当前 turn

它**不是**：

- 主记忆引擎
- 本地数据库持有者
- 图谱主逻辑实现者
- planner / rerank / gating 实现层
- model/provider 注册层
- pi TUI 命令系统

---

## 2. Design Principles

### 2.1 Thin bridge only

bridge 应尽量薄：

- 无长期状态
- 无本地图谱数据库
- 无复杂缓存逻辑
- 无主业务决策

### 2.2 Temporary loading semantics

对用户而言，bridge 应是：

- **按当前 Pi-Telegram GitHub ref 临时加载**
- 只对当前 Pi-Telegram 启动的 pi 进程生效
- 不污染用户的全局或项目 pi 配置
- 来源是 `Pi-Telegram` 同仓库中的 bridge 子目录，而不是单独 bridge 仓库

### 2.3 Cached implementation

对实现而言，Pi-Telegram 允许：

- 从 GitHub 下载当前 `Pi-Telegram` 仓库对应 ref 一次
- 本地缓存 bridge 扩展目录
- 后续子进程直接复用缓存路径

### 2.4 No TUI command surface in MVP

MVP 明确不做：

- `/memory` TUI 命令
- 自定义 renderer
- widget/footer/status UI

### 2.5 Local-only communication

bridge 与 Pi-Telegram 之间的通信必须：

- 仅限本地机器
- 默认走 `127.0.0.1`
- 使用一次性 token 做鉴权

### 2.6 Provider registration is separate

memory LLM 的 provider 注册不应由 bridge 负责。

推荐做法是：

- `Pi-Telegram` 读取 `C:\Users\Administrator\.pi\telegram\settings.json`
- 根据其中的 `memory.llm` 配置生成一个**临时 provider-registration extension**
- 将该扩展注入需要使用 memory LLM 的 pi 进程

因此：

- bridge 负责生命周期桥接
- provider-registration extension 负责 `pi.registerProvider()`

---

## 3. Runtime Topology

```text
+--------------------------------------------------+
|                  Pi-Telegram                     |
|--------------------------------------------------|
| Memory Core                                      |
| Local Bridge API                                 |
| Extension Cache Manager                          |
+-------------------------+------------------------+
                          ^
                          | localhost / loopback
                          v
+--------------------------------------------------+
|         pi + pi-memory-bridge extension          |
|--------------------------------------------------|
| Hook handlers                                    |
| - before_agent_start                             |
| - agent_end                                      |
| - session_before_switch                          |
| - session_shutdown                               |
+--------------------------------------------------+
```

---

### 3.1 Codebase preparation prerequisite

bridge 虽然位于 `packages/pi-memory-bridge`，但它所桥接的 Memory Core 运行在 `Pi-Telegram` 主程序内部。

因此，在真正开始实现 bridge + memory 之前，主仓库源码结构应先完成一轮浅层模块化整理，至少形成：

- `src/app/`
- `src/telegram/`
- `src/pi/`
- `src/cron/`
- `src/shared/`
- `src/memory/`

这样才能保证：

- bridge 的上游目标明确是 `src/memory/` 对应的 Memory Core，而不是继续把逻辑堆进 `src/bot.ts`
- provider-registration extension、bridge API、memory core 之间的边界清晰
- 后续 same-repo 分发模型不会和扁平源码结构互相打架

这部分前置整理由以下文档定义：

- `docs/specs/pi-telegram-pre-memory-prep.md`
- `docs/specs/pi-telegram-refactor-automation.md`

---

## 4. Same-Repo GitHub Temporary Loading Model

## 4.1 Source of truth

bridge 的权威来源不是独立仓库，而是 `Pi-Telegram` 仓库本身。

Pi-Telegram 应维护一个内部 source tuple：

```text
repo   = github.com/<owner>/Pi-Telegram
ref    = <app-tag-or-commit>
subdir = packages/pi-memory-bridge
```

推荐 `<ref>`：

- 与当前 `Pi-Telegram` release 对应的 tag
- 或当前构建对应的 commit hash

不建议生产环境长期依赖浮动分支名（如 `main`）。

## 4.2 Repository layout assumption

推荐同仓库目录结构：

```text
Pi-Telegram/
├── src/
│   └── memory/
└── packages/
    └── pi-memory-bridge/
        ├── package.json
        ├── bridge.manifest.json
        └── extensions/
            └── memory-bridge.ts
```

### 4.2.1 Self-contained subdirectory requirement

由于运行时会把 `packages/pi-memory-bridge` 单独提取并通过 `-e <cached-local-extension-path>` 加载，因此该子目录应尽量**自包含**：

- 必须拥有自己的 `package.json`
- 不应依赖 monorepo 根目录特有的路径别名
- 不应假设只能在仓库根目录下运行
- 若需要依赖，应保证在该子目录内可解析

## 4.3 Version ownership

bridge 的版本管理规则：

- `pi-memory` 属于 `Pi-Telegram` 主程序，不单独发版
- `pi-memory-bridge` 也不是独立产品
- `pi-memory-bridge` 的 `package.json.version` 应与 `Pi-Telegram` 主版本一致
- bridge-only 修改也应通过新的 `Pi-Telegram` release 交付

## 4.4 Protocol binding

除版本外，还应定义一个独立常量：

```text
bridgeProtocolVersion
```

该值由：

- `Pi-Telegram` 主程序持有一份
- `pi-memory-bridge` manifest 持有一份

MVP 采用**严格匹配**：

- `bridgeVersion === appVersion`
- `bridgeProtocolVersion === expectedProtocolVersion`

## 4.5 Bridge manifest

建议 `packages/pi-memory-bridge/bridge.manifest.json` 至少包含：

```json
{
  "name": "pi-memory-bridge",
  "appVersion": "0.1.4",
  "bridgeVersion": "0.1.4",
  "bridgeProtocolVersion": 1,
  "entry": "./extensions/memory-bridge.ts"
}
```

Pi-Telegram 在启动前应校验：

- manifest 存在
- `appVersion` 与主程序版本一致
- `bridgeVersion` 与主程序版本一致
- `bridgeProtocolVersion` 与当前主程序期望值一致
- `entry` 文件存在

## 4.6 Cache path

建议缓存到：

```text
~/.pi/telegram/extensions-cache/<repo>@<ref>/<subdir>/p<protocol>/
```

其中：

- `<repo>` 可做路径安全化处理
- `<ref>` 保留版本/提交信息，便于审计和回滚
- `<subdir>` 用于标识 bridge 来自同仓库哪个子目录
- `p<protocol>` 用于隔离协议版本不兼容的缓存

## 4.7 Launch flow

Pi-Telegram 启动 pi 子进程时建议执行：

1. 根据当前构建信息确定 `repo/ref/subdir/protocol`
2. 检查缓存目录是否存在且 manifest 校验通过
3. 如果不存在或校验失败：
   - 拉取/下载当前 `Pi-Telegram` 仓库 ref
   - 提取 `packages/pi-memory-bridge`
   - 验证入口文件与 manifest
4. 读取 `C:\Users\Administrator\.pi\telegram\settings.json`
5. 根据 `memory.llm` 配置生成临时 provider-registration extension
6. 生成本地 bridge API 配置
7. 设置环境变量
8. 启动**主对话 pi 进程**时，使其同时具备：
   - `pi-memory-bridge`
   - provider-registration extension
9. 启动**内部 extraction pi RPC 进程**时：
   - 仅需 provider-registration extension
   - 使用 `pi --mode rpc --no-session`
   - 不加载 `pi-memory-bridge`

## 4.8 Why cached local path over direct git loading

相比每次都直接：

```text
pi -e git:github.com/...
```

缓存后再本地加载的优势：

- 启动更快
- 网络故障时更稳
- 多 chat 并发时不重复下载
- 更容易做版本固定与故障回滚
- 更容易排查“当前到底加载的是哪个 app ref、哪个 bridge version、哪个 protocol”

## 4.9 Cache invalidation

建议首版采用最简单策略：

- 同一个 `repo + ref + subdir + protocol` 命中缓存则直接复用
- 不做自动更新
- 只有 ref 或 protocol 变更时才拉新缓存

后续可选：

- 手动清缓存
- 启动时校验 hash
- 指定 refresh policy

---

## 5. Bridge Environment Contract

Pi-Telegram 在启动 pi 时，建议注入以下环境变量：

- `PI_MEMORY_ENABLED=1`
- `PI_MEMORY_CHAT_SCOPE=chat:telegram:<botHash>:<chatId>`
- `PI_MEMORY_USER_SCOPE=user:telegram:<userId>`（若可用）
- `PI_MEMORY_WORKSPACE_SCOPE=workspace:<workspaceId>`
- `PI_MEMORY_BRIDGE_URL=http://127.0.0.1:<port>`
- `PI_MEMORY_BRIDGE_TOKEN=<ephemeral-random-token>`
- `PI_MEMORY_SOURCE=telegram`
- `PI_MEMORY_APP_VERSION=<pi-telegram-version>`
- `PI_MEMORY_BRIDGE_VERSION=<bridge-version>`
- `PI_MEMORY_BRIDGE_PROTOCOL_VERSION=<protocol-version>`

### Notes

- `PI_MEMORY_BRIDGE_TOKEN` 应每次 Pi-Telegram 启动时重新生成
- `PI_MEMORY_USER_SCOPE` 若不可得可省略，但 bridge 应能容错
- `PI_MEMORY_WORKSPACE_SCOPE` 应由 Pi-Telegram 统一生成，bridge 不自己推导
- `PI_MEMORY_APP_VERSION` 与 `PI_MEMORY_BRIDGE_VERSION` 在 MVP 中应精确相等
- `PI_MEMORY_BRIDGE_PROTOCOL_VERSION` 用于运行时协议兼容校验

---

## 6. Bridge API Contract

bridge 调用的是 Pi-Telegram 暴露的**本地 bridge API**。

## 6.1 Auth

所有请求应带：

- `Authorization: Bearer <PI_MEMORY_BRIDGE_TOKEN>`

或等价 header。

## 6.2 Required endpoints

### `GET /v1/health`

用途：
- bridge 在 `session_start` 时探活

示例返回：

```json
{
  "ok": true,
  "service": "pi-memory-core",
  "appVersion": "0.1.4",
  "bridgeProtocolVersion": 1
}
```

### `POST /v1/context`

用途：
- `before_agent_start` 获取 memory context

请求建议：

```json
{
  "prompt": "用户当前输入",
  "scopes": {
    "chat": "chat:telegram:botHash:7032858921",
    "user": "user:telegram:123456",
    "workspace": "workspace:repo.9f3a2c"
  },
  "session": {
    "sessionId": "abc123",
    "sessionFile": "/path/to/session.jsonl"
  },
  "budget": {
    "maxTokens": 1500
  }
}
```

响应建议：

```json
{
  "contextText": "[高优先级行为约束]\n- ...",
  "selectedUris": [
    "urn:pi-memory:node:procedural:workspace:..."
  ],
  "trace": null
}
```

### `POST /v1/ingest-turns`

用途：
- `agent_end` 把完整 turn 数据回传给 Pi-Telegram

请求建议：

```json
{
  "scopes": {
    "chat": "chat:telegram:botHash:7032858921",
    "user": "user:telegram:123456",
    "workspace": "workspace:repo.9f3a2c"
  },
  "session": {
    "sessionId": "abc123",
    "sessionFile": "/path/to/session.jsonl"
  },
  "messages": [
    {
      "role": "user",
      "content": "...",
      "timestamp": 1730000000000
    },
    {
      "role": "assistant",
      "content": "...",
      "timestamp": 1730000005000
    }
  ]
}
```

响应建议：

```json
{
  "accepted": true,
  "queued": true,
  "ingestId": "01J..."
}
```

### `POST /v1/flush`

用途：
- `session_before_switch` / `session_shutdown` 请求 flush

请求建议：

```json
{
  "scopes": {
    "chat": "chat:telegram:botHash:7032858921",
    "user": "user:telegram:123456",
    "workspace": "workspace:repo.9f3a2c"
  },
  "session": {
    "sessionId": "abc123"
  },
  "reason": "switch"
}
```

响应建议：

```json
{
  "ok": true,
  "flushed": 6
}
```

## 6.3 Optional endpoints

后续可加：

- `POST /v1/memory/add`
- `POST /v1/memory/search`
- `POST /v1/memory/forget`
- `POST /v1/memory/trace`

但这些不是 bridge MVP 的前置条件。

---

## 7. Lifecycle Mapping

## 7.1 `before_agent_start`

bridge 行为：

1. 读取 prompt / scopes / session metadata
2. 调用 `/v1/context`
3. 如果成功，注入 extension message
4. 如果失败，静默降级或仅记录日志

## 7.2 `agent_end`

bridge 行为：

1. 收集本轮完整 user / assistant messages
2. 调用 `/v1/ingest-turns`
3. 不等待高层 consolidation 完成
4. 不在扩展内做 extract / graph / retrieval

## 7.3 `session_before_switch`

bridge 行为：

1. 调用 `/v1/flush`
2. reason = `switch`
3. 若 flush 失败，至少记录错误，不阻塞 session switch 太久

## 7.4 `session_shutdown`

bridge 行为：

1. 调用 `/v1/flush`
2. reason = `shutdown`
3. 清理本地连接状态

## 7.5 `session_start` (optional)

bridge 行为：

1. 调用 `/v1/health`
2. 校验 scope / token / url 是否齐全
3. 校验 `PI_MEMORY_APP_VERSION`、`PI_MEMORY_BRIDGE_VERSION`、`PI_MEMORY_BRIDGE_PROTOCOL_VERSION`
4. 可选上报 bridge version

---

## 8. What the Bridge Must NOT Do

bridge 不应：

- 持有长期 SQLite
- 自己实现 graph extraction
- 自己实现 TMT consolidation
- 自己实现 planner / rerank / gating
- 自己实现 forgetting policy
- 自己读取 `C:\Users\Administrator\.pi\telegram\settings.json` 并解释模型配置
- 自己调用 `pi.registerProvider()` 注册 memory provider
- 自己注册 TUI commands（MVP）
- 自己注册 TUI renderers（MVP）

否则会把本应在 Pi-Telegram 的业务逻辑重新散落进 pi 扩展层。

---

## 9. Failure Handling

## 9.1 Bridge API unavailable

若 `PI_MEMORY_BRIDGE_URL` 不可达：

- `before_agent_start`：跳过 memory context 注入
- `agent_end`：放弃本轮 ingest，记录日志
- `session_before_switch` / `session_shutdown`：尝试一次 flush，失败则跳过

## 9.2 Invalid token

若 token 校验失败：

- bridge 不应重试太多次
- 应记录为配置错误
- 不应阻塞主会话

## 9.3 Extension cache missing or corrupt

若缓存目录损坏：

- Pi-Telegram 应删除该缓存并重新从**当前仓库 ref**拉取
- 若重新拉取失败，可退回“无 bridge 模式”启动 pi

## 9.4 GitHub unavailable on first fetch

若首次获取 bridge 扩展失败：

- Pi-Telegram 应允许启动无 bridge 的 pi
- 同时记录错误，并在日志里标明“memory bridge disabled for this run”
- 日志中应注明失败的 `repo/ref/subdir`

---

## 10. Security Notes

1. bridge API 默认只监听 `127.0.0.1`
2. 使用一次性 bearer token
3. 缓存目录应只允许当前用户读写
4. bridge source 应尽量 pin 到 `Pi-Telegram` 仓库的 tag 或 commit hash
5. 不应自动执行来自未信任来源或未校验 manifest 的 bridge 代码

---

## 11. MVP Recommendation

首版 bridge 应满足：

- 从 **Pi-Telegram 同仓库同 ref** 获取 `packages/pi-memory-bridge` 并缓存
- 以本地缓存路径临时注入到主对话 pi 进程
- 启动前校验 `bridge.manifest.json`
- 严格校验：
  - `bridgeVersion === appVersion`
  - `bridgeProtocolVersion === expectedProtocolVersion`
- 与 bridge 分开的 provider-registration extension 一起工作
- provider-registration extension 由 `settings.json` 生成
- 内部 extraction pi RPC 进程使用 `--no-session`
- 只桥接四个事件：
  - `before_agent_start`
  - `agent_end`
  - `session_before_switch`
  - `session_shutdown`
- 不注册 TUI commands
- 不注册 renderers
- 不持有长期数据库
- 不承担主记忆逻辑

这是最小、清晰、稳定的 bridge 设计。
