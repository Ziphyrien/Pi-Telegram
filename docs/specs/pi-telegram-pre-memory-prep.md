# Pi-Telegram Pre-Memory Preparation Spec

Status: Draft
Owner: TBD
Last Updated: 2026-03-08
Related Specs:
- `docs/specs/README.md`
- `docs/specs/pi-telegram-refactor-automation.md`
- `docs/specs/pi-memory.md`
- `docs/specs/pi-memory-bridge.md`
- `docs/specs/pi-memory-prompts.md`

## 1. Purpose

本文档定义 `Pi-Telegram` 在正式编写长期记忆系统前，需要先完成的**源码结构整理准备工作**。

重点不是立即实现 `pi-memory`，而是先把当前 `src/` 的结构整理到一个：

- 清晰
- 浅层
- 可批量迁移
- 可重复执行
- 便于后续扩展 `memory/` 模块

的状态。

本文档试图回答四个具体问题：

1. 当前 `src/` 结构的主要问题是什么
2. 在不做过深重构的前提下，推荐整理成什么样
3. 哪些职责边界要先明确，哪些先不拆
4. 如何**批量整理代码结构而不是手工逐文件搬迁**

---

## 2. Background and Current Snapshot

当前 `src/` 文件如下：

```text
src/
├── attachment.ts
├── bot.ts
├── cron-service.ts
├── cron-tool.ts
├── cron-types.ts
├── jsonl.ts
├── log.ts
├── main.ts
├── md2tg.ts
├── menu.ts
├── pi-rpc.ts
├── pool.ts
├── reply-tool.ts
├── tools.ts
├── types.ts
└── version.ts
```

当前主要文件体量：

- `src/bot.ts` ≈ 2504 行
- `src/cron-service.ts` ≈ 911 行
- `src/pi-rpc.ts` ≈ 480 行
- `src/main.ts` ≈ 446 行
- `src/menu.ts` ≈ 404 行

这说明项目已经明显超出“单入口小脚本”的阶段，但还没有进入规范模块化状态。

### 2.1 Observed import graph hotspots

基于当前 `src/*.ts` 的本地 import 关系，可以看到：

- `log.ts` 被多个核心模块引用，是共享基础设施
- `types.ts` 同时被 `bot.ts`、`main.ts`、`menu.ts`、`pi-rpc.ts` 依赖，是一个混合类型汇聚点
- `pool.ts` 同时被 `bot.ts`、`main.ts`、`menu.ts` 使用，是 pi 运行态的关键边界
- `bot.ts` 依赖 `menu.ts`、`attachment.ts`、`reply-tool.ts`、`cron-tool.ts`、`pool.ts`、`cron-service.ts`、`types.ts`
- `main.ts` 依赖 `pool.ts`、`bot.ts`、`cron-service.ts`、`tools.ts`、`version.ts`、`types.ts`

从这个结构看，当前天然存在四个模块簇：

1. Telegram 交互簇
2. pi 子进程簇
3. cron 调度簇
4. app/runtime 装配簇

问题不是“没有模块”，而是**模块已经客观存在，但还没有在目录和文件命名上显式表达出来**。

### 2.2 Current structural problems

#### A. Flat layout, unclear ownership

当前根目录文件虽然不多，但不同层级职责混在一起：

- 启动与配置：`main.ts`
- Telegram 交互：`bot.ts`, `menu.ts`, `md2tg.ts`, `attachment.ts`, `reply-tool.ts`
- pi 子进程：`pi-rpc.ts`, `pool.ts`, `tools.ts`
- cron：`cron-service.ts`, `cron-tool.ts`, `cron-types.ts`
- 通用工具：`jsonl.ts`, `log.ts`, `version.ts`, `types.ts`

这些文件都平铺在 `src/` 根下，后续再加入 `memory/` 会继续恶化。

#### B. Large files hide future seams

当前真正需要在“准备阶段”识别出来的，不是所有函数都拆，而是：

- 哪些文件的**模块归属已经足够明确**
- 哪些大文件即使暂时不深拆，也应该先放进自己的目录
- 哪些职责未来是 memory 最可能接入的插点

#### C. Type and config ownership is mixed

例如：

