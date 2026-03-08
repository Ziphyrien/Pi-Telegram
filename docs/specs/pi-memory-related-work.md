# pi-memory Related Work

Status: Draft
Related Spec: `docs/specs/pi-memory.md`
Last Updated: 2026-03-08

## 1. Purpose

本文档整理与 `pi-memory` 最相关的论文与系统设计，重点关注：

- 长期记忆
- 混合搜索（semantic / lexical / graph / temporal）
- 层级巩固
- 复杂度感知召回
- reranking / gating / filtering
- 时间连续性与遗忘机制

目标不是做综述大全，而是明确：

1. 哪些论文最值得借鉴
2. 各自适合融入 `pi-memory` 的哪一层
3. 哪些机制适合进入主 spec
4. 哪些机制目前不应直接照搬

---

## 2. Design Questions for pi-memory

`pi-memory` 当前要解决的不是单一“检索问题”，而是六类组合问题：

1. **什么值得记忆？**
2. **记忆如何跨时间巩固？**
3. **不同作用域的记忆如何共存？**
4. **查询时如何做混合召回？**
5. **最终候选如何 rerank / gate / collapse？**
6. **模型何时应主动发起记忆操作（add / update / delete / retrieve / reflect）？**

对应地，相关工作也应按功能拆看，而不是只看“哪个系统更强”。

---

## 3. Most Relevant Papers

## 3.1 TiMem: Temporal-Hierarchical Memory Consolidation for Long-Horizon Conversational Agents

- **Paper**: Kai Li et al., 2026
- **ID**: arXiv:2601.02845
- **URL**: https://arxiv.org/abs/2601.02845

### Core ideas

- Temporal Memory Tree (TMT)
- Semantic-guided consolidation
- Stratified scheduling
- Complexity-aware recall
- Recall Planner + Hierarchical Recall + Recall Gating

### Why it matters to pi-memory

TiMem 是当前 `pi-memory` spec 的主理论骨架，尤其适合：

- 把时间连续性显式建模
- 用 child memories + historical memories 做高层巩固
- 让召回路径按 query complexity 自适应

### What to borrow

- `T1~T5` 时间抽象层级
- planner 输出 complexity / levels / budget
- base-level activation -> hierarchical propagation -> gating
- instruction-guided consolidation（不依赖 fine-tuning）

### What not to copy literally

- 不要机械照搬 day/week/month 的窗口设计
- coding-agent / Telegram 场景需要重新参数化 temporal window
- procedural memory 不必强行放进完整 T1~T5 树

---

## 3.2 HyMem: Hybrid Memory Architecture with Dynamic Retrieval Scheduling

- **Paper**: 2026
- **ID**: arXiv:2602.13933
- **URL**: https://arxiv.org/html/2602.13933v1

### Core ideas

- Hybrid memory
- Dual-granularity storage
- Dynamic retrieval scheduling
- Query complexity 驱动浅层 / 深层记忆切换

### Why it matters to pi-memory

HyMem 对 `pi-memory` 最大的价值不是“内存结构”，而是：

- **检索不是固定路径**
- 应按 query complexity 动态切换召回深度和资源预算

### What to borrow

- shallow vs deep recall scheduling
- complexity-aware retrieval budget
- 不同 query 走不同 memory plane / level 组合

### What not to copy literally

- 不必照抄其 memory module 分法
- 我们已有 plane / scope / TMT，需要借鉴的是调度思想

---

## 3.3 Query-focused and Memory-aware Reranker for Long Context Processing

- **Paper**: 2026
- **ID**: arXiv:2602.12192
- **URL**: https://arxiv.org/pdf/2602.12192

### Core ideas

- Query-focused reranking
- Memory-aware reranking
- rank -> rerank pipeline

### Why it matters to pi-memory

`pi-memory` 的真正难点不只是“召回到候选”，而是：

- 如何在多个 plane / 多个 temporal level / 多个 scope 的候选里选最合适的
- 如何避免把相似但不对题的记忆一起塞进上下文

### What to borrow

- 检索和 rerank 分层
- query-aware final ordering
- memory-aware feature augmentation

