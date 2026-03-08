# pi-memory Prompt Spec

Status: Draft
Related Specs:
- `docs/specs/pi-memory.md`
- `docs/specs/pi-memory-related-work.md`
Last Updated: 2026-03-08

## 1. Purpose

本文档定义 `pi-memory` 的 **LLM prompt contracts**。

这些 prompt 运行在 **Pi-Telegram 的 Memory Core** 内，而不是运行在 bridge 扩展里。

重点覆盖：

- 候选记忆提取
- 实体发现
- 实体链接 / 归一化
- 关系候选生成
- 关系判定
- 事件/动作节点构建
- T1~T5 层级巩固
- Recall Planner
- Recall Gating
- Hybrid Rerank / Evidence Selection

目标不是给出“好看的 prompt 文案”，而是给出：

1. 每一步的职责边界
2. 输入/输出 JSON 形状
3. 允许的词表 / 枚举
4. 降低 hallucination 的约束
5. 后续可直接转实现的 prompt contract

---

## 2. Prompting Principles

所有 `pi-memory` prompt 默认遵守以下原则。

### 2.1 JSON-first

- 输出必须是 **strict JSON**
- 不允许 Markdown 解释
- 不允许额外自然语言前后缀
- 不允许省略字段名

### 2.2 Closed-world bias

默认采取“**保守抽取**”策略：

- 看不出来就输出 `none` / `unknown` / `unresolved`
- 不为追求覆盖率而胡乱补实体或关系
- 若是推断而不是显式证据，必须打上 `inference: true`

### 2.3 Evidence-grounded

抽取出的实体、关系、事件节点，必须尽量附带：

- `evidenceTurnUris`
- `evidenceSpans`（若可用）
- `confidence`

### 2.4 Canonical vocabulary preferred

- `entityType` 应优先使用 canonical inventory
- `predicate` 应优先使用 canonical predicate inventory
- 输出词表外关系时，必须通过后处理映射回 canonical inventory，或降级为 `related_to`

### 2.5 Separation of concerns

不同 prompt 只做自己的事：

- entity discovery 不负责最终 linking
- relation candidate generation 不负责最终 relation decision
- planner 不负责最终 rerank
- gating 不负责生成新记忆

### 2.6 Determinism bias

建议实现时：

- `temperature` 接近 0
- 使用 JSON schema / response format（如果 provider 支持）
- 长 prompt 中先给 inventory 再给 context

---

## 3. Shared Prompt Context Blocks

多个 prompt 可复用这些上下文块。

### 3.1 Scope block

```json
{
  "chatScope": "chat:telegram:<botHash>:<chatId>",
  "userScope": "user:telegram:<userId>",
  "workspaceScope": "workspace:<workspaceId>",
  "source": "telegram"
}
```

### 3.2 Entity inventory block

传给 LLM 的应是精简版，而不是整份大词典。至少包含：

- `entityType`
- 定义
- 正例示意

示例：

```json
{
  "entityTypes": [
    { "name": "repository", "description": "代码仓库，如 GitHub repo" },
    { "name": "workspace", "description": "当前工作区或项目根目录" },
    { "name": "rule", "description": "稳定行为规则或执行约束" },
    { "name": "tool", "description": "agent 可调用工具，如 bash/read/edit/write" },
    { "name": "concept", "description": "无法可靠归类时的兜底概念" }
  ]
}
```

### 3.3 Predicate inventory block

示例：

```json
{
  "predicates": [
    "prefers",
    "avoids",
    "requires",
    "prohibits",
    "corrects",
    "overrides",
    "supports_rule",
    "uses",
    "depends_on",
    "implements",
    "configures",
    "affects",
    "related_to",
    "works_on",
    "targets",
    "happened_before",
    "happened_after",
    "derived_from",
    "summarizes",
    "revision_of",
    "same_topic_as",
    "contradicts",
    "supports_fact",
    "references",
    "mentions"
  ]
}
```

### 3.4 Turn window block

```json
{
  "turns": [
    {
      "turnUri": "urn:pi-memory:turn:telegram:...",
      "role": "user",
      "content": "...",
      "timestamp": 1730000000000
    }
  ]
}
```

### 3.5 Existing entity candidates block

给 linking prompt 用：

```json
{
  "mention": "Pi-Telegram",
  "candidates": [
    {
      "entityUri": "urn:pi-memory:entity:repo:github:Ziphyrien/Pi-Telegram",
      "entityType": "repository",
      "label": "Pi-Telegram",
      "aliases": ["pitg"],
      "description": "Telegram bridge for pi coding agent",
      "retrievalScore": 0.91
    }
  ]
}
```

### 3.6 Relation candidate block

