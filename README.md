# Claude Code Usage Tracker

A VSCode extension that shows your Claude Code usage in one dashboard:

- **Official subscription quota** — the 5-hour, 7-day, and per-model windows plus pay-as-you-go credits, read from the same source Claude Code uses internally.
- **Per-project / per-model token usage and cost**, with history — computed locally from your `~/.claude` transcripts.

## How it works

- **Quota** comes from `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the OAuth token Claude Code already stored on your machine (`~/.claude/.credentials.json`, or the macOS Keychain item `Claude Code-credentials`). No separate login.
- **Usage & cost** are computed from `~/.claude/projects/*.jsonl` (token counts × model pricing fetched from LiteLLM). Records are deduplicated by request id; files are parsed incrementally.

## Privacy

No telemetry. The only network calls are to `api.anthropic.com` (quota) and the configured pricing URL. Your transcripts never leave your machine.

## Caveats

- The `oauth/usage` endpoint is **undocumented/private** and gated behind a beta header; Anthropic may change or remove it at any time, which would break the Quota view. Reusing the Claude Code token for it is a Terms-of-Service gray area.
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
