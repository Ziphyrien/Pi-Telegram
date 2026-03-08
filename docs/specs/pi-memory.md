# pi-memory Spec

Status: Draft
Owner: TBD
Last Updated: 2026-03-08
Related Specs:
- `docs/specs/README.md`
- `docs/specs/pi-telegram-pre-memory-prep.md`
- `docs/specs/pi-telegram-refactor-automation.md`
- `docs/specs/pi-memory-bridge.md`
- `docs/specs/pi-memory-prompts.md`
- `docs/specs/pi-memory-related-work.md`

## 1. Summary

`pi-memory` 是 **Pi-Telegram 内置的长期记忆子系统**，并配套一个**临时加载到 pi 进程中的 bridge 扩展**。

也就是说：

- **主记忆引擎（Memory Core）运行在 Pi-Telegram 内部**
- **pi 扩展只做 bridge / hook 层**
- `Pi-Telegram` 负责记忆数据库、图谱抽取、混合检索、TMT 巩固、URI 管理
- bridge 扩展负责在 pi 生命周期事件里把数据送到 Pi-Telegram，再把记忆上下文注入回当前 turn
- `pi-memory` **不单独版本化**，它算作 `Pi-Telegram` 主程序的一部分
- `pi-memory-bridge` 位于 `Pi-Telegram` **同一仓库**中，并与主程序**同版本发布、同 ref 绑定**

它的核心目标是：

- 让基于 pi 的代理记住用户历史对话、偏好、习惯和长期约束
- 在跨会话场景下持续复用记忆
- 通过 **LLM 提取层** 把原始对话转成高质量、可检索、可合并的记忆条目
- 使用本地 SQLite / 文件持久化
- 调用外部 LLM API 和 Embedding API
- 通过 pi 扩展事件（如 `before_agent_start`、`agent_end`、`session_before_switch`、`session_shutdown`）桥接 agent 生命周期
- 让 `Pi-Telegram` 成为长期记忆、图谱、检索和调度的唯一主控层

本 spec 的核心结论是：

> `pi-memory` 采用 **联邦式分层记忆架构（Federated Layered Memory）**，并吸收论文 **TiMem: Temporal-Hierarchical Memory Consolidation for Long-Horizon Conversational Agents**（arXiv:2601.02845）的三个关键机制：
>
> 1. **Temporal Memory Tree (TMT)**：把时间连续性作为一等组织原则；
> 2. **Semantic-Guided Consolidation**：用子记忆 + 同层历史 + 层级提示词做分层巩固；
> 3. **Complexity-Aware Recall**：按查询复杂度动态决定召回层级与范围。
>
> 同时，本架构增加一个 **Canonical URI Layer**：
>
> 4. **Canonical URI Layer**：为 scope / memory node / entity / edge / raw turn 提供稳定标识、可追踪引用与 URI-family 级别去重。

也就是说，本架构不只是在“作用域上分布”，还在“时间抽象层级上分布”，并且引入了统一身份层：

- **横向**：按 plane / scope 联邦组织
- **纵向**：按时间层级 T1-T5 逐级巩固
- **身份层**：按 canonical URI 统一引用、追踪和去重

本 spec 只定义产品与系统设计，不直接开始实现。

---

## 2. Background

当前 `Pi-Telegram` 已具备：

- Telegram → pi 的消息桥接
- 每个 chat 独立 session
- 会话持久化
- 定时任务
- 回复上下文、图片、文件传递

但它缺少一个“长期记忆层”：

- 当前上下文主要依赖单个 session 文件
- 新建会话后，用户偏好和长期事实不会自动保留
- 模型无法稳定记住“跨会话仍然成立”的信息
- 无法把“项目层约束”“个人偏好”“长期事实”“临时任务记忆”“行为纠偏”统一建模

`Mem0` 更像工具包，不包含完整记忆架构；`MemGPT` / `Letta` 作为完整系统接入成本较高，且不适合当前项目最小改造路径。因此需要设计一个**内聚、轻量、可控**的长期记忆子系统。

但 `MemGPT` 提供的若干思想仍然值得吸收，尤其是：

- 把 prompt context 视为稀缺资源
- 引入 working context / recall / archival 的层次化驻留模型
- 用 memory pressure warning、recursive summary、function-chained retrieval 做虚拟上下文管理

同时，已经明确以下约束：

- **主记忆功能优先集成在 Pi-Telegram 内部**
- pi 侧只保留一个 **bridge 扩展**，用于 hook 生命周期并与 Pi-Telegram 通信
- `pi-memory-bridge` 位于 **Pi-Telegram 同一仓库**中，由 Pi-Telegram 按自身 GitHub ref 临时一次性加载给 pi 进程，但允许本地缓存
- `pi-memory` 不单独作为独立产品或独立仓库维护
- 不需要给 pi TUI 注册命令或 renderer 作为主交互面
- `Pi-Telegram` 负责启动 pi、传入 scope、维持 chat 与 session 的边界
- 存储后端优先本地 SQLite / 文件
- 提取和向量化依赖外部 API
- 写入时机必须优雅，不能粗暴每轮直写

论文 `TiMem` 的启发点在于：

- 长程会话记忆不能只靠单层 summary 或单桶向量库
- 时间连续性要被显式建模
- 高层抽象记忆应由低层记忆逐步巩固，而不是一次性扁平总结
- 召回不应固定；应按查询复杂度动态决定召回深度

因此，首选架构应为：

> **Pi-Telegram 内置 `pi-memory` 主引擎 → 在同仓库中维护 `packages/pi-memory-bridge` → 启动 pi 时按当前 Pi-Telegram 版本对应的 GitHub ref 提取并临时加载该 bridge 子目录 → bridge 扩展在 pi 生命周期事件中与 Pi-Telegram 通信 → 由 Pi-Telegram 统一完成 SQLite、图谱、检索、巩固与注入。**

### 2.1 Research foundations

`pi-memory` 的设计不是从单篇论文直接翻译而来，而是吸收多条研究线索：

- **TiMem**：提供时间层级巩固、planner、hierarchical recall、gating
- **HyMem**：提供 query complexity 驱动的动态检索调度
- **2511.17208 event-centric baseline**：提供 dense–sparse integration、事件中心 memory unit、graph anchor retrieval
- **QRRanker**：提供 retrieval 与 rerank 分层思想
- **MemoRAG**：提供 clue-guided retrieval 的思路
- **LightMem**：提供 sleep-time / offline consolidation 的思路
- **A-MEM / Hindsight / CMA / MemoryBank**：补充图结构、反思、遗忘、选择性强化与长期用户画像
- **MemGPT**：提供 virtual context management、working context / recall / archival 分层、memory pressure 与 recursive summary 的控制思想

详细文献整理见：

- `docs/specs/pi-memory-related-work.md`
- `docs/specs/pi-memory-prompts.md`
- `docs/specs/pi-memory-bridge.md`

### 2.2 Codebase preparation prerequisite

在 `Pi-Telegram` 当前代码结构下，`pi-memory` **不应直接叠加到现有扁平 `src/` 根目录上实现**。

在真正进入 memory implementation 之前，必须先完成一轮**浅层模块化整理**，其目标不是大规模语义重构，而是：

- 明确 `app / telegram / pi / cron / shared / memory` 的一级模块边界
- 让 `main.ts` 回到薄入口角色
- 让 `bot.ts`、`pi-rpc.ts`、`cron-service.ts` 等大文件先退出根目录
- 为 future `src/memory/` 提供稳定落点
- 用脚本完成文件搬迁、import 重写与 shim 生成，而不是手工逐文件修改

这部分前置工作由以下文档定义：

- `docs/specs/pi-telegram-pre-memory-prep.md`
- `docs/specs/pi-telegram-refactor-automation.md`

本 spec 与这两份文档的关系是：

- `pi-telegram-pre-memory-prep.md` 定义**整理目标结构与边界**
- `pi-telegram-refactor-automation.md` 定义**如何批量实施结构迁移**
- 本文档定义**结构整理完成后，memory 应落在哪些模块与运行边界上**

换句话说：

> `pi-memory` 的实现前提不是“先把记忆逻辑塞进 `bot.ts`”，而是“先把代码库整理到可以承载 memory core 的状态”。

---

## 3. Goals

### 3.1 Product Goals

1. **长期记忆**
   - 记住用户偏好、约束、常见项目背景、历史决定
2. **跨会话持久化**
   - `/new` 后仍能恢复有用记忆
3. **混合作用域**
   - 同时支持 chat-local、user-global、workspace-global 记忆
4. **混合检索**
   - 同时支持语义检索和简单检索（关键词 / 实体 / 时间 / 类型）
5. **优雅写入时机**
   - 不在每条 token 或每个流式片段上立刻写库
   - 只在稳定、边界明确、价值足够高时写入
6. **bridge 式接入**
   - 通过一个轻量 pi bridge 扩展接入生命周期事件
   - 不要求改造 pi 核心
7. **临时可加载同仓库 bridge**
   - bridge 扩展来自 `Pi-Telegram` 同仓库的指定 ref 与子目录
   - 由 Pi-Telegram 管理缓存、版本固定与启动注入
8. **行为记忆优先级明确**
   - 把 procedural / correction 单独成层，而不是和普通 preference 混在一起
9. **时间连续性显式建模**
   - 不是只存记忆条目，而是保留从细粒度证据到高阶人格/项目画像的巩固链路
10. **复杂度感知召回**
    - 简单问题不必召回整棵树；复杂问题才扩大召回范围
11. **稳定身份与可追踪引用**
    - 通过 URI 让 node / scope / entity / edge / turn 都有稳定标识
    - 支持 URI-family 级别的 dedupe、trace 和 ancestry propagation

### 3.2 Technical Goals

1. 使用本地 SQLite 持久化
2. 外部 API 提供：
   - LLM 提取 / 巩固 / gating
   - Embedding 生成
3. 支持可演进的数据模型与检索策略
4. 对 `Pi-Telegram` 的侵入尽量小
5. 优先单机可用，再考虑更复杂能力
6. 主记忆引擎运行在 Pi-Telegram 进程内；bridge 扩展运行在 pi 进程内
7. Pi-Telegram 与 bridge 扩展之间通过本地 bridge API 通信，且 bridge 仅在当前运行期间临时加载
8. bridge 的来源、版本与协议兼容性由 Pi-Telegram 主程序统一约束
9. 支持 TiMem 风格的层级巩固与复杂度感知召回，但保留对 Telegram / coding-agent 场景的适配

---

## 4. Non-Goals

以下内容不在首版范围内：

1. 多节点分布式部署 / 集群一致性
2. 复杂权限系统 / 多租户 SaaS 形态
3. 完整知识图谱平台
4. 自动长期计划执行器
5. 独立守护进程式本地服务
6. 重写 pi 自身会话系统
7. 首版即做复杂图关系推理引擎
8. 首版即做完全自动、不可解释的“黑盒人格建模”

---

## 5. Key Decisions

## 5.1 “分布式记忆”的正式定义

本 spec 中，“分布式记忆”指**逻辑分布式**，不是多节点部署。

也就是说，记忆不是塞进一个单桶里，而是按多个维度分布：

- **作用域分布**：chat / user / workspace / system
- **记忆平面分布**：episodic / profile / project / procedural
- **时间层级分布**：T1 / T2 / T3 / T4 / T5
- **索引分布**：semantic / lexical / entity / temporal
- **生命周期分布**：raw buffer / hot / warm / cold

因此，系统采用：

> **Federated Layered Memory + Temporal Memory Tree**

即：

- 写入时，记忆先被提取，再被路由到不同平面与作用域，并在各自树中逐级巩固
- 检索时，不是全库混搜，而是各平面分开召回，再统一重排与组装

## 5.2 Packaging and Runtime Model

`pi-memory` 的主运行形态不是“把主逻辑做成独立 pi 扩展”，而是：

- **`pi-memory` 属于 Pi-Telegram 主程序本体，不单独版本化**
- **主记忆引擎集成在 Pi-Telegram 内**
- **`pi-memory-bridge` 位于 Pi-Telegram 同一仓库内**（例如 `packages/pi-memory-bridge`）
- bridge 扩展运行在 pi 进程内，并通过本地 bridge API 调用 Pi-Telegram
- bridge 扩展在语义上是“临时加载”的，不写入用户全局 / 项目 pi settings
- 物理实现上允许 Pi-Telegram 对**同仓库、同 ref** 的 bridge 子目录做本地缓存，以提高稳定性与启动速度

