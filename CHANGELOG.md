# Changelog

## [Unreleased]

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