- `types.ts` 同时承担 app config、pi RPC、通用结构
- `tools.ts` 实际上是 Telegram 输出协议 system prompt 注册，不是通用工具库
- `main.ts` 同时承担路径管理、settings 规范化、版本检查、bot/pool/cron 装配、退出清理

#### D. Future memory module has no clean landing zone

如果现在直接新增 `src/memory/`：

- `main.ts` 会继续膨胀
- `bot.ts` 会继续承担更多 orchestration 责任
- `pi-rpc.ts` / `pool.ts` / `tools.ts` 的边界会更乱

因此，**先做结构整理，再做 memory** 是必要前置。

---

## 3. Goals

### 3.1 Main goals

1. 把 `src/` 从扁平结构整理为**浅层模块结构**
2. 在不做深度重构的前提下，先明确模块归属
3. 为未来 `src/memory/` 预留稳定落点
4. 通过批量脚本完成文件移动、import 重写、shim 生成
5. 避免人工逐文件搬迁和手工修 import
6. 不改变现有行为语义
7. 让结构迁移过程可重复、可审计、可回滚

### 3.2 Secondary goals

1. 让 `main.ts` 回到“薄入口”角色
2. 让 `bot.ts` 不再占据根目录与默认架构中心位置
3. 让 cron / pi / telegram 成为一眼可见的一级模块
4. 降低后续 memory 接入时的 merge risk
5. 为后续 selective seam extraction 留出稳定边界

---

## 4. Non-Goals

以下内容**不属于这份准备 spec**：

1. 立即实现 `pi-memory`
2. 立即深拆 `bot.ts` 内部所有命令与流程
3. 引入复杂 DI 容器 / IoC 框架
4. 引入过深的 feature nesting
5. 全面重写为 DDD / CQRS / 六边形架构
6. 立刻引入 tsconfig path alias 和运行时 alias 系统
7. 手工逐个修 import 的“人工大扫除”
8. 在同一个改动里同时完成“文件搬迁 + 大规模语义改写”
9. 在 Phase 1 就追求完美的类型重新归属

---

## 5. Design Principles

### 5.1 Shallow-first, not deep-first

这次整理的目标是：

- 先把归属明确
- 再考虑是否深拆

优先形成：

- `src/app/*`
- `src/telegram/*`
- `src/pi/*`
- `src/cron/*`
- `src/shared/*`
- `src/memory/*`

而不是一开始就进入：

```text
src/features/telegram/bot/handlers/messages/...
```

### 5.2 Mechanical move first, semantic split later

准备阶段优先做：

1. 文件归位
2. import 路径归一
3. 入口瘦身
4. 兼容 shim
5. 模块边界明确

而不是立刻做：

- 大量函数抽取
- 流程重组
- 抽象层层套娃

### 5.3 No behavior change in phase 1

首阶段目标应是：

- 路径变
- 目录变
- import 变
- 但行为不变

### 5.4 Batch automation over hand editing

任何可通过脚本完成的结构整理，都不应要求人工逐文件修改。

### 5.5 Explicit imports over barrels in phase 1

Phase 1 默认**不引入 `index.ts` barrel exports**。

原因：

- 机械迁移阶段最怕额外增加一层导出路径
- 当前项目使用 ESM `.js` 后缀 import
- 明确文件路径更利于脚本重写和定位问题

如果未来需要 `index.ts`，应放到 Phase 3 之后再评估。

---

## 6. Target Source Layout

建议整理后的一级结构如下：

```text
src/
├── main.ts
├── app/
├── telegram/
├── pi/
├── cron/
├── shared/
└── memory/
```

其中：

- 根目录长期只保留 `main.ts`
- 其他实现文件原则上不再长期停留在 `src/` 根下

### 6.1 Module responsibilities

#### `src/app/`

负责：

- 启动流程
- settings 读取与规范化
- 路径常量
- runtime 装配
- 版本检查 / changelog 提示
- 进程退出 / shutdown 协调

#### `src/telegram/`

负责：

- Telegram bot 创建
- 菜单
- 输出格式转换
- Telegram 回复/附件/cron 指令协议
- chat 交互层
- 命令注册与消息处理流程

#### `src/pi/`

负责：

- pi RPC 子进程封装
- pool
- pi 相关类型
- system prompt / tool prompt 的 pi 侧拼装支撑
- 未来 provider-registration extension 生成支撑

#### `src/cron/`

负责：

