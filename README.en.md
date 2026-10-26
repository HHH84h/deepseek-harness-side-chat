# DeepSeek Harness Side Chat

[简体中文](README.md) · **English**

[Download for macOS](https://github.com/HHH84h/deepseek-harness-side-chat/releases/download/v1.1.2/deepseek-harness-side-chat-macos-v1.1.2.zip) · [Releases](https://github.com/HHH84h/deepseek-harness-side-chat/releases)
**Keep your main task moving. Ask questions on the side.**

Use `/side` to open an independent, read-only conversation in the right sidebar of DeepSeek Harness. Explain errors, discuss approaches, and read code without interrupting the main task or adding side-chat questions to its model context.

A community plugin by HHH84h, independently developed and not affiliated with DeepSeek. MIT licensed.

## Preview

![Main conversation and independent side chat](docs/assets/side-chat-demo.png)

The demo uses fictional content and a test model. Usage and speed figures are not real-model benchmarks. The current interface and launcher filenames are Chinese; this English README does not translate the interface.

## Features

- **Independent questions**: keep the main task running while you ask on the side. Cancelling the side chat does not cancel the main task.
- **Main-chat snapshot**: capture context for the first question, with its source, time, and status. Refresh manually for newer information; ordinary follow-ups do not recapture it.
- **Read-only tools**: read files and images or search code, with no file-writing, editing, or terminal execution tools.
- **Separate statistics**: view side-chat usage and context occupancy. Missing data is not replaced with invented values.
- **Temporary conversations**: collapse to keep, recover after restart, and explicitly end to delete. Side chats stay out of the ordinary conversation list.
- **Recovery**: preserve failed questions for retry, retry pending cleanup, inspect status, and export redacted diagnostics.

## Installation

**Current release: 1.1.2 · macOS · DeepSeek Harness 0.2.1-rc.3**

1. Download `deepseek-harness-side-chat-macos-v1.1.2.zip` from this project's [Releases](https://github.com/HHH84h/deepseek-harness-side-chat/releases).
2. **Extract the entire folder**, save your work, and fully quit Harness (`⌘Q`).
3. Double-click **`安装或更新.command`** (Install or Update) and wait for success.
4. Start Harness again and enter `/side` in the main conversation.

The installer checks the application version, runtime, profile, permissions, and installation conflicts. It backs up before making changes and restores the previous state if installation fails. It prefers Harness's bundled runtime and falls back to an existing Node 20+ installation. It does not install extra software or force-quit the application.

**Existing script installations can be upgraded directly** using the new launcher, without a separate uninstall or migration. Reinstalling an identical payload does not duplicate configuration entries.

If you installed the native `.tgz` edition, disable and uninstall Side Chat in Harness first, then quit the application and run this installer. The two installation methods cannot be used together; conflicts stop installation.

### Included tools

| Double-click launcher | Purpose |
| --- | --- |
| 安装或更新.command | Install or upgrade, with backup and automatic failure recovery |
| 检查安装.command | Check files, configuration, and links without changing the installation |
| 回退上一版.command | Restore the state before the latest managed operation |
| 卸载.command | Remove the installation while preserving side-chat data and backups |

An optional `检查更新.command` is also included. **No update source is enabled in this release**: checking makes no update request, and there are no background scheduled checks.

Keep the extracted folder. For future upgrades, quit Harness and run the newer Install or Update launcher. Quit Harness before rollback or removal as well. Rollback uses local backups, preserves later unrelated plugin changes, and refuses to overwrite manually modified plugin state.

The script exits automatically on success. Whether the terminal window closes depends on your Terminal settings.

## Usage

In the main conversation, enter:

```text
/side
```

Or open the sidebar and send a question in one step:

```text
/side Explain what caused the last error
```

The first question uses a snapshot of the main conversation, and follow-ups keep using it. After adding new information to the main chat, click **Refresh Context (「刷新上下文」)**. Refreshing during generation is queued; failure preserves the last valid snapshot. Snapshots may be truncated, so check their status and include relevant text when asking about a specific tool error.

| Action | Conversation data |
| --- | --- |
| Collapse the sidebar or switch main conversations | Preserved for later use |
| Quit and restart Harness | Unfinished side chats can recover |
| Close the side-chat tab and confirm that you want to end it | The local session and cache are deleted; the next `/side` starts a new conversation |
| Run `卸载.command` | Unfinished side chats and recovery data are preserved |

Failed deletions can be retried through the pending-cleanup action. Side Chat uses the model service configured in Harness; ending a side chat removes its local records without changing the provider's data-retention policy.

## Compatibility and validation

This release targets **macOS / Harness 0.2.1-rc.3** only. Other Harness versions, Windows, and Linux are unvalidated. A Harness update may require a new compatible release.

Validation includes **111 unit tests, 17 client tests, and 102 host regression checks**, plus installation, upgrades, failure recovery, rollback, and removal using the extracted ZIP. Real-browser checks cover input, snapshot refresh, statistics, closing, and restart recovery.

Tests use isolated environments and a recording test model. They do not establish real-model behavior or end-to-end validation in the user's Electron desktop application. Long-term resource growth and occasional top-edge window-dragging failures remain incompletely attributed. Statistics depend on the model adapter's available data.

See the [validation report](docs/验收与隐私报告.md) and [installation and rollback guide](docs/双击安装使用说明.md), both currently in Chinese.

## Feedback and license

Open an [issue](https://github.com/HHH84h/deepseek-harness-side-chat/issues) with your plugin, Harness, and macOS versions and reproduction steps. You may attach a reviewed, redacted diagnostic export; do not attach real conversations, credentials, or your entire configuration directory.

[MIT](LICENSE) · HHH84h