因此本系统有两个组成部分：

1. `Pi-Telegram` 主程序内的 `pi-memory` Memory Core
2. `Pi-Telegram` 同仓库内的 `pi-memory-bridge` 扩展目录

### 5.2.1 Version ownership and binding

版本规则正式定义为：

- `pi-memory` **不单独发版**，跟随 `Pi-Telegram` 主版本
- `pi-memory-bridge` 也**不是独立产品**，其版本应与 `Pi-Telegram` 主版本保持一致
- bridge-only 变更也应通过新的 `Pi-Telegram` release 交付，而不是单独发布 bridge
- 运行时除了检查版本外，还应检查一个独立的 `bridgeProtocolVersion`
- MVP 采用**严格绑定**：
  - `bridge.version === app.version`
  - `bridge.bridgeProtocolVersion === app.bridgeProtocolVersion`

## 5.3 Global Memory Taxonomy

“global” 不再是一个单桶，而是正式拆分为：

- `user-global`
- `workspace-global`

可选保留：

- `system-global`（极少量系统级默认记忆）

## 5.4 Procedural / Correction Single Plane

`procedural` / `correction` 记忆**正式单独成层**。

原因：

- 它们本质上是行为规则，不是普通事实或偏好
- 召回优先级应高于其他记忆
- 通常具有“覆盖旧规则”的语义

例子：

- “编写 spec 而不是直接开始”
- “统一停止动作和 /new 的行为一致”
- “流式停止时先结束输出，再额外弹出 🛑 已中止”

## 5.5 TiMem-inspired commitments

本 spec 吸收 TiMem 的以下设计承诺：

1. **Temporal continuity is first-class**
   - 时间连续性不是 metadata，而是结构的一部分
2. **Consolidation is hierarchical, not flat**
   - 高层记忆由低层记忆逐步巩固而来
3. **Recall should be adaptive**
   - 不同复杂度问题应走不同召回路径
4. **Instruction-guided consolidation over fine-tuning**
   - 首版不依赖专门微调模型
5. **Efficiency matters**
   - 目标不是召回越多越好，而是更少、更准、更稳

## 5.6 Canonical URI Layer

本 spec 正式引入 **Canonical URI Layer**，作为 plane / scope / temporal level 之外的独立身份层。

URI 的职责不是替代检索，而是提供：

- **稳定身份**：每个 memory node、scope、entity、edge、raw turn 都有可持久引用的标识
- **追踪能力**：高层记忆可以追溯到来源 turn、child memories 和历史修订链
- **结构化表示**：缓解 TiMem 中“高层记忆结构化表示不足”的限制
- **URI-aware dedupe**：同一 canonical family 下的不同版本、不同层级节点可以被统一管理
- **调试与运维**：支持 URI 级别的 show / trace / links / forget 能力（由 Pi-Telegram API 或 Telegram 侧命令承载）

推荐采用 **URN 风格** URI，而不是把本地记忆对象伪装成网络 URL。

## 5.7 MemGPT-inspired Virtual Context Management

本 spec 额外吸收 **MemGPT** 的一个关键结论：

> 对长期记忆系统而言，真正稀缺的不是“数据库容量”，而是**当前可放进 prompt 的主上下文容量**。

因此，`pi-memory` 除了 plane / scope / temporal level / URI 这些长期结构外，还应显式建模一个与之正交的**上下文驻留层（context residency layer）**。

该层不负责定义记忆“是什么”，而负责定义记忆**当前驻留在哪里**：

- 是否驻留在当前 turn 的 working set 中
- 是否只保存在 recall store 中，等待被重新拉回上下文
- 是否位于 archival store 中，作为长期外部记忆

需要特别强调：

- 这**不是新的 memory plane**
- 这是一个受 MemGPT 启发的**运行时上下文管理层**
- 它与 plane / scope / TMT / URI 是正交关系

它主要影响：

- prompt budget 管理
- recursive session summary
- memory pressure warning
- context pager / working-set compiler
- recall 与 archival 之间的数据回填策略

---

## 6. High-Level Architecture

```text
+--------------------------------------------------+
|                  Pi-Telegram                     |
|--------------------------------------------------|
| Memory Core                                      |
| - SQLite / FTS5                                  |
| - URI layer                                      |
| - entity / relation / event extraction           |
| - T1~T5 consolidation                            |
| - hybrid retrieval                               |
| - planner / rerank / gating                      |
| - graph fusion                                   |
| - context residency manager / pager              |
| - queue summary / memory pressure controller     |
| - local bridge API                               |
+-------------------------+------------------------+
                          ^
                          | local bridge API
                          v
+--------------------------------------------------+
|         pi + pi-memory-bridge extension          |
|--------------------------------------------------|
| Hook Layer                                       |
| - before_agent_start                             |
| - agent_end                                      |
| - session_before_switch                          |
| - session_shutdown                               |
| - context injection                              |
+-------------------------+------------------------+
                          ^
                          | RPC
                          v
+--------------------------------------------------+
|                     pi runtime                   |
+--------------------------------------------------+
```

### 6.1 Responsibility Split

#### Pi-Telegram (Memory Core Owner)

- 启动 pi（RPC 模式）
- 为每个 chat 提供稳定的 memory scope
- 持有 SQLite / 图谱 / URI / TMT / retrieval 主逻辑
- 维护 MemGPT-inspired 的 context residency manager / pager
- 读取 `C:\Users\Administrator\.pi\telegram\settings.json` 作为 memory 模型配置源
- 直接初始化 embedding client（OpenAI SDK 兼容端点）
- 根据简化后的 memory LLM 配置生成临时 provider-registration extension
- 暴露本地 bridge API 给扩展调用
- 管理 bridge 扩展的获取、缓存与版本固定
- 按需启动内部 extraction / consolidation / planner 用的独立 pi RPC 进程

#### pi-memory-bridge extension

- 在 `before_agent_start` 向 Pi-Telegram 请求 memory context
- 在 `agent_end` 把完整 turn 数据回传给 Pi-Telegram
- 在 `session_before_switch` / `session_shutdown` 请求 flush
- 不持有长期记忆数据库
- 不承担主记忆引擎逻辑
- MVP 不注册 pi TUI 命令或 renderer

#### Temporary provider-registration extension

- 由 Pi-Telegram 根据 `settings.json` 在运行时临时生成或填充
- 使用 `pi.registerProvider()` 以 pi custom provider 同款逻辑注册 memory LLM provider
- 可被注入到主对话 pi 进程和内部 extraction pi 进程
- 不负责 memory bridge、上下文注入或长期记忆主逻辑

#### External APIs

- Memory LLM：用于提取、归一化、评分、分类、去重辅助判断、recall gating
- Embedding API：用于语义搜索

---

## 7. Same-Repo Bridge Distribution and Caching Model

`pi-memory` 与 `pi-memory-bridge` 都属于 `Pi-Telegram` 仓库；其中 `pi-memory-bridge` 不是独立产品，而是**同仓库内部 bridge 扩展**。

### 7.1 Repository layout

推荐仓库结构：

```text
Pi-Telegram/
├── src/
│   └── memory/
│       ├── core/
│       ├── store/
│       ├── retrieval/
│       ├── extraction/
│       └── bridge-server/
└── packages/
    └── pi-memory-bridge/
        ├── package.json
        ├── bridge.manifest.json
        └── extensions/
            └── memory-bridge.ts
```

### 7.2 Runtime loading model

bridge 扩展应满足：

- 对用户而言是**临时加载**
- 不写入 `~/.pi/agent/settings.json`
- 不写入 `.pi/settings.json`
- 只在当前由 Pi-Telegram 启动的 pi 进程中生效
- 其**权威来源**是 `Pi-Telegram` 仓库自身的某个 Git ref + 子目录，而不是独立 bridge 仓库

### 7.3 GitHub source model

Pi-Telegram 应维护一个内部 source tuple，而不是把 bridge 视为独立仓库：

```text
repo   = github.com/<owner>/Pi-Telegram
ref    = <app-tag-or-commit>
subdir = packages/pi-memory-bridge
```

其中 `<ref>` 推荐使用：

- 与当前 `Pi-Telegram` release 对应的 tag
- 或当前构建对应的 commit hash

不建议长期依赖浮动分支名（如 `main`）作为稳定生产来源。

### 7.4 Version and protocol binding

bridge 的版本管理规则：

- `pi-memory` 不单独发版，跟随 `Pi-Telegram`
- `pi-memory-bridge` 的 `package.json.version` 应与 `Pi-Telegram` 主版本一致
- bridge-only 修复也应通过新的 `Pi-Telegram` patch/minor release 交付
- 运行时还应校验 `bridgeProtocolVersion`
- MVP 采用**精确匹配**：
  - `bridge.version === app.version`
  - `bridge.bridgeProtocolVersion === app.bridgeProtocolVersion`

### 7.5 Bridge manifest

建议在 `packages/pi-memory-bridge/bridge.manifest.json` 中保存最小元数据：

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
- `appVersion` 与当前主程序版本一致
- `bridgeVersion` 与当前主程序版本一致
- `bridgeProtocolVersion` 与主程序期望值一致
- `entry` 指向的扩展入口存在

### 7.6 Cache strategy

虽然语义上是“按当前 Pi-Telegram GitHub ref 临时加载 bridge”，但物理实现上建议由 Pi-Telegram 做本地缓存：

```text
~/.pi/telegram/extensions-cache/<repo>@<ref>/<subdir>/p<protocol>/
```

启动策略建议：

1. 根据当前主程序构建信息得到 `repo/ref/subdir/protocol`
2. 若本地缓存不存在，则拉取/下载当前 `Pi-Telegram` 仓库 ref
3. 提取 `packages/pi-memory-bridge`
4. 校验 `bridge.manifest.json` 与入口文件
5. 若缓存已存在且校验通过，则直接复用
6. 启动 pi 时使用本地缓存路径作为 `-e` 参数

即：

- **来源是 Pi-Telegram 自己的 GitHub 仓库**
- **运行时加载是临时的**
- **底层允许缓存以避免重复下载和网络抖动**
- **缓存 key 同时受版本和协议版本约束**

### 7.7 Why local cached path is preferred

相比每次都直接：

```text
pi -e git:github.com/...
```

更推荐：

```text
pi -e <cached-local-extension-path>
```

原因：

- 启动更快
- 网络故障时更稳
- 多 chat 并发时不重复下载
- 更容易做版本锁定与审计
- 更容易确认“当前加载的是哪个 app ref、哪个 bridge version、哪个 protocol”

### 7.8 Bridge package shape

bridge 扩展可保持尽量小：

```text
packages/pi-memory-bridge/
├── package.json
├── bridge.manifest.json
├── README.md
└── extensions/
    └── memory-bridge.ts
```

MVP 不需要：

- TUI commands
- TUI renderers
- 本地数据库
- graph / retrieval 主逻辑

---

## 8. Distributed Memory Architecture

本节定义系统的核心：**联邦式平面 + TiMem 风格时间树 + 联邦召回**。

### 8.1 Two orthogonal axes

本架构有两条正交维度：

#### A. Plane / Scope axis（联邦维度）

回答“这条记忆属于谁 / 属于哪类长期空间”：

- plane：episodic / profile / project / procedural
- scope：chat-local / user-global / workspace-global / system-global

#### B. Temporal hierarchy axis（时间抽象维度）

回答“这条记忆位于哪个时间抽象层级”：

- T1：细粒度证据
- T2：局部总结
- T3：短期模式
- T4：中期趋势
- T5：稳定画像 / 宪章级抽象

> 关键点：
> **plane 不是 temporal level。**
> plane 决定“记忆的角色”，temporal level 决定“记忆的抽象深度”。

### 8.2 Memory Planes

#### L0. Raw Turn Buffer

原始对话缓冲层，不直接参与长期召回。

存放：

- user / assistant 完整消息
- 时间戳
- scope
- 提取状态
- source turn ids

职责：

- 作为 LLM 提取输入原料
- 失败时可重试
- 保留最小审计链路

#### L1. Chat Episodic Memory

chat 级情景记忆。

存放：

- 某个 chat 内的重要事实
- 某次会话形成的局部决策
- 针对这个 chat 的临时约束
- chat 内未完成任务

特征：

- 默认优先写入这一层
- 与当前 chat 强相关
- 检索时权重高、时间相关性强

#### L2. User / Profile Memory

