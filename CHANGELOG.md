# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## 0.4.1 (2026-03-02)


### Features

* add persistent cron scheduler and /cron commands ([e751e2f](https://github.com/Ziphyrien/Pi-Telegram/commit/e751e2fd1a3d646cb47a9bcbd0505b16f7bccf78))
* integrate @grammyjs/files and include file paths in context ([2d4845c](https://github.com/Ziphyrien/Pi-Telegram/commit/2d4845ca3a5e3615727bb5b5a01b89f6cd1598df))


### Bug Fixes

* avoid streaming preview/finalize edit race ([d2984f0](https://github.com/Ziphyrien/Pi-Telegram/commit/d2984f04b63c06c57c7078dd46dd729bd74e8aa4))
* ignore Telegram message-not-modified during streaming edits ([dabb68b](https://github.com/Ziphyrien/Pi-Telegram/commit/dabb68bfe7d0ab9875e47458defceccd2c03f726))
* keep partial streamed output when generation errors ([6d44958](https://github.com/Ziphyrien/Pi-Telegram/commit/6d4495868bd7328adb30147346f5f66df30f029e))
* make /abort keep queue and add /abortall ([19f0a7a](https://github.com/Ziphyrien/Pi-Telegram/commit/19f0a7afbb4b2642c3d74e8a4758a38f787e4a22))
* prevent raw protocol/markdown leak on HTML fallback ([7d25467](https://github.com/Ziphyrien/Pi-Telegram/commit/7d2546702c8fdad4f8252da47fd7dab50b6b05dc))

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