### What not to copy literally

- 不必依赖该文的具体 reranker 架构
- 可以先在 spec 中抽象成 `Recall Gating + Hybrid Rerank`

---

## 3.4 A Simple Yet Strong Baseline for Long-Term Conversational Memory (event-centric memory graph)

- **Paper**: 2025
- **ID**: arXiv:2511.17208
- **URL**: https://arxiv.org/html/2511.17208v1

### Core ideas

- event-centric memory graph
- enriched EDUs 作为 memory unit
- dense–sparse integration
- graph-based associative recall
- query mention anchoring
- LLM-based recall filtering

### Why it matters to pi-memory

这篇论文对“混合搜索”的实际启发极强，因为它几乎正面回答了：

- 为什么不能只用 flat chunks
- 为什么 graph retrieval 值得做
- 为什么 dense + sparse + graph + filter 要联合使用

### What to borrow

- event-centric / self-contained memory units
- dense–sparse integration
- entity / concept mention anchoring
- retrieval 后再做 LLM recall filtering

### What not to copy literally

- 不必把整个系统完全变成 event graph-only
- 我们仍然保留联邦平面 + TMT + URI 层

---

## 3.5 MemoRAG: Boosting Long Context Processing with Global Memory-Enhanced Retrieval Augmentation

- **Paper**: 2024/2025
- **ID**: arXiv:2409.05591
- **URL**: https://arxiv.org/abs/2409.05591

### Core ideas

- global memory compression
- dual-system architecture
- clue-guided retrieval
- draft answer / clues 先行，再检索证据

### Why it matters to pi-memory

MemoRAG 对 `pi-memory` 的价值不在于“长期记忆管理”，而在于：

- 对复杂、模糊查询，不应直接拿 query 原文去搜
- 可以先生成 retrieval clues，再做更精准的检索

### What to borrow

- optional clue generation stage before retrieval
- 先 planner / clue，再 retrieval
- 对隐式查询更友好

### What not to copy literally

- 不需要 MemoRAG 的 KV compression 机制
- 其重点在长文上下文，不完全等同于长期记忆系统

---

## 3.6 Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects

- **Paper**: 2025
- **ID**: arXiv:2512.12818
- **URL**: https://arxiv.org/html/2512.12818v1

### Core ideas

- retain / recall / reflect 三段式
- graph- and time-aware retrieval
- 反思（reflect）操作与长期记忆质量有关

### Why it matters to pi-memory

它对 `pi-memory` 的提醒是：

- 记忆系统不能只有存和搜
- 还应该有“reflect / revise / consolidate”

### What to borrow

- graph-aware + time-aware recall
- 反思操作对记忆演化有帮助
- recall 后的 memory evolution 可以作为后续阶段

---

## 3.7 LightMem: Lightweight and Efficient Memory-Augmented Generation

- **Paper**: 2025
- **ID**: arXiv:2510.18866
- **URL**: https://arxiv.org/html/2510.18866v1

### Core ideas

- sensory -> short-term -> long-term
- topic-aware short-term consolidation
- sleep-time update
- 在线检索与离线巩固解耦

### Why it matters to pi-memory

LightMem 很适合补强 `pi-memory` 在效率上的设计：

- 在线路径不要太重
- 高层巩固应尽量离线化
- consolidation 不应阻塞主回复路径

### What to borrow

- sleep-time / offline consolidation
- topic-aware grouping
- 短期记忆和长期记忆分工

---

## 3.8 MemoryBank: Enhancing Large Language Models with Long-Term Memory

- **Paper**: 2023
- **ID**: arXiv:2305.10250
- **URL**: https://arxiv.org/abs/2305.10250

### Core ideas

- long-term memory with user portrait
- forgetting curve inspired updating
- recall + reinforce + forget

### Why it matters to pi-memory

虽然它在检索结构上不如新论文复杂，但很适合补强：

- 用户画像
- reinforcement / decay
- forgetting policy

### What to borrow

- recency + importance + reinforcement
- forgetting / strengthen dynamics
- profile memory 长期演化