跨 chat 的稳定用户画像 / 偏好记忆。

存放：

- 用户长期偏好
- 输出风格偏好
- 工作习惯
- 常见技术栈
- 持续性的纠偏

特征：

- 这是 user-global 的核心层
- 不能轻易污染
- 只应由高置信度规则写入或提升而来

#### L3. Workspace / Project Memory

项目级 / 工作区级共享记忆。

存放：

- 项目背景
- 仓库约束
- 架构选择
- 项目术语
- 工作区长期知识

特征：

- 不属于某个 chat
- 也不完全属于某个人
- 属于 workspace-global 的核心层

#### L4. Procedural / Correction Memory

高优先级行为记忆。

存放：

- 用户明确纠偏
- “以后都这样做”的规则
- 对 agent 行为的强约束

特征：

- 检索优先级最高
- 更像行为规则而不是普通事实
- 通常支持覆盖旧规则
- 不要求完整 T1-T5 树，可采用“规则节点 + 修订链”模型

### 8.3 Temporal Memory Tree (TMT) adaptation

受 TiMem 启发，`pi-memory` 在 **L1/L2/L3** 三个平面上采用时间层级树；`L4 Procedural` 默认使用轻量规则树或修订链，不强制完整五层。

#### T1. Factual Segment Evidence

- 最细粒度的稳定证据节点
- 通常来源于单个 turn 或微批量 turn
- 对应 TiMem 的 base-level factual segment memories

#### T2. Session / Chunk Summary

- 会话块 / 主题块的局部总结
- 聚合多个 T1 节点
- 强调同一小时间窗口内的连续性

#### T3. Short-Horizon Pattern

- 短时间跨度内的模式总结
- 可对应“某天 / 某个主题周期 / 某个短期项目阶段”
- 聚合多个 T2 节点

#### T4. Medium-Horizon Trend

- 中期趋势或阶段性长期约束
- 可对应“某周 / 某个 milestone / 某个开发阶段”
- 聚合多个 T3 节点

#### T5. Stable Distilled Profile / Charter

- 稳定画像、长期项目宪章、持续行为规则的高层抽象
- user plane 上更像长期 persona / working style
- project plane 上更像长期架构宪章 / working agreement

### 8.4 TMT constraints

借鉴 TiMem 的约束，树结构应满足：

1. **Temporal containment**
   - 父节点时间区间必须包含其所有子节点时间区间
2. **Progressive consolidation**
   - 高层节点数量不应多于低层节点数量
3. **Level marking**
   - 每个节点必须显式带 `temporal_level`
4. **Edge consistency**
   - parent-child 只允许从高层指向低层，且相邻层优先

### 8.5 Plane × temporal applicability

| Plane | T1 | T2 | T3 | T4 | T5 |
|------|----|----|----|----|----|
| L1 Chat Episodic | ✅ | ✅ | ✅ | ✅ | ⚠️（少量） |
| L2 User/Profile | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| L3 Workspace/Project | ⚠️ | ✅ | ✅ | ✅ | ✅ |
| L4 Procedural/Correction | ⚠️（rule evidence） | ⚠️（rule cluster） | 可选 | 可选 | 可选 |

含义：

- Episodic 更依赖 T1-T4
- Profile / Project 更依赖 T2-T5
- Procedural 默认不做完整时间树，首版更适合 revision chain

### 8.6 Why not a single global bucket

如果只有一个 `global` 桶，会快速污染：

- 用户偏好会和项目约束混在一起
- 某个 chat 的局部决定可能错误提升为全局事实
- 检索排序难以稳定

因此正式采用三类长期作用域：

- `chat-local`
- `user-global`
- `workspace-global`

必要时保留：

- `system-global`

### 8.7 Scope Taxonomy

#### chat-local

```text
chat:telegram:<botId>:<chatId>
```

表示某个 Telegram chat 内的局部长期记忆。

#### user-global

```text
user:telegram:<userId>
```

表示用户跨 chat 的长期偏好 / 画像。

> 若首版无法稳定获得 userId，可延后开启，但 schema 和 routing 需要预留。

#### workspace-global

```text
workspace:<workspaceId>
```

表示当前工作区 / 仓库范围内的长期知识。

`workspaceId` 可以来源于：

- cwd hash
- repo root hash
- 显式配置

#### system-global (optional)

```text
system:default
```

用于极少量系统级默认记忆，不作为主要承载层。

### 8.8 Plane × Scope matrix

| Plane | chat-local | user-global | workspace-global | system-global |
|------|------------|-------------|------------------|---------------|
| L0 Raw Buffer | ✅ | ❌ | ❌ | ❌ |
| L1 Episodic | ✅ | ❌ | ❌ | ❌ |
| L2 Profile | ⚠️（候选） | ✅ | ❌ | ❌ |
| L3 Project | ⚠️（候选） | ❌ | ✅ | ⚠️ |
| L4 Procedural | ✅ / ✅提升 | ✅ | ✅ | ⚠️ |

### 8.9 Canonical URI Layer

URI 层是联邦平面与时间树之外的第三条结构轴：

- plane 决定“记忆的角色”
- scope 决定“记忆属于谁”
- temporal level 决定“记忆抽象到哪一层”
- **URI 决定“这个对象到底是谁，以及如何被稳定引用”**

#### URI design principles

1. **稳定**：同一个对象重启后 URI 不应变化
2. **本地优先**：采用 URN 风格，不依赖网络可达性
3. **可组合**：URI 应编码最小必要身份信息，但不把可变文本塞进 URI
4. **可追踪**：高层记忆能追溯到 child / source turn / 修订历史
5. **可去重**：同一 canonical family 可做 family-aware dedupe

#### Recommended URI forms

##### Scope URI

```text
urn:pi-memory:scope:chat:telegram:<botHash>:<chatId>
urn:pi-memory:scope:user:telegram:<userId>
urn:pi-memory:scope:workspace:<workspaceId>
urn:pi-memory:scope:system:default
```

##### Memory Node URI

```text
urn:pi-memory:node:<plane>:<scopeKind>:<scopeId>:<temporalLevel>:<nodeId>
```

示例：

```text
urn:pi-memory:node:episodic:chat:telegram.botA.7032858921:T1:01JNY...
urn:pi-memory:node:profile:user:telegram.123456:T4:01JNY...
urn:pi-memory:node:project:workspace:repo.9f3a2c:T5:01JNY...
urn:pi-memory:node:procedural:workspace:repo.9f3a2c:T5:01JNY...
```

##### Entity URI

```text
urn:pi-memory:entity:<entityType>:<namespace>:<entityId>
```

示例：

```text
urn:pi-memory:entity:repo:github:Ziphyrien/Pi-Telegram
urn:pi-memory:entity:language:iso:zh-CN
urn:pi-memory:entity:concept:local:spec-first-workflow
```

##### Edge URI

```text
urn:pi-memory:edge:<edgeType>:<edgeId>
```

推荐 edge types：

- `temporal_parent`
- `derived_from`
- `revision_of`
- `refers_to_entity`
- `supports_rule`
- `contradicts`
- `co_occurs`

##### Raw Turn URI

```text
urn:pi-memory:turn:<source>:<scopeId>:<turnGroupId>:<messageId>
```

#### URI family

除对象级 URI 外，建议引入 `family_uri` 概念，用于表达：

- 同一事实的多层抽象节点
- 同一规则的多个修订版本
- 同一实体相关的同族记忆

`family_uri` 不是唯一键，而是 trace / dedupe / collapse 的辅助索引。

---

## 9. Memory Model

### 9.1 Memory Types

建议首版支持以下类型：

- `preference`：偏好，例如“喜欢简洁中文回复”
- `profile`：稳定身份信息，例如“主要做 TS/Node 项目”
- `fact`：长期有效事实
- `project`：项目背景与约束
- `task`：长期未完成任务 / 承诺
- `correction`：用户对模型行为的纠正
- `event`：重要事件记录

### 9.2 Temperature

每条记忆带一个温度层级：

- `hot`：近期高相关
- `warm`：中期有用
- `cold`：低频但长期保留

温度影响检索排序和压缩策略，不直接决定是否删除。

### 9.2.1 Context residency state (MemGPT-inspired)

除温度外，记忆还应具备一个**上下文驻留状态（residency state）**。这吸收自 MemGPT 的“main context / external context”思路。

建议至少区分：

- `resident-working`
  - 当前被编译进 active working set，可直接进入 prompt
- `resident-queue`
  - 当前仍位于会话近历史 / FIFO 区，尚未被压缩或驱逐
- `recall-only`
  - 已不在当前 prompt 中，但仍可通过 recall search 重新拉回
- `archival-only`
  - 仅在长期记忆 / 外部文档存储中，需显式检索后才能进入 prompt

#### Important distinction

- `temperature` 回答“这条记忆长期价值如何”
- `residency` 回答“这条记忆此刻是否在主上下文里”

两者相关但不等价：

- `hot` 记忆通常更容易进入 `resident-working`
- `cold` 记忆也可能因 query 命中而被临时拉回主上下文
- 某条高重要性的 procedural 规则可长期保持 `resident-working`

#### MemGPT-style mapping in pi-memory

在 `pi-memory` 中，MemGPT 的层次可映射为：

- **working context** → `resident-working` 的 pinned working set
- **FIFO queue + recursive summary** → 当前 chat 的近历史、滚动摘要与 recall queue
- **recall storage** → raw turns / session summaries / chat recall index
- **archival storage** → L1-L4 memory nodes + 外部文档/附件索引

### 9.3 Confidence and Importance

每条记忆至少应带：

- `importance`：对未来帮助程度
- `confidence`：提取 / 归类 / 提升路由的置信度

建议：

- `importance` 主要影响召回排序
- `confidence` 主要影响是否允许提升到 `user-global` / `workspace-global`

### 9.4 Temporal metadata

属于 TMT 的节点还应带：

- `temporal_level`：`T1..T5`
- `interval_start`
- `interval_end`
- `parent_memory_id`（可选，若用 edge table 则不直接放）
- `child_count`

### 9.5 URI-backed identity model

每个核心对象都应具备 URI 身份：

- `scope_uri`
- `node_uri`
- `entity_uri`
- `edge_uri`
- `turn_uri`

对于 memory node，建议至少具备：

- `canonical_uri`：当前节点的稳定 URI
- `family_uri`：所属 canonical family
- `source_turn_uris`：来源 raw turn URI 列表
- `primary_entity_uris`：核心关联实体 URI 列表

其中：

- `canonical_uri` 用于唯一定位节点
- `family_uri` 用于跨层/跨版本 collapse 和 dedupe
- `source_turn_uris` 用于 provenance trace

---

## 10. Write Pipeline

### 10.1 Principles

1. **不在流式过程中写正式记忆**
2. **只在稳定边界后提取**
3. **先入缓冲，再异步提取**
4. **高价值优先**
5. **显式写入优先于隐式写入**
6. **高层记忆由低层逐步巩固，不直接一步生成**
7. **时间参数可配置，不把 day/week/month 写死在代码里**

### 10.2 End-to-end write flow

```text
agent_end / session boundary
    ↓
Raw Turn Buffer (L0)
    ↓
T1 Consolidation (online / nearline)
    ↓
Plane Router
    ↓
Canonical URI Assignment / Family Resolution
    ↓
Dedup / Merge
    ↓
Write T1 nodes into L1 / L2 / L3 / L4
    ↓
Scheduled T2/T3/T4/T5 consolidation
    ↓
Higher-level memory updates
```

### 10.3 Semantic-guided consolidation operator

受 TiMem 启发，每个可巩固层级使用统一的语义引导巩固接口：

```text
Φ(level, plane): (ChildMemories, HistoricalMemories, Instructions) -> NewMemoryNodes
```

其中：

- `ChildMemories`：来自下一低层的子记忆
- `HistoricalMemories`：同层最近历史记忆，用于连续性约束
- `Instructions`：该层专属的抽象目标提示词

这意味着高层记忆不是只看原始 turn，而是：

- 主要看下层巩固结果
- 辅助看同层短历史
- 按层级目标生成更抽象、更稳定的表示

### 10.4 Stratified scheduling

受 TiMem 的两层调度思想启发，首版采用**分层调度**：

#### Online / nearline consolidation

- `T1` 采用近线巩固
- 推荐在 `agent_end` 后立即或短 debounce 后生成
- 目标是捕获细粒度证据，不丢失新鲜事实

#### Offline / coarse-grained consolidation

