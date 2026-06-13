# Claude Code Usage & Quota Dashboard

A VSCode extension that shows your Claude Code usage in one dashboard:

- **Official subscription quota** — the 5-hour, 7-day, and per-model windows plus pay-as-you-go credits, read from the same source Claude Code uses internally.
- **Per-project / per-model token usage and cost**, with history — computed locally from your `~/.claude` transcripts.

## How it works

- **Quota** is read using the credentials Claude Code already stores on your machine (`~/.claude/.credentials.json`, or the macOS Keychain item `Claude Code-credentials`) — the same source Claude Code itself uses. No separate login.
- **Usage & cost** are computed from `~/.claude/projects/*.jsonl` (token counts × model pricing fetched from LiteLLM). Records are deduplicated by request id; files are parsed incrementally.

## Privacy

No telemetry. The only network calls are to `api.anthropic.com` (quota) and the configured pricing URL. Your transcripts never leave your machine.

## Caveats

- The quota source is **unofficial** and may change or stop working without notice, which would break the Quota view. Local usage & cost tracking is unaffected.
- Requires a **Claude Pro/Max subscription** (the quota endpoint returns 403 otherwise).
- The token is not refreshed by this extension; if it expires, start a Claude Code session and refresh.

## Settings

`claudeUsage.statusBar.mode`, `claudeUsage.statusBar.colorFrom`, `claudeUsage.clockFormat`, `claudeUsage.pollIntervalSeconds`, `claudeUsage.pricingUrl`, `claudeUsage.currency`.

## Development

```bash
npm install
npm run build
npm run test:unit
# F5 in VSCode to launch the Extension Development Host
npm run package   # produce a .vsix
```