---

## 3.9 A-MEM: Agentic Memory for LLM Agents

- **Paper**: 2025
- **ID**: 2502.12110 / OpenReview NeurIPS 2025
- **URLs**:
  - https://openreview.net/forum?id=FiM0M8gcct
  - https://www.alphaxiv.org/overview/2502.12110v9

### Core ideas

- Zettelkasten-inspired dynamic memory organization
- dynamic indexing and linking
- memory evolution
- link generation + contextual expansion

### Why it matters to pi-memory

它对 `pi-memory` 的主要价值在于：

- URI layer
- entity / relation edge
- dynamic link growth
- memory evolution beyond static storage

### What to borrow

- note-like memory unit enrichment
- dynamic linking
- 更新旧记忆的 contextual representation

---

## 3.10 Continuum Memory Architectures for Long-Horizon LLM Agents

- **Paper**: 2026
- **ID**: arXiv:2601.09913
- **URL**: https://arxiv.org/html/2601.09913v1

### Core ideas

- memory as a continuously evolving substrate
- selective retention
- associative routing
- temporal chaining
- retrieval-driven mutation
- contextual partitioning / disambiguation

### Why it matters to pi-memory

这篇论文更像“架构哲学”，适合当成 checklist：

- 我们的系统是否真的支持动态记忆？
- 检索是否会影响未来状态？
- 是否能做上下文消歧与关联传播？

### What to borrow

- retrieval-driven mutation 作为未来演进方向
- contextual disambiguation
- temporal chaining
- selective retention checklist

---

## 3.11 LOCOMO / Long-term conversational memory evaluation

- **Paper**: 2024
- **ID**: arXiv:2402.17753
- **URL**: https://www.alphaxiv.org/overview/2402.17753v1

### Why it matters to pi-memory

它不是混合搜索架构论文，但它告诉我们：

- 纯长上下文不够
- temporal reasoning 仍然困难
- observation-based retrieval 往往优于原始对话检索

### What to borrow

- retrieval unit 应偏向 distilled observation / event unit
- temporal reasoning 必须是系统级关注点
- benchmark 设计可借鉴

---

## 3.12 Knowledge Graph Extraction and Fusion Papers

以下论文更偏向“从文本 / 对话自动抽实体关系并构图”，对 `pi-memory` 的图谱层最直接：

### Automated Construction of Theme-specific Knowledge Graphs

- **ID**: arXiv:2404.19146
- **URL**: https://arxiv.org/html/2404.19146v1

#### 值得借鉴
- entity ontology + relation ontology
- 先生成 relation candidate set，再让 LLM 选择
- 明确支持 `none` relation，减少误抽取

#### 对 pi-memory 的意义
- 适合 relation candidate generation
- 适合 `entity_uri` / `edge_uri` 的 relation inventory 设计

### RAKG: Document-level Retrieval Augmented Knowledge Graph Construction

- **ID**: arXiv:2504.09823
- **URL**: https://arxiv.org/pdf/2504.09823

#### 值得借鉴
- retrieval-augmented KG construction
- pre-entities 作为中间表示
- 利用 subgraph + context 共同做关系构建

#### 对 pi-memory 的意义
- 适合把 retrieval 引入 graph construction 本身
- 适合 `graph fusion` 与 `subgraph-aware extraction`

### WAKA: Human-Supervised Knowledge Graph Construction from Natural Language

- **ID**: arXiv:2401.07683
- **URL**: https://arxiv.org/pdf/2401.07683

#### 值得借鉴
- entity discovery pipeline
- entity retrieval + reranking
- relation extraction + relation linking
- knowledge fusion + NLI verification

#### 对 pi-memory 的意义
- 适合工程化拆分 graph extraction pipeline
- 适合后续 `/memory trace` / `/memory review` 调试能力

### Iterative Zero-Shot LLM Prompting for Knowledge Graph Construction

- **ID**: arXiv:2307.01128
- **URL**: https://arxiv.org/html/2307.01128

#### 值得借鉴
- iterative extraction
- entity / predicate resolution
- schema inference without fine-tuning