- `T2-T5` 采用较粗粒度调度
- 由 timer、batch threshold、session boundary 驱动
- 目标是在保证新鲜度的同时控制成本
- 这一层可参考 LightMem 的 `sleep-time update` 思想：尽量把昂贵的重组、去重、抽象放到离线路径而不是在线回复路径

### 10.5 Recommended temporal schedule

以下是适配 coding-agent / Telegram 场景的默认建议，不是硬编码事实：

- `T1`：每轮 `agent_end` 后，按 turn 或微批量生成
- `T2`：每 4~8 个 turn、一次 session 片段结束、或 5~15 分钟窗口触发
- `T3`：每若干 `T2` 节点、topic cluster 完结、或短期阶段边界触发
- `T4`：每若干 `T3` 节点、milestone 边界、或更长窗口触发
- `T5`：仅在稳定证据足够多时更新；不要频繁重写

> 说明：
> 论文中的日/周/月只是 temporal hierarchy 的一个实例。
> 对 pi-memory 来说，应把时间窗口设计成**可配置参数**，这也是对论文“temporal parameterization”限制的回应。

### 10.6 Write Triggers

#### Trigger A: turn-complete debounce

- 来源：`agent_end`
- 行为：把本轮用户消息 + assistant 完整结果写入 raw turn buffer
- 执行：开启一个 debounce（建议 30~120 秒）
- 目的：避免每轮都立即触发昂贵的高层提取

#### Trigger B: boundary flush

- 来源：`session_before_switch` / `session_shutdown`
- 行为：立即 flush 当前 buffer，并发起一次提取
- 目的：在 `/new` 或进程退出前不丢信息

#### Trigger C: batch threshold

满足任一条件即触发一次提取：

- 最近未提取 turn 数 ≥ N（建议 4~8）
- 原始文本累计字数 ≥ M（建议 2000~4000 字）
- 距离上次提取已超过 T（建议 5~15 分钟）

#### Trigger D: explicit memory intent

- 来源：未来的 tool，如 `memory_add`
- 行为：立即请求 LLM 提取并进入 admission control
- 用于：用户明确说“记住这个”“以后都这样做”

#### Trigger E: model-active memory proposal (future phase)

- 来源：模型主动记忆控制链路
- 行为：模型提出 `add / update / delete / noop / link` 等记忆操作建议
- 约束：不得直接绕过 admission control 与审计逻辑落库
- 用于：
  - 模型识别到高价值、可复用的长期信息
  - 模型识别到旧记忆已过时、冲突或应修订
  - 复杂检索中需要主动发起 retrieve / reflect / rerank 控制

### 10.7 What should NOT trigger writes

- 单条问候
- 无任务意义的寒暄
- 中断的一半 token
- 尚未完成的工具调用中间态
- 同一内容在极短时间内重复出现

---

## 11. LLM Extraction and Consolidation Layer

LLM 提取层是记忆系统的核心，不直接把原始对话写进长期记忆，而是先做结构化抽取，再做层级巩固。

### 11.1 Three sub-stages

建议拆为三个概念步骤：

#### Stage A: Candidate Extraction

从 raw turns 中提取候选记忆：

- 是否值得记忆
- 初步类型
- 候选 plane / scope
- 重要性与置信度
- 实体 / 关键词

#### Stage B: Admission Control & Operation Decision

对候选记忆做准入与操作决策：

- 是否进入长期记忆
- 应该 `add / update / replace / delete / noop / link / evolve`
- 是否需要人工 review 或延迟观察

#### Stage C: Level-aware Consolidation

按平面与时间层级做巩固：

- T1：从原始 turn 生成事实证据
- T2-T5：从 child memories + same-level history 生成高层记忆

### 11.2 Extraction Input

输入包含：

- 最近一批原始对话 turn
- 当前 chat-local scope
- user-global / workspace-global 候选记忆（用于去重 / 合并）
- child memories（若当前是 T2-T5）
- historical memories（同层最近节点）
- level-specific instructions

### 11.3 Extraction Responsibilities

LLM 需要完成：

1. 判断是否值得记忆
2. 归一化表达（从对话改写为稳定记忆）
3. 识别 memory type
4. 识别候选 plane（L1/L2/L3/L4）
5. 识别候选 temporal level（T1-T5）
6. 判断推荐作用域：`chat-local` / `user-global` / `workspace-global` / `both`
7. 给出 importance score
8. 给出 confidence score
9. 提取实体与关键词
10. 发现候选实体 mention，并尝试给出 entity normalization 线索
11. 发现候选关系或事件角色关系，并给出 relation hint
12. 判断是否有过期时间（临时任务 / 短期约束）
13. 给出 admission hint（accept / review / reject）
14. 给出 memory operation hint（add / update / replace / delete / noop / link / evolve）

### 11.4 Extraction Output Schema

```json
{
  "shouldRemember": true,
  "memories": [
    {
      "content": "用户偏好使用中文且回答尽量简洁。",
      "summary": "偏好：中文、简洁",
      "type": "preference",
      "plane": "profile",
      "temporalLevel": "T4",
      "importance": 0.92,
      "confidence": 0.88,
      "scopeRecommendation": "user-global",
      "temperature": "warm",
      "entities": [
        { "name": "中文", "type": "language" }
      ],
      "keywords": ["中文", "简洁", "回答风格"],
      "expiresAt": null,
      "admissionHint": "accept",
      "operationHint": "update",
      "mergeHint": "upsert",
      "interval": {
        "start": 1730000000000,
        "end": 1730003600000
      }
    }
  ],
  "skipReason": ""
}
```

### 11.5 Extraction Quality Rules

LLM 必须：

- 避免把纯聊天噪音写入记忆
- 不直接照搬长段原文
- 尽量输出可长期复用的“稳定表达”
- 对有时间敏感性的内容添加 `expiresAt`
- 不把短期上下文误写成 user-global / workspace-global
- 对行为规则优先识别为 `procedural`
- 对 `delete / replace` 类建议必须要求更强证据与更高置信度
- 高层节点应比低层节点更抽象、更压缩，而不是简单重写

### 11.6 No fine-tuning assumption

与 TiMem 一样，首版默认：

- 使用 instruction-guided consolidation
- 不要求额外微调专门模型
- 通过 level-specific prompts 约束抽象粒度

> 对应的 prompt contract 细节见：`docs/specs/pi-memory-prompts.md`

### 11.7 Knowledge Graph Extraction Layer

`pi-memory` 不应把知识图谱抽取看成一个独立于记忆系统的外部玩具功能，而应把它视为：

- 实体归一化层
- 关系结构化层
- graph-aware retrieval 的支撑层
- URI layer 的事实来源层

这层的目标不是“构建一个通用世界知识图谱”，而是：

- 从对话与相关文档中提取对 agent 长期行为有用的实体和关系
- 为 `entity_uri` / `edge_uri` / `family_uri` 提供稳定支撑
- 为 graph / entity-anchor retrieval 提供结构化索引

设计上吸收以下方向：

- **Theme-specific KG construction**：relation ontology + LLM relation chooser
- **RAKG**：retrieval-augmented graph construction
- **WAKA**：entity retrieval / reranking / relation linking / fusion pipeline
- **event-centric memory graph**：事件中心 memory unit + graph anchor retrieval
- **A-MEM**：dynamic linking 与 memory evolution

### 11.8 Entity Discovery and Linking

建议采用两阶段实体处理：

#### Stage A: Entity discovery

从 raw turns / extracted memory candidates 中发现：

- named entities
- concept mentions
- role-like arguments（如人、项目、规则、工具、文件、仓库、模型）
- event arguments（谁、对什么、在什么上下文中发生）

#### Stage B: Entity linking / normalization

对发现的实体做归一化：

- 映射到已有 `entity_uri`
- 或生成新的 `entity_uri`
- 记录 mention -> entity 的置信度

推荐使用混合策略：

1. lexical retrieval（label / alias）
2. dense semantic retrieval（description / context embedding）
3. entity reranking（基于句子上下文）
4. 若仍不确定，则保留 unresolved mention，等待后续 merge 或人工纠偏

#### Entity extraction output

建议输出结构至少包含：

```json
{
  "entities": [
    {
      "mention": "Pi-Telegram",
      "entityType": "repo",
      "entityUri": "urn:pi-memory:entity:repo:github:Ziphyrien/Pi-Telegram",
      "confidence": 0.93,
      "aliases": ["Pi Telegram", "pitg"]
    }
  ]
}
```

### 11.9 Relation Extraction and Graph Fusion

关系抽取建议采用“候选生成 + 上下文判定 + 图融合”三阶段，而不是直接让 LLM 无限自由生成三元组。

#### Stage A: Relation candidate generation

对于实体对、事件对、节点对，先生成候选关系集合：

- 来自 relation ontology / relation type inventory
- 来自已有 graph schema
- 或由 LLM 基于实体类型推断可能关系

推荐候选关系类型包括：

- `prefers`
- `uses`
- `works_on`
- `belongs_to_workspace`
- `affects`
- `supports_rule`
- `contradicts`
- `caused_by`
- `happened_before`
- `same_topic_as`
- `revision_of`
- `derived_from`

#### Stage B: Relation decision

让 LLM 在给定上下文和候选关系中做判定：

- 选择最合适关系
- 或输出 `none`

这比“完全开放式生成 relation string”更稳，更适合 production 级记忆系统。

#### Stage C: Graph fusion

将最终关系融合进图结构：

- 写入 `memory_edges`
- 更新 node 的 `primary_entity_uris`
- 必要时合并重复 relation
- 必要时建立 `family_uri` 级别关系

#### Relation extraction output

建议输出结构至少包含：

```json
{
  "relations": [
    {
      "subjectUri": "urn:pi-memory:entity:repo:github:Ziphyrien/Pi-Telegram",
      "predicate": "supports_rule",
      "objectUri": "urn:pi-memory:node:procedural:workspace:repo.9f3a2c:T5:01JNY...",
      "confidence": 0.87,
      "evidenceTurnUris": ["urn:pi-memory:turn:telegram:..."],
      "extractionMode": "candidate_select"
    }
  ]
}
```

### 11.10 Event-Centric Graph Representation

针对对话记忆，首版不建议把 raw turn 直接当作 graph node 的唯一单位。

更推荐采用事件中心或 action-centered 的 memory unit：

- 一次用户纠偏
- 一次架构决定
- 一次项目约束确认
- 一次偏好表达
- 一次任务承诺 / 更新

这样做的好处：

- 比 raw turn 更适合 graph 检索
- 比简单 triples 保留更多局部语义
- 更适合后续做 T1/T2/T3 巩固

建议节点级表示至少包含：

- canonical text
- involved entities
- event / action type
- temporal interval
- supporting turn URIs
- local context summary

### 11.11 Graph Construction Principles

首版知识图谱抽取应遵守：

1. **先可用，再完整**
   - 先保证实体和关键关系可靠，不追求全量开放关系覆盖
2. **先候选，再判定**
   - relation candidate generation 优于完全开放式 relation generation
3. **先事件中心，再过度本体化**
   - 对话记忆更适合 event/action centric，而不是一开始就做超细 ontology
4. **图谱服务记忆，而不是喧宾夺主**
   - graph 的目标是提升 recall / trace / disambiguation，不是独立追求 KG 指标
5. **URI 优先于字符串**
   - 进入 graph 的实体、节点、边应尽量尽快具备 URI 身份

### 11.12 Entity Type Taxonomy

首版建议把实体类型分成 **核心类型** 和 **扩展类型**。

#### Core entity types (MVP)

这些类型优先实现，足以支撑 `pi-memory` 的主要场景：

- `user`
- `assistant`
- `agent`
- `workspace`
- `repository`
- `branch`
- `file`
- `directory`
- `document`
- `package`
- `library`
- `framework`
- `language`
- `tool`
- `command`
- `model`
- `provider`
- `task`
- `issue`
- `rule`
- `preference`
- `concept`
- `service`

#### Extended entity types (later)

- `pull_request`
- `commit`
- `release`
- `tag`
- `config_key`
- `environment_variable`
- `api`
- `endpoint`
- `dataset`
- `persona`
- `event_anchor`

#### Entity typing rules

1. 同一个 mention 可映射到多个候选类型，但最终 canonical entity 只能有一个主类型
2. 类型优先服务检索与 disambiguation，不追求知识工程上的绝对完备
3. 若无法可靠分类，可先落为 `concept`
4. 与 code / project 强相关对象优先类型化，不要都落成通用 `concept`