- cron store / scheduler / executor 协调
- cron directive parsing
- cron domain types

#### `src/shared/`

负责：

- 日志
- JSONL
- 少量通用基础设施
- 过渡期共享类型
- 通用版本信息辅助

#### `src/memory/`

当前阶段：

- 只预留模块落点，不实现主功能

未来负责：

- memory core
- ingest / extraction / consolidation
- retrieval / rerank / context assembly
- graph / URI / trace
- runtime pager / residency manager

---

## 7. Module Dependency Rules

准备阶段不仅要整理目录，还要明确**允许的依赖方向**。

### 7.1 Allowed dependency directions

推荐规则：

- `main.ts` -> `app/runtime.ts`
- `app/*` -> `telegram/*`, `pi/*`, `cron/*`, `shared/*`, `memory/*`
- `telegram/*` -> `pi/*`, `cron/*`, `shared/*`
- `pi/*` -> `shared/*`
- `cron/*` -> `shared/*`
- `memory/*` -> `shared/*`, `pi/*`, `cron/*`
- `shared/*` -> 不依赖本地业务模块

### 7.2 Forbidden or discouraged directions

准备阶段应尽量避免：

- `shared/*` -> 依赖任何业务模块
- `pi/*` -> 依赖 `telegram/*`
- `cron/*` -> 依赖 `telegram/*`
- `telegram/*` -> 直接依赖 `app/*`
- `memory/*` -> 直接耦合 Telegram 发送细节

### 7.3 Why this matters for memory

未来 memory 如果直接挂在 `bot.ts` 深处，会导致：

- Telegram 层与记忆核心绑死
- 内部 extraction / consolidation runner 很难复用
- bridge / provider extension 的职责边界不清楚

因此现在就要保证 memory 的未来入口更像：

- `app/runtime` 装配
- `telegram/create-bot` 调用 memory facade
- `pi/` 与 `memory/` 在 runtime 层被接线

而不是让 `memory/` 直接变成 `telegram/` 的子模块。

---

## 8. Recommended File Move Map

本阶段推荐的**机械迁移映射**如下。

### 8.1 App

```text
src/main.ts                -> src/app/runtime.ts
(new) src/main.ts          -> 薄入口，只 import/run runtime
```

建议新增：

```text
src/app/config.ts
src/app/paths.ts
src/app/types.ts          # 可选；若暂不拆则先不建
```

其中：

- `config.ts` 负责 `settings.json` 读取、默认值、normalize、rewrite queue
- `paths.ts` 负责 `telegramRoot/settingsPath/sessionsRoot/cronRoot/defaultWorkspace` 等路径

### 8.2 Telegram

```text
src/bot.ts                 -> src/telegram/create-bot.ts
src/menu.ts                -> src/telegram/menu.ts
src/attachment.ts          -> src/telegram/attachment.ts
src/reply-tool.ts          -> src/telegram/reply.ts
src/md2tg.ts               -> src/telegram/format.ts
src/tools.ts               -> src/telegram/tool-prompt.ts
```

说明：

- `tools.ts` 虽然名字泛，但其内容是 Telegram 输出协议 system prompt，更适合归属 `telegram/`
- `bot.ts` Phase 1 可以仍是大文件，但必须先从根目录退出

### 8.3 Pi

```text
src/pi-rpc.ts              -> src/pi/rpc.ts
src/pool.ts                -> src/pi/pool.ts
```

建议新增：

```text
src/pi/types.ts
```

说明：

- `PiRpcEvent`, `PiModelInfo`, `PiSessionStats`, `PiImage`, `PromptResult` 最终更适合归属 `pi/types.ts`
- 但不要求在机械迁移阶段一次性拆干净

### 8.4 Cron

```text
src/cron-service.ts        -> src/cron/service.ts
src/cron-tool.ts           -> src/cron/directives.ts
src/cron-types.ts          -> src/cron/types.ts
```

### 8.5 Shared

```text
src/jsonl.ts               -> src/shared/jsonl.ts
src/log.ts                 -> src/shared/log.ts
src/version.ts             -> src/shared/version.ts
src/types.ts               -> src/shared/types.ts   # 过渡方案
```

说明：

- `src/types.ts` 首阶段先整体迁到 `shared/types.ts`
- 第二阶段再考虑是否继续拆成：
  - `app/config.types.ts`
  - `pi/types.ts`
  - `telegram/types.ts`