#### 对 pi-memory 的意义
- 适合 MVP 阶段先靠 prompt 做 KG extraction
- 适合 relation extraction 与 schema inference 解耦

### REBEL: Relation Extraction by End-to-end Language Generation

- **Venue**: Findings of EMNLP 2021
- **URL**: https://aclanthology.org/2021.findings-emnlp.204.pdf

#### 值得借鉴
- end-to-end relation extraction as generation
- triple-oriented structured output

#### 对 pi-memory 的意义
- 适合作为后续 relation extraction baseline
- 适合对比 LLM prompt-based relation extraction 的稳定性

### Docs2KG: Unified Knowledge Graph Construction from Heterogeneous Documents

- **ID**: arXiv:2406.02962
- **URL**: https://arxiv.org/pdf/2406.02962

#### 值得借鉴
- semantic proximity + structural proximity
- anchor node retrieval + n-hop expansion
- heterogeneous sources unified into a graph

#### 对 pi-memory 的意义
- 适合未来把文档/附件/网页内容并入记忆图谱
- 适合 structural + semantic mixed graph retrieval

## 3.13 SCM: Enhancing Large Language Model with Self-Controlled Memory Framework

- **Paper**: 2023/2025
- **ID**: arXiv:2304.13343
- **URL**: https://arxiv.org/abs/2304.13343

### Core ideas

- memory stream
- memory controller
- 决定何时激活记忆、何时只用摘要、何时引入更多历史信息
- 尽量只把必要记忆送回模型，避免噪音

### Why it matters to pi-memory

SCM 对 `pi-memory` 的主要启发是：

- “记忆控制器”应是一个明确组件
- 记忆使用不是无条件发生，而是要由控制层决定**何时、如何、引入多少**

### What to borrow

- memory controller 的显式建模
- selective activation
- summary-first / detail-later 的控制思路

---

## 3.14 How Memory Management Impacts LLM Agents: An Empirical Study of Experience-Following Behavior

- **Paper**: 2025
- **ID**: arXiv:2505.16067
- **URL**: https://arxiv.org/html/2505.16067v2

### Core ideas

- 系统研究 memory addition / deletion 对 agent 行为的影响
- 发现 experience-following 行为
- 指出错误记忆写入与错误经验回放会持续污染后续行为
- evaluator signal 对 memory management 很关键

### Why it matters to pi-memory

这篇论文提醒 `pi-memory`：

- “主动记忆”不只是多写入，而是要防止错误传播
- admission / deletion / update 必须可审计、可约束
- evaluator-like 信号值得进入 admission control

### What to borrow

- 将 memory add / delete 视为高风险控制点
- 在 admission / update 阶段引入 reliability 信号
- 对错误记忆引入修订、删除与冷却机制

---

## 3.15 A-MAC: Adaptive Memory Admission Control for LLM Agents

- **Paper**: 2026
- **ID**: arXiv:2603.04549
- **URL**: https://arxiv.org/abs/2603.04549

### Core ideas

- 把 memory admission 看成结构化决策问题
- 不依赖“全靠 LLM 一次判断”
- 用 interpretable signals 评估 future utility、confidence、novelty 等维度
- hybrid design：规则特征 + 少量 LLM 推断

### Why it matters to pi-memory

A-MAC 对 `pi-memory` 的直接价值在于：

- “是否写入长期记忆”应单独建模为 admission control
- 应把 add / update / reject 视为准入决策，而不是 extraction 的附带产物

### What to borrow

- admission control 作为独立阶段
- value / reliability / persistence / novelty 等准入特征
- rule-first + LLM-assisted 的 hybrid decision

---

## 3.16 Memory-R1: Enhancing Large Language Model Agents to Manage and Utilize Memories via Reinforcement Learning

- **Paper**: 2025
- **ID**: arXiv:2508.19828
- **URL**: https://arxiv.org/abs/2508.19828

### Core ideas

- Memory Manager 学习执行 `{ADD, UPDATE, DELETE, NOOP}`
- Answer Agent 对检索记忆再做 distillation / selection
- 用 outcome-driven RL 学习 memory operation，而不是只靠 in-context instruction