### 11.13 Relation Inventory

关系分成 **核心谓词** 和 **扩展谓词**。

#### Core predicates (MVP)

##### Ownership / scope

- `belongs_to_workspace`
- `belongs_to_repository`
- `belongs_to_chat`
- `owned_by`

##### Preference / behavior

- `prefers`
- `avoids`
- `requires`
- `prohibits`
- `corrects`
- `overrides`
- `supports_rule`

##### Project / technical

- `uses`
- `depends_on`
- `implements`
- `configures`
- `affects`
- `related_to`
- `works_on`
- `targets`

##### Temporal / derivation

- `happened_before`
- `happened_after`
- `derived_from`
- `summarizes`
- `revision_of`
- `same_topic_as`

##### Conflict / evidence

- `contradicts`
- `supports_fact`
- `references`
- `mentions`

#### Extended predicates (later)

- `fixed_by`
- `blocked_by`
- `caused_by`
- `triggered_by`
- `alias_of`
- `co_occurs`
- `same_scope_as`
- `same_entity_as`

#### Predicate rules

1. 首版关系集合应控制在可解释范围内，不追求开放词表
2. 如果 LLM 生成了词表外关系，优先映射到最近的 canonical predicate
3. 若无法映射，则输出 `none` 或降级为 `related_to`
4. `revision_of`、`overrides`、`contradicts` 对 procedural plane 尤其重要

### 11.14 Relation Candidate Matrix

首版应基于实体类型限制关系候选集合，避免让 LLM 在过大的开放空间里胡乱生成关系。

#### Example matrix

##### `user` / `assistant` / `agent`

允许优先候选：

- `prefers`
- `avoids`
- `requires`
- `prohibits`
- `uses`
- `works_on`
- `corrects`
- `overrides`

##### `workspace` / `repository`

允许优先候选：

- `uses`
- `depends_on`
- `configures`
- `implements`
- `affects`
- `related_to`
- `belongs_to_workspace`

##### `rule` / `preference`

允许优先候选：

- `supports_rule`
- `corrects`
- `overrides`
- `revision_of`
- `contradicts`
- `derived_from`

##### `task` / `issue`

允许优先候选：

- `targets`
- `affects`
- `depends_on`
- `blocked_by`
- `related_to`
- `derived_from`

##### `tool` / `command` / `model` / `provider`

允许优先候选：

- `uses`
- `configures`
- `depends_on`
- `affects`
- `related_to`

#### Candidate selection policy

1. 先根据 subject / object 的实体类型生成谓词候选集合
2. 再把上下文片段交给 LLM 在候选集合中选择
3. 如果候选集合为空，才允许退回开放式推断
4. 开放式推断结果必须再次映射回 canonical predicate inventory

### 11.15 Event / Action Node Schema

对话记忆图谱中的 node 不应只是一句文本；它应尽量具有事件/动作语义。

#### Recommended event/action types

- `preference_statement`
- `behavior_correction`
- `project_decision`
- `task_creation`
- `task_update`
- `implementation_action`
- `failure_report`
- `resolution`
- `config_change`
- `release_note`
- `context_reference`
- `question`
- `answer`

#### Event node fields

建议事件/动作节点至少具备：

- `canonical_uri`
- `family_uri`
- `event_type`
- `plane`
- `temporal_level`
- `canonical_text`
- `summary`
- `primary_entity_uris`
- `supporting_turn_uris`
- `interval_start`
- `interval_end`
- `importance`
- `confidence`
- `metadata_json`

#### Event node construction rules

1. 一个 event/action node 应尽量表达“一个可检索、可引用、可推理的最小事件单元”
2. 不要把多个不相干动作强行拼进一个节点
3. 同一事件的多个表达应优先合并到同一 `family_uri`
4. procedural / correction 类事件应优先落到 `behavior_correction` 或 `project_decision`

### 11.16 Extraction Output Extensions

在 11.4 的 extraction output 基础上，建议扩展为：

```json
{
  "entities": [
    {
      "mention": "Pi-Telegram",
      "entityType": "repository",
      "entityUri": "urn:pi-memory:entity:repo:github:Ziphyrien/Pi-Telegram",
      "confidence": 0.93
    }
  ],
  "relations": [
    {
      "subjectUri": "urn:pi-memory:entity:user:telegram:123456",
      "predicate": "prefers",
      "objectUri": "urn:pi-memory:entity:concept:local:spec-first-workflow",
      "confidence": 0.88
    }
  ],
  "eventNode": {
    "eventType": "behavior_correction",
    "canonicalText": "用户要求先写 spec，再开始实现。",
    "plane": "procedural",
    "temporalLevel": "T3"
  }
}
```

这并不要求所有字段在首版都强制落库，但它定义了上层抽取接口的目标形态。

---

## 12. Write Routing & Promotion Rules

本节定义“提取出来的候选记忆应落到哪一层”。

### 12.1 Default routing

所有候选记忆默认先假设：

- plane = `L1 Chat Episodic`
- scope = `chat-local`
- temporal level = `T1`

只有满足提升条件时，才允许进入更高层。

### 12.2 Promotion to User / Profile (L2)

满足任一条件即可考虑提升到 `user-global`：

- 用户明确表达“以后都这样”“默认这样”“我一直喜欢……”
- 多个 chat / 多轮对话重复出现相同偏好
- LLM 判断为稳定偏好且 `confidence` 足够高
- 类型属于：
  - `preference`
  - `profile`
  - `correction`

#### Constraints

- 不得把一次性任务或局部上下文提升为 user-global
- 对 user-global 的写入应设置更高置信度阈值
- user-global 更适合从 T2/T3/T4 证据提升，而不是直接从单个 raw turn 硬写入

### 12.3 Promotion to Workspace / Project (L3)

满足任一条件即可考虑提升到 `workspace-global`：

- 内容明显是项目约束
- 与仓库结构 / 架构 / 开发方式有关
- 多个 chat 重复提到相同项目事实
- 用户明确说明“这个项目里……”“这个仓库里……”

### 12.4 Promotion to Procedural / Correction (L4)

满足任一条件即可进入 `procedural`：

- 用户明确纠正 agent 行为
- 出现“以后都这样做”“不要再这样”“统一按这个规则”
- 内容本质上是执行规则，而不是事实描述

#### Scope selection for L4

- 只对当前 chat 有意义 → `chat-local`
- 对用户所有 chat 生效 → `user-global`
- 对整个项目 / workspace 生效 → `workspace-global`

### 12.5 Stay in Chat Episodic (L1)

以下内容通常只留在 `chat-local episodic`：

- 短期任务
- 某次会话局部决定
- 当前讨论上下文
- 只在这个 chat 有意义的信息

### 12.6 Temporal promotion rules

- `T1 -> T2`：局部事实证据足够聚合时
- `T2 -> T3`：开始出现短期模式时
- `T3 -> T4`：出现跨 session / 跨阶段趋势时
- `T4 -> T5`：只有在稳定性足够高时才允许

> 重要：
> `T-level` 的提升和 `plane/scope` 的提升是两件不同的事。
> 一条记忆可以先从 `T1 episodic` 升到 `T3 episodic`，之后再被提升到 `T4 profile` 或 `T4 project`。

### 12.7 Active Memory Operation Chain (future phase)

受 SCM、A-MAC、Memory-R1、AgeMem 等工作启发，`pi-memory` 在 MVP 之后应支持“**模型主动记忆链路**”，但其主实现位置仍应在 `Pi-Telegram` Memory Core，而不是把主逻辑下放到 bridge 扩展。

#### Goals

主动记忆链路的目标不是“让模型随便写记忆”，而是让模型在受控条件下参与：

- 是否值得进入长期记忆
- 应执行 `add / update / replace / delete / noop / link / evolve` 中哪种操作
- 在复杂查询下是否应继续 `retrieve / reflect / rerank`

#### Write-side operation inventory

写侧最小操作集合建议为：

- `add`：新增独立记忆
- `update`：更新已有记忆
- `replace`：用新版本替换旧版本
- `delete`：删除已确认过时或错误的记忆
- `noop`：不做改动
- `link`：建立与已有记忆的连接
- `evolve`：推动已有记忆向更高层表示演化

其中：

- `add / update / replace / delete / noop` 参考 Memory-R1
- `link / evolve` 参考 A-MEM

#### Read-side operation inventory

读侧主动控制建议为：

- `retrieve`：发起或细化召回
- `reflect`：分析当前证据缺口与冲突
- `rerank`：重排候选并挑选代表证据
- `answer`：停止检索并进入最终回答

其中：

- `retrieve / reflect / answer` 参考 MemR3
- retrieval-reasoning coupling 参考 ActMem

#### Recommended control flow

建议链路如下：

```text
raw turns / user instruction
  ↓
Candidate Extraction
  ↓
Admission Control
  ↓
Operation Decision
  ├─ add
  ├─ update
  ├─ replace
  ├─ delete
  ├─ noop
  ├─ link
  └─ evolve
  ↓
Apply mutation
  ↓
Post-update validation / trace
```

#### Admission control is mandatory

主动记忆链路中，模型提出的 operation proposal **不得直接落库**。

必须先经过 admission control，至少考虑：

- future utility
- factual confidence / evidence quality
- semantic novelty
- stability / persistence
- scope fit
- potential conflict with existing memory

这对应 A-MAC 与 2505.16067 的启发：

- memory admission 是独立控制问题
- 错误写入会导致后续 experience-following 污染

#### Runtime positioning

首版建议：

- **MVP 不要求把上述操作直接暴露成 public tools**
- 先作为 `Pi-Telegram` 内部控制链路实现
- 后续 Phase 4 再决定哪些操作值得暴露成显式 `memory_*` tools

---

## 13. Retrieval Federation & Complexity-Aware Recall

### 13.1 Retrieval principle

不要把所有记忆混在一起搜。

`pi-memory` 的检索应显式采用**混合检索栈（hybrid retrieval stack）**，并把检索、扩展、过滤、重排拆开。

这里的“混合”**不只**指 dense / sparse / graph / temporal 多通道并行，也正式包含 **LLM 参与的检索控制层**。也就是说，混合检索至少由两部分组成：

1. **程序化候选召回通道**
   - dense
   - sparse
   - graph / entity-anchor
   - temporal
2. **LLM 参与层**
   - Recall Planner
   - clue generation / query reformulation
   - recall gating
   - final rerank / evidence selection

其思想来源于：

- **TiMem**：planner + hierarchical recall + gating
- **HyMem**：动态检索调度
- **2511.17208 event-centric baseline**：dense–sparse integration + graph retrieval
- **QRRanker**：retrieval 与 rerank 分层
- **MemoRAG**：clue-guided retrieval

整体链路：

```text
Query
 ├─ LLM Recall Planner
 │    └─ outputs: complexity + keywords + target levels + scope hints
 ├─ LLM Clue Generator / Query Reformulation
 ├─ Hybrid Candidate Retrieval
 │    ├─ Dense semantic retrieval
 │    ├─ Sparse lexical retrieval
 │    ├─ Graph / entity-anchor retrieval
 │    └─ Temporal neighborhood retrieval
 ├─ Search L4 Procedural / Correction
 ├─ Search L2 User / Profile
 ├─ Search L3 Workspace / Project
 └─ Search L1 Chat Episodic
        ↓
Base-level activation
        ↓
Hierarchical propagation
        ↓
LLM-first recall gating
        ↓
LLM-first hybrid rerank / evidence selection
        ↓
Context assembly
```

#### Retrieval channels

混合搜索至少包含四条通道：

1. **Dense semantic retrieval**
   - embedding 相似度召回
2. **Sparse lexical retrieval**
   - BM25 / FTS5 关键词召回
3. **Graph / entity-anchor retrieval**
   - 以 `entity_uri`、概念提及、graph edges 为锚点扩展候选
4. **Temporal neighborhood retrieval**
   - 对锚点时间附近的记忆做局部时间召回

这些通道不是互斥关系，而是共同生成候选集合，再进入后续 propagation / gating / rerank。

#### LLM participation rules

LLM 参与检索时应遵守以下约束：

- LLM **不直接替代索引检索**，而是参与 query 理解、候选控制和最终筛选
- LLM **不扫描全库原始记忆**，只处理 planner 输入、clues、候选池和聚合后的证据块
- `simple` 查询可在预算紧张时关闭 clue generation 或 LLM rerank
- `hybrid` / `complex` 查询应默认包含 LLM 参与
- 当 LLM 不可用时，系统必须可降级到 heuristic planner / gating / rerank

