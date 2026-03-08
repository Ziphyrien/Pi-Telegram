# Pi-Telegram Module Refactor Automation Spec

Status: Draft
Owner: TBD
Last Updated: 2026-03-08
Related Specs:
- `docs/specs/README.md`
- `docs/specs/pi-telegram-pre-memory-prep.md`
- `docs/specs/pi-memory.md`

## 1. Purpose

本文档定义 `Pi-Telegram` 在“记忆系统实现前的源码结构整理”阶段所需的**自动化重构机制**。

它专门回答以下工程问题：

1. 如何用脚本而不是手工完成文件搬迁
2. 如何批量重写 import/export 路径
3. 如何在迁移期间生成兼容 shim
4. 如何让迁移过程可 dry-run、可验证、可回滚、可重复执行

本文档不负责定义业务模块边界本身；模块边界由：

- `docs/specs/pi-telegram-pre-memory-prep.md`

定义。

本文档负责的是：

> **如何把那份结构准备 spec 机械地、稳定地、可审计地落到仓库中。**

补充说明：

- 这套自动化是为 `Pi-Telegram` 当前这次模块化整理服务的**一次性迁移辅助机制**
- 它不要求长期作为仓库内工具链保留
- 当迁移已经完成且目录结构稳定后，相关 `scripts/refactor/*` 可以被清理删除

---

## 2. Scope

本自动化 spec 覆盖：

- `scripts/refactor/module-layout.json` 的清单格式
- `scripts/refactor/apply-module-layout.mjs` 的行为规范
- import/export 重写规则
- shim 生成规则
- dry-run / apply / verify / rollback 约束
- 报告格式

不覆盖：

- 深层业务逻辑拆分
- 函数级语义抽取
- 自动理解并重构大型函数内部控制流
- 任何超出“机械迁移”的自动代码重写

---

## 3. Design Principles

### 3.1 Mechanical, not semantic

脚本应只做**机械迁移**：

- move
- rewrite imports/exports
- generate shims
- create skeletal files

不应试图：

- 理解业务语义
- 重命名 symbol
- 自动抽函数
- 自动改变控制流

### 3.2 Idempotent where possible

同一份 manifest 在未额外手工修改的情况下，多次运行结果应尽量稳定。

### 3.3 Git-friendly

脚本应假定运行在 git 仓库中，并把：

- dry-run
- apply
- verify
- rollback

都设计成适合 git 工作流的模式。

### 3.4 ESM-aware

当前项目使用：

- TypeScript 源文件
- Node16 module resolution
- ESM 风格 `.js` module specifier

因此脚本必须正确处理：

- `.ts` 文件路径移动
- `.js` import specifier 重算
- 相对路径层级变化

---

## 4. Files and Deliverables

自动化重构至少包含两个文件：

```text
scripts/refactor/module-layout.json
scripts/refactor/apply-module-layout.mjs
```

可选输出：

```text
scripts/refactor/last-report.json
```

用于保留最近一次迁移报告。

---

## 5. Manifest Specification

## 5.1 File path

清单路径固定建议为：

```text
scripts/refactor/module-layout.json
```

## 5.2 Top-level shape

建议顶层结构：

```json
{
  "version": 1,
  "moves": {},
  "shims": [],
  "createFiles": {},
  "notes": []
}
```

### 5.2.1 `version`

用于 manifest schema 版本控制。

MVP 固定：

```json
{ "version": 1 }
```

### 5.2.2 `moves`

类型：

```json
{
  "src/old.ts": "src/new.ts"
}
```

语义：

- key 为旧路径
- value 为新路径
- 路径均相对仓库根目录
- 默认只允许 `.ts` 文件

### 5.2.3 `shims`

类型：

```json
["src/old.ts"]
```

语义：

- 指定哪些旧路径在移动后要生成 shim
- shim 路径必须同时存在于 `moves` 的 key 集合中

### 5.2.4 `createFiles`

类型：

```json
{
  "path/to/file": "file contents"
}
```

语义：

- 在迁移完成后创建由脚本托管的文件
- 典型用途：
  - 新 `src/main.ts`
  - `src/memory/README.md`

### 5.2.5 `notes`

可选，仅用于人工备注，不影响执行。

---

## 6. Manifest Validation Rules

脚本读取 manifest 后，必须先做严格校验。

### 6.1 Required checks

1. `version` 必须存在且为支持值
2. `moves` 不可为空
3. `moves` 的 key 不能重复
4. `moves` 的 value 不能重复
5. `moves` 的 source 与 target 不能相同
6. 每个 source 必须存在
7. 每个 target 不能与未迁移文件冲突
8. `shims` 中每个路径必须属于 `moves` 的 source
9. `createFiles` 不能与 `moves` target 冲突
10. 不允许循环 move 覆盖

### 6.2 Extension checks

MVP 默认只处理：

- `.ts`
- `.md`
- `.json`