### Why it matters to pi-memory

Memory-R1 对 `pi-memory` 的关键启发是：

- memory operation inventory 应明确化
- `update` 与 `delete` 不能只靠启发式字符串规则
- 回答链路中的“distillation”与记忆管理链路可分离

### What to borrow

- `{ADD, UPDATE, DELETE, NOOP}` 作为核心写操作词表
- memory manager 与 answer/retrieval selection 分离
- outcome-driven evaluation 作为后续演进方向

---

## 3.17 Agentic Memory (AgeMem): Unified Long-Term and Short-Term Memory Management for LLM Agents

- **Paper**: 2026
- **ID**: arXiv:2601.01885
- **URL**: https://arxiv.org/abs/2601.01885

### Core ideas

- 把 memory operation 暴露成 tool-based action
- 统一管理 LTM 与 STM
- 操作集合覆盖 `ADD / UPDATE / DELETE / RETRIEVE / SUMMARY / FILTER`
- 把 memory management 纳入 agent policy 本身

### Why it matters to pi-memory

AgeMem 对 `pi-memory` 的价值在于：

- “主动记忆链路”应覆盖写与读两侧
- 不只要有 write-time add/update/delete，也要有 read-time retrieve/summary/filter
- memory tools 可以被看作模型决策空间的一部分，而不是纯外部胶水

### What to borrow

- write-side 与 read-side operation inventory 分开设计
- tool-shaped memory actions
- 主动记忆控制作为 future phase，而不是只做被动 extraction

---

## 3.18 MemR3: Memory Retrieval via Reflective Reasoning for LLM Agents

- **Paper**: 2025
- **ID**: arXiv:2512.20237
- **URL**: https://arxiv.org/abs/2512.20237

### Core ideas

- retrieve / reflect / answer 三动作闭环
- router 动态决定下一步操作
- global evidence-gap tracker 显式维护“已知证据 / 缺失证据”
- 检索不是一次性动作，而是闭环顺序决策

### Why it matters to pi-memory

MemR3 对 `pi-memory` 的主要启发是：

- 检索链路也可以是主动控制链路
- 对复杂 query，可引入 retrieve–reflect–answer 的闭环检索控制器
- 应显式区分“已经拿到什么证据”和“还缺什么证据”

### What to borrow

- closed-loop retrieval controller
- evidence-gap tracking
- reflect 作为 retrieval-time action，而不是只用于 write-time reflection

---

## 3.19 ActMem: Bridging the Gap Between Memory Retrieval and Reasoning in LLM Agents

- **Paper**: 2026
- **ID**: arXiv:2603.00026
- **URL**: https://arxiv.org/abs/2603.00026

### Core ideas

- 强调 retrieval 与 reasoning 的断裂问题
- 用 actionable memory graph 把“可回忆”转成“可行动”
- memory KG 中加入 causal / semantic edges
- 二次 refined retrieval + reasoning 共同作用

### Why it matters to pi-memory

ActMem 提醒 `pi-memory`：

- 主动记忆链路的目标不是“记得住”，而是“对当前行动有用”
- 检索后的 reasoning / conflict detection 也应进入设计
- graph retrieval 的价值在于支撑 action-oriented reasoning

### What to borrow

- retrieval-reasoning coupling
- conflict-aware memory use
- 复杂 query 下的 refined retrieval

---

## 3.20 MemGPT: Towards LLMs as Operating Systems

- **Paper**: 2023/2024
- **ID**: arXiv:2310.08560
- **URL**: https://arxiv.org/abs/2310.08560

### Core ideas

- virtual context management
- main context vs external context
- working context + FIFO queue + recursive summary
- recall storage + archival storage
- memory pressure warning / flush thresholds
- function-chained retrieval / interrupts

### Why it matters to pi-memory

MemGPT 对 `pi-memory` 的最大价值不在于“我们要照抄它整套系统”，而在于它明确指出：