### 13.2 Recall Planner

Recall Planner 负责：

- 估计查询复杂度
- 提取关键词
- 决定搜索哪些平面
- 决定搜索哪些 temporal levels
- 决定启用哪些 retrieval channels
- 决定召回预算
- 必要时触发 clue generation

建议复杂度分类：

- `simple`
- `hybrid`
- `complex`

建议输出：

```json
{
  "complexity": "hybrid",
  "keywords": ["偏好", "spec", "扩展"],
  "clues": ["回答风格规则", "项目工作流约束"],
  "targetPlanes": ["procedural", "profile", "project", "episodic"],
  "targetLevels": ["T1", "T2", "T4", "T5"],
  "targetChannels": ["dense", "sparse", "graph", "temporal"],
  "scopeHints": ["chat-local", "workspace-global"],
  "budget": {
    "maxCandidates": 24,
    "maxFinalMemories": 10
  }
}
```

### 13.3 LLM-guided clue generation and query reformulation

受 MemoRAG 启发，系统可在正式召回前使用 LLM 生成 retrieval clues，并在必要时做 query reformulation。

适用场景：

- 用户问题表达模糊
- query 本身缺少明确实体词
- 需要跨多个 plane 聚合证据
- 原 query 更像代词指代、模糊回指或高层意图

clue / reformulation 不直接作为最终答案，而是帮助：

- 缩小 semantic gap
- 触发更合适的 graph / entity anchor retrieval
- 提高 sparse retrieval 的关键词质量
- 为 dense retrieval 生成更稳定的语义检索意图

默认策略建议：

- `simple`：可跳过 clue/reformulation
- `hybrid`：默认启用 clue generation
- `complex`：默认启用 clue generation + query reformulation

### 13.3.1 Closed-loop retrieval controller (future phase)

受 MemR3 与 ActMem 启发，`pi-memory` 在复杂查询下可进一步把检索链路升级为**闭环控制过程**，而不是“一次检索后立即回答”。

建议动作集合：

- `retrieve`：发起或细化候选召回
- `reflect`：分析当前证据缺口、冲突、缺失实体或时间段
- `answer`：停止继续检索，进入最终回答装配

可选维护一个轻量 `evidence-gap state`，用于记录：

- 已确认的证据点
- 仍缺失的证据点
- 当前是否已足够支撑回答

首版建议：

- `simple` / `hybrid` 仍以单轮 planner + retrieval 为主
- `complex` 查询可进入 retrieve–reflect–answer 闭环
- 闭环检索默认仍受预算上限、迭代上限和 early stop 控制

### 13.4 Stage 1: Base-level activation

受 TiMem 启发，最低可用层的叶子节点先被激活。

对于多数平面，这意味着先从较低 temporal level 搜索：

- episodic：通常从 `T1/T2` 开始
- profile/project：通常从 `T2/T3` 开始
- procedural：直接搜索当前规则节点

在这一阶段，候选不应只来自单一路径，而应由四条通道共同产生：

- dense semantic retrieval
- sparse lexical retrieval
- entity / concept anchor retrieval
- temporal neighborhood retrieval

这一步也吸收了 event-centric baseline 的经验：

- query 中未命名或泛化提法（如 “那个项目”“这个规则”“上次那个问题”）
- 往往不适合只靠 exact string match
- 应允许通过 entity / concept mention detection 把 query 锚定到 graph / URI / entity 层

基础评分建议采用 semantic-heavy 混合：

```text
baseScore =
  cosine(embedding(query), embedding(memory)) * λ +
  BM25(memory_text, keywords) * (1 - λ)
```

建议 `λ` 取值：

- `0.8 ~ 0.9`

这与 TiMem 中“语义优先、关键词辅助”的思路一致。

### 13.5 Stage 2: Hierarchical propagation

对于被激活的低层节点，沿 TMT 向上收集其祖先节点：

- 祖先层级由 Recall Planner 决定
- 复杂度越高，允许传播得越高
- 不同 plane 的传播深度可不同

示例：

- `simple`：主要看低层 + 少量高层摘要
- `hybrid`：低层证据 + 中层模式 + 高层画像
- `complex`：跨平面、跨层级联合召回

### 13.6 Recall Gating

Recall Gating 负责：

- 在 candidate pool 上做二次过滤
- 保留对 query 真正相关且时间一致的记忆
- 丢掉语义相似但 temporal / scope 不匹配的节点

首版建议：

- 默认用 1 次 LLM 调用做 gating
- 这一层正式算作**混合检索本身的一部分**，不是可有可无的后处理
- 当 API 不可用或预算不足时，可降级为 heuristic gating

Gating 关注：

- query relevance
- temporal consistency
- scope fit
- plane priority compatibility
- candidate 是否只是 graph expansion 带来的噪音扩展

这一层对应相关工作中的两类思想：

- **TiMem**：planner 后的 recall-time filtering
- **2511.17208 / QRRanker**：candidate recall 之后再做 recall-oriented filtering / reranking

### 13.7 Per-plane search strategy

#### L4 Procedural / Correction

- 以精确匹配 + 高权重语义匹配为主
- 预算建议：2~4 条

#### L2 User / Profile

- 以语义检索 + 关键词为主
- 预算建议：3~5 条

#### L3 Workspace / Project

- 以实体 / 关键词 / 语义混合为主
- 预算建议：4~6 条

#### L1 Chat Episodic

- 以时间新近度 + 语义为主
- 预算建议：5~8 条

### 13.8 Ranking Formula

平面内可采用：

```text
planeScore =
  semanticScore * W_semantic +
  lexicalScore  * W_lexical  +
  recencyScore  * W_recency  +
  importance    * W_importance
```

全局预排序时增加：

- plane priority boost
- scope priority boost
- temporal level appropriateness boost
- URI-family collapse penalty / boost
- entity-anchor match boost

推荐默认：

- `procedural` 最高
- `user-profile` 次高
- `workspace-project` 其次
- `chat-episodic` 最后按新近度补充

> 注：虽然 `chat` 通常更贴近当前上下文，但行为规则和用户长期偏好仍应优先出现。

在预排序之后，混合检索应再做一次 **LLM-first final rerank / evidence selection**：

- 输入：已通过 gating 的候选集合
- 输出：最终注入的 memory 子集及其顺序
- 目标：
  - 选择最适合当前 query complexity 的层级代表
  - 决定是否同时保留 summary + evidence
  - 控制同一 family 的 collapse
  - 避免把“相似但不同 scope”的记忆并排塞进上下文

首版建议：

- 默认使用 1 次 LLM 调用做 final rerank
- 若预算不足，则退回程序化排序

从系统设计上，建议明确区分：

1. **candidate retrieval**
2. **recall gating**
3. **final rerank**

不要把三者混成一个大函数。这也是相关工作（尤其 QRRanker、TiMem、event-centric baseline）反复说明的工程经验：

- 检索负责找“可能相关”
- gating 负责去掉明显噪音
- rerank 负责决定最终上下文排序
- LLM 主要参与 planner / clue / gating / rerank，而不是替代底层索引检索

### 13.9 Context Assembly

最终注入给模型时，不应做成乱序列表，而应按区块组装：

```text
[高优先级行为约束]
- ...
- ...

[用户长期偏好]
- ...
- ...

[项目/工作区长期记忆]
- ...
- ...

[当前 chat 相关记忆]
- ...
- ...
```

#### Why block assembly

- 模型更容易理解层级关系
- 不会把项目约束和局部 chat 决策混淆
- 更利于 future compression / truncation
- 更贴合 TiMem 的“层级召回后再组织输出”思路

### 13.10 Injection method

注入方式优先级：

1. **extension message**（推荐）
2. per-turn system prompt augmentation（备用）

首版建议使用 **extension message**，避免污染全局系统提示模板。

示例：

```ts
pi.on("before_agent_start", async (event, ctx) => {
  const memoryBlock = await buildMemoryContext(...);
  return {
    message: {
      customType: "pi-memory-context",
      content: memoryBlock,
      display: false
    }
  };
});
```

### 13.10.1 MemGPT-inspired context pager

在注入阶段，`pi-memory` 应吸收 MemGPT 的**虚拟上下文管理**思想：

- prompt context 是稀缺资源
- 外部记忆必须显式分页回填到主上下文
- 系统需要一个 working-set compiler / context pager，而不是简单把检索结果无脑拼接

建议采用如下运行时结构：

#### A. Pinned working set

长期驻留在当前 prompt 的小型高优先级区块，典型包括：

- 当前生效的 procedural / correction 规则
- 极少量稳定用户偏好
- 当前 workspace 的核心 charter / repo 约束
- 当前 session 的活跃 task charter（若存在）

这相当于 MemGPT 的 working context / core memory 思路，但在 `pi-memory` 中由 `Pi-Telegram` 的 context pager 统一编译，而不是直接暴露给用户编辑。

#### B. Rolling queue / recent history

对应当前会话近历史：

- 最近若干轮 user / assistant turns
- 最近工具结果摘要
- 必要的系统事件

这相当于 MemGPT 的 FIFO queue 思路。

#### C. Recall-only region

对已被驱逐出当前 prompt，但仍可能再次需要的近期历史：

- 被压缩前的完整对话 turn
- recursive summary 的前序块
- 可通过 lexical / semantic / temporal search 再次拉回的 recall 索引

#### D. Archival region

对真正长期的外部记忆与文档：

- L1-L4 记忆节点
- 外部文档 / 附件 / 长资料索引
- graph / URI / entity 关联结构

#### Memory pressure policy

建议引入 MemGPT-style 的两级阈值：

- `warning threshold`
  - 当预计 prompt 占用接近预算上限（例如 70%~80%）时，触发内部 memory pressure 信号
  - 优先：
    - 刷新 pinned working set
    - 触发 queue summary
    - 将低价值 recent history 下沉到 recall-only 区
- `flush threshold`
  - 当 prompt 明显超限时，强制执行 queue flush
  - 生成或更新 recursive summary
  - 保留少量最新 turns 与 pinned working set
  - 被驱逐的消息仍保留在 recall store 中，可后续检索回填

#### Function-chained retrieval analogue

MemGPT 使用 `request_heartbeat=true` 支持多步函数链。在 `pi-memory` 中，对应的适配方式不一定要复刻同名机制，但应保留其核心思想：

- 对复杂 query，允许多步 retrieve / reflect / rerank
- 在单次用户回答前，可由 `Pi-Telegram` 内部连续执行数次 memory-side 控制动作
- 直到 working set 足够稳定，再把最终 memory block 注入当前 turn

#### Recursive summary policy

对被驱逐的 session history，不应简单丢弃。建议：

- 维护 recursive session summary
- summary 自身也进入 recall store，可作为二级证据
- 当 recall 命中 summary 仍不足时，再回退到更细粒度 raw turns

### 13.11 URI-aware retrieval controls

在联邦召回阶段，URI 不负责“找到相关内容”，而负责“控制结果如何被折叠、追踪与解释”。

#### URI-family dedupe

如果同一 `family_uri` 下同时命中了：

- T1 低层证据
- T3/T4 中层模式
- T5 高层画像

则默认只保留**最适合当前 query 复杂度**的一层，避免重复注入。

#### URI ancestry propagation

在 hierarchical propagation 时：

- 向上找祖先不只看 `parent_memory_id`
- 也要允许通过 `edge_uri` / `family_uri` 进行 ancestry trace

这使得：

- 高层摘要可以追到低层证据
- procedural 规则可以追到修订链
- project / profile 抽象可以追到支撑事实

#### URI-aware gating

Recall Gating 除 relevance 外，还应考虑：

- 同 URI family 是否已有代表节点入选
- 当前节点是否只是更低质量的重复版本
- 当前节点是否只是某个高层节点已经覆盖的祖先证据

#### URI-aware observability

最终注入块或调试命令中，系统应能输出：

- `canonical_uri`
- `family_uri`
- `source_turn_uris`（必要时截断）

便于后续追踪“为什么这条记忆会被召回”。

---

## 14. Dedup / Merge Strategy

### 14.1 Why dedupe matters

如果没有去重，用户每次说“请用中文简洁回答”都会写出一条新的重复记忆，长期会污染召回质量。

### 14.2 Merge flow

对于每条候选记忆：