其中：

- `moves` 只应处理 `.ts`
- `createFiles` 可处理 `.ts` / `.md`

### 6.3 Root safety checks

脚本应拒绝：

- 移动到仓库外路径
- 使用 `..` 逃逸仓库根目录
- 覆盖 `.git`、`node_modules`、`dist` 等目录内容

---

## 7. Current Recommended Manifest for Pi-Telegram

结合当前代码结构，推荐首版 manifest：

```json
{
  "version": 1,
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
    "src/pool.ts",
    "src/cron-service.ts",
    "src/tools.ts",
    "src/types.ts"
  ],
  "createFiles": {
    "src/main.ts": "import { runApp } from \"./app/runtime.js\";\n\nvoid runApp();\n",
    "src/memory/README.md": "# memory\n\nReserved for future pi-memory implementation.\n"
  },
  "notes": [
    "Phase 1 only performs mechanical module normalization.",
    "Do not combine with semantic function extraction in the same pass."
  ]
}
```

---

## 8. CLI Contract

## 8.1 Command forms

脚本建议支持：

```bash
node scripts/refactor/apply-module-layout.mjs --dry-run
node scripts/refactor/apply-module-layout.mjs --apply
node scripts/refactor/apply-module-layout.mjs --verify
```

### 8.1.1 `--dry-run`

只输出计划，不修改文件。

### 8.1.2 `--apply`

执行迁移、重写、建文件、生成 shim，并运行验证。

### 8.1.3 `--verify`

不再搬文件，只检查当前仓库是否已符合 manifest 目标布局。

## 8.2 Optional flags

可选支持：

```bash
--manifest <path>
--report <path>
--allow-dirty
--no-build
```

### `--allow-dirty`

默认建议：

- 若工作树不干净，则拒绝执行 `--apply`

但考虑到当前仓库可能已有未提交 spec 变更，可允许显式传 `--allow-dirty` 跳过。

### `--no-build`

仅在调试脚本时使用；默认 `--apply` 完成后必须跑构建。

---

## 9. Execution Pipeline

## 9.1 Dry-run pipeline

```text
load manifest
validate manifest
scan current repo
compute move plan
compute rewrite plan
compute shim plan
compute create-file plan
print report
exit
```

## 9.2 Apply pipeline

```text
load manifest
validate manifest
optional: enforce git cleanliness
snapshot current file list
move files
rewrite imports/exports
generate shims
create managed files
run verification
run build
emit report
```

## 9.3 Verify pipeline

```text
load manifest
validate manifest
check target files exist
check source files are shims or absent as expected
check imports are resolvable
optionally run build
emit report
```

---

## 10. Import/Export Rewrite Rules

## 10.1 What must be rewritten

脚本必须处理：

- `import ... from "..."`
- `export * from "..."`
- `export { ... } from "..."`
- `import type ... from "..."`
- `export type { ... } from "..."`

## 10.2 What should be ignored

默认不处理：

- 非本地模块路径（如 `grammy`、`node:fs`）
- 动态 import（若出现，可先记录 warning）
- 字符串字面量中的非 module specifier 内容

## 10.3 Local path detection

以下视为本地路径：

- `./...`
- `../...`

### 10.3.1 ESM suffix policy

当前 TypeScript 源码中 module specifier 使用 `.js` 后缀。

因此：

- 物理文件搬迁操作针对 `.ts`
- specifier 重写结果仍应为 `.js`

例如：

```ts
import { createBot } from "./bot.js";
```

若文件移动后应变成：

```ts
import { createBot } from "../telegram/create-bot.js";
```

## 10.4 Relative path recomputation

每个 module specifier 应根据：

- 当前文件新位置
- 被引用目标新位置

重新计算最短相对路径。

不得直接做字符串替换假设目录层级不变。

## 10.5 Rewrite preference

若某旧路径会生成 shim，脚本仍应**优先重写到新目标路径**，而不是继续引用 shim。

原因：

- shim 只是过渡层
- 应减少新结构对旧路径的依赖

---

## 11. AST Strategy

推荐优先实现为：

- 使用仓库现有 `typescript` 依赖
- 通过 compiler API 扫描 source file
- 识别 import/export declaration
- 仅替换 module specifier string literal

### 11.1 Why not regex

regex 不可靠的原因：

- 容易误伤普通字符串
- 难以覆盖所有 import/export 语法变体
- 难以稳定处理 type-only import/export
- 难以安全保留 formatting

### 11.2 Minimal mutation rule

脚本应尽量只改 module specifier，不改其余代码格式。

---

## 12. Shim Generation Rules

## 12.1 Shim content

对于：

```text
src/bot.ts -> src/telegram/create-bot.ts
```

shim 内容为：

```ts
export * from "./telegram/create-bot.js";
```

如果目标模块有 default export，则可按需补：

```ts
export { default } from "./telegram/create-bot.js";
```

