# Changelog

## [Unreleased]

### Fixed

- Fixed a streaming race where late preview edits could overwrite the finalized response and make the message tail look truncated.
- Stream finalization now waits for in-flight preview edits to finish before sending the final output.
- Fixed `/abort` behavior with queued messages: it now aborts only the current running task instead of clearing the whole queue.
- Added `/abortall` to explicitly abort current task and clear queued tasks when needed.

## [0.4.0] - 2026-02-26

### New Features

- Added `@grammyjs/files` integration for inbound Telegram file downloads (`hydrateFiles`).
- Added document message handling (`message:document`) with local caching.
- Added `current_file_paths` injection into reply context so local cached file paths can be referenced by the model.
- Download pipeline now prefers `file.download(localPath)` (files plugin) and falls back to direct Bot API URL fetch when needed.

### Fixed

- Suppressed noisy Telegram `message is not modified` warnings during streaming edits.
- Treated `message is not modified` on streaming finalization as success (no unnecessary fallback send).

## [0.3.1] - 2026-02-26

又写错版本号了，多加了个.1

### New Features

- Added a full cron subsystem for Pi-Telegram with persistent per-bot storage:
  - Store path: `~/.pi/telegram/cron/<botName>/jobs.json`
  - Schedule types: `at` / `every` / `cron`
  - Runtime state tracking: next run, last run, errors, retries, running marker
  - Startup recovery for interrupted runs
- Added `/cron` command suite:
  - `/cron` opens an interactive cron menu
  - `/cron list`, `/cron stat`
  - `/cron add at <ISO时间> <内容>`
  - `/cron add every <间隔> <内容>`
  - `/cron add cron "<表达式>" [时区] <内容>`
  - `/cron on <id>`, `/cron off <id>`, `/cron del <id>`, `/cron rename <id> <新名称>`, `/cron run <id>`
- Added cron execution integration with existing Pi session and Telegram reply pipeline.
- Added cron summary to `/status` output.
- Added AI bridge cron tool protocol `tg-cron` with actions: `add`, `list`, `stat`, `on`, `off`, `del`, `run`, `rename`.
- Added interactive cron job management UI:
  - Root menu with status, refresh, quick create flows (one-shot/interval/cron)
  - Per-job submenu actions (enable/disable, run now, rename, delete)
  - Guided text input mode for creating/renaming jobs directly from chat
- Added cron job naming improvements:
  - Explicit naming support for command/menu inputs via `名称||内容`
  - Better automatic name derivation from prompt when name is omitted

### Changed

- Added `cron` configuration block to settings with normalization/defaults:
  - `enabled`, `defaultTimezone`, `maxJobsPerChat`, `maxRunSeconds`,
    `maxLatenessMs`, `retryMax`, `retryBackoffMs`
- Main lifecycle now starts/stops cron service together with bot and pool.

### Fixed

- Prevented raw protocol/markdown leakage when HTML send/edit fails by using plain-text fallback sanitization.

## [0.2.1] - 2026-02-25

Initial public release.