1. 在目标平面 + 目标作用域 + 目标 temporal level 中查找 lexical 相近候选
2. 查找同 `family_uri` / 同主实体 URI / 同规则修订链候选
3. 对候选做 embedding 相似度比对
4. 若相似度或 family 关联强于阈值（建议 0.85 或显式 family 命中）：
   - 由 LLM 或规则判断：
     - `merge`：更新旧记忆
     - `replace`：删除旧记忆，插入新记忆
     - `ignore`：新内容无增量
     - `revise`：作为同一规则 / 同一事实 family 下的新修订版本写入
5. 若无高相似候选，则新增

### 14.3 Update policy by plane

#### L2 User / Profile

- 新偏好通常覆盖旧偏好
- 新纠偏通常覆盖旧行为偏好

#### L3 Workspace / Project

- 更像 upsert
- 同一项目事实应合并而不是重复插入

#### L1 Chat Episodic

- 允许更多并存
- 但相似事件可合并摘要

#### L4 Procedural

- 更强调 rule replacement
- 新规则可覆盖旧规则
- 应保留有限修订历史以便调试

### 14.4 Cross-level dedupe

需要避免的错误：

- 同一事实在 T1/T2/T3 多层被当成“多个独立事实”重复召回
- 同一规则的多个修订版本同时进入最终上下文

因此：

- 召回阶段应优先保留最适合 query 的层级版本
- 若高层摘要已覆盖低层证据，则默认不同时展示两者，除非 query 明确要求证据细节
- 同一 `family_uri` 默认只保留一个代表节点，除非 query 明确要求 `trace` / `evidence` / `history`

---

## 15. Storage Design

### 15.1 SQLite as primary store

首版采用 SQLite 单文件存储。

原因：

- 本地部署简单
- 易备份
- 无额外服务依赖
- 支持 FTS5
- 适合单机 pi / Pi-Telegram 部署模型
- 与“作为扩展直接运行在 pi 进程内”的架构一致

### 15.2 Physical storage strategy

采用：

- **一个 SQLite 文件**
- **多张表**
- 使用 `plane + scope + temporal_level + type` 做逻辑分片
- 对 `canonical_uri / family_uri / scope_uri / entity_uri` 建立索引

不建议：

- 每层一个 DB 文件
- 每个 scope 一个 DB 文件

原因：

- 事务更简单
- 检索跨层更方便
- migration 更可控

### 15.3 Proposed tables

#### memory_nodes

主记忆节点表。

字段建议：

- `id`
- `canonical_uri`
- `family_uri`
- `canonical_text`
- `summary`
- `plane` (`episodic` / `profile` / `project` / `procedural`)
- `temporal_level` (`T1` / `T2` / `T3` / `T4` / `T5`)
- `type`
- `importance`
- `confidence`
- `temperature`
- `interval_start`
- `interval_end`
- `created_at`
- `updated_at`
- `last_accessed_at`
- `access_count`
- `expires_at`
- `status`
- `source`
- `metadata_json`

#### memory_scopes

节点与 scope 的映射。

字段建议：

- `memory_id`
- `scope_uri`
- `scope_kind` (`chat` / `user` / `workspace` / `system`)
- `scope_id`
- `weight`

#### memory_edges

TMT 的 parent-child 边与其他结构边。

字段建议：

- `edge_uri`
- `parent_memory_id`
- `child_memory_id`
- `edge_type` (`temporal_parent` / `revision_of` / `derived_from` / `refers_to_entity` / `supports_rule`)

#### memory_embeddings

- `memory_id`
- `embedding_model`
- `embedding_json_or_blob`
- `embedding_dim`

#### memory_entities

- `memory_id`
- `entity_uri`
- `entity_name`
- `entity_type`
- `relevance`

#### entity_mentions (optional)

用于保留 mention 到 canonical entity 的映射与置信度。

- `mention_id`
- `turn_uri`
- `mention_text`
- `entity_uri`
- `confidence`
- `sentence_offset`

#### relation_candidates (optional)

用于保留 relation candidate generation 的中间结果，便于调试与回溯。

- `candidate_id`
- `subject_uri`
- `object_uri`
- `candidate_relation`
- `turn_uri`
- `confidence`
- `selected`

#### raw_turns

原始 ingestion buffer，不直接参与最终召回。

- `id`
- `turn_uri`
- `scope_uri`
- `scope_kind`
- `scope_id`
- `turn_group_id`
- `role`
- `content`
- `timestamp`
- `processed`
- `metadata_json`

#### extraction_runs

- `id`
- `scope_kind`
- `scope_id`
- `started_at`
- `ended_at`
- `status`
- `input_turn_count`
- `output_memory_count`
- `error`

### 15.4 Embedding storage strategy

首版不强制依赖 `sqlite-vec`。

建议：

- MVP：embedding 存 SQLite，向量相似度在应用层算
- 后续：抽象出 vector backend，可选 `sqlite-vec`

这样可以减少平台相关的 native extension 风险。

### 15.5 Extension state vs DB state

#### 存在 SQLite 的内容

- 长期记忆条目
- raw turn buffer
- extraction job 记录
- embedding / entity / merge 元数据
- TMT parent-child edges

#### 允许存在 pi session custom entry 的内容

- 调试痕迹
- 最近一次 extraction marker
- 用户可见的 memory operation log（可选）

#### 不建议存进 pi session entry 的内容

- 主记忆内容本身
- 大量 embedding
- 检索索引
- TMT 主结构

原因：`pi.appendEntry()` 适合少量 session-local 状态，而不是长期记忆主库。

---

## 16. Bridge Extension Surface

首版应把“扩展接口”理解为：**bridge 扩展暴露的生命周期桥接能力**，而不是 TUI 命令层。

### 16.1 Event hooks to implement

#### `before_agent_start`

职责：

- 收集当前 prompt、scope、session 信息
- 调用 Pi-Telegram 本地 bridge API 请求 memory context
- 把返回的 memory context 注入当前 turn

#### `agent_end`

职责：

- 收集本轮 user / assistant 完整消息
- 调用 Pi-Telegram 本地 bridge API 写入 raw turns
- 不在扩展内做主数据库写入与高层巩固

#### `session_before_switch`

职责：

- 在 `/new` / `/resume` 前通知 Pi-Telegram flush 当前缓冲

#### `session_shutdown`

职责：

- 退出前通知 Pi-Telegram flush
- 清理 bridge 本地连接状态

#### Optional: `session_start`

职责：

- 做 bridge 启动自检
- 验证本地 bridge API 可达
- 可选上报扩展版本与 capabilities

### 16.2 No TUI commands in MVP

MVP 明确不做：

- `pi.registerCommand("memory", ...)`
- `/memory ...` TUI 命令
- TUI widget / footer / renderer

原因：

- 主交互面是 Telegram，不是 pi TUI
- 记忆主逻辑已经在 Pi-Telegram 中
- bridge 扩展应尽量轻量、无状态、无 UI 依赖

### 16.3 Optional tools later

未来如有需要，可增加少量 bridge tools，但不是 MVP 前提：

- `memory_add`
- `memory_search`
- `memory_forget`
- `memory_trace`

这些更适合被视为**用户/模型可显式调用的安全外层工具**。

与之区分，主动记忆链路中的内部操作（如 `update / replace / delete / link / evolve / retrieve / reflect`）默认更适合作为 `Pi-Telegram` Memory Core 的**内部控制动作**，而不是一开始就全部暴露成 public tools。

即便将来添加显式工具，它们也应只是转发到 Pi-Telegram，而不是在扩展内实现主逻辑。

---

## 17. Pi-Telegram ↔ Bridge Contract

`Pi-Telegram` 是记忆主控层，bridge 扩展只是它在 pi 进程中的代理入口。

### 17.1 Minimal environment contract

Pi-Telegram 启动 pi 时，推荐通过环境变量传给 bridge：

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

其中：

- `PI_MEMORY_BRIDGE_URL` 指向 Pi-Telegram 暴露的本地 bridge API
- `PI_MEMORY_BRIDGE_TOKEN` 用于防止本机其他进程随意调用该 API
- `PI_MEMORY_APP_VERSION` 与 `PI_MEMORY_BRIDGE_VERSION` 在 MVP 中应精确相等
- `PI_MEMORY_BRIDGE_PROTOCOL_VERSION` 用于运行时协议兼容校验

### 17.2 Minimal local bridge API

推荐最小接口如下：

#### `GET /v1/health`

用途：
- bridge 扩展在 `session_start` 时探活

#### `POST /v1/context`

用途：
- `before_agent_start` 获取 memory context

输入建议：
- prompt
- chat/user/workspace scopes
- session id
- token budget

输出建议：
- memory context text
- selected memory URIs（可选）
- trace（可选）

#### `POST /v1/ingest-turns`

用途：
- `agent_end` 回传完整 turn 数据

输入建议：
- user / assistant messages
- timestamps
- session metadata
- scopes

#### `POST /v1/flush`

用途：
- `session_before_switch` / `session_shutdown` 请求 flush

输入建议：
- scopes
- session id
- reason (`switch` / `shutdown` / `manual`)

### 17.3 Startup contract for temporary same-repo bridge

Pi-Telegram 的启动职责应包括：

1. 根据当前构建信息确定：
   - `repo = github.com/<owner>/Pi-Telegram`
   - `ref = 当前 app 对应 tag 或 commit`
   - `subdir = packages/pi-memory-bridge`
   - `bridgeProtocolVersion = 当前主程序期望值`
2. 检查本地 cache 是否存在且 manifest 校验通过
3. 若不存在或校验失败，则下载/拉取当前 `Pi-Telegram` 仓库 ref 到 cache
4. 提取 `packages/pi-memory-bridge` 子目录并校验：
   - `bridgeVersion === appVersion`
   - `bridgeProtocolVersion === expectedProtocolVersion`
5. 读取 `C:\Users\Administrator\.pi\telegram\settings.json`，并据此生成**临时 provider-registration extension**
6. 启动**主对话 pi 进程**时，应同时具备两种临时能力：
   - `pi-memory-bridge`
   - provider-registration extension
7. 按需启动**内部 extraction pi RPC 进程**时：
   - 仅需要 provider-registration extension
   - 使用 `pi --mode rpc --no-session`
   - 不加载 `pi-memory-bridge`
8. 注入 bridge 所需环境变量

注意：

- 对用户而言，扩展是临时加载的
- 对实现而言，Pi-Telegram 可以缓存下载结果
- bridge 的权威来源是 **Pi-Telegram 同仓库同 ref**
- provider-registration extension 的权威来源是 **Pi-Telegram 读取后的 `settings.json`**
- 不应修改用户全局或项目级 pi settings

### 17.4 Important boundary

#### Pi-Telegram SHOULD own

- SQLite schema
- raw turn ingestion
- entity/relation/event extraction orchestration
- TMT consolidation
- hybrid retrieval
- planner / rerank / gating
- graph fusion
- forgetting / archival
- `settings.json` 读取与模型配置解释
- embedding client 的直接初始化与调用
- 临时 provider-registration extension 的生成
- 内部 extraction pi RPC 进程的生命周期管理

#### Bridge extension SHOULD NOT own

- 长期记忆数据库
- retrieval 主逻辑
- TMT 主逻辑
- provider/model 配置源解释
- TUI commands / renderers（MVP）
- 生产级本地缓存策略

---

## 18. Model Configuration and External Model Usage

虽然 `pi-memory` 不是本地 HTTP 服务，但它仍然依赖外部模型能力：

- 一个 **memory LLM** 用于 extraction / consolidation / routing / gating
- 一个 **embedding model** 用于 semantic search

### 18.1 Configuration source

memory 模型配置的权威来源应为：

```text
C:\Users\Administrator\.pi\telegram\settings.json
```

但这个文件应由 **Pi-Telegram 主程序**读取和解释，而不是由扩展自己直接读取绝对路径。

也就是说：

- `settings.json` 是 Pi-Telegram 的配置源
- Pi-Telegram 负责把配置展开为：
  - memory core 内部 embedding client
  - 临时 provider-registration extension
  - 内部 extraction runner 的启动参数

### 18.2 Simplified settings shape

首版建议使用**简化结构**，避免把完整 provider/model 元数据全部暴露到配置中。

推荐形状：

```json
{
  "memory": {
    "llm": {
      "provider": "telegram-memory",
      "model": "qwen-plus",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "MEMORY_LLM_API_KEY",
      "api": "openai-completions",
      "authHeader": true
    },
    "embedding": {
      "model": "text-embedding-3-large",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyEnv": "EMBEDDING_API_KEY"
    }
  }
}
```

