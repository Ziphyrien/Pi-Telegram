# Specs Index

Status: Draft
Last Updated: 2026-03-08

本目录存放 `Pi-Telegram` 当前与未来功能的设计文档。

## Reading Order

建议阅读顺序：

1. `pi-telegram-pre-memory-prep.md`
   - 记忆系统实现前的源码结构整理准备 spec
   - 目标是先把 `src/` 模块边界定下来
2. `pi-telegram-refactor-automation.md`
   - 批量整理代码结构的自动化实施 spec
   - 目标是避免手工逐文件搬迁和手工修 import
3. `pi-memory.md`
   - `Pi-Telegram` 内置长期记忆子系统总 spec
4. `pi-memory-bridge.md`
   - 同仓库 bridge 扩展的运行与分发 spec
5. `pi-memory-prompts.md`
   - extraction / consolidation / retrieval 相关 prompt 规格
6. `pi-memory-related-work.md`
   - 论文调研、问题映射与设计启发

## Current Files

- `pi-telegram-pre-memory-prep.md`
  - 目标：在实现 memory 前先完成代码结构整理、模块归位、批量迁移方案
- `pi-telegram-refactor-automation.md`
  - 目标：定义 `module-layout.json` 与 `apply-module-layout.mjs` 的自动化重构契约
- `pi-memory.md`
  - 目标：定义 `Pi-Telegram` 内置记忆系统的总体架构
- `pi-memory-bridge.md`
  - 目标：定义同仓库 bridge 的加载、版本绑定、协议与职责边界
- `pi-memory-prompts.md`
  - 目标：定义提取、巩固、召回、gating、rerank 等 prompt 接口
- `pi-memory-related-work.md`
  - 目标：记录相关论文与对当前设计的映射

## Current Recommendation

如果当前工作重点是“在不立刻实现 memory 的情况下，为 memory 铺路”，优先推进：

1. `pi-telegram-pre-memory-prep.md`
2. `pi-telegram-refactor-automation.md`
3. `scripts/refactor/module-layout.json`
4. `scripts/refactor/apply-module-layout.mjs`

完成结构整理后，再继续 `pi-memory` 的实现级设计与接入。