但当前项目多数是 named export，MVP 可先只生成 `export *`。

## 12.2 Shim file marker

建议 shim 文件头部增加注释：

```ts
// AUTO-GENERATED SHIM. DO NOT ADD LOGIC HERE.
```

### 12.2.1 Why marker matters

这样做是为了：

- 防止后续误把实现重新写回 shim
- 便于后续集中清理
- 便于 verify 阶段识别 shim

---

## 13. Managed File Rules

## 13.1 New thin entry file

脚本应支持创建：

```ts
import { runApp } from "./app/runtime.js";

void runApp();
```

作为新的 `src/main.ts`。

## 13.2 Memory placeholder

脚本应支持创建：

```text
src/memory/README.md
```

用于显式声明 future memory 落点。

## 13.3 Overwrite policy

对于 `createFiles`：

- 若目标不存在，则直接创建
- 若目标已存在且由脚本托管，可覆盖
- 若目标已存在但看起来是人工编辑内容，应拒绝覆盖并报错

MVP 最简单方案：

- 仅允许覆盖有 `AUTO-GENERATED` 标记的文件

---

## 14. Verification Rules

## 14.1 Structural verification

至少检查：

1. 每个 move target 存在
2. 每个需要 shim 的 source 存在且内容符合 shim 模式
3. 每个 createFile 存在
4. 根目录剩余文件符合预期

## 14.2 Import verification

至少检查：

- `src/**/*.ts` 中所有本地 import/export 路径都能解析到目标文件

## 14.3 Build verification

默认执行：

```bash
npm run build
```

## 14.4 Optional smoke reminders

脚本可在最终报告中提示人工执行：

- 启动程序
- 测试 `/status`
- 测试 `/cron`
- 测试 `/abort`
- 测试 `/abortall`
- 测试 `/new`

---

## 15. Report Format

建议报告至少包含：

```json
{
  "ok": true,
  "mode": "apply",
  "movedFiles": 16,
  "rewrittenSpecifiers": 23,
  "generatedShims": 6,
  "createdFiles": 2,
  "remainingRootFiles": ["src/main.ts", "src/bot.ts"],
  "warnings": [],
  "errors": []
}
```

### 15.1 Human-readable summary

除了 JSON 报告，也应输出简短文本摘要：

- moved files
- rewritten imports
- generated shims
- build status
- next manual smoke steps

---

## 16. Failure Handling

### 16.1 Manifest invalid

- 立即失败
- 不做任何文件修改

### 16.2 Move collision

- 立即失败
- 不进入 rewrite 阶段

### 16.3 Rewrite failure

- 立即失败
- 输出失败文件与原因
- 依赖 git 回滚

### 16.4 Build failure after apply

- 报告失败
- 不自动再做语义级回滚
- 由使用者通过 git 恢复

### 16.5 Dirty working tree

默认：

- 拒绝执行 `--apply`

除非显式传入 `--allow-dirty`。

---

## 17. Rollback Strategy

推荐最简单可控的回滚方式：

1. 在 git 工作树中执行
2. 先 dry-run
3. 再 apply
4. 若失败，通过 git 回滚

不建议首版脚本自行实现复杂文件级事务回滚。

原因：

- 仓库本身已有版本控制
- 复杂事务系统会显著增加脚本复杂度
- 这次目标是“稳妥机械迁移”，不是做通用重构平台

---

## 18. Implementation Notes for Current Repo

针对当前 `Pi-Telegram`，脚本实现时应特别注意：

1. `src/main.ts` 既是源文件，又会变成新入口文件
2. `src/bot.ts` 文件很大，但首阶段只搬运，不深拆
3. `src/types.ts` 为混合归属文件，先整体迁移到 `shared/types.ts`
4. `src/tools.ts` 虽名为 tools，实为 Telegram tool-prompt 定义
5. 当前 import 使用 `.js` specifier，重写时不能丢后缀

---

## 19. Acceptance Criteria

本自动化方案完成后，应满足：

1. 通过 manifest 可复现结构迁移
2. 无需人工逐文件搬运
3. 无需人工逐文件修 import/export
4. 可生成 shim 过渡层
5. 支持 dry-run
6. 支持 apply
7. 支持 verify
8. 迁移后 `npm run build` 通过
9. 迁移结果与 `pi-telegram-pre-memory-prep.md` 的目标结构一致

---

## 20. Recommended Next Step

在文档层面，下一步应：

1. 将本 spec 与 `pi-telegram-pre-memory-prep.md` 一起视为结构整理基线
2. 基于本 spec 实际创建：
   - `scripts/refactor/module-layout.json`
   - `scripts/refactor/apply-module-layout.mjs`
3. 先执行 dry-run，再执行 apply
4. 在结构稳定后，才开始真正落地 `src/memory/`

这样才能做到：

- 先规范化代码结构
- 再实现记忆系统
- 避免 memory 在混乱目录上继续堆积