设计原则：

- `memory.llm` 的语义**对齐 pi custom provider**
- 但首版不要求把完整 `models[]`、cost、contextWindow 等字段都写进配置
- `apiKeyEnv` 推荐引用环境变量名，而不是把密钥字面量写入文件
- 若未来某个 provider 需要额外字段，可再按需增加 `headers`、`compat` 等可选项

### 18.3 Embedding model path

embedding 模型应由 `Pi-Telegram` memory core **直接调用**：

- 使用 OpenAI SDK 兼容端点
- 不通过 `pi.registerProvider()`
- 不依赖 pi 会话或 bridge 扩展
- 主要用于 embedding 生成与语义检索

因此：

- embedding = Pi-Telegram 进程内直接调用
- memory LLM = 通过 pi provider 语义接入

### 18.4 Memory LLM provider path

memory LLM 的配置语义应与 pi 的 custom provider 机制保持一致。

也就是说，Pi-Telegram 应根据 `memory.llm` 配置生成一个**临时 provider-registration extension**，其职责是：

- 在目标 pi 进程中调用 `pi.registerProvider()`
- 注册一个 memory 专用 provider 名称
- 让 memory extraction / consolidation / planner 等内部任务可以像使用普通 pi provider 一样使用该模型

关键点：

- 这是**临时注册**，不是写入 pi settings 的长期安装
- provider-registration extension 与 `pi-memory-bridge` 是两个不同职责
- bridge 负责记忆生命周期桥接
- provider-registration extension 负责模型提供商注册

### 18.5 Execution runners

本系统至少存在两类 pi 运行实例：

#### A. 主对话 pi 进程

用途：

- 处理 Telegram 用户对话
- 接收 memory context 注入
- 正常进行 agent 推理

它应具备：

- `pi-memory-bridge`
- provider-registration extension

#### B. 内部 extraction pi RPC 进程

用途：

- candidate memory extraction
- entity / relation / event extraction
- consolidation
- planner / gating 等内部任务

它应满足：

- 使用独立 pi RPC 进程
- 启动参数包含：

```text
pi --mode rpc --no-session
```

- 不保存会话
- 不进入 Pi-Telegram 正式会话体系
- 不加载 `pi-memory-bridge`
- 只需要 provider-registration extension

### 18.6 Failure tolerance

- extraction 失败：保留 raw turns，稍后重试
- embedding 失败：记忆可先落库但标记为待向量化
- 网络失败：主 agent 回复不应被阻塞太久

因此记忆系统应采用：

- 读路径尽量快
- 写路径异步优先
- 强依赖失败时自动降级

---

## 19. Security & Privacy

1. 默认本地 DB，数据不外发到第三方存储
2. 但会把提取样本发送给外部 LLM / embedding API
3. 应支持：
   - 删除指定记忆
   - 删除某个 scope 下全部记忆
   - 导出 / 备份
4. 对用户敏感数据应支持最小化保留
5. 对扩展发布形式要强调：
   - 扩展具有本机代码执行权限
   - 用户应只安装受信任来源的包
6. `settings.json` 中应优先保存 `apiKeyEnv` 之类的环境变量引用，而不是明文 API key

---

## 20. Failure Handling and Degradation Strategy

### 20.1 LLM extraction failure

- 原始 turn 仍然保留在 `raw_turns`
- 标记 extraction run 失败
- 后续可重试
- 不影响当前 agent 正常回复

### 20.2 Embedding failure

- 记忆可以先写入，但标记为 `embedding_missing`
- 后台异步补 embedding

### 20.3 Recall planner failure

- 降级为默认 hybrid recall
- 使用简单关键词 + 低层优先搜索
- 不阻塞主流程

### 20.4 Recall gating failure

- 使用 heuristic gating：
  - plane priority
  - lexical overlap
  - recency
- 若仍不稳定，则减少高层节点召回数量

### 20.5 Search timeout

- 降级只用 lexical / recent memories
- 再不行则跳过记忆注入，不阻塞主流程

### 20.6 DB lock / corruption

- 首版应启用 WAL 模式
- 建议增加备份与 integrity check 机制

### 20.7 Extension reload / restart

由于 pi 支持 `/reload` 和扩展热重载：

- 内存中的 debounce timer / 队列必须可丢失或可恢复
- 未 flush 的 raw turns 应尽量在事件边界落盘
- reload 后应通过 `session_start` 恢复运行态并继续工作

### 20.8 Known limitations inherited from TiMem

受论文启发，也应显式承认以下风险：

1. **LLM middleware performance**
   - consolidation / planner / gating 都会带来额外调用成本
2. **Structured representation is still limited**
   - 仅靠 summary + embedding 仍不足以表达全部结构信息
3. **Forgetting mechanism is incomplete**
   - 首版应有 TTL / deletion，但不代表已解决长期遗忘策略
4. **Temporal parameterization matters**
   - T2/T3/T4/T5 的窗口设计需要调参，不存在一组通用最佳值

---

## 21. Rollout Plan

### Phase -1: Codebase preparation baseline

- 完成 `docs/specs/pi-telegram-pre-memory-prep.md`
- 完成 `docs/specs/pi-telegram-refactor-automation.md`
- 固定 `src/` 的目标浅层模块结构：
  - `app/`
  - `telegram/`
  - `pi/`
  - `cron/`
  - `shared/`
  - `memory/`
- 通过一次性迁移辅助完成模块整理（可临时使用 `scripts/refactor/*` 一类脚本）
- 用机械迁移方式完成：
  - 文件归位
  - import/export 重写
  - shim 生成
  - `main.ts` 薄入口化
- 让 `src/memory/` 成为稳定落点，但此阶段**不实现 memory 主逻辑**

### Phase 0: Memory spec baseline

- 完成本 spec
- 统一 scope 设计与扩展契约
- 统一联邦式分层记忆模型
- 统一 TMT 适配策略
- 明确 bridge、provider-registration extension、memory core 的边界

### Phase 1: MVP integrated memory core + internal bridge

- `Pi-Telegram` 内置 `pi-memory` core
- 同仓库加入 `packages/pi-memory-bridge`
- 定义 `bridge.manifest.json`
- 确立 `bridgeProtocolVersion`
- 读取 `C:\Users\Administrator\.pi\telegram\settings.json`
- 按 `memory.llm` 配置生成临时 provider-registration extension
- embedding 走 OpenAI SDK 兼容端点直连
- 内部 extraction runner 使用 `pi --mode rpc --no-session`
- SQLite 持久化
- `agent_end` 写 raw turns
- T1 consolidation
- embedding + semantic search
- lexical search (FTS5)
- `before_agent_start` 注入上下文
- `session_before_switch` / `session_shutdown` flush
- chat-local + workspace-global 基础支持

### Phase 2: Temporal hierarchy completion

- T2/T3/T4/T5 consolidation
- planner / gating 基础版本
- parent-child edges
- basic dedupe / merge
- MemGPT-inspired context pager / recursive queue summary
- warning threshold / flush threshold 的 prompt budget 管理

### Phase 3: User-global & routing refinement

- user-global scope 正式启用
- promotion / routing rules 完整实现
- procedural plane 提升准确率
- forget / delete operations

### Phase 4: Explicit memory tools

- agent 可主动调用 `memory_add`
- 用户可显式说“记住这个”“忘掉这个”
- implicit extraction 与 explicit tools 协同
- 建立 active memory operation chain：
  - admission control
  - operation decision
  - add / update / delete / noop
  - link / evolve（可选）
- 复杂查询可进一步引入 retrieve / reflect / rerank 的闭环控制

### Phase 5: Advanced ranking & forgetting

- temperature lifecycle
- context compression
- smarter plane routing
- optional vector backend acceleration
- forgetting / decay / archival policy

---

## 22. Open Questions

1. 首版是否强依赖稳定的 `userId`，还是允许 `user-global` 延后启用？
2. `workspaceId` 的正式生成规则是：cwd hash、repo root hash，还是显式配置？
3. `T2/T3/T4/T5` 的默认时间窗口如何参数化，才能适配 coding-agent 而不是机械沿用 day/week/month？
4. `procedural` plane 是不是永远使用 revision chain，而不进入完整五层树？
5. memory context 在调试模式下是否允许可见？
6. 显式 tool、implicit extraction 与 active memory controller 的优先级如何定义？
7. 是否允许 `Pi-Telegram` 提供 Telegram 侧 `/memory` 命令，还是首版完全走自动记忆流程？
8. forgetting / archival policy 是否应在 MVP 后尽快补入，而不是拖到更后阶段？
9. `canonical_uri` 与 `family_uri` 的生成规则应完全可重算，还是允许一次生成后永久固定？
10. `entityType` 与 `predicate` inventory 是否应该配置化，还是首版先硬编码 canonical set？
11. unresolved entity mention 是直接保留，还是必须在 extraction 阶段尽量归一化？

---

## 23. Initial Recommendation

首版推荐方案：

- 在真正实现 `pi-memory` 前，先执行：
  - `docs/specs/pi-telegram-pre-memory-prep.md`
  - `docs/specs/pi-telegram-refactor-automation.md`
  - 先把代码库整理到可承载 `src/memory/` 的状态
- `pi-memory` 作为 **Pi-Telegram 内置子系统** 实现
- `pi-memory-bridge` 作为 **Pi-Telegram 同仓库内部 bridge 扩展** 实现
- bridge 扩展位于：
  - `packages/pi-memory-bridge`
- memory 模型配置统一来自：
  - `C:\Users\Administrator\.pi\telegram\settings.json`
- 模型策略：
  - `memory.embedding` 由 Pi-Telegram memory core 直接通过 OpenAI SDK 兼容端点调用
  - `memory.llm` 采用与 pi custom provider 对齐的简化配置语义
  - Pi-Telegram 根据 `memory.llm` 生成临时 provider-registration extension
- bridge 扩展的加载方式：
  - 语义上按当前 `Pi-Telegram` GitHub ref 临时一次性加载
  - 实现上允许 Pi-Telegram 做本地缓存
  - 启动时通过本地缓存路径注入
- 版本策略：
  - `pi-memory` 不单独发版
  - `pi-memory-bridge` 与 `Pi-Telegram` **同版本绑定**
  - 运行时额外检查 `bridgeProtocolVersion`
- 主动记忆策略：
  - MVP 先采用被动 extraction + admission control
  - 后续再引入 active memory operation chain
  - 主动链路默认先以内置控制动作实现，而不是一开始就暴露全部 public tools
- 主运行形态：
  - **Pi-Telegram = Memory Core**
  - **主对话 pi 进程 = bridge hook layer + provider-registration capability**
  - **内部 extraction pi 进程 = `pi --mode rpc --no-session` + provider-registration capability**
- 主架构：**Federated Layered Memory + TiMem-inspired TMT + Canonical URI Layer**
- 运行时上下文管理：**MemGPT-inspired context residency layer / pager**
- 联邦平面：
  - `L0 Raw Buffer`
  - `L1 Chat Episodic`
  - `L2 User / Profile`
  - `L3 Workspace / Project`
  - `L4 Procedural / Correction`
- 作用域：
  - `chat-local`
  - `user-global`
  - `workspace-global`
- 时间层级：
  - `T1 factual evidence`
  - `T2 chunk/session summary`
  - `T3 short-horizon pattern`
  - `T4 medium-horizon trend`
  - `T5 stable profile/charter`
- 身份层：
  - `canonical_uri`
  - `family_uri`
  - `entity_uri`
  - `edge_uri`
  - `turn_uri`
- 主存储：SQLite + FTS5
- 外部 API：LLM extraction / planner / gating + embedding
- 图谱层：entity discovery + entity linking + relation extraction + graph fusion
- 图谱 schema：typed entity inventory + canonical predicate inventory + event/action node schema
- 注入点：bridge `before_agent_start`
- 写入点：bridge `agent_end` + `session_before_switch` + `session_shutdown`
- 召回方式：planner + hierarchical propagation + gating
- bridge MVP 不注册 pi TUI commands / renderers

这是当前复杂度 / 可维护性 / 业务贴合度之间最平衡的路径。

---

## 24. Reference

- Kai Li et al., **TiMem: Temporal-Hierarchical Memory Consolidation for Long-Horizon Conversational Agents**, arXiv:2601.02845, 2026.
- Paper URL: https://arxiv.org/abs/2601.02845