### 8.6 Future reserved module

```text
(new) src/memory/
```

为了让空目录能进入 git，建议二选一：

```text
src/memory/README.md
```

或：

```text
src/memory/.gitkeep
```

推荐 `README.md`，写明：当前目录为记忆系统预留落点，尚未实现。

---

## 9. Target Depth Rules

为了避免目录过深，定义以下约束。

### 9.1 Maximum depth

在 `src/` 下建议：

- 一级模块目录最多一层
- 一般不超过：
  - `src/<module>/<file>.ts`

也就是说，优先允许：

```text
src/telegram/create-bot.ts
src/pi/rpc.ts
src/cron/service.ts
```

而不优先允许：

```text
src/telegram/bot/handlers/commands/create.ts
```

### 9.2 Exception rule

只有当某个一级模块内部文件数明显超过 8~10 个，并且职责已经自然分层时，才允许进入下一层。

本准备阶段默认**不主动引入第二层嵌套**。

### 9.3 Root hygiene rule

长期规则：

- `src/` 根目录只保留：`main.ts`
- 业务实现文件不再停留在根目录
- 若存在旧路径 shim，应视为过渡遗留而不是长期结构

---

## 10. Ownership and De-duplication Targets

这次整理不以“把所有重复逻辑抽干净”为目标，但要先明确哪些内容的归属已经清楚。

### 10.1 Paths ownership

以下路径不应继续在多文件中散落：

- `telegramRoot`
- `settingsPath`
- `sessionsRoot`
- `cronRoot`
- 默认 workspace 路径
- 未来 memory store/cache 路径

统一归属：

```text
src/app/paths.ts
```

### 10.2 Config normalization ownership

当前 `main.ts` 中的：

- `settings.json` 读取
- settings 模板生成
- cron config normalize
- `streamByChat` normalize
- settings rewrite queue

统一归属：

```text
src/app/config.ts
```

### 10.3 Telegram protocol ownership

Telegram 输出协议相关：

- markdown/plain/html 转换
- `<tg-attachment>` 解析
- `<tg-reply>` 解析
- `<tg-cron>` 解析

统一归属：

