# Changelog

## [Unreleased]

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
