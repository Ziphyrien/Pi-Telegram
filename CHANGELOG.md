# Changelog

## [Unreleased]

### New Features

- Added a full cron subsystem for Pi-Telegram with persistent per-bot storage:
  - Store path: `~/.pi/telegram/cron/<botName>/jobs.json`
  - Schedule types: `at` / `every` / `cron`
  - Runtime state tracking: next run, last run, errors, retries, running marker
  - Startup recovery for interrupted runs
- Added `/cron` command suite:
  - `/cron list`, `/cron stat`
  - `/cron add at <ISO时间> <内容>`
  - `/cron add every <间隔> <内容>`
  - `/cron add cron "<表达式>" [时区] <内容>`
  - `/cron on <id>`, `/cron off <id>`, `/cron del <id>`, `/cron run <id>`
- Added cron execution integration with existing Pi session and Telegram reply pipeline.
- Added cron summary to `/status` output.

### Changed

- Added `cron` configuration block to settings with normalization/defaults:
  - `enabled`, `defaultTimezone`, `maxJobsPerChat`, `maxRunSeconds`,
    `maxLatenessMs`, `retryMax`, `retryBackoffMs`
- Main lifecycle now starts/stops cron service together with bot and pool.

### Fixed

- Prevented raw protocol/markdown leakage when HTML send/edit fails by using plain-text fallback sanitization.

## [0.2.1] - 2026-02-25

Initial public release.