```json
{
  "subject": {
    "entityUri": "urn:pi-memory:entity:user:telegram:123456",
    "entityType": "user",
    "label": "user"
  },
  "object": {
    "entityUri": "urn:pi-memory:entity:concept:local:spec-first-workflow",
    "entityType": "concept",
    "label": "spec-first-workflow"
  },
  "candidatePredicates": [
    "prefers",
    "requires",
    "related_to",
    "none"
  ]
}
```

---

## 4. Prompt 1 — Candidate Memory Extraction

### 4.1 Purpose

从 raw turns 中提取值得长期记忆的候选项。

### 4.2 Input

- turn window
- scope block
- 可选：最近已有 memory summaries

### 4.3 Output schema

```json
{
  "shouldRemember": true,
  "memories": [
    {
      "content": "用户偏好先写 spec 再开始实现。",
      "summary": "偏好：spec 优先",
      "type": "preference",
      "plane": "profile",
      "temporalLevel": "T3",
      "scopeRecommendation": "user-global",
      "importance": 0.92,
      "confidence": 0.89,
      "temperature": "warm",
      "keywords": ["spec", "实现流程"],
      "expiresAt": null,
      "mergeHint": "upsert",
      "evidenceTurnUris": [
        "urn:pi-memory:turn:telegram:..."
      ]
    }
  ],
  "skipReason": ""
}
```

### 4.4 Prompt contract

System intent:

- 你是长期记忆候选提取器
- 只提取对未来多轮交互仍有帮助的信息
- 忽略闲聊、寒暄、短期噪音
- 偏好稳定表达，不要照搬原文
- 输出必须是 JSON

Key rules:

- 若只是一次性上下文，优先落 `episodic`
- 若是持续偏好，才允许推荐 `profile`
- 若是项目约束，才允许推荐 `project`
- 若是行为纠偏，优先推荐 `procedural`

---

## 5. Prompt 2 — Entity Discovery

### 5.1 Purpose

从 turns / memory candidates / event candidates 中识别候选实体 mention。

### 5.2 Input

- turn window
- entity inventory block
- optional memory candidate text

### 5.3 Output schema

```json
{
  "entities": [
    {
      "mention": "Pi-Telegram",
      "entityType": "repository",
      "confidence": 0.93,
      "aliases": ["pitg"],
      "evidenceTurnUris": ["urn:pi-memory:turn:telegram:..."]
    },
    {
      "mention": "spec",
      "entityType": "concept",
      "confidence": 0.78,
      "aliases": ["specification"]
    }
  ]
}
```

### 5.4 Prompt contract

System intent:

- 你只负责找出实体 mention，不负责最终 URI linking
- 如果 mention 很模糊，但对后续检索有价值，也可以保留为 `concept`
- 不要把完整句子都当成实体

Extraction priorities:

1. repo / workspace / file / tool / command / model / provider
2. rule / preference / concept
3. task / issue / event anchor

---

## 6. Prompt 3 — Entity Linking / Normalization

### 6.1 Purpose

在候选实体集里为 mention 选择最合适的 canonical entity，或决定新建 / unresolved。

### 6.2 Input

- mention
- candidate entities from retrieval
- local sentence / turn context
- optional existing entity inventory near the same family

### 6.3 Output schema

```json
{
  "decision": "link",
  "entityUri": "urn:pi-memory:entity:repo:github:Ziphyrien/Pi-Telegram",
  "entityType": "repository",
  "confidence": 0.94,
  "reason": "Mention matches repository name and context is project architecture discussion"
}
```

Allowed decisions:

- `link`
- `create_new`
- `unresolved`

For `create_new`:

```json
{
  "decision": "create_new",
  "proposedEntity": {
    "entityType": "concept",
    "label": "spec-first-workflow",
    "aliases": ["先写 spec 再实现"],
    "description": "A working style where specification is written before implementation"
  },
  "confidence": 0.73
}
```

### 6.4 Prompt contract

System intent:

- 倾向于复用已有 canonical entity
- 只有在现有候选都明显不匹配时才建议 `create_new`
- 如果证据不足，不要强行链接，输出 `unresolved`

---

## 7. Prompt 4 — Relation Candidate Generation

### 7.1 Purpose

针对 subject / object 对生成一个较小的 relation candidate set，供下一步判定。

### 7.2 Input

- subject entity
- object entity
- entity types
- canonical predicate inventory
- optional type-based candidate matrix
- local context

### 7.3 Output schema

```json
{
  "candidatePredicates": [
    "prefers",
    "requires",
    "related_to",
    "none"
  ],
  "reason": "User + concept pair in preference-setting context"
}
```

### 7.4 Prompt contract

System intent:

- 你只负责缩小候选关系空间
- 候选集应尽量小而覆盖合理可能性
- 必须包含 `none`
- 优先从 canonical inventory 中选择

