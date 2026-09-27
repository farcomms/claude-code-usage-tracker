# Claude Code Usage & Quota Dashboard

A VSCode extension that shows your Claude Code usage in one dashboard:

- **Official subscription quota** — the 5-hour, 7-day, and per-model windows plus pay-as-you-go credits, read from the same source Claude Code uses internally.
- **Per-project / per-model token usage and cost**, with history — computed locally from your `~/.claude` transcripts.
- **Multiple accounts** — every Claude account you log into is saved; switch Claude Code between them from the status bar (**Claude Usage: Switch Account**), add one with **Claude Usage: Add Account**. If Claude Code isn't installed, Add Account offers to install it with Anthropic's official installer (only after you confirm) and, on Windows, adds it to your PATH.

## How it works

- **Quota** is read using the credentials Claude Code already stores on your machine (`~/.claude/.credentials.json`, or the macOS Keychain item `Claude Code-credentials`) — the same source Claude Code itself uses. No separate login.
- **Usage & cost** are computed from `~/.claude/projects/*.jsonl` (token counts × model pricing fetched from LiteLLM). Records are deduplicated by request id; files are parsed incrementally.

## Privacy

No telemetry. The only network calls are to `api.anthropic.com` (quota), the configured pricing URL, and — only when you switch to a saved account whose login has expired — Anthropic's auth server (`platform.claude.com`) to renew it. If you choose to install Claude Code from Add Account, its official installer downloads from `claude.ai` in a terminal you can see. Your transcripts never leave your machine.

Saved accounts' logins are kept only in VS Code's SecretStorage (encrypted by your OS keychain), never in settings or plain files.

## Caveats

- The quota source is **unofficial** and may change or stop working without notice, which would break the Quota view. Local usage & cost tracking is unaffected.
- Requires a **Claude Pro/Max subscription** (the quota endpoint returns 403 otherwise).
- The token is not refreshed by this extension; if it expires, start a Claude Code session and refresh.
- **Switching accounts rewrites Claude Code's stored login** (the Keychain item or `.credentials.json`, and `oauthAccount` in `~/.claude.json`). Restart any running Claude Code sessions afterwards; otherwise one may write the old account back when it renews its token.
- Renewing a saved account's login uses Claude Code's **undocumented** token endpoint, which may change.
- Usage & cost are **machine-wide**: transcripts don't record which account made each request. Only the quota follows the active account.

## Settings

`claudeUsage.statusBar.mode`, `claudeUsage.statusBar.colorFrom`, `claudeUsage.clockFormat`, `claudeUsage.pollIntervalSeconds`, `claudeUsage.pricingUrl`, `claudeUsage.currency`, `claudeUsage.account.display` (`email` / `name` / `off`).

## Development

```bash
npm install
npm run build
npm run test:unit
# F5 in VSCode to launch the Extension Development Host
npm run package   # produce a .vsix
```
