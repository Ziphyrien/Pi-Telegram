# memory

Pi-Telegram 内置长期记忆子系统。

当前代码结构：

- `types.ts` / `scope.ts`
  - 领域类型、scope 与 URI helper
- `contracts.ts`
  - local bridge API contract
- `store/`
  - SQLite 主存储
- `ingest/`
  - 写侧 pipeline 与 candidate extractor
- `retrieval/`
  - planner 与 hybrid retrieval
- `context/`
  - context assembly 与 pager
- `bridge-server/`
  - 本地 bridge API
- `service.ts`
  - 统一 memory facade
- `telegram-client.ts`
  - Telegram 侧 transport adapter

当前已实现：

- SQLite 主存储与 FTS5 检索
- raw turns 写入
- 单一写侧 pipeline
- 单一检索主路径
- 单一 context assembly / pager 输出路径
- heuristic extractor / planner 作为 fallback adapter
- direct / bridge 两种 transport 适配
- 本地 memory bridge API：
  - `/v1/health`
  - `/v1/context`
  - `/v1/ingest-turns`
  - `/v1/flush`
- same-repo `packages/pi-memory-bridge` 骨架与最小扩展入口

当前仍未完成的 future phase：

- LLM extraction / consolidation
- embedding API 接入
- graph / entity / relation extraction
- T2/T3/T4/T5 分层巩固
- active memory controller
- GitHub ref cache / provider-registration extension