- 真正稀缺的是 **prompt 主上下文容量**
- 外部长期记忆系统必须配套一个**context pager / working-set compiler**
- recall store 与 archival store 应被区别对待
- 长对话历史不应简单丢弃，而应通过 recursive summary + searchable recall 保存

### What to borrow

- 把 context residency 作为一等问题建模
- pinned working set / recent queue / recall-only / archival-only 的运行时分层
- warning threshold / flush threshold 的 prompt budget 管理
- recursive session summary
- 多步函数链式 retrieval 的控制思想

### What not to copy literally

- 不必复刻 MemGPT 的完整 agent runtime
- 不必把所有上下文编辑权直接下放给主对话模型
- 在 `pi-memory` 中，context pager 更适合由 `Pi-Telegram` Memory Core 主控，而不是完全放给 bridge 或前台 agent 自由操作

## 4. How these papers map to pi-memory

| Problem | Best references | What to borrow |
|---|---|---|
| 时间层级巩固 | TiMem, LightMem | T1-T5 / stratified scheduling / offline consolidation |
| 查询复杂度驱动召回 | TiMem, HyMem | planner / adaptive budget / dynamic retrieval scheduling |
| dense + sparse 混合搜索 | 2511.17208, QRRanker | dense–sparse integration / rerank split |
| 图 / 关联检索 | 2511.17208, A-MEM, Hindsight | graph anchor / associative recall / linking |
| clue-guided retrieval | MemoRAG, MemR3 | query clue stage / refinement query |
| rerank / gating | TiMem, QRRanker, 2511.17208, MemR3 | planner + filtering + reranking + evidence-gap control |
| 主动记忆准入 | A-MAC, 2505.16067 | admission control / evaluator signals / novelty-reliability tradeoff |
| 主动记忆 CRUD / operation inventory | Memory-R1, AgeMem, SCM | ADD / UPDATE / DELETE / NOOP / RETRIEVE / SUMMARY / FILTER |
| 检索-推理闭环 | MemR3, ActMem | retrieve / reflect / answer / refined retrieval / action-oriented reasoning |
| 虚拟上下文管理 | MemGPT | working set / recall store / archival store / memory pressure / recursive summary |
| profile / forgetting | MemoryBank, CMA, 2505.16067 | user profile / reinforcement / decay / stale memory risk |
| 系统级架构约束 | CMA, SCM, MemGPT | persistence / retention / mutation / chaining / controller design / context pager |

---

## 5. Recommended Hybrid Retrieval Stack for pi-memory

综合这些论文，`pi-memory` 的混合搜索建议采用四层：

### Layer 1 — Planner / Query Analysis

参考：
- TiMem
- HyMem
- MemoRAG

职责：
- complexity classification
- keyword extraction
- optional clue generation
- retrieval budget selection

### Layer 2 — Candidate Retrieval

参考：
- 2511.17208
- TiMem
- MemoRAG

通道：
- dense semantic retrieval
- sparse lexical retrieval
- entity / concept anchor retrieval
- temporal neighborhood retrieval

### Layer 3 — Associative / Hierarchical Expansion

参考：
- TiMem
- Hindsight
- A-MEM
- CMA

职责：
- 沿 TMT 向上收集祖先
- 沿 graph / URI / entity 边扩展关联节点
- 做跨 plane 的局部传播

### Layer 4 — Rerank / Gate / Collapse

参考：
- QRRanker
- TiMem
- 2511.17208

职责：
- query-aware reranking
- URI-family collapse
- evidence vs summary 选层
- final context assembly

### Optional Control Overlay — Retrieve / Reflect / Answer

参考：
- MemR3
- ActMem

职责：
- 在复杂 query 下把检索变成闭环控制过程
- 显式维护 evidence gap
- 决定是否继续 retrieve、先 reflect，还是直接 answer

### Context Residency Overlay — Working Set / Recall / Archival Pager

参考：
- MemGPT

职责：
- 把 prompt 主上下文当成稀缺资源管理
- 区分 pinned working set、recent queue、recall-only、archival-only
- 在 memory pressure 下执行 recursive summary、queue flush 与回填策略

---

## 6. What should enter the main spec now

