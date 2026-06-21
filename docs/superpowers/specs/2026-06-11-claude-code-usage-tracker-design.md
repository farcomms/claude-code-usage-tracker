# Claude Code Usage Tracker — VSCode Extension Design

**Date:** 2026-06-11
**Status:** Approved design (pre-implementation)
**Type:** New, from-scratch VSCode extension (TypeScript)

---

## 1. Goal

A VSCode extension that gives a **combined dashboard** of Claude Code usage:

- **Official subscription quota** (the real 5-hour / 7-day / per-model limits + extra credits), and
- **Computed project-, model-, and session-level token usage and cost**, with history.

It targets a **Claude.ai Pro/Max subscription** user (the account type that authenticates Claude Code via OAuth). It is modeled on `yahyashareef48/claude-usage-monitor`'s quota mechanism, and extends it with the local-transcript computation that repo does not do.

---

## 2. Key finding that shapes the design

There is **no documented public Anthropic API** for Pro/Max subscription usage. However, Claude Code itself reads quota from a **private, undocumented endpoint**, and we reuse the same path (verified by reverse-engineering the reference repo):

```
GET https://api.anthropic.com/api/oauth/usage
  Authorization: Bearer <Claude Code OAuth access token>
  anthropic-beta: oauth-2025-04-20
  Content-Type: application/json
```

- This returns **quota utilization %** per window — **not** per-project token counts or cost.
- Per-project / per-model / cost / history therefore must be **computed from the local JSONL transcripts** (`~/.claude/projects/*/*.jsonl`), the same data `ccusage` uses.

**The design uses both sources together.**

### Caveats (documented in the README, accepted)
- The `oauth/usage` endpoint is **undocumented / private** (gated by `anthropic-beta: oauth-2025-04-20`); Anthropic may change or remove it without notice.
- Reusing Claude Code's OAuth token for this endpoint is a **Terms-of-Service gray area**.
- **No token-refresh logic**: we read the on-disk/Keychain token and rely on the Claude Code CLI to keep it fresh; an expired token yields a 401 with a "start a Claude Code session" hint.
- Quota JSON field names are inferred from the reference repo, not a documented schema; an unannounced rename degrades gracefully (bucket → null).

---

## 3. Architecture

Two data sources → one extension host (Node/TypeScript) → three UI surfaces.

```
SOURCES
  Claude Code credentials  ─┐
  (file → macOS Keychain)   │→ token
  api.anthropic.com/oauth/usage  ── official quota (5h/7d/per-model/extra)
  ~/.claude/projects/*.jsonl     ── local usage records (computed)
  LiteLLM price map              ── per-model rates (cached, offline-safe)

HOST (TypeScript)
  quotaClient · transcriptIndexer · pricing · aggregator
  + caching (globalState/globalStorage), polling, FileSystemWatcher

UI
  Status bar item   (5h quota glance)
  Activity Bar tree (Overview · By project · By model · Quota · Sessions)
  Webview dashboard (charts, bars, breakdowns)
```

**Data routing:** Quota view + status bar ← `oauth/usage` (official). Overview / By project / By model / Sessions ← local transcripts + pricing (computed).

### Module breakdown (each focused + unit-testable)
| Module | Responsibility |
|---|---|
| `credentials.ts` | Resolve OAuth token: `$CLAUDE_CONFIG_DIR/.credentials.json` → `~/.claude/.credentials.json` (`claudeAiOauth.accessToken`) → **macOS Keychain** (`security find-generic-password -s 'Claude Code-credentials' -w`, taking `accessToken` or legacy `claudeAiOauth.accessToken`). Returns token or a typed "no token" result. |
| `quotaClient.ts` | `GET …/api/oauth/usage` (Bearer + beta header, 8 s timeout). Parse snake_case → `QuotaData`. Typed errors for 401/403/429/network. |
| `transcriptIndexer.ts` | Discover `projects/<encoded>/<sessionId>.jsonl`; incrementally parse appended bytes; extract usage; **dedup by `requestId` (+ `messageId`)**; attribute to project (via record `cwd`/`gitBranch`), model, timestamp, session. |
| `pricing.ts` | Fetch LiteLLM `model_prices_and_context_window.json`; cache last-good; `priceFor(model)` → input/output/cache-read/cache-write rates. |
| `aggregator.ts` | Roll up by project / model / day / session; apply pricing → cost. |
| `statusBar.ts` | One `StatusBarItem` (5h quota glance, color states). |
| `treeProvider.ts` | Activity Bar `viewsContainer` + `TreeDataProvider` (5 views). |
| `dashboard/` | Webview (vanilla TS + CSS + small chart lib). |
| `extension.ts` | Activation, commands, polling timers, `FileSystemWatcher`, cache orchestration, wiring. |