```text
src/telegram/*`
```

而不是由 `create-bot.ts` 一边处理消息、一边充当所有协议解析的长期承载体。

### 10.4 Pi process ownership

pi 子进程相关逻辑应限制在：

- `src/pi/rpc.ts`
- `src/pi/pool.ts`
- （未来）`src/pi/provider-extension.ts`

Telegram 层不要承担 subprocess 细节。

### 10.5 Cron domain ownership

Cron 相关核心状态与调度逻辑应固定在：

- `src/cron/service.ts`
- `src/cron/types.ts`
- `src/cron/directives.ts`

不要让 app/runtime 或 telegram 层复制 cron 规则。

### 10.6 Types ownership transition policy

`types.ts` 是当前最典型的“混合归属文件”。

过渡策略：

1. Phase 1：整体迁移到 `src/shared/types.ts`
2. Phase 2：逐步按 ownership 拆分
3. Phase 3：旧 `src/types.ts` 仅保留 shim 或删除

要求：

- 不在第一次机械迁移时一口气完成所有类型重构
- 避免把“文件搬迁”与“类型体系大改”绑成同一次大 diff

---

## 11. Migration Strategy

### 11.1 Phase 0 — Snapshot and protection

在真正迁移前，应先做：

1. 确认工作树状态
2. 记录当前 `src/` 文件清单
3. 记录 move map
4. 先跑一次 `npm run build` 作为基线

这一步的目标是保证：

- 迁移前项目处于可构建状态
- 后续能明确是“结构迁移引入的问题”而不是旧问题

### 11.2 Phase 1 — Mechanical module normalization

目标：

- 仅做文件归位
- 不做大规模行为修改
- 可接受大文件先原样迁移

动作：

1. 创建目标目录
2. 按 move map 批量迁移文件
3. 生成旧路径 shim 文件
4. 全局重写 import/export 路径
5. 生成新的薄入口 `src/main.ts`
6. 运行构建验证

### 11.3 Phase 2 — Entry slimming and app extraction

目标：

- `src/main.ts` 只保留启动入口
- `src/app/runtime.ts` 接管装配逻辑
- `src/app/config.ts` / `src/app/paths.ts` 接管基础启动职责

要求：

- `main.ts` 不再包含完整 settings normalize / runner / shutdown 协调
- `main.ts` 只负责调用 `runApp()` 或等价入口

### 11.4 Phase 3 — Selective seam extraction (optional before memory)

这一阶段不是必须立刻完成，但如果要继续为 memory 做准备，优先考虑：

- 从 `telegram/create-bot.ts` 中抽出：
  - auth guard
  - command registration
  - output sending
  - abort/new/session control
  - cron menu upsert 相关块
- 从 `app/runtime.ts` 中抽出：
  - config loading
  - path bootstrap
  - version notification
  - shutdown coordination

但本 spec 明确：

> 不要求在准备阶段把 `bot.ts` 完全切碎。

### 11.5 Phase 4 — Memory landing preparation

在结构整理完成后，再进行：

1. 建立 `src/memory/` 的 facade 与 README
2. 确定 memory 与 `telegram/`、`pi/`、`app/` 的接线点
3. 开始真正的 memory 设计落地

---

## 12. Compatibility Shim Policy

为了避免一次性改动过大，允许短期保留 shim 文件，例如：

```ts
// src/bot.ts
export * from "./telegram/create-bot.js";
```

同理可用于：

- `src/pi-rpc.ts`
- `src/cron-service.ts`
- `src/tools.ts`
- `src/types.ts`
- `src/menu.ts`
- `src/pool.ts`

这些 shim 的目标是：

- 降低机械迁移风险
- 允许 import rewrite 分阶段进行
- 便于回滚
- 让外部引用在过渡期不立刻全部失效

### 12.1 Shim constraints

shim 文件必须满足：

1. 只做 re-export，不新增业务逻辑
2. 不允许继续在 shim 中新增实现代码
3. 每个 shim 都应在迁移报告中被列出
4. 后续应有清理目标，而不是永久保留

### 12.2 Shim removal target

建议目标：

- 结构迁移完成后 1~2 个迭代内清理掉绝大部分 shim
- 最迟在开始 memory 实现前，把高频 shim 去掉

---

## 13. How to Batch Reorganize Without Manual Editing

这是本文档最关键的工程要求。

### 13.1 Principle

结构整理必须尽量通过**一次性脚本**完成，而不是手动：

- 手改 import
- 手动新建目录
- 手工复制/粘贴文件
- 手工检查遗漏路径

### 13.2 Proposed approach

建议引入一个**布局清单 + AST 重写脚本**的方案。

#### A. Layout manifest

新增：

```text
scripts/refactor/module-layout.json
```

建议结构：

```json
{
  "moves": {
    "src/bot.ts": "src/telegram/create-bot.ts",
    "src/pi-rpc.ts": "src/pi/rpc.ts",
    "src/pool.ts": "src/pi/pool.ts",
    "src/cron-service.ts": "src/cron/service.ts",
    "src/cron-tool.ts": "src/cron/directives.ts",
    "src/cron-types.ts": "src/cron/types.ts",
    "src/menu.ts": "src/telegram/menu.ts",
    "src/attachment.ts": "src/telegram/attachment.ts",
    "src/reply-tool.ts": "src/telegram/reply.ts",
    "src/md2tg.ts": "src/telegram/format.ts",
    "src/tools.ts": "src/telegram/tool-prompt.ts",
    "src/jsonl.ts": "src/shared/jsonl.ts",
    "src/log.ts": "src/shared/log.ts",
    "src/version.ts": "src/shared/version.ts",
    "src/types.ts": "src/shared/types.ts",
    "src/main.ts": "src/app/runtime.ts"
  },
  "shims": [
    "src/bot.ts",
    "src/pi-rpc.ts",
    "src/cron-service.ts",
    "src/tools.ts",
    "src/types.ts"
  ],
  "createFiles": {
    "src/main.ts": "import { runApp } from \"./app/runtime.js\";\n\nvoid runApp();\n",
    "src/memory/README.md": "# memory\n\nReserved for future pi-memory implementation.\n"
  }
}
```

#### B. Apply script

新增：

```text
scripts/refactor/apply-module-layout.mjs
```

职责：

1. 读取 manifest
2. 校验 move map 不冲突
3. 创建目标目录
4. 批量移动文件
5. 在旧路径写 shim re-export 文件
6. 生成新的薄入口 `src/main.ts`
7. 全局扫描 `src/**/*.ts` 并重写 import/export 路径
8. 输出变更报告
9. 调用构建验证

#### C. Import rewrite strategy

推荐使用：

- TypeScript compiler API
- 或 `ts-morph`

从当前仓库依赖最小化角度，优先建议使用已有 `typescript` 依赖，通过 compiler API 完成：

- import/export specifier 解析
- old path -> new path 映射
- 相对路径重新计算
- ESM `.js` 后缀保留

### 13.3 Why AST rewrite instead of regex

纯 regex 替换风险较高，因为：

- ESM `.js` 后缀路径需要正确重算
- `export * from ...`、`export { ... } from ...` 也要改
- 同一路径可能以不同相对层级出现
- 未来还可能有 type-only import/export

因此应使用 AST 或至少基于 TS module specifier 的精确处理。

### 13.4 Dry-run requirement

脚本必须支持：

```bash
node scripts/refactor/apply-module-layout.mjs --dry-run
```

输出：

- 将移动哪些文件
- 将改写哪些 import/export
- 将生成哪些 shim
- 将创建哪些新文件
- 是否存在 unresolved target 或循环覆盖

### 13.5 Verification pipeline

脚本执行完成后应自动串行运行：

1. `npm run build`
2. unresolved import 检查
3. 可选：目录布局检查

若失败，则：

- 输出失败报告
- 保持可回滚

### 13.6 Rollback strategy

推荐脚本具备至少一种回滚策略：

- 基于 git 工作树回滚：要求在干净工作树或明确确认下执行
- 或先复制到临时目录，成功后再覆盖

最简单的工程策略是：

1. 要求在 git 管理下运行
2. Dry-run 确认后再 apply
3. 失败时由 `git restore` / `git reset --hard` 回滚

### 13.7 Report format

脚本最终应输出一个结构化报告，至少包含：

- moved files count
- rewritten imports count
- generated shims count
- created files count
- build status
- remaining root files
- remaining shim files

### 13.8 Why this is enough for the preparation phase

因为准备阶段的目标不是“自动理解业务并重构逻辑”，而是：

- 自动完成机械搬运
- 自动完成 import 归一
- 自动生成兼容层
- 自动建立模块骨架

这已经能解决 80% 以上的结构整理工作量。

---

## 14. Script Pseudocode

以下伪代码用于约束自动化脚本行为。

```text
load manifest
validate moves/shims/createFiles
ensure no target collisions
ensure old path exists for each move

