# Pi-Telegram

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Ziphyrien/Pi-Telegram)
[![npm version](https://img.shields.io/npm/v/pi-telegram?logo=npm)](https://www.npmjs.com/package/pi-telegram)
[![npm downloads](https://img.shields.io/npm/dm/pi-telegram)](https://www.npmjs.com/package/pi-telegram)

**English** · [简体中文](README.zh-CN.md)

Pi-Telegram connects Telegram bots to the [pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent): messages go to pi, and its responses return to Telegram.

It supports text, images, documents, isolated sessions per chat, scheduled tasks, and multiple bots in one process.

## Quick Start

Requirements:

- Node.js 22.19 or newer
- A working `pi` installation ([setup guide](https://linux.do/t/topic/1680124))
- A Telegram bot token from [BotFather](https://t.me/BotFather)

Make sure `pi` runs normally from your terminal, then install and start Pi-Telegram:

```bash
npm install -g pi-telegram
pitg
```

On first launch, Pi-Telegram creates `settings.json` and exits:

- Linux/macOS: `~/.pi/telegram/settings.json`
- Windows: `%USERPROFILE%/.pi/telegram/settings.json`

Replace the placeholder token with your BotFather token, then run `pitg` again.

### Run From Source

```bash
git clone https://github.com/Ziphyrien/Pi-Telegram.git
cd Pi-Telegram
bun install --frozen-lockfile
bun run build
bun run dev
```

Run tests with `bun run test`.

## Configuration

Example configuration:

```json
{
  "bots": [
    {
      "token": "<YOUR_TELEGRAM_BOT_TOKEN>",
      "name": "Pi-Telegram",
      "allowedUsers": [],
      "cwd": "~/.pi/telegram/workspace",
      "streamByChat": {}
    }
  ],
  "idleTimeoutMs": 600000,
  "maxResponseLength": 4000,
  "language": "en",
  "cron": {
    "enabled": true,
    "defaultTimezone": "Asia/Shanghai",
    "maxJobsPerChat": 20,
    "maxRunSeconds": 900,
    "maxLatenessMs": 600000,
    "retryMax": 2,
    "retryBackoffMs": 30000
  }
}
```

- `bots`: bot configurations; add more entries to run multiple bots.
- `bots[].token`: Telegram bot token.
- `bots[].name`: name used for session and scheduled-task directories.
- `bots[].allowedUsers`: allowed Telegram user IDs or usernames. An empty list allows everyone.
- `bots[].cwd`: working directory used by pi.
- `idleTimeoutMs`: idle time before a chat's pi process is released.
- `maxResponseLength`: maximum Telegram message length before replies are split.
- `language`: interface language, `"en"` or `"zh"`. The generated template follows your system locale. If omitted, detection checks `LC_ALL`, `LC_MESSAGES`, `LANG`, and `LANGUAGE`, then the OS locale through `Intl` (including Windows). Chinese locales use Chinese; all others use English.
- `cron`: scheduled-task settings.

## Usage

Send the bot text, an image, or a document. When you reply to an earlier Telegram message, Pi-Telegram includes that message as context for pi.

### Commands

| Command | Action |
| --- | --- |
| `/status` | Show the current chat status |
| `/new` | Start a new session |
| `/abort` | Stop the current task |
| `/abortall` | Stop the current task and clear its queue |
| `/model` | Open model selection |
| `/stream` | Switch between streaming and non-streaming output |
| `/thinking` | Set the thinking level |
| `/cron` | Open the scheduled-task menu |

## Scheduled Tasks

```text
/cron list
/cron stat
/cron add at <ISO time> <prompt>
/cron add every <interval> <prompt>
/cron add cron "<expression>" [timezone] <prompt>
/cron on <id>
/cron off <id>
/cron del <id>
/cron rename <id> <new name>
/cron run <id>
```

Intervals support `s`, `m`, `h`, and `d`, for example `30s`, `10m`, `2h`, or `1d`.

Cron expressions are parsed by Croner 10. They may include seconds, years, `W`, `+`, `@midnight`, and other OCPS syntax. `?` is an alias for the `*` wildcard; it does not mean “current time.”

Use `name||prompt` to give a task a separate display name:

```bash
/cron add every 10m Health check||Check alerts and summarize
/cron add at 2026-03-01T09:00:00+08:00 Morning brief||Summarize yesterday's logs
/cron add cron "0 9 * * 1-5" Asia/Shanghai Weekday brief||Summarize the daily report
```

## AI Bridge Tags

Pi-Telegram gives pi three tag protocols:

- `tg-reply`: reply to a specific Telegram message.
- `tg-attachment`: send a file or other media.
- `tg-cron`: create or manage scheduled tasks.

You normally do not write these tags yourself; pi emits them when needed.

## Data and Sessions

Pi-Telegram stores its data under `~/.pi/telegram`:

- `settings.json`: main configuration.
- `workspace/`: default pi working directory.
- `sessions/`: session data for each bot and chat.
- `cron/`: persisted scheduled tasks.
- `inbound/`: images and files downloaded from Telegram.

Each chat starts pi with a fixed `--session-dir`:

```text
~/.pi/telegram/sessions/<bot-name>/bot<token-hash>_chat<chatId>
```

This keeps chats isolated and lets a chat resume after a restart. Normal launches use `-c` to continue the latest session; `/new` starts a fresh one. Pi-Telegram manages these arguments automatically.

To inspect a chat's history directly with pi, use the same directory:

```bash
pi --session-dir "<session-directory>" -r
```

`-r` opens the session list. Other useful forms are:

```bash
pi --session-dir "<session-directory>" -c
pi --session-dir "<session-directory>" --session <session-file-or-id>
```
