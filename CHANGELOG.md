# Changelog

## [Unreleased]

### Fixed

- Fixed long-running pi RPC prompts timing out after 60 seconds in Telegram bridging by waiting for `agent_end` without the `RpcClient.collectEvents()` timeout path.
- Fixed Telegram error replies to send a fresh message instead of overwriting the temporary “思考中...” status, and increased the reported error length limit so diagnostics are less likely to be truncated.

## [0.3.3] - 2026-04-18

### Changed

- Refactored the pi RPC bridge to use the official `RpcClient`, simplifying lifecycle handling and removing the obsolete manual JSONL helper.
- Updated `@mariozechner/pi-coding-agent` to `^0.67.68`.

### Added

- `/status` now shows the current context usage.

## [0.3.2] - 2026-04-18

### Changed

- Reduced CPU time in Telegram streaming draft preview rendering by caching repeated preview work, reusing the prejoined tool prefix, and avoiding unnecessary HTML/plain-text formatting on the hot path.

## [0.3.1] - 2026-03-12

### Fixed

- Fixed `src/main.ts` / `npm run dev` startup failures after the source tree refactor by resolving the pi theme module via package resolution instead of a broken relative `node_modules` path.

## [0.3.0] - 2026-03-12

### Breaking Changes

- Removed the built-in `pi-memory` system introduced in `0.2.0`, including its bridge/runtime integration and related memory features.

### Changed

- `/new` now always recreates the chat session by spawning a fresh pi RPC subprocess instead of resetting the existing process.

### Fixed

- Fixed RPC prompt error handling so only failed `prompt` responses terminate the active request, preventing follow-up messages from hitting `Agent is already processing` after an earlier error.

## [0.2.0] - 2026-03-08

### New Features

- Added the built-in `pi-memory` long-term memory system for Pi-Telegram, including same-repo bridge integration, multi-scope SQLite storage, hybrid retrieval with RRF/MMR/Time-Decay/ColBERT/PPR/recursive clustering/novelty scoring/evidence-gap analysis, optional LLM-driven extraction and control, explicit memory operations, export/backup/repair/integrity tooling, and release-time bridge version synchronization.

## [0.1.3] - 2026-03-08

### Changed

- Unified stop handling across `/abort`, `/abortall`, and `/new`: non-streaming runs now send partial output before stopping, streaming runs stop cleanly, and queued requests are cancelled silently when appropriate.

### Fixed

- Restored `/cron` menu responses by sending and refreshing the menu through the Telegram bot context instead of direct bot API calls.

## [0.1.2] - 2026-03-07

### Changed

- Improved streaming draft previews to render Telegram HTML when possible and automatically fall back to plain text if Telegram rejects the HTML.

### Fixed

- Adapted Pi-Telegram to pi's strict LF-delimited JSONL RPC framing, replacing Node `readline` with an LF-only reader so payloads containing `U+2028` / `U+2029` no longer break the stream.

## [0.1.1] - 2026-03-03

### Changed

- Refactored streaming output using `sendMessageDraft`.
- Redesigned cron and refresh flow in menu.

### Fixed

- Fixed empty text warning in stream preview.

## [0.1.0] - 2026-03-2

Initial public release.
