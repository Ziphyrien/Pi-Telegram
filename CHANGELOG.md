# Changelog

## [Unreleased]

### Fixed

- Adapted pi RPC framing to strict LF-delimited JSONL, replacing Node `readline` with an LF-only reader so payloads containing `U+2028` / `U+2029` no longer break the stream.

## [0.1.1] - 2026-03-03

### Changed

- Refactored streaming output using `sendMessageDraft`.
- Redesigned cron and refresh flow in menu.

### Fixed

- Fixed empty text warning in stream preview.

## [0.1.0] - 2026-03-2

Initial public release.