Constraint:

- 候选数量建议控制在 `3~7` 个

---

## 8. Prompt 5 — Relation Decision

### 8.1 Purpose

在给定上下文和候选谓词集合的情况下，选择最合适的关系，或返回 `none`。

### 8.2 Input

- subject entity
- object entity
- candidate predicates
- local context (sentence / turns / memory candidate)
- optional graph neighborhood

### 8.3 Output schema

```json
{
  "decision": "select",
  "predicate": "prefers",
  "confidence": 0.88,
  "inference": false,
  "evidenceTurnUris": ["urn:pi-memory:turn:telegram:..."],
  "reason": "The user explicitly states a preferred workflow"
}
```

Or:

```json
{
  "decision": "none",
  "predicate": "none",
  "confidence": 0.82,
  "inference": false,
  "reason": "No factual relation is supported by the context"
}
```

### 8.4 Prompt contract

System intent:

- 你必须在候选集合中选择，不能发明新谓词
- 若候选中都不合适，必须输出 `none`
- 如果关系来自推断而非直接证据，标记 `inference: true`

---

## 9. Prompt 6 — Event / Action Node Construction

### 9.1 Purpose

把多条 turn 压成一个可检索的事件/动作节点，而不是只保留原始对话。

### 9.2 Input

- turn window
- extracted entities
- selected relations
- current memory candidate

### 9.3 Output schema

```json
{
  "eventNode": {
    "eventType": "behavior_correction",
    "canonicalText": "用户要求先写 spec，再开始实现。",
    "summary": "流程纠偏：spec 优先于直接实现",
    "plane": "procedural",
    "temporalLevel": "T3",
    "importance": 0.95,
    "confidence": 0.91,
    "primaryEntityUris": [
      "urn:pi-memory:entity:concept:local:spec-first-workflow"
    ],
    "supportingTurnUris": [
      "urn:pi-memory:turn:telegram:..."
    ]
  }
}
```

### 9.4 Prompt contract

System intent:

- 构造一个最小但完整的事件/动作单元
- 不要把多个不相干动作塞进同一个节点
- 倾向使用简洁、稳定、可复用的语言

---

## 10. Prompt 7 — T1 Consolidation

### 10.1 Purpose

从原始 turn 生成最底层、最稳定的 factual evidence / event evidence 节点。

### 10.2 Input

- raw turn window
- entities
- relations
- event candidates
- T1 instruction block

### 10.3 Output schema

```json
{
  "nodes": [
    {
      "temporalLevel": "T1",
      "plane": "episodic",
      "canonicalText": "用户要求统一停止动作与 /new 行为一致。",
      "summary": "停止行为统一",
      "importance": 0.84,
      "confidence": 0.9,
      "primaryEntityUris": [],
      "supportingTurnUris": ["urn:pi-memory:turn:telegram:..."]
    }
  ]
}
```

### 10.4 Prompt contract

- 强调事实性 / 证据性
- 不做过高抽象
- 不生成人格级结论

---

## 11. Prompt 8 — T2/T3/T4/T5 Consolidation Family

### 11.1 Purpose

基于 child memories + same-level history，生成更高层的抽象节点。

### 11.2 Shared input

- `childMemories`
- `historicalMemories`
- `levelInstructions`
- `scopeContext`
- optional existing high-level nodes

### 11.3 Shared output schema

```json
{
  "nodes": [
    {
      "temporalLevel": "T4",
      "plane": "profile",
      "canonicalText": "用户长期偏好先通过 spec 收敛需求，再进入实现阶段。",
      "summary": "长期流程偏好：spec-first",
      "importance": 0.91,
      "confidence": 0.86,
      "supportingNodeUris": [
        "urn:pi-memory:node:episodic:..."
      ]
    }
  ]
}
```

### 11.4 Level-specific guidance

#### T2
- 目标：局部 session/chunk summary
- 侧重：把多个 T1 证据压成可用摘要

#### T3
- 目标：短期模式
- 侧重：重复出现的局部规律

#### T4
- 目标：中期趋势 / 稳定策略
- 侧重：跨 session 的长期偏好、长期项目约束

#### T5
- 目标：稳定画像 / 宪章级抽象
- 侧重：最稳定、最少变化、最值得长期保留的高层结论

---

## 12. Prompt 9 — Recall Planner

### 12.1 Purpose

根据 query 决定：

- complexity
- target planes
- target levels
- retrieval channels
- budget
- optional clues

### 12.2 Input

- user query
- optional recent conversation
- optional active task context
- optional memory stats

### 12.3 Output schema