建议立即融入主 spec 的点：

1. **Hybrid retrieval channels**
   - semantic / lexical / graph / temporal
2. **Planner / Retrieval / Reranker split**
3. **Optional clue-guided retrieval stage**
4. **Entity / concept anchoring**
5. **Sleep-time / offline consolidation**
6. **MemGPT-inspired context pager**
   - working set / recall store / archival store
   - warning threshold / flush threshold
   - recursive session summary
7. **Admission control as a separate stage**
   - 不把“是否写入”混进 extraction 的附带输出里
8. **Operation inventory for active memory**
   - `add / update / delete / noop`（写侧）
   - `retrieve / reflect / rerank`（读侧）
9. **Closed-loop retrieval controller as future phase**
   - retrieve–reflect–answer / evidence-gap tracking
10. **Reinforcement / forgetting policy 作为后续阶段**

## Not urgent for the main spec

1. 复杂的 learned reranker 细节
2. 完整 graph neural retrieval
3. 端到端 RL 训练 memory manager
4. 完整认知架构复刻

---

## 7. Preliminary Position for pi-memory

`pi-memory` 不应做成：

- 纯向量库
- 纯 summary memory
- 纯 graph memory
- 纯 RAG wrapper

而应做成：

> **联邦式平面记忆 + 时间层级树 + URI 身份层 + 混合检索栈**

也就是：

- plane 负责角色划分
- scope 负责归属划分
- temporal tree 负责时间抽象
- URI layer 负责身份与追踪
- hybrid retrieval stack 负责查询时的实际召回与过滤

---

## 8. Suggested Next Spec Updates

主 spec 建议继续补以下章节或增强现有章节：

1. `Related Work`（简短版）
2. `Hybrid Retrieval Architecture`
3. `Retrieval Channels`
4. `Planner / Retrieval / Reranker split`
5. `Clue-guided retrieval`
6. `Admission Control`
7. `Active Memory Operation Chain`
8. `Offline consolidation / sleep-time update`

---

## 9. References

- TiMem: Temporal-Hierarchical Memory Consolidation for Long-Horizon Conversational Agents. arXiv:2601.02845.
- HyMem: Hybrid Memory Architecture with Dynamic Retrieval Scheduling. arXiv:2602.13933.
- Query-focused and Memory-aware Reranker for Long Context Processing. arXiv:2602.12192.
- A Simple Yet Strong Baseline for Long-Term Conversational Memory. arXiv:2511.17208.
- MemoRAG: Boosting Long Context Processing with Global Memory-Enhanced Retrieval Augmentation. arXiv:2409.05591.
- Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects. arXiv:2512.12818.
- LightMem: Lightweight and Efficient Memory-Augmented Generation. arXiv:2510.18866.
- MemoryBank: Enhancing Large Language Models with Long-Term Memory. arXiv:2305.10250.
- A-MEM: Agentic Memory for LLM Agents. OpenReview / arXiv:2502.12110.
- MemGPT: Towards LLMs as Operating Systems. arXiv:2310.08560.
- SCM: Enhancing Large Language Model with Self-Controlled Memory Framework. arXiv:2304.13343.
- How Memory Management Impacts LLM Agents: An Empirical Study of Experience-Following Behavior. arXiv:2505.16067.
- Adaptive Memory Admission Control for LLM Agents. arXiv:2603.04549.
- Agentic Memory: Learning Unified Long-Term and Short-Term Memory Management for Large Language Model Agents. arXiv:2601.01885.
- Memory-R1: Enhancing Large Language Model Agents to Manage and Utilize Memories via Reinforcement Learning. arXiv:2508.19828.
- MemR3: Memory Retrieval via Reflective Reasoning for LLM Agents. arXiv:2512.20237.
- ActMem: Bridging the Gap Between Memory Retrieval and Reasoning in LLM Agents. arXiv:2603.00026.
- Continuum Memory Architectures for Long-Horizon LLM Agents. arXiv:2601.09913.
- Evaluating Very Long-Term Conversational Memory of LLM Agents. arXiv:2402.17753.