for each move:
  create target directory
  move source file -> target path

for each source file in project:
  parse TS AST
  rewrite local import/export specifiers according to move map
  write file back if changed

for each shim path:
  generate re-export shim pointing to moved target

for each createFile entry:
  create file if missing or overwrite only when managed by script policy

run npm run build
collect report
exit with non-zero status on failure
```

### 14.1 Module specifier rewrite rules

对于：

```ts
import { createBot } from "./bot.js";
```

若 `src/bot.ts -> src/telegram/create-bot.ts`，则：

- 对于 `src/app/runtime.ts` 应重写为：

```ts
import { createBot } from "../telegram/create-bot.js";
```

- 对于仍暂时保留 shim 的旧文件，允许继续引用旧路径，但优先改成新路径

### 14.2 Managed file policy

脚本应区分：

- moved file
- generated shim
- generated entry file
- untouched file

避免后续运行时误覆盖手工写入内容。

---

## 15. Recommended Immediate Target After Refactor

完成这份准备 spec 后，`src/` 理想上应接近：

```text
src/
├── main.ts
├── app/
│   ├── runtime.ts
│   ├── config.ts
│   └── paths.ts
├── telegram/
│   ├── create-bot.ts
│   ├── menu.ts
│   ├── attachment.ts
│   ├── reply.ts
│   ├── format.ts
│   └── tool-prompt.ts
├── pi/
│   ├── rpc.ts
│   ├── pool.ts
│   └── types.ts           # 可后置
├── cron/
│   ├── service.ts
│   ├── directives.ts
│   └── types.ts
├── shared/
│   ├── jsonl.ts
│   ├── log.ts
│   ├── version.ts
│   └── types.ts
└── memory/
    └── README.md