```json
{
  "complexity": "hybrid",
  "keywords": ["停止行为", "/new", "流式输出"],
  "clues": ["行为规则修订", "流式停止显示逻辑"],
  "targetPlanes": ["procedural", "project", "episodic"],
  "targetLevels": ["T1", "T3", "T5"],
  "targetChannels": ["dense", "sparse", "graph", "temporal"],
  "scopeHints": ["workspace-global", "chat-local"],
  "budget": {
    "maxCandidates": 24,
    "maxFinalMemories": 10
  }
}
```

### 12.4 Prompt contract

- `simple`：尽量少层少通道
- `hybrid`：平衡精度与覆盖，并默认生成 retrieval clues
- `complex`：允许更深层和更多 graph/temporal expansion，并默认生成 retrieval clues / query reformulation

---

## 13. Prompt 10 — Recall Gating

### 13.1 Purpose

在 candidate pool 上做过滤与 collapse。

### 13.2 Input

- query
- candidate memories
- family_uri groups
- optional graph neighborhood
- planner output

### 13.3 Output schema

```json
{
  "selectedUris": [
    "urn:pi-memory:node:procedural:workspace:repo.9f3a2c:T5:01JNY...",
    "urn:pi-memory:node:episodic:chat:telegram.botA.7032858921:T1:01JNZ..."
  ],
  "dropped": [
    {
      "uri": "urn:pi-memory:node:profile:user:telegram.123456:T4:01JNX...",
      "reason": "Covered by a stronger family representative"
    }
  ]
}
```

### 13.4 Prompt contract

- 优先保留最贴合 query complexity 的层级
- 同一 `family_uri` 默认只保留一个代表节点
- 若 query 明确需要证据链，可同时保留 summary + evidence
- gating 属于混合检索阶段的 LLM 参与层，而不是可有可无的后处理

---

## 14. Prompt 11 — Hybrid Rerank / Evidence Selection

### 14.1 Purpose

在 gating 之后，对剩余候选做最终排序与证据选择。

### 14.2 Input

- query
- gated candidate memories
- optional planner output
- optional family groups
- optional evidence chains
- token budget / context budget

### 14.3 Output schema

```json
{
  "selected": [
    {
      "uri": "urn:pi-memory:node:procedural:workspace:repo.9f3a2c:T5:01JNY...",
      "rank": 1,
      "reason": "Highest policy relevance for current query"
    },
    {
      "uri": "urn:pi-memory:node:episodic:chat:telegram.botA.7032858921:T1:01JNZ...",
      "rank": 2,
      "reason": "Concrete supporting evidence"
    }
  ],
  "collapsedFamilies": [
    {
      "familyUri": "urn:pi-memory:family:procedural:workspace:repo.9f3a2c:abort-behavior",
      "keptUri": "urn:pi-memory:node:procedural:workspace:repo.9f3a2c:T5:01JNY..."
    }
  ]
}
```

### 14.4 Prompt contract

- 优先输出最适合当前 query complexity 的代表层级
- 默认避免同一 `family_uri` 多个近义版本同时入选
- 若 query 明确需要依据，可保留 summary + evidence 的组合
- 不得编造新 memory URI
- 只在给定候选池内做排序、选择与 collapse

---

## 15. Suggested Runtime Order

完整抽取与召回流程建议按如下顺序执行：

### Write path
1. Candidate Memory Extraction
2. Entity Discovery
3. Entity Linking
4. Relation Candidate Generation
5. Relation Decision
6. Event / Action Node Construction
7. T1 Consolidation
8. T2/T3/T4/T5 Consolidation (scheduled)

### Read path
1. Recall Planner
2. Optional Clue-Guided Retrieval / Query Reformulation
3. Hybrid Candidate Retrieval
4. Hierarchical Propagation
5. Recall Gating
6. Hybrid Rerank / Evidence Selection
7. Context Assembly

---

## 16. Implementation Notes

1. 每个 prompt 都应有独立版本号，便于后续 A/B 测试
2. 建议把 inventory（entity/predicate）作为插槽注入，而不是写死在 prompt 文字中
3. 可先实现最小集合：
   - Candidate Extraction
   - Entity Discovery
   - Relation Decision
   - Event Node Construction
   - Recall Planner
   - Recall Gating
   - Hybrid Rerank / Evidence Selection
4. 主动记忆链路进入实现阶段后，建议补两类 prompt：
   - Memory Admission / Operation Decision
   - Closed-loop Retrieve / Reflect / Answer Controller
5. 若引入 MemGPT-style context pager，建议再补两类 prompt：
   - Working-Set Compilation / Pinned Context Selection
   - Memory-Pressure Queue Summary / Recursive Summary Refresh
6. relation candidate generation 若初期不稳定，可先用程序规则代替 LLM
7. entity linking 若候选不足，可先允许 `create_new` + 后续 merge
