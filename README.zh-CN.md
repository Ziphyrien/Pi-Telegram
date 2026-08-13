# Pi-Telegram

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/Ziphyrien/Pi-Telegram)
[![npm version](https://img.shields.io/npm/v/pi-telegram?logo=npm)](https://www.npmjs.com/package/pi-telegram)
[![npm downloads](https://img.shields.io/npm/dm/pi-telegram)](https://www.npmjs.com/package/pi-telegram)

[English](README.md) · **简体中文**

Pi-Telegram 将 Telegram bot 连接到 [pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)：消息交给 pi 处理，结果再发回 Telegram。

支持文本、图片、文档、每个聊天独立会话、定时任务，以及单进程运行多个 bot。

## 快速开始

需要：

- Node.js 22.19 或更高版本
- 已安装并能在终端正常运行的 `pi`（[安装教程](https://linux.do/t/topic/1680124)）
- 通过 [BotFather](https://t.me/BotFather) 创建的 Telegram bot token

安装并启动：

```bash
npm install -g pi-telegram
pitg
```

首次启动会生成 `settings.json`，然后退出：

- Linux/macOS：`~/.pi/telegram/settings.json`
- Windows：`%USERPROFILE%/.pi/telegram/settings.json`

将占位 token 替换为 BotFather 提供的真实 token，再次运行 `pitg`。

### 从源码运行

```bash
git clone https://github.com/Ziphyrien/Pi-Telegram.git
cd Pi-Telegram
bun install --frozen-lockfile
bun run build
bun run dev
```

运行测试：`bun run test`。

## 配置

配置示例：

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
  "language": "zh",
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

- `bots`：bot 配置列表；添加条目即可同时运行多个 bot。
- `bots[].token`：Telegram bot token。
- `bots[].name`：用于区分会话目录和定时任务目录的名称。
- `bots[].allowedUsers`：允许访问的 Telegram 用户 ID 或用户名；空列表表示不限制。
- `bots[].cwd`：pi 的工作目录。
- `idleTimeoutMs`：聊天空闲多久后释放对应的 pi 进程。
- `maxResponseLength`：Telegram 单条回复的最大长度，超出后自动分段。
- `language`：界面语言，可设为 `"zh"` 或 `"en"`。生成模板会根据系统语言写入该值；不设置时依次检测 `LC_ALL`、`LC_MESSAGES`、`LANG`、`LANGUAGE`，最后通过 `Intl` 读取系统语言（包括 Windows）。中文 locale 使用中文，其他 locale 使用英文。
- `cron`：定时任务配置。

## 使用

直接向 bot 发送文本、图片或文档即可。在 Telegram 中回复历史消息时，Pi-Telegram 会将被回复内容作为上下文一并交给 pi。

### 命令

| 命令 | 作用 |
| --- | --- |
| `/status` | 查看当前聊天状态 |
| `/new` | 新建会话 |
| `/abort` | 中止当前任务 |
| `/abortall` | 中止当前任务并清空队列 |
| `/model` | 打开模型选择菜单 |
| `/stream` | 切换流式或非流式输出 |
| `/thinking` | 设置思考等级 |
| `/cron` | 打开定时任务菜单 |

## 定时任务

```text
/cron list
/cron stat
/cron add at <ISO时间> <内容>
/cron add every <间隔> <内容>
/cron add cron "<表达式>" [时区] <内容>
/cron on <id>
/cron off <id>
/cron del <id>
/cron rename <id> <新名称>
/cron run <id>
```

间隔支持 `s`、`m`、`h`、`d`，例如 `30s`、`10m`、`2h`、`1d`。

Cron 表达式由 Croner 10 解析，支持秒字段、年份字段、`W`、`+`、`@midnight` 等 OCPS 语法。`?` 是 `*` 的通配符别名，不表示当前时间。

使用 `名称||内容` 可以单独指定任务名：

```bash
/cron add every 10m 巡检||检查报警并总结
/cron add at 2026-03-01T09:00:00+08:00 早报||汇总昨日日志
/cron add cron "0 9 * * 1-5" Asia/Shanghai 工作日早报||汇总日报
```

## AI 桥接标签

Pi-Telegram 会向 pi 注入三种标签协议：

- `tg-reply`：回复指定 Telegram 消息。
- `tg-attachment`：发送文件或媒体。
- `tg-cron`：创建或管理定时任务。

通常无需手动编写这些标签，pi 会在需要时自动输出。

## 数据与会话

数据保存在 `~/.pi/telegram`：

- `settings.json`：主配置。
- `workspace/`：默认 pi 工作目录。
- `sessions/`：每个 bot 和聊天的会话数据。
- `cron/`：持久化的定时任务。
- `inbound/`：从 Telegram 下载的图片和文件。

每个聊天都会使用固定的 `--session-dir` 启动 pi：

```text
~/.pi/telegram/sessions/<bot-name>/bot<token哈希>_chat<chatId>
```

因此不同聊天互不干扰，重启后也能继续上下文。常规启动使用 `-c` 继续最近会话；执行 `/new` 后会创建新会话。这些参数由 Pi-Telegram 自动管理。

如需直接用 pi 查看某个聊天的历史记录，请使用相同目录：

```bash
pi --session-dir "<会话目录>" -r
```

`-r` 会打开会话列表。其他常用写法：

```bash
pi --session-dir "<会话目录>" -c
pi --session-dir "<会话目录>" --session <会话文件或会话ID>
```