### UI / webview tech
**Vanilla TypeScript + CSS** (VSCode theme variables) for the webview, with a **small charting lib** (e.g. uPlot or Chart.js) for time-series. Smallest bundle, easiest CSP, full theming control.

---

## 4. Data acquisition & correctness

### 4.1 Token resolution (`credentials.ts`)
First hit wins: (1) `$CLAUDE_CONFIG_DIR/.credentials.json`; (2) `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`; (3) macOS Keychain item `Claude Code-credentials` → `accessToken` (new) or `claudeAiOauth.accessToken` (legacy). None → UI "Log in to Claude Code" state.
> Note: on the target machine, `~/.claude/.credentials.json` is **absent** (token in Keychain) — the Keychain fallback is **mandatory**, not optional.

### 4.2 Quota (`quotaClient.ts`)
Response → `QuotaData`:
```ts
interface QuotaBucket { utilization: number; /* 0-100 */ resetsAt: string; /* ISO 8601 */ }
interface ExtraUsage {
  isEnabled: boolean; monthlyLimit: number | null; /* cents */
  usedCredits: number | null; /* cents */ utilization: number | null; currency: string | null;
}
interface QuotaData {
  fiveHour: QuotaBucket | null;
  sevenDay: QuotaBucket | null;
  sevenDaySonnet: QuotaBucket | null;
  sevenDayOpus: QuotaBucket | null;
  sevenDayOauthApps: QuotaBucket | null;
  extraUsage: ExtraUsage | null;
  fetchedAt: Date;
}
```
Raw wire JSON (snake_case): `five_hour`, `seven_day`, `seven_day_sonnet`, `seven_day_opus`, `seven_day_oauth_apps` (each `{utilization, resets_at}`), `extra_usage {is_enabled, monthly_limit, used_credits, utilization, currency}`; error envelope `{type:"error", error:{message}}`. Money fields are **cents** (÷100 for display).
Errors: 401 → token expired; 403 → needs Pro/Max; 429 → back off; network → last-cached + "stale" badge.

### 4.3 Local transcripts (`transcriptIndexer.ts`)
- Per assistant record with `message.usage`: capture `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` (+ 5 m / 1 h ephemeral split), `model`, `timestamp`, `sessionId`, `requestId`, `messageId`.
- **Dedup by `requestId` (+ `messageId`)** — identical usage repeats across consecutive records; count once.
- Skip `isSidechain` / `isMeta` records.
- Project identity from the record's real `cwd` (and `gitBranch`), not the encoded folder name.
- **Incremental index**: persist per-file `{path, size, mtime, byteOffset, partial aggregates, seen-id tail}`; on refresh, read only appended bytes (stream the chunk, split on newlines). Handles multi-MB / 13 MB files cheaply.

### 4.4 Pricing & cost (`pricing.ts` + `aggregator.ts`)
- Fetch LiteLLM price map; cache last-good in `globalStorage`; refresh ~daily; offline → cached.
- `cost = input×inRate + output×outRate + cacheRead×readRate + cacheCreation×writeRate`, summed per project / model / day / session. Respect 5 m vs 1 h ephemeral cache-write rates if distinguished by the price map; otherwise use the single cache-write rate.
- Unknown model → tokens counted, cost flagged "n/a".

---

## 5. UI / views