```

说明：

- `memory/` 当前只需作为稳定落点存在
- `pi/types.ts` 可以是后续增量，不要求第一步就完整落地
- 若 Phase 1 结束时仍有少量 shim 文件存在，可以接受
- 但根目录不应继续长期堆放业务实现文件

---

## 16. Quality Gates and Smoke Checklist

结构迁移不是只看 TypeScript 编译通过，还要验证几个关键行为没有被误伤。

### 16.1 Required gates

1. `npm run build` 通过
2. 无 unresolved local import
3. `src/` 根目录仅剩 `main.ts` 与允许的过渡 shim
4. 目录深度符合规则
5. 迁移报告可复现

### 16.2 Minimum smoke checklist

完成机械迁移后，至少手动验证：

1. 启动程序
2. 普通对话消息正常
3. `/status` 正常
4. `/cron` 菜单正常
5. `/abort` 正常
6. `/abortall` 正常
7. `/new` 正常
8. 模型菜单 / stream 菜单可用

### 16.3 Why smoke still matters

因为这次整理目标虽然是不改行为，但：

- 入口拆分
- import 重写
- shim 生成
- 目录结构变化

都可能带来运行期问题，仅靠编译不足以完全覆盖。

---

## 17. Risks and Mitigations

### 17.1 Import suffix mistakes

风险：

- TypeScript 源码里使用 `.js` module specifier
- 重写相对路径时容易路径正确但后缀遗漏

缓解：

- 使用 AST + path relative 统一重算
- 构建后做 unresolved import 检查

### 17.2 Shim divergence

风险：

- 迁移后新逻辑又被错误地写回旧 shim 文件

缓解：

- 在 spec 和代码注释中明确 shim 仅做 re-export
- 在清理阶段优先删除高频 shim

### 17.3 Over-refactoring in one pass

风险：

- 把“文件迁移”“函数抽取”“逻辑重组”绑在同一次提交里，导致难以审查与回滚

缓解：

- 第一阶段只做机械迁移
- 第二阶段再做入口瘦身与轻量抽取

### 17.4 Memory module coupling too early

风险：

- 在结构整理还没完成前就开始插入 memory，最终把 memory 绑死在 `bot.ts`

缓解：

- 先完成 `app/telegram/pi/cron/shared` 归位
- 再正式建立 `memory/` facade

---

## 18. Deliverables

完成这份准备阶段后，建议至少产出：

1. `docs/specs/pi-telegram-pre-memory-prep.md`
2. `docs/specs/README.md`
3. 一次性迁移方案（可通过临时 `scripts/refactor/*` 落地）
4. `src/memory/README.md`（或等价占位文件）

其中：

- 第 1、2 项属于文档交付
- 第 3 项属于一次性结构整理辅助
- 第 4 项属于 future memory 落点占位

说明：

- 若结构迁移已经完成，则一次性迁移脚本不要求长期保留在仓库中

---

## 19. Acceptance Criteria

完成本准备阶段后，应满足：

1. `npm run build` 通过
2. `src/` 一级目录清晰，未来 `memory/` 有稳定落点
3. `main.ts` 已恢复为薄入口
4. `bot.ts` / `pi-rpc.ts` / `cron-service.ts` 不再作为根目录主文件长期存在（允许短期 shim）
5. 无需人工逐文件修 import
6. 结构迁移可以通过脚本复现
7. 目录层级不过深
8. 不引入行为变更
9. 关键 Telegram 命令 smoke 验证通过
10. 迁移结果能够作为 memory 开发前的稳定基线

---

## 20. Recommended Next Steps

在正式编写记忆系统之前，建议按如下顺序执行：

1. 定稿本准备 spec
2. 写定 `scripts/refactor/module-layout.json`
3. 编写 `scripts/refactor/apply-module-layout.mjs`
4. 先做 dry-run
5. 执行机械迁移 + shim + import 重写
6. 让 `main.ts` 变薄
7. 跑构建与 smoke checklist
8. 之后再开始 `src/memory/` 的真正设计与接入

这条路径的特点是：

- 不深拆
- 不手工搬文件
- 不提前过度设计
- 但足够规范化
- 能为 `pi-memory` 提供干净落点

非常适合作为 `Pi-Telegram` 在记忆系统实现前的准备工作。