- **Status bar:** single right-aligned `StatusBarItem`, e.g. `☁ 42% · 3h 10m` (5h quota + reset countdown). Color: green <60 %, amber 60–80 % (`statusBarItem.warningBackground`), red >80 % (`statusBarItem.errorBackground`) — **only this segment** colors. Hover = rich tooltip (all windows); click = open dashboard. Configurable mode (5h / 7d / both), color source (5h / 7d / max), visibility.
- **Activity Bar tree** (`viewsContainer` + 5 views): `Overview · By project · By model · Quota · Sessions`; selecting a node opens that view in the webview.
- **Overview:** KPI cards (Today / Week / Month cost + tokens, live 5h quota), 30-day cost chart, top-projects + by-model bars.
- **By project:** tokens (in/out/cache) + cost + % of total + last-active per project; drill into a project's model split + trend.
- **By model:** per-model token-type breakdown + cost + share.
- **Quota** (official `oauth/usage`): progress bars for 5-Hour / 7-Day / 7-Day Sonnet / 7-Day Opus / 7-Day OAuth Apps (utilization % + "resets in"), plus Extra Usage ($ spent / cap).
- **Sessions:** one row per JSONL session — project, start/end, duration, message count, tokens, cost; sortable; click → detail.

---

## 6. Cross-cutting

- **Refresh cadence:** quota polled ~2 min while focused (paused when unfocused), exponential backoff (4/8/16 min) on error; local usage refreshed on activation + on file change, debounced ~1.5 s. Manual Refresh command + webview button.
- **File watching:** `FileSystemWatcher` on `~/.claude/projects/**/*.jsonl` → incremental parse of changed file → re-aggregate → update tree + webview.
- **Caching / cross-window de-dup:** quota in `globalState` (~115 s TTL) so multiple windows don't double-hit; keep last-good on error with "stale" badge. Transcript offset-index + aggregates in `globalStorage` (instant reopen; reconcile by size/mtime). Pricing map in `globalStorage`, ~daily refresh.
- **Error / empty states:** no token → "Log in to Claude Code"; 401 expired; 403 needs Pro/Max; 429/offline → cached + stale; no transcripts → friendly empty; unknown model → cost "n/a".
- **Performance:** stream appended chunks (never load whole large files); small, debounced passes. Worker thread deferred (YAGNI).
- **Settings:** status-bar mode, color source, status-bar visibility, clock format (12/24 h), poll interval, pricing-source URL override, currency.
- **Commands:** Refresh, Show Dashboard, focus each view.
- **Privacy/security:** token read locally; only outbound calls are `api.anthropic.com` (quota) and the LiteLLM pricing URL; **no telemetry**. README documents this and the ToS/undocumented-endpoint caveat.

---

## 7. Testing (TDD)

Unit tests for: credential resolution (file + mocked Keychain), quota parsing (fixtures incl. null buckets + error envelope), transcript **dedup + aggregation** (fixture JSONL with duplicate `requestId`s, drawn from real samples), cost math (incl. cache read/write), incremental-index correctness (append → only-new-bytes parsed). `@vscode/test` for activation + commands. Tests written before implementation per TDD.

---

## 8. Packaging & tooling

TypeScript + **esbuild** bundle, eslint. `package.json` contributes: an Activity Bar `viewsContainer`, the 5 tree views, commands, configuration; the status-bar item is created in code. `vsce package` → `.vsix`. Pinned VSCode `engines` version and Node target.

---

## 9. Non-goals (YAGNI)

- No Chrome extension (the reference repo's secondary product) — out of scope.
- No worker threads for parsing (revisit only if profiling demands it).
- No writing to / mutating Claude Code data.
- No multi-account switching; no Admin/Console API integration (subscription-only).
- No token refresh (delegated to the Claude Code CLI).

---

## 10. Decisions log (from brainstorming)

1. Scope: **combined dashboard** ("the works").
2. UI surface: **Activity Bar tree + detailed webviews + status-bar glance**.
3. Pricing: **live-fetch (LiteLLM)** with last-fetch cache for offline.
4. Quota: **official `oauth/usage` endpoint** (reuse Claude Code token; Keychain fallback on macOS).
5. Data scope: **both sources** — official quota + local-transcript project/model/cost/history.
6. Webview tech: **vanilla TS + small chart lib**.
Sorry