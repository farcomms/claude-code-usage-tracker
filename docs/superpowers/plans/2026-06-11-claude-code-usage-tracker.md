# Claude Code Usage Tracker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A from-scratch VSCode extension that shows Claude Code usage as a combined dashboard — official subscription quota (from the undocumented `api/oauth/usage` endpoint, reusing the Claude Code OAuth token) plus project/model/cost/history computed from local `~/.claude/projects/*.jsonl` transcripts.

**Architecture:** Pure-logic modules (`credentials`, `quotaClient`, `pricing`, `transcriptIndexer`, `aggregator`, `format`) take injected dependencies and never import `vscode`, so they unit-test with vitest. The `vscode`-facing modules (`statusBar`, `treeProvider`, `dashboard/panel`, `extension`) wire those into UI surfaces: a status-bar item, an Activity Bar tree (Overview / By project / By model / Quota / Sessions), and a webview dashboard. Quota is polled ~2 min while focused; transcripts are parsed incrementally (byte-offset) on a debounced FileSystemWatcher. Caches live in `globalState`/`globalStorage`.

**Tech Stack:** TypeScript, VSCode Extension API (`engines.vscode` ^1.90.0, Node 20 runtime → global `fetch`), esbuild (bundle), vitest (unit), @vscode/test-electron + @vscode/test-cli (integration), @vscode/vsce (package). Webview = vanilla TS/JS + CSS with hand-rolled inline-SVG charts (no chart-lib dependency for v1 — see note in Task 16; a lib can drop into `charts.ts` later without touching callers).

**Conventions:** Commit messages do **not** include a `Co-Authored-By: Claude` trailer (user preference). Work on a feature branch off `main`.

---

## File structure

```
claude-code-usage-tracker/
├─ package.json                  # manifest: contributes (viewsContainer, view, commands, config), scripts, deps
├─ tsconfig.json                 # TS config (src + test)
├─ esbuild.js                    # bundles src/extension.ts -> out/extension.js
├─ vitest.config.ts              # unit-test config (node env, excludes integration)
├─ eslint.config.mjs             # lint
├─ .vscodeignore                 # files excluded from the .vsix
├─ .vscode/{launch.json,tasks.json}
├─ media/
│  ├─ icon.svg                   # Activity Bar container icon
│  ├─ dashboard.html             # webview shell (placeholders for csp/nonce/uris)
│  ├─ dashboard.css              # webview styles (VSCode theme vars)
│  └─ dashboard.js               # webview script (renders state, hand-rolled SVG charts)
├─ src/
│  ├─ types.ts                   # shared interfaces (quota + usage + rollups)
│  ├─ credentials.ts             # OAuth token resolution (file -> macOS Keychain)
│  ├─ quotaClient.ts             # parse + fetch api/oauth/usage; typed errors
│  ├─ pricing.ts                 # LiteLLM price map: normalize + priceForModel + fetch/cache
│  ├─ transcriptIndexer.ts       # discover + incremental parse + dedup of JSONL
│  ├─ aggregator.ts              # cost + rollups (project/model/day/session)
│  ├─ format.ts                  # pure formatting (status text, duration, USD)
│  ├─ statusBar.ts               # StatusBarItem manager (vscode)
│  ├─ treeProvider.ts            # Activity Bar TreeDataProvider (vscode)
│  ├─ dashboard/panel.ts         # webview controller (vscode)
│  └─ extension.ts               # activation, commands, polling, watcher, caches (vscode)
└─ test/
   ├─ credentials.test.ts
   ├─ quotaClient.test.ts
   ├─ pricing.test.ts
   ├─ transcriptIndexer.test.ts
   ├─ aggregator.test.ts
   ├─ format.test.ts
   ├─ fixtures/                  # sample JSONL lines + quota/pricing JSON
   └─ integration/activation.test.ts   # @vscode/test-electron smoke test
```

---

## Task 0: Create the feature branch

- [ ] **Step 1: Branch off main**

Run:
```bash
cd /Users/muhammadfaraan/FarDev/claude-code-usage-tracker
git checkout -b feat/usage-tracker
```
Expected: `Switched to a new branch 'feat/usage-tracker'`

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.js`, `vitest.config.ts`, `eslint.config.mjs`, `.vscodeignore`, `.vscode/launch.json`, `.vscode/tasks.json`, `media/icon.svg`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-code-usage-tracker",
  "displayName": "Claude Code Usage Tracker",
  "description": "Dashboard of Claude Code usage: official subscription quota + per-project/model token usage and cost.",
  "version": "0.1.0",
  "publisher": "nuvoladigital",
  "engines": { "vscode": "^1.90.0", "node": ">=20" },
  "categories": ["Other"],
  "main": "./out/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "claudeUsage", "title": "Claude Usage", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "claudeUsage": [
        { "id": "claudeUsage.tree", "name": "Usage" }
      ]
    },
    "commands": [
      { "command": "claudeUsage.refresh", "title": "Claude Usage: Refresh", "icon": "$(refresh)" },
      { "command": "claudeUsage.showDashboard", "title": "Claude Usage: Show Dashboard" },
      { "command": "claudeUsage.openSection", "title": "Claude Usage: Open Section" }
    ],
    "menus": {
      "view/title": [
        { "command": "claudeUsage.refresh", "when": "view == claudeUsage.tree", "group": "navigation" }
      ]
    },
    "configuration": {
      "title": "Claude Usage Tracker",
      "properties": {
        "claudeUsage.statusBar.mode": {
          "type": "string", "enum": ["5h", "7d", "both", "off"], "default": "5h",
          "description": "What the status-bar item shows."
        },
        "claudeUsage.statusBar.colorFrom": {
          "type": "string", "enum": ["5h", "7d", "max"], "default": "5h",
          "description": "Which window drives the status-bar warning color."
        },
        "claudeUsage.clockFormat": {
          "type": "string", "enum": ["auto", "12h", "24h"], "default": "auto",
          "description": "Clock format for reset times."
        },
        "claudeUsage.pollIntervalSeconds": {
          "type": "number", "default": 120, "minimum": 30,
          "description": "Quota poll interval (seconds) while the window is focused."
        },
        "claudeUsage.pricingUrl": {
          "type": "string",
          "default": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
          "description": "Source for the model price map."
        },
        "claudeUsage.currency": {
          "type": "string", "default": "USD",
          "description": "Currency label shown in the UI (display only; no FX conversion)."
        }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.js",
    "watch": "node esbuild.js --watch",
    "lint": "eslint src test",
    "test:unit": "vitest run",
    "test:integration": "vscode-test",
    "vscode:prepublish": "node esbuild.js --production",
    "package": "vsce package"
  },
  "devDependencies": {
    "@eslint/js": "^9.9.0",
    "@types/node": "^20.14.0",
    "@types/vscode": "^1.90.0",
    "@vscode/test-cli": "^0.0.10",
    "@vscode/test-electron": "^2.4.1",
    "@vscode/vsce": "^3.2.0",
    "esbuild": "^0.23.0",
    "eslint": "^9.9.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "Node16",
    "moduleResolution": "Node16",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src", "test"],
  "exclude": ["node_modules", "out"]
}
```

- [ ] **Step 3: Create `esbuild.js`**

```js
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node20",
    outfile: "out/extension.js",
    external: ["vscode"],
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  });
  if (watch) { await ctx.watch(); }
  else { await ctx.rebuild(); await ctx.dispose(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules", "out"],
  },
});
```

- [ ] **Step 5: Create `eslint.config.mjs`**

```js
import js from "@eslint/js";
export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: { "no-unused-vars": "off" },
  },
  { ignores: ["out/**", "node_modules/**", "media/dashboard.js"] },
];
```

- [ ] **Step 6: Create `.vscodeignore`**

```
.vscode/**
test/**
src/**
**/*.ts
**/*.map
esbuild.js
vitest.config.ts
eslint.config.mjs
tsconfig.json
.superpowers/**
docs/**
node_modules/**
```

- [ ] **Step 7: Create `.vscode/launch.json`**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"],
      "preLaunchTask": "npm: build"
    }
  ]
}
```

- [ ] **Step 8: Create `.vscode/tasks.json`**

```json
{
  "version": "2.0.0",
  "tasks": [
    { "type": "npm", "script": "build", "problemMatcher": "$esbuild", "label": "npm: build" }
  ]
}
```

- [ ] **Step 9: Create `media/icon.svg`**

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
</svg>
```

- [ ] **Step 10: Install dependencies and verify the build compiles**

Run:
```bash
npm install && npm run build
```
Expected: `npm install` completes, then esbuild prints it wrote `out/extension.js` — wait, there is no `src/extension.ts` yet. Instead, create a temporary stub so the build can be verified:

```bash
mkdir -p src && printf 'export function activate() {}\nexport function deactivate() {}\n' > src/extension.ts
npm run build
```
Expected: esbuild logs `out/extension.js` written, no errors.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "Scaffold VSCode extension (manifest, build, lint, test config)"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
// ---------- Official quota (api/oauth/usage) ----------
export interface QuotaBucket {
  utilization: number;        // 0-100
  resetsAt: string | null;    // ISO 8601
}
export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null; // cents
  usedCredits: number | null;  // cents
  utilization: number | null;
  currency: string | null;
}
export interface QuotaData {
  fiveHour: QuotaBucket | null;
  sevenDay: QuotaBucket | null;
  sevenDaySonnet: QuotaBucket | null;
  sevenDayOpus: QuotaBucket | null;
  sevenDayOauthApps: QuotaBucket | null;
  extraUsage: ExtraUsage | null;
  fetchedAt: string;          // ISO
}
export type QuotaErrorKind = "no-token" | "unauthorized" | "forbidden" | "rate-limited" | "network" | "bad-response";
export interface QuotaError { kind: QuotaErrorKind; message: string; }
export type QuotaResult = { ok: true; data: QuotaData } | { ok: false; error: QuotaError };

// ---------- Local transcript usage ----------
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}
export interface UsageRecord {
  requestId: string;
  messageId: string | null;
  model: string;
  timestamp: string;      // ISO
  project: string;        // display name
  projectPath: string;    // cwd
  sessionId: string;
  tokens: TokenCounts;
}

// ---------- Aggregations ----------
export interface CostedTotals {
  tokens: TokenCounts;
  totalTokens: number;
  cost: number;           // USD
  costKnown: boolean;     // false if any contributing model lacked pricing
}
export interface ProjectRollup extends CostedTotals { project: string; projectPath: string; lastActive: string; }
export interface ModelRollup extends CostedTotals { model: string; }
export interface DayRollup extends CostedTotals { day: string; }   // YYYY-MM-DD
export interface SessionRollup extends CostedTotals {
  sessionId: string; project: string; start: string; end: string; messages: number;
}
export interface UsageSummary {
  totals: CostedTotals;
  today: CostedTotals;
  week: CostedTotals;
  month: CostedTotals;
  byProject: ProjectRollup[];
  byModel: ModelRollup[];
  byDay: DayRollup[];
  sessions: SessionRollup[];
}

// ---------- Pricing ----------
export interface ModelPrice {
  input: number;          // USD per token
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export type PriceMap = Record<string, ModelPrice>;

// ---------- Persisted incremental index (per file) ----------
export interface FileIndexEntry {
  size: number;
  mtimeMs: number;
  offset: number;             // bytes parsed so far
  seenIds: string[];          // dedup keys seen in this file
  records: UsageRecord[];     // deduped usage records from this file
}
export type FileIndex = Record<string, FileIndexEntry>;  // keyed by absolute file path
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "Add shared types"
```

---

## Task 3: Credential resolution (`credentials.ts`)

**Files:**
- Create: `src/credentials.ts`
- Test: `test/credentials.test.ts`

`resolveToken` takes injected deps so it is testable without touching the real filesystem/Keychain.

- [ ] **Step 1: Write the failing test**

Create `test/credentials.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveToken, CredentialDeps } from "../src/credentials";

function deps(over: Partial<CredentialDeps>): CredentialDeps {
  return {
    env: {},
    homedir: () => "/home/u",
    readFileText: () => null,
    platform: "linux",
    runKeychain: () => null,
    ...over,
  };
}

describe("resolveToken", () => {
  it("reads claudeAiOauth.accessToken from ~/.claude/.credentials.json", () => {
    const r = resolveToken(deps({
      readFileText: (p) => p === "/home/u/.claude/.credentials.json"
        ? JSON.stringify({ claudeAiOauth: { accessToken: "tok-file" } }) : null,
    }));
    expect(r).toEqual({ token: "tok-file" });
  });

  it("honors CLAUDE_CONFIG_DIR over the home default", () => {
    const r = resolveToken(deps({
      env: { CLAUDE_CONFIG_DIR: "/cfg" },
      readFileText: (p) => p === "/cfg/.credentials.json"
        ? JSON.stringify({ claudeAiOauth: { accessToken: "tok-env" } }) : null,
    }));
    expect(r).toEqual({ token: "tok-env" });
  });

  it("falls back to macOS Keychain (new format) when no file", () => {
    const r = resolveToken(deps({
      platform: "darwin",
      runKeychain: () => JSON.stringify({ accessToken: "tok-kc" }),
    }));
    expect(r).toEqual({ token: "tok-kc" });
  });

  it("falls back to macOS Keychain legacy format", () => {
    const r = resolveToken(deps({
      platform: "darwin",
      runKeychain: () => JSON.stringify({ claudeAiOauth: { accessToken: "tok-legacy" } }),
    }));
    expect(r).toEqual({ token: "tok-legacy" });
  });

  it("does not use Keychain off macOS", () => {
    const r = resolveToken(deps({ platform: "linux", runKeychain: () => JSON.stringify({ accessToken: "x" }) }));
    expect(r).toEqual({ token: null, reason: "no-credentials" });
  });

  it("returns no-credentials when nothing is found", () => {
    expect(resolveToken(deps({}))).toEqual({ token: null, reason: "no-credentials" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:unit -- credentials`
Expected: FAIL — cannot find module `../src/credentials`.

- [ ] **Step 3: Write `src/credentials.ts`**

```ts
export interface CredentialDeps {
  env: Record<string, string | undefined>;
  homedir: () => string;
  readFileText: (path: string) => string | null;   // null if missing/unreadable
  platform: NodeJS.Platform;
  runKeychain: () => string | null;                 // raw stdout of the security command, or null
}
export type TokenResult = { token: string } | { token: null; reason: "no-credentials" };

function configDir(d: CredentialDeps): string {
  const env = d.env.CLAUDE_CONFIG_DIR;
  if (env && env.length > 0) { return env; }
  return `${d.homedir()}/.claude`;
}

function tokenFromJson(raw: string | null): string | null {
  if (!raw) { return null; }
  try {
    const j = JSON.parse(raw);
    return j?.accessToken ?? j?.claudeAiOauth?.accessToken ?? null;
  } catch { return null; }
}

export function resolveToken(d: CredentialDeps): TokenResult {
  const fileToken = tokenFromJson(d.readFileText(`${configDir(d)}/.credentials.json`));
  if (fileToken) { return { token: fileToken }; }
  if (d.platform === "darwin") {
    const kcToken = tokenFromJson(d.runKeychain());
    if (kcToken) { return { token: kcToken }; }
  }
  return { token: null, reason: "no-credentials" };
}

// Production deps factory (used by extension.ts).
export function defaultCredentialDeps(): CredentialDeps {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const cp = require("node:child_process") as typeof import("node:child_process");
  return {
    env: process.env,
    homedir: () => os.homedir(),
    readFileText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    platform: process.platform,
    runKeychain: () => {
      try {
        return cp.execFileSync("security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      } catch { return null; }
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit -- credentials`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/credentials.ts test/credentials.test.ts
git commit -m "Add OAuth token resolution (file + macOS Keychain)"
```

---

## Task 4: Quota parsing (`quotaClient.ts` — pure parse)

**Files:**
- Create: `src/quotaClient.ts`
- Create fixtures: `test/fixtures/quota-full.json`, `test/fixtures/quota-partial.json`
- Test: `test/quotaClient.test.ts`

- [ ] **Step 1: Create fixtures**

`test/fixtures/quota-full.json`:
```json
{
  "five_hour": { "utilization": 42, "resets_at": "2026-06-11T20:00:00Z" },
  "seven_day": { "utilization": 70, "resets_at": "2026-06-18T00:00:00Z" },
  "seven_day_sonnet": { "utilization": 12, "resets_at": "2026-06-18T00:00:00Z" },
  "seven_day_opus": { "utilization": 88, "resets_at": "2026-06-18T00:00:00Z" },
  "seven_day_oauth_apps": { "utilization": 5, "resets_at": "2026-06-18T00:00:00Z" },
  "extra_usage": { "is_enabled": true, "monthly_limit": 5000, "used_credits": 1234, "utilization": 24.68, "currency": "USD" }
}
```

`test/fixtures/quota-partial.json`:
```json
{ "five_hour": { "utilization": 10, "resets_at": "2026-06-11T20:00:00Z" } }
```

- [ ] **Step 2: Write the failing test (parse only)**

Create `test/quotaClient.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuota } from "../src/quotaClient";

const load = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8"));

describe("parseQuota", () => {
  it("maps all buckets and extra usage", () => {
    const q = parseQuota(load("quota-full.json"), "2026-06-11T19:00:00Z");
    expect(q.fiveHour).toEqual({ utilization: 42, resetsAt: "2026-06-11T20:00:00Z" });
    expect(q.sevenDayOpus).toEqual({ utilization: 88, resetsAt: "2026-06-18T00:00:00Z" });
    expect(q.extraUsage).toEqual({
      isEnabled: true, monthlyLimit: 5000, usedCredits: 1234, utilization: 24.68, currency: "USD",
    });
    expect(q.fetchedAt).toBe("2026-06-11T19:00:00Z");
  });

  it("sets missing buckets to null", () => {
    const q = parseQuota(load("quota-partial.json"), "2026-06-11T19:00:00Z");
    expect(q.fiveHour?.utilization).toBe(10);
    expect(q.sevenDay).toBeNull();
    expect(q.extraUsage).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:unit -- quotaClient`
Expected: FAIL — cannot find `../src/quotaClient`.

- [ ] **Step 4: Write `src/quotaClient.ts` (parse only for now)**

```ts
import { QuotaBucket, QuotaData, ExtraUsage } from "./types";

function bucket(raw: any): QuotaBucket | null {
  if (!raw || typeof raw.utilization !== "number") { return null; }
  return { utilization: raw.utilization, resetsAt: raw.resets_at ?? null };
}
function extra(raw: any): ExtraUsage | null {
  if (!raw) { return null; }
  return {
    isEnabled: !!raw.is_enabled,
    monthlyLimit: raw.monthly_limit ?? null,
    usedCredits: raw.used_credits ?? null,
    utilization: raw.utilization ?? null,
    currency: raw.currency ?? null,
  };
}
export function parseQuota(raw: any, fetchedAtIso: string): QuotaData {
  return {
    fiveHour: bucket(raw?.five_hour),
    sevenDay: bucket(raw?.seven_day),
    sevenDaySonnet: bucket(raw?.seven_day_sonnet),
    sevenDayOpus: bucket(raw?.seven_day_opus),
    sevenDayOauthApps: bucket(raw?.seven_day_oauth_apps),
    extraUsage: extra(raw?.extra_usage),
    fetchedAt: fetchedAtIso,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit -- quotaClient`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/quotaClient.ts test/quotaClient.test.ts test/fixtures/quota-full.json test/fixtures/quota-partial.json
git commit -m "Add quota response parsing"
```

---

## Task 5: Quota fetch + error mapping (`quotaClient.ts`)

**Files:**
- Modify: `src/quotaClient.ts`
- Modify: `test/quotaClient.test.ts`

`fetchQuota` takes an injected `httpGet` so HTTP and error mapping are testable without the network.

- [ ] **Step 1: Add failing tests**

Append to `test/quotaClient.test.ts`:
```ts
import { fetchQuota, HttpResponse } from "../src/quotaClient";

const okResp = (body: unknown): HttpResponse => ({ status: 200, body: JSON.stringify(body) });

describe("fetchQuota", () => {
  it("returns no-token error when token is null", async () => {
    const r = await fetchQuota({ token: null }, async () => okResp({}), () => "2026-06-11T19:00:00Z");
    expect(r).toEqual({ ok: false, error: { kind: "no-token", message: expect.any(String) } });
  });

  it("returns parsed data on 200", async () => {
    const r = await fetchQuota({ token: "t" }, async () => okResp(load("quota-full.json")), () => "2026-06-11T19:00:00Z");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.fiveHour?.utilization).toBe(42); }
  });

  it("maps 401 -> unauthorized", async () => {
    const r = await fetchQuota({ token: "t" }, async () => ({ status: 401, body: "" }), () => "x");
    expect(r).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
  });

  it("maps 403 -> forbidden", async () => {
    const r = await fetchQuota({ token: "t" }, async () => ({ status: 403, body: "" }), () => "x");
    expect(r).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("maps 429 -> rate-limited", async () => {
    const r = await fetchQuota({ token: "t" }, async () => ({ status: 429, body: "" }), () => "x");
    expect(r).toMatchObject({ ok: false, error: { kind: "rate-limited" } });
  });

  it("maps a thrown error -> network", async () => {
    const r = await fetchQuota({ token: "t" }, async () => { throw new Error("boom"); }, () => "x");
    expect(r).toMatchObject({ ok: false, error: { kind: "network" } });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- quotaClient`
Expected: FAIL — `fetchQuota` / `HttpResponse` not exported.

- [ ] **Step 3: Extend `src/quotaClient.ts`**

Append:
```ts
import { QuotaResult } from "./types";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const BETA_HEADER = "oauth-2025-04-20";

export interface HttpResponse { status: number; body: string; }
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export async function fetchQuota(
  creds: { token: string | null },
  httpGet: HttpGet,
  now: () => string,
): Promise<QuotaResult> {
  if (!creds.token) {
    return { ok: false, error: { kind: "no-token", message: "Log in to Claude Code (run `claude`)." } };
  }
  let resp: HttpResponse;
  try {
    resp = await httpGet(USAGE_URL, {
      "Authorization": `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      "anthropic-beta": BETA_HEADER,
    });
  } catch (e) {
    return { ok: false, error: { kind: "network", message: String((e as Error)?.message ?? e) } };
  }
  if (resp.status === 401) { return { ok: false, error: { kind: "unauthorized", message: "Token expired — start a Claude Code session." } }; }
  if (resp.status === 403) { return { ok: false, error: { kind: "forbidden", message: "This endpoint needs a Claude Pro/Max subscription." } }; }
  if (resp.status === 429) { return { ok: false, error: { kind: "rate-limited", message: "Rate limited — backing off." } }; }
  if (resp.status < 200 || resp.status >= 300) { return { ok: false, error: { kind: "bad-response", message: `HTTP ${resp.status}` } }; }
  try {
    return { ok: true, data: parseQuota(JSON.parse(resp.body), now()) };
  } catch (e) {
    return { ok: false, error: { kind: "bad-response", message: "Unparseable response." } };
  }
}

// Production httpGet using Node's global fetch.
export function defaultHttpGet(): HttpGet {
  return async (url, headers) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      return { status: res.status, body: await res.text() };
    } finally { clearTimeout(t); }
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- quotaClient`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/quotaClient.ts test/quotaClient.test.ts
git commit -m "Add quota fetch with typed error mapping"
```

---

## Task 6: Pricing normalize + lookup (`pricing.ts`)

**Files:**
- Create: `src/pricing.ts`
- Create fixture: `test/fixtures/litellm-sample.json`
- Test: `test/pricing.test.ts`

- [ ] **Step 1: Create fixture**

`test/fixtures/litellm-sample.json`:
```json
{
  "claude-opus-4-8": {
    "input_cost_per_token": 0.000005,
    "output_cost_per_token": 0.000025,
    "cache_read_input_token_cost": 0.0000005,
    "cache_creation_input_token_cost": 0.00000625
  },
  "anthropic/claude-sonnet-4-6": {
    "input_cost_per_token": 0.000003,
    "output_cost_per_token": 0.000015,
    "cache_read_input_token_cost": 0.0000003,
    "cache_creation_input_token_cost": 0.00000375
  },
  "sample_spec": { "note": "non-model entry that must be ignored" }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/pricing.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePrices, priceForModel } from "../src/pricing";

const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", "litellm-sample.json"), "utf8"));

describe("normalizePrices", () => {
  it("keeps only entries with input/output costs", () => {
    const m = normalizePrices(raw);
    expect(m["claude-opus-4-8"]).toEqual({ input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 });
    expect(m["sample_spec"]).toBeUndefined();
  });
});

describe("priceForModel", () => {
  it("matches exact id", () => {
    const m = normalizePrices(raw);
    expect(priceForModel("claude-opus-4-8", m)?.output).toBe(0.000025);
  });
  it("matches with anthropic/ prefix", () => {
    const m = normalizePrices(raw);
    expect(priceForModel("claude-sonnet-4-6", m)?.input).toBe(0.000003);
  });
  it("returns null for unknown model", () => {
    expect(priceForModel("gpt-9", normalizePrices(raw))).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test:unit -- pricing`
Expected: FAIL — cannot find `../src/pricing`.

- [ ] **Step 4: Write `src/pricing.ts`**

```ts
import { ModelPrice, PriceMap } from "./types";

export function normalizePrices(raw: any): PriceMap {
  const out: PriceMap = {};
  if (!raw || typeof raw !== "object") { return out; }
  for (const [key, v] of Object.entries<any>(raw)) {
    if (!v || typeof v.input_cost_per_token !== "number" || typeof v.output_cost_per_token !== "number") { continue; }
    out[key] = {
      input: v.input_cost_per_token,
      output: v.output_cost_per_token,
      cacheRead: v.cache_read_input_token_cost ?? 0,
      cacheWrite: v.cache_creation_input_token_cost ?? 0,
    };
  }
  return out;
}

export function priceForModel(model: string, prices: PriceMap): ModelPrice | null {
  if (prices[model]) { return prices[model]; }
  if (prices[`anthropic/${model}`]) { return prices[`anthropic/${model}`]; }
  // suffix match (e.g. provider-prefixed keys)
  const hit = Object.keys(prices).find((k) => k.endsWith(`/${model}`));
  return hit ? prices[hit] : null;
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test:unit -- pricing`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/pricing.ts test/pricing.test.ts test/fixtures/litellm-sample.json
git commit -m "Add pricing normalization and model lookup"
```

---

## Task 7: Pricing fetch with cache fallback (`pricing.ts`)

**Files:**
- Modify: `src/pricing.ts`
- Modify: `test/pricing.test.ts`

`loadPrices` fetches fresh; on failure it returns the provided cached map (offline-safe).

- [ ] **Step 1: Add failing tests**

Append to `test/pricing.test.ts`:
```ts
import { loadPrices } from "../src/pricing";

describe("loadPrices", () => {
  const fresh = JSON.stringify({ "m": { input_cost_per_token: 1, output_cost_per_token: 2 } });

  it("returns fresh normalized map when fetch succeeds", async () => {
    const r = await loadPrices("http://x", async () => fresh, null);
    expect(r.fromCache).toBe(false);
    expect(r.prices["m"]).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("falls back to cached map on fetch failure", async () => {
    const cached = { m2: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } };
    const r = await loadPrices("http://x", async () => { throw new Error("offline"); }, cached);
    expect(r.fromCache).toBe(true);
    expect(r.prices).toEqual(cached);
  });

  it("returns empty map when fetch fails and no cache", async () => {
    const r = await loadPrices("http://x", async () => { throw new Error("offline"); }, null);
    expect(r.prices).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- pricing`
Expected: FAIL — `loadPrices` not exported.

- [ ] **Step 3: Extend `src/pricing.ts`**

Append:
```ts
export type Fetcher = (url: string) => Promise<string>;
export interface LoadResult { prices: PriceMap; fromCache: boolean; }

export async function loadPrices(url: string, fetchText: Fetcher, cached: PriceMap | null): Promise<LoadResult> {
  try {
    const prices = normalizePrices(JSON.parse(await fetchText(url)));
    if (Object.keys(prices).length === 0) { throw new Error("empty price map"); }
    return { prices, fromCache: false };
  } catch {
    return { prices: cached ?? {}, fromCache: cached != null };
  }
}

export function defaultFetcher(): Fetcher {
  return async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try { const r = await fetch(url, { signal: ctrl.signal }); return await r.text(); }
    finally { clearTimeout(t); }
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- pricing`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/pricing.ts test/pricing.test.ts
git commit -m "Add pricing fetch with offline cache fallback"
```

---

## Task 8: Transcript line parsing (`transcriptIndexer.ts`)

**Files:**
- Create: `src/transcriptIndexer.ts`
- Test: `test/transcriptIndexer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/transcriptIndexer.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseUsageLine, projectNameFromCwd } from "../src/transcriptIndexer";

const assistantLine = JSON.stringify({
  type: "assistant",
  timestamp: "2026-06-08T20:31:46.176Z",
  sessionId: "sess-1",
  requestId: "req_1",
  cwd: "/Users/u/FarDev/Chat-App",
  gitBranch: "main",
  message: {
    id: "msg_1",
    model: "claude-opus-4-8",
    usage: { input_tokens: 1978, output_tokens: 617, cache_read_input_tokens: 16760, cache_creation_input_tokens: 3205 },
  },
});

describe("projectNameFromCwd", () => {
  it("uses the last path segment", () => {
    expect(projectNameFromCwd("/Users/u/FarDev/Chat-App")).toBe("Chat-App");
    expect(projectNameFromCwd("/Users/u/FarDev/Chat-App/")).toBe("Chat-App");
    expect(projectNameFromCwd("")).toBe("(unknown)");
  });
});

describe("parseUsageLine", () => {
  it("parses an assistant usage record", () => {
    const r = parseUsageLine(assistantLine);
    expect(r).toMatchObject({
      requestId: "req_1", messageId: "msg_1", model: "claude-opus-4-8",
      sessionId: "sess-1", project: "Chat-App", projectPath: "/Users/u/FarDev/Chat-App",
      tokens: { input: 1978, output: 617, cacheRead: 16760, cacheCreation: 3205 },
    });
  });
  it("returns null for non-assistant lines", () => {
    expect(parseUsageLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
  });
  it("returns null for assistant lines without usage", () => {
    expect(parseUsageLine(JSON.stringify({ type: "assistant", message: { id: "m" } }))).toBeNull();
  });
  it("skips sidechain and meta records", () => {
    const side = JSON.parse(assistantLine); side.isSidechain = true;
    expect(parseUsageLine(JSON.stringify(side))).toBeNull();
  });
  it("returns null for malformed JSON", () => {
    expect(parseUsageLine("{not json")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- transcriptIndexer`
Expected: FAIL — cannot find `../src/transcriptIndexer`.

- [ ] **Step 3: Write `src/transcriptIndexer.ts` (parsing only)**

```ts
import { UsageRecord } from "./types";

export function projectNameFromCwd(cwd: string): string {
  if (!cwd) { return "(unknown)"; }
  const parts = cwd.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "(unknown)";
}

export function parseUsageLine(line: string): UsageRecord | null {
  let d: any;
  try { d = JSON.parse(line); } catch { return null; }
  if (!d || d.type !== "assistant" || d.isSidechain || d.isMeta) { return null; }
  const u = d.message?.usage;
  if (!u || typeof u.output_tokens !== "number") { return null; }
  const cwd = typeof d.cwd === "string" ? d.cwd : "";
  return {
    requestId: d.requestId ?? d.message?.id ?? "",
    messageId: d.message?.id ?? null,
    model: d.message?.model ?? "unknown",
    timestamp: d.timestamp ?? "",
    project: projectNameFromCwd(cwd),
    projectPath: cwd,
    sessionId: d.sessionId ?? "",
    tokens: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- transcriptIndexer`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/transcriptIndexer.ts test/transcriptIndexer.test.ts
git commit -m "Add transcript line parsing"
```

---

## Task 9: Dedup + incremental file indexing (`transcriptIndexer.ts`)

**Files:**
- Modify: `src/transcriptIndexer.ts`
- Modify: `test/transcriptIndexer.test.ts`

`indexFile` is pure: it takes the prior `FileIndexEntry | null`, the current file stat, and a `readFrom(offset)` function returning the appended text; it returns the updated entry with new deduped records appended.

- [ ] **Step 1: Add failing tests**

Append to `test/transcriptIndexer.test.ts`:
```ts
import { indexFile, FileStat } from "../src/transcriptIndexer";
import { FileIndexEntry } from "../src/types";

function line(reqId: string, out = 10): string {
  return JSON.stringify({
    type: "assistant", timestamp: "2026-06-08T20:31:46Z", sessionId: "s", requestId: reqId,
    cwd: "/Users/u/Proj", message: { id: reqId + "-m", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: out } },
  });
}

describe("indexFile", () => {
  const stat = (size: number): FileStat => ({ size, mtimeMs: size });

  it("parses a fresh file and dedups duplicate requestIds", () => {
    const text = [line("req_1"), line("req_1"), line("req_2")].join("\n") + "\n";
    const entry = indexFile(null, stat(text.length), () => text);
    expect(entry.records.map((r) => r.requestId)).toEqual(["req_1", "req_2"]);
    expect(entry.offset).toBe(text.length);
  });

  it("only reads appended bytes on subsequent calls", () => {
    const first = [line("req_1")].join("\n") + "\n";
    const e1 = indexFile(null, stat(first.length), () => first);
    const appended = [line("req_2")].join("\n") + "\n";
    const total = first + appended;
    let readFromOffset = -1;
    const e2 = indexFile(e1, stat(total.length), (off) => { readFromOffset = off; return appended; });
    expect(readFromOffset).toBe(first.length);
    expect(e2.records.map((r) => r.requestId)).toEqual(["req_1", "req_2"]);
  });

  it("re-reads the whole file if it shrank or mtime is unexpected (rotation)", () => {
    const first = [line("req_1"), line("req_2")].join("\n") + "\n";
    const e1 = indexFile(null, stat(first.length), () => first);
    const replaced = [line("req_9")].join("\n") + "\n";
    const e2 = indexFile(e1, { size: replaced.length, mtimeMs: 999999 }, () => replaced);
    expect(e2.records.map((r) => r.requestId)).toEqual(["req_9"]);
    expect(e2.offset).toBe(replaced.length);
  });

  it("ignores a trailing partial line (no newline yet)", () => {
    const text = line("req_1") + "\n" + line("req_2"); // req_2 has no trailing newline
    const entry = indexFile(null, stat(text.length), () => text);
    expect(entry.records.map((r) => r.requestId)).toEqual(["req_1"]);
    // offset advances only past the last complete newline
    expect(entry.offset).toBe(line("req_1").length + 1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- transcriptIndexer`
Expected: FAIL — `indexFile` / `FileStat` not exported.

- [ ] **Step 3: Extend `src/transcriptIndexer.ts`**

Append:
```ts
import { FileIndexEntry } from "./types";

export interface FileStat { size: number; mtimeMs: number; }

function dedupKey(r: { requestId: string; messageId: string | null }): string {
  return `${r.requestId}|${r.messageId ?? ""}`;
}

/**
 * Update (or create) the per-file index entry.
 * `readFrom(offset)` returns the file text starting at `offset` (UTF-8).
 * Only whole newline-terminated lines are consumed; a trailing partial line is left for next time.
 */
export function indexFile(
  prev: FileIndexEntry | null,
  stat: FileStat,
  readFrom: (offset: number) => string,
): FileIndexEntry {
  // Detect truncation/rotation: file shrank below our offset -> start over.
  const startFresh = !prev || stat.size < prev.offset;
  const base: FileIndexEntry = startFresh
    ? { size: 0, mtimeMs: 0, offset: 0, seenIds: [], records: [] }
    : { ...prev, seenIds: [...prev.seenIds], records: [...prev.records] };

  if (!startFresh && stat.size === base.offset && stat.mtimeMs === base.mtimeMs) {
    return { ...base, size: stat.size, mtimeMs: stat.mtimeMs }; // nothing new
  }

  const text = readFrom(base.offset);
  const lastNl = text.lastIndexOf("\n");
  const consumable = lastNl >= 0 ? text.slice(0, lastNl + 1) : "";
  const consumedBytes = Buffer.byteLength(consumable, "utf8");

  const seen = new Set(base.seenIds);
  for (const raw of consumable.split("\n")) {
    if (!raw) { continue; }
    const rec = parseUsageLine(raw);
    if (!rec) { continue; }
    const key = dedupKey(rec);
    if (seen.has(key)) { continue; }
    seen.add(key);
    base.records.push(rec);
  }

  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    offset: base.offset + consumedBytes,
    seenIds: Array.from(seen),
    records: base.records,
  };
}

/** Production helper: read a file slice from a byte offset. */
export function readFileFrom(path: string, offset: number): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const fd = fs.openSync(path, "r");
  try {
    const stat = fs.fstatSync(fd);
    const len = Math.max(0, stat.size - offset);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}

/** Production helper: enumerate transcript files under ~/.claude/projects. */
export function discoverTranscripts(projectsDir: string): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const out: string[] = [];
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return out; }
  for (const d of dirs) {
    const full = path.join(projectsDir, d);
    try {
      if (!fs.statSync(full).isDirectory()) { continue; }
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith(".jsonl")) { out.push(path.join(full, f)); }
      }
    } catch { /* skip unreadable dir */ }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- transcriptIndexer`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/transcriptIndexer.ts test/transcriptIndexer.test.ts
git commit -m "Add incremental file indexing with dedup"
```

---

## Task 10: Aggregation + cost (`aggregator.ts`)

**Files:**
- Create: `src/aggregator.ts`
- Test: `test/aggregator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/aggregator.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { costOf, summarize } from "../src/aggregator";
import { UsageRecord, PriceMap } from "../src/types";

const prices: PriceMap = {
  "claude-opus-4-8": { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
};

function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    requestId: "r", messageId: "m", model: "claude-opus-4-8", timestamp: "2026-06-11T10:00:00Z",
    project: "Proj", projectPath: "/p", sessionId: "s",
    tokens: { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 }, ...over,
  };
}

describe("costOf", () => {
  it("sums per-token costs", () => {
    const c = costOf({ input: 1000, output: 1000, cacheRead: 2000, cacheCreation: 400 }, prices["claude-opus-4-8"]);
    // 1000*5e-6 + 1000*25e-6 + 2000*5e-7 + 400*6.25e-6 = 0.005 + 0.025 + 0.001 + 0.0025 = 0.0335
    expect(c).toBeCloseTo(0.0335, 6);
  });
});

describe("summarize", () => {
  it("rolls up by project/model/day and totals with cost", () => {
    const recs = [
      rec({ project: "A", model: "claude-opus-4-8" }),
      rec({ project: "B", model: "claude-opus-4-8", timestamp: "2026-06-10T10:00:00Z" }),
    ];
    const s = summarize(recs, prices, new Date("2026-06-11T12:00:00Z"));
    expect(s.totals.totalTokens).toBe(4000);
    expect(s.byProject.map((p) => p.project).sort()).toEqual(["A", "B"]);
    expect(s.byModel[0].model).toBe("claude-opus-4-8");
    expect(s.byDay.map((d) => d.day)).toContain("2026-06-11");
    expect(s.today.totalTokens).toBe(2000);
    expect(s.totals.cost).toBeGreaterThan(0);
    expect(s.totals.costKnown).toBe(true);
  });

  it("flags costKnown=false when a model has no price", () => {
    const s = summarize([rec({ model: "mystery-model" })], prices, new Date("2026-06-11T12:00:00Z"));
    expect(s.totals.costKnown).toBe(false);
    expect(s.totals.cost).toBe(0);
  });

  it("builds sessions with message counts and time span", () => {
    const recs = [
      rec({ sessionId: "s1", timestamp: "2026-06-11T10:00:00Z" }),
      rec({ sessionId: "s1", requestId: "r2", timestamp: "2026-06-11T10:05:00Z" }),
    ];
    const s = summarize(recs, prices, new Date("2026-06-11T12:00:00Z"));
    expect(s.sessions[0]).toMatchObject({ sessionId: "s1", messages: 2, start: "2026-06-11T10:00:00Z", end: "2026-06-11T10:05:00Z" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- aggregator`
Expected: FAIL — cannot find `../src/aggregator`.

- [ ] **Step 3: Write `src/aggregator.ts`**

```ts
import {
  UsageRecord, PriceMap, ModelPrice, TokenCounts, CostedTotals,
  ProjectRollup, ModelRollup, DayRollup, SessionRollup, UsageSummary,
} from "./types";
import { priceForModel } from "./pricing";

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation,
});
const sumTokens = (t: TokenCounts): number => t.input + t.output + t.cacheRead + t.cacheCreation;

export function costOf(t: TokenCounts, p: ModelPrice): number {
  return t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheCreation * p.cacheWrite;
}

function dayOf(iso: string): string { return (iso || "").slice(0, 10); }

interface Acc { tokens: TokenCounts; cost: number; costKnown: boolean; }
const emptyAcc = (): Acc => ({ tokens: { ...ZERO }, cost: 0, costKnown: true });
function addRecord(acc: Acc, r: UsageRecord, prices: PriceMap): void {
  acc.tokens = addTokens(acc.tokens, r.tokens);
  const price = priceForModel(r.model, prices);
  if (price) { acc.cost += costOf(r.tokens, price); }
  else { acc.costKnown = false; }
}
function toTotals(acc: Acc): CostedTotals {
  return { tokens: acc.tokens, totalTokens: sumTokens(acc.tokens), cost: acc.cost, costKnown: acc.costKnown };
}

export function summarize(records: UsageRecord[], prices: PriceMap, now: Date): UsageSummary {
  const total = emptyAcc(), today = emptyAcc(), week = emptyAcc(), month = emptyAcc();
  const proj = new Map<string, Acc & { projectPath: string; lastActive: string }>();
  const model = new Map<string, Acc>();
  const day = new Map<string, Acc>();
  const sess = new Map<string, Acc & { project: string; start: string; end: string; messages: number }>();

  const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  const startWeek = startToday - 6 * 86400000;
  const startMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  for (const r of records) {
    addRecord(total, r, prices);
    const ts = Date.parse(r.timestamp);
    if (!Number.isNaN(ts)) {
      if (ts >= startToday) { addRecord(today, r, prices); }
      if (ts >= startWeek) { addRecord(week, r, prices); }
      if (ts >= startMonth) { addRecord(month, r, prices); }
    }
    if (!proj.has(r.project)) { proj.set(r.project, Object.assign(emptyAcc(), { projectPath: r.projectPath, lastActive: r.timestamp })); }
    const pa = proj.get(r.project)!; addRecord(pa, r, prices);
    if (r.timestamp > pa.lastActive) { pa.lastActive = r.timestamp; }

    if (!model.has(r.model)) { model.set(r.model, emptyAcc()); }
    addRecord(model.get(r.model)!, r, prices);

    const d = dayOf(r.timestamp);
    if (!day.has(d)) { day.set(d, emptyAcc()); }
    addRecord(day.get(d)!, r, prices);

    if (!sess.has(r.sessionId)) { sess.set(r.sessionId, Object.assign(emptyAcc(), { project: r.project, start: r.timestamp, end: r.timestamp, messages: 0 })); }
    const sa = sess.get(r.sessionId)!; addRecord(sa, r, prices); sa.messages += 1;
    if (r.timestamp < sa.start) { sa.start = r.timestamp; }
    if (r.timestamp > sa.end) { sa.end = r.timestamp; }
  }

  const byProject: ProjectRollup[] = [...proj.entries()]
    .map(([project, a]) => ({ project, projectPath: a.projectPath, lastActive: a.lastActive, ...toTotals(a) }))
    .sort((x, y) => y.cost - x.cost || y.totalTokens - x.totalTokens);
  const byModel: ModelRollup[] = [...model.entries()]
    .map(([m, a]) => ({ model: m, ...toTotals(a) })).sort((x, y) => y.cost - x.cost);
  const byDay: DayRollup[] = [...day.entries()]
    .map(([d, a]) => ({ day: d, ...toTotals(a) })).sort((x, y) => x.day.localeCompare(y.day));
  const sessions: SessionRollup[] = [...sess.entries()]
    .map(([sessionId, a]) => ({ sessionId, project: a.project, start: a.start, end: a.end, messages: a.messages, ...toTotals(a) }))
    .sort((x, y) => y.end.localeCompare(x.end));

  return { totals: toTotals(total), today: toTotals(today), week: toTotals(week), month: toTotals(month), byProject, byModel, byDay, sessions };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- aggregator`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/aggregator.ts test/aggregator.test.ts
git commit -m "Add usage aggregation and cost rollups"
```

---

## Task 11: Pure formatting helpers (`format.ts`)

**Files:**
- Create: `src/format.ts`
- Test: `test/format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/format.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { formatDuration, formatUsd, formatTokens, statusBarText, utilizationColor } from "../src/format";
import { QuotaData } from "../src/types";

function quota(fhUtil: number | null, sdUtil: number | null): QuotaData {
  return {
    fiveHour: fhUtil == null ? null : { utilization: fhUtil, resetsAt: "2026-06-11T20:00:00Z" },
    sevenDay: sdUtil == null ? null : { utilization: sdUtil, resetsAt: "2026-06-18T00:00:00Z" },
    sevenDaySonnet: null, sevenDayOpus: null, sevenDayOauthApps: null, extraUsage: null,
    fetchedAt: "2026-06-11T19:00:00Z",
  };
}

describe("formatDuration", () => {
  it("renders h/m", () => {
    expect(formatDuration(2 * 3600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(-5)).toBe("now");
  });
});

describe("formatUsd / formatTokens", () => {
  it("formats dollars", () => { expect(formatUsd(4.2)).toBe("$4.20"); expect(formatUsd(0)).toBe("$0.00"); });
  it("formats token counts", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(9400)).toBe("9.4K");
    expect(formatTokens(420)).toBe("420");
  });
});

describe("statusBarText", () => {
  const now = new Date("2026-06-11T17:46:00Z"); // 2h14m before 20:00 reset
  it("5h mode shows pct + countdown", () => {
    expect(statusBarText(quota(42, 70), "5h", now)).toBe("$(claude-icon) 42% · 2h 14m");
  });
  it("7d mode", () => {
    expect(statusBarText(quota(42, 70), "7d", now)).toContain("7d 70%");
  });
  it("both mode", () => {
    expect(statusBarText(quota(42, 70), "both", now)).toBe("$(claude-icon) 5h 42% · 7d 70%");
  });
});

describe("utilizationColor", () => {
  it("thresholds at 60/80", () => {
    expect(utilizationColor(quota(50, 0), "5h")).toBeUndefined();
    expect(utilizationColor(quota(65, 0), "5h")).toBe("statusBarItem.warningBackground");
    expect(utilizationColor(quota(85, 0), "5h")).toBe("statusBarItem.errorBackground");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit -- format`
Expected: FAIL — cannot find `../src/format`.

- [ ] **Step 3: Write `src/format.ts`**

```ts
import { QuotaData } from "./types";

export function formatDuration(ms: number): string {
  if (ms <= 0) { return "now"; }
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
export function formatUsd(v: number): string { return `$${v.toFixed(2)}`; }
export function formatTokens(n: number): string {
  if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(1)}M`; }
  if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
  return String(n);
}

function resetMs(resetsAt: string | null, now: Date): number {
  if (!resetsAt) { return 0; }
  return Date.parse(resetsAt) - now.getTime();
}

export type StatusMode = "5h" | "7d" | "both" | "off";
const ICON = "$(claude-icon)";

export function statusBarText(q: QuotaData | null, mode: StatusMode, now: Date): string {
  if (!q) { return `${ICON} —`; }
  const fh = q.fiveHour, sd = q.sevenDay;
  if (mode === "7d" && sd) { return `${ICON} 7d ${Math.round(sd.utilization)}% · ${formatDuration(resetMs(sd.resetsAt, now))}`; }
  if (mode === "both") {
    const a = fh ? `5h ${Math.round(fh.utilization)}%` : "5h —";
    const b = sd ? `7d ${Math.round(sd.utilization)}%` : "7d —";
    return `${ICON} ${a} · ${b}`;
  }
  if (fh) { return `${ICON} ${Math.round(fh.utilization)}% · ${formatDuration(resetMs(fh.resetsAt, now))}`; }
  return `${ICON} —`;
}

export function utilizationColor(q: QuotaData | null, colorFrom: "5h" | "7d" | "max"): string | undefined {
  if (!q) { return undefined; }
  const fh = q.fiveHour?.utilization ?? 0, sd = q.sevenDay?.utilization ?? 0;
  const u = colorFrom === "7d" ? sd : colorFrom === "max" ? Math.max(fh, sd) : fh;
  if (u >= 80) { return "statusBarItem.errorBackground"; }
  if (u >= 60) { return "statusBarItem.warningBackground"; }
  return undefined;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit -- format`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format.test.ts
git commit -m "Add pure formatting helpers"
```

---

## Task 12: Status bar manager (`statusBar.ts`)

**Files:**
- Create: `src/statusBar.ts`

This module touches `vscode`; its formatting logic already lives in the tested `format.ts`, so it stays thin.

- [ ] **Step 1: Write `src/statusBar.ts`**

```ts
import * as vscode from "vscode";
import { QuotaData, QuotaError } from "./types";
import { statusBarText, utilizationColor, formatDuration, StatusMode } from "./format";

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "claudeUsage.showDashboard";
  }

  update(quota: QuotaData | null, error: QuotaError | null): void {
    const cfg = vscode.workspace.getConfiguration("claudeUsage");
    const mode = cfg.get<StatusMode>("statusBar.mode", "5h");
    if (mode === "off") { this.item.hide(); return; }
    const colorFrom = cfg.get<"5h" | "7d" | "max">("statusBar.colorFrom", "5h");
    const now = new Date();

    if (!quota) {
      this.item.text = error?.kind === "no-token" ? "$(claude-icon) Log in to Claude Code" : "$(claude-icon) —";
    } else {
      this.item.text = statusBarText(quota, mode, now) + (error ? " $(warning)" : "");
    }
    const colorId = utilizationColor(quota, colorFrom);
    this.item.backgroundColor = colorId ? new vscode.ThemeColor(colorId) : undefined;
    this.item.tooltip = this.tooltip(quota, error, now);
    this.item.show();
  }

  private tooltip(q: QuotaData | null, error: QuotaError | null, now: Date): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown("**Claude Usage**\n\n");
    if (q) {
      const row = (label: string, b: { utilization: number; resetsAt: string | null } | null) =>
        b ? `- ${label}: ${Math.round(b.utilization)}% (resets in ${formatDuration(Date.parse(b.resetsAt ?? "") - now.getTime())})\n` : "";
      md.appendMarkdown(row("5-hour", q.fiveHour));
      md.appendMarkdown(row("7-day", q.sevenDay));
      md.appendMarkdown(row("7-day Opus", q.sevenDayOpus));
      md.appendMarkdown(row("7-day Sonnet", q.sevenDaySonnet));
    }
    if (error) { md.appendMarkdown(`\n_${error.message}_ (showing cached data)\n`); }
    md.appendMarkdown("\nClick to open the dashboard.");
    return md;
  }

  dispose(): void { this.item.dispose(); }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/statusBar.ts
git commit -m "Add status bar manager"
```

---

## Task 13: Tree provider (`treeProvider.ts`)

**Files:**
- Create: `src/treeProvider.ts`

The tree shows five fixed nodes; selecting one runs `claudeUsage.openSection` with the section id. Node descriptions show live numbers from the latest summary/quota.

- [ ] **Step 1: Write `src/treeProvider.ts`**

```ts
import * as vscode from "vscode";
import { QuotaData, UsageSummary } from "./types";
import { formatUsd, formatTokens } from "./format";

export type Section = "overview" | "projects" | "models" | "quota" | "sessions";

class SectionNode extends vscode.TreeItem {
  constructor(public section: Section, label: string, description: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.command = { command: "claudeUsage.openSection", title: "Open", arguments: [section] };
    this.iconPath = new vscode.ThemeIcon(
      section === "quota" ? "dashboard" : section === "sessions" ? "history" :
      section === "projects" ? "folder" : section === "models" ? "symbol-class" : "graph",
    );
  }
}

export class UsageTreeProvider implements vscode.TreeDataProvider<SectionNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private summary: UsageSummary | null = null;
  private quota: QuotaData | null = null;

  setData(summary: UsageSummary | null, quota: QuotaData | null): void {
    this.summary = summary; this.quota = quota; this._onDidChange.fire();
  }
  getTreeItem(e: SectionNode): vscode.TreeItem { return e; }
  getChildren(): SectionNode[] {
    const s = this.summary;
    const fh = this.quota?.fiveHour ? `${Math.round(this.quota.fiveHour.utilization)}%` : "—";
    return [
      new SectionNode("overview", "Overview", s ? `${formatUsd(s.totals.cost)} · ${formatTokens(s.totals.totalTokens)}` : ""),
      new SectionNode("projects", "By project", s ? `${s.byProject.length}` : ""),
      new SectionNode("models", "By model", s ? `${s.byModel.length}` : ""),
      new SectionNode("quota", "Quota", fh),
      new SectionNode("sessions", "Sessions", s ? `${s.sessions.length}` : ""),
    ];
  }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/treeProvider.ts
git commit -m "Add Activity Bar tree provider"
```

---

## Task 14: Webview assets (`media/`)

**Files:**
- Create: `media/dashboard.html`, `media/dashboard.css`, `media/dashboard.js`

> **Charting note:** v1 renders bars and the 30-day trend as hand-rolled inline SVG/CSS in `dashboard.js` — no chart-lib dependency, which keeps the webview CSP simple. All chart drawing is isolated in the `charts` object so a library (uPlot/Chart.js) can replace it later without touching the render logic.

The webview receives `{ type: "state", summary, quota, error, section, stale }` via `postMessage` and posts back `{ type: "refresh" }` and `{ type: "navigate", section }`.

- [ ] **Step 1: Create `media/dashboard.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src {{cspSource}} 'unsafe-inline'; script-src 'nonce-{{nonce}}';" />
  <link rel="stylesheet" href="{{cssUri}}" />
  <title>Claude Usage</title>
</head>
<body>
  <header>
    <div class="tabs" id="tabs"></div>
    <button id="refresh" title="Refresh">↻</button>
  </header>
  <div id="banner" class="banner hidden"></div>
  <main id="view"></main>
  <footer id="footer"></footer>
  <script nonce="{{nonce}}" src="{{jsUri}}"></script>
</body>
</html>
```

- [ ] **Step 2: Create `media/dashboard.css`**

```css
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0 14px 20px; }
header { display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; background: var(--vscode-editor-background); padding: 10px 0; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.tab { padding: 4px 10px; border-radius: 5px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font-size: 12px; }
.tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
#refresh { background: none; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-foreground); border-radius: 5px; cursor: pointer; padding: 2px 8px; }
.banner { padding: 6px 10px; border-radius: 5px; background: var(--vscode-inputValidation-warningBackground); margin-bottom: 10px; font-size: 12px; }
.hidden { display: none; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
.card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 7px; padding: 10px; }
.card .l { font-size: 10px; text-transform: uppercase; letter-spacing: .5px; opacity: .7; }
.card .v { font-size: 20px; font-weight: 600; margin-top: 3px; }
.card .d { font-size: 11px; opacity: .7; }
.panel { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 7px; padding: 11px; margin-bottom: 12px; }
.panel h3 { margin: 0 0 9px; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; opacity: .8; }
.row { display: flex; align-items: center; gap: 8px; margin: 5px 0; font-size: 12px; }
.row .nm { width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .bar { flex: 1; height: 8px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 4px; overflow: hidden; }
.row .bar > i { display: block; height: 100%; background: var(--vscode-charts-blue, #4ea1ff); }
.row .vv { width: 70px; text-align: right; opacity: .85; }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
th { opacity: .7; font-weight: 500; }
footer { font-size: 11px; opacity: .6; margin-top: 8px; }
svg { display: block; width: 100%; height: 90px; }
```

- [ ] **Step 3: Create `media/dashboard.js`**

```js
const vscode = acquireVsCodeApi();
let state = { summary: null, quota: null, error: null, section: "overview", stale: false };

const SECTIONS = [
  ["overview", "Overview"], ["projects", "By project"], ["models", "By model"],
  ["quota", "Quota"], ["sessions", "Sessions"],
];
const usd = (v) => `$${(v ?? 0).toFixed(2)}`;
const tok = (n) => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"K" : String(n ?? 0);
const pct = (v) => `${Math.round(v ?? 0)}%`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

const charts = {
  barRows(items, label, value, max) {
    const m = max || Math.max(1, ...items.map(value));
    return items.map((it) =>
      `<div class="row"><span class="nm">${esc(label(it))}</span><span class="bar"><i style="width:${Math.min(100, value(it)/m*100)}%"></i></span><span class="vv">${esc(usd(value(it)))}</span></div>`
    ).join("");
  },
  line(days) {
    if (!days.length) { return "<svg></svg>"; }
    const w = 600, h = 90, max = Math.max(1, ...days.map((d) => d.cost));
    const step = days.length > 1 ? w / (days.length - 1) : 0;
    const pts = days.map((d, i) => `${(i*step).toFixed(1)},${(h - d.cost/max*(h-8) - 4).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="var(--vscode-charts-blue,#4ea1ff)" stroke-width="2" points="${pts}"/></svg>`;
  },
  quotaBar(label, b) {
    if (!b) { return ""; }
    const u = b.utilization, color = u >= 80 ? "#ff6b6b" : u >= 60 ? "#ffd93d" : "#51cf66";
    const resets = b.resetsAt ? ` · resets ${new Date(b.resetsAt).toLocaleString()}` : "";
    return `<div class="row"><span class="nm">${esc(label)}</span><span class="bar"><i style="width:${Math.min(100,u)}%;background:${color}"></i></span><span class="vv">${pct(u)}</span></div><div style="font-size:10px;opacity:.6;margin:-2px 0 6px 138px">${esc(resets)}</div>`;
  },
};

function render() {
  document.getElementById("tabs").innerHTML = SECTIONS.map(([id, lbl]) =>
    `<span class="tab ${id===state.section?"active":""}" data-s="${id}">${lbl}</span>`).join("");
  document.querySelectorAll(".tab").forEach((el) =>
    el.addEventListener("click", () => vscode.postMessage({ type: "navigate", section: el.dataset.s })));

  const banner = document.getElementById("banner");
  if (state.error) { banner.classList.remove("hidden"); banner.textContent = state.error + (state.stale ? " — showing cached data" : ""); }
  else { banner.classList.add("hidden"); }

  document.getElementById("view").innerHTML = renderSection();
  const s = state.summary;
  document.getElementById("footer").textContent =
    (s ? `Updated ${new Date(state.quota?.fetchedAt || Date.now()).toLocaleTimeString()} · ` : "") +
    "Quota via api.anthropic.com/api/oauth/usage · cost computed locally";
}

function renderSection() {
  const s = state.summary, q = state.quota;
  switch (state.section) {
    case "quota":
      if (!q) { return `<div class="panel">No quota data yet.</div>`; }
      return `<div class="panel"><h3>Quota windows</h3>
        ${charts.quotaBar("5-Hour", q.fiveHour)}${charts.quotaBar("7-Day", q.sevenDay)}
        ${charts.quotaBar("7-Day Sonnet", q.sevenDaySonnet)}${charts.quotaBar("7-Day Opus", q.sevenDayOpus)}
        ${charts.quotaBar("7-Day OAuth Apps", q.sevenDayOauthApps)}</div>
        ${q.extraUsage ? `<div class="panel"><h3>Extra usage</h3><div class="row"><span class="nm">Spent / limit</span><span class="vv">${usd((q.extraUsage.usedCredits||0)/100)} / ${usd((q.extraUsage.monthlyLimit||0)/100)}</span></div></div>` : ""}`;
    case "projects":
      if (!s) { return empty(); }
      return `<div class="panel"><h3>By project</h3><table><tr><th>Project</th><th>Tokens</th><th>Cost</th><th>Last active</th></tr>
        ${s.byProject.map((p) => `<tr><td>${esc(p.project)}</td><td>${tok(p.totalTokens)}</td><td>${p.costKnown?usd(p.cost):"n/a"}</td><td>${esc((p.lastActive||"").slice(0,10))}</td></tr>`).join("")}</table></div>`;
    case "models":
      if (!s) { return empty(); }
      return `<div class="panel"><h3>By model</h3>${charts.barRows(s.byModel, (m)=>m.model, (m)=>m.cost)}</div>`;
    case "sessions":
      if (!s) { return empty(); }
      return `<div class="panel"><h3>Sessions</h3><table><tr><th>Session</th><th>Project</th><th>Msgs</th><th>Tokens</th><th>Cost</th></tr>
        ${s.sessions.map((x) => `<tr><td>${esc(x.sessionId.slice(0,8))}</td><td>${esc(x.project)}</td><td>${x.messages}</td><td>${tok(x.totalTokens)}</td><td>${x.costKnown?usd(x.cost):"n/a"}</td></tr>`).join("")}</table></div>`;
    default: // overview
      if (!s) { return empty(); }
      const fh = q?.fiveHour;
      return `<div class="cards">
          <div class="card"><div class="l">Today</div><div class="v">${usd(s.today.cost)}</div><div class="d">${tok(s.today.totalTokens)} tok</div></div>
          <div class="card"><div class="l">This week</div><div class="v">${usd(s.week.cost)}</div><div class="d">${tok(s.week.totalTokens)} tok</div></div>
          <div class="card"><div class="l">This month</div><div class="v">${usd(s.month.cost)}</div><div class="d">${tok(s.month.totalTokens)} tok</div></div>
          <div class="card"><div class="l">5h quota</div><div class="v">${fh?pct(fh.utilization):"—"}</div><div class="d">${fh&&fh.resetsAt?("resets "+new Date(fh.resetsAt).toLocaleTimeString()):""}</div></div>
        </div>
        <div class="panel"><h3>Cost · last 30 days</h3>${charts.line(s.byDay.slice(-30))}</div>
        <div class="panel"><h3>Top projects</h3>${charts.barRows(s.byProject.slice(0,5), (p)=>p.project, (p)=>p.cost)}</div>
        <div class="panel"><h3>By model</h3>${charts.barRows(s.byModel, (m)=>m.model, (m)=>m.cost)}</div>`;
  }
}
function empty() { return `<div class="panel">No local usage found yet. Use Claude Code, then refresh.</div>`; }

document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
window.addEventListener("message", (e) => { if (e.data?.type === "state") { state = e.data; render(); } });
render();
```

- [ ] **Step 4: Commit**

```bash
git add media/dashboard.html media/dashboard.css media/dashboard.js
git commit -m "Add webview dashboard assets"
```

---

## Task 15: Dashboard webview controller (`dashboard/panel.ts`)

**Files:**
- Create: `src/dashboard/panel.ts`

- [ ] **Step 1: Write `src/dashboard/panel.ts`**

```ts
import * as vscode from "vscode";
import { QuotaData, QuotaError, UsageSummary } from "../types";
import { Section } from "../treeProvider";

function nonce(): string {
  let s = ""; const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}

export interface DashboardState {
  summary: UsageSummary | null;
  quota: QuotaData | null;
  error: QuotaError | null;
  section: Section;
  stale: boolean;
}

export class DashboardPanel {
  private panel: vscode.WebviewPanel | undefined;
  private section: Section = "overview";
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onRefresh: () => void,
    private readonly getState: () => Omit<DashboardState, "section">,
  ) {}

  show(section?: Section): void {
    if (section) { this.section = section; }
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); this.post(); return; }
    this.panel = vscode.window.createWebviewPanel("claudeUsage", "Claude Usage", vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    });
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => { this.panel = undefined; });
    this.panel.webview.onDidReceiveMessage((m) => {
      if (m?.type === "refresh") { this.onRefresh(); }
      else if (m?.type === "navigate") { this.section = m.section; this.post(); }
    });
    this.post();
  }

  update(): void { if (this.panel) { this.post(); } }

  private post(): void {
    if (!this.panel) { return; }
    const s = this.getState();
    this.panel.webview.postMessage({ type: "state", section: this.section, ...s });
  }

  private html(webview: vscode.Webview): string {
    const fs = require("node:fs") as typeof import("node:fs");
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f)).toString();
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, "media", "dashboard.html").fsPath;
    const n = nonce();
    return fs.readFileSync(htmlPath, "utf8")
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, n)
      .replace(/{{cssUri}}/g, uri("dashboard.css"))
      .replace(/{{jsUri}}/g, uri("dashboard.js"));
  }

  dispose(): void { this.panel?.dispose(); }
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/panel.ts
git commit -m "Add dashboard webview controller"
```

---

## Task 16: Extension activation + orchestration (`extension.ts`)

**Files:**
- Modify: `src/extension.ts` (replace the stub from Task 1)

Wires everything: builds the data store (quota poll + transcript index), caches in `globalState`/`globalStorage`, registers commands, watches transcripts, drives the three UI surfaces.

- [ ] **Step 1: Write `src/extension.ts`**

```ts
import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import { QuotaData, QuotaError, UsageSummary, PriceMap, FileIndex } from "./types";
import { resolveToken, defaultCredentialDeps } from "./credentials";
import { fetchQuota, defaultHttpGet } from "./quotaClient";
import { loadPrices, defaultFetcher } from "./pricing";
import { discoverTranscripts, indexFile, readFileFrom, FileStat } from "./transcriptIndexer";
import { summarize } from "./aggregator";
import { StatusBarManager } from "./statusBar";
import { UsageTreeProvider, Section } from "./treeProvider";
import { DashboardPanel } from "./dashboard/panel";

const QUOTA_CACHE = "claudeUsage.quotaCache";
const PRICE_CACHE = "claudeUsage.priceCache";
const FILE_INDEX = "claudeUsage.fileIndex";

export function activate(context: vscode.ExtensionContext): void {
  const projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

  const statusBar = new StatusBarManager();
  const tree = new UsageTreeProvider();
  context.subscriptions.push(statusBar, vscode.window.registerTreeDataProvider("claudeUsage.tree", tree));

  let quota: QuotaData | null = context.globalState.get<QuotaData>(QUOTA_CACHE) ?? null;
  let quotaError: QuotaError | null = null;
  let summary: UsageSummary | null = null;
  let prices: PriceMap = context.globalState.get<PriceMap>(PRICE_CACHE) ?? {};
  let fileIndex: FileIndex = context.globalState.get<FileIndex>(FILE_INDEX) ?? {};

  const dashboard = new DashboardPanel(
    context.extensionUri,
    () => { void refreshAll(true); },
    () => ({ summary, quota, error: quotaError, stale: quotaError != null && quota != null }),
  );
  context.subscriptions.push(dashboard);

  function pushUi(): void {
    statusBar.update(quota, quotaError);
    tree.setData(summary, quota);
    dashboard.update();
  }

  async function refreshQuota(): Promise<void> {
    const creds = resolveToken(defaultCredentialDeps());
    const res = await fetchQuota({ token: creds.token }, defaultHttpGet(), () => new Date().toISOString());
    if (res.ok) {
      quota = res.data; quotaError = null;
      await context.globalState.update(QUOTA_CACHE, quota);
    } else {
      quotaError = res.error; // keep last-good `quota` for the stale badge
    }
  }

  async function refreshPrices(): Promise<void> {
    const url = vscode.workspace.getConfiguration("claudeUsage")
      .get<string>("pricingUrl", "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json");
    const r = await loadPrices(url, defaultFetcher(), Object.keys(prices).length ? prices : null);
    prices = r.prices;
    if (!r.fromCache) { await context.globalState.update(PRICE_CACHE, prices); }
  }

  function rebuildSummary(): void {
    const all = Object.values(fileIndex).flatMap((e) => e.records);
    summary = summarize(all, prices, new Date());
  }

  async function refreshTranscripts(): Promise<void> {
    for (const file of discoverTranscripts(projectsDir)) {
      let stat: FileStat;
      try { const s = fs.statSync(file); stat = { size: s.size, mtimeMs: s.mtimeMs }; } catch { continue; }
      const prev = fileIndex[file] ?? null;
      if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) { continue; }
      fileIndex[file] = indexFile(prev, stat, (off) => readFileFrom(file, off));
    }
    await context.globalState.update(FILE_INDEX, fileIndex);
    rebuildSummary();
  }

  async function refreshAll(force = false): Promise<void> {
    await Promise.allSettled([refreshQuota(), refreshTranscripts()]);
    pushUi();
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeUsage.refresh", () => refreshAll(true)),
    vscode.commands.registerCommand("claudeUsage.showDashboard", () => dashboard.show()),
    vscode.commands.registerCommand("claudeUsage.openSection", (section: Section) => dashboard.show(section)),
  );

  // Transcript file watcher (debounced)
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(projectsDir, "**/*.jsonl"));
  let debounce: NodeJS.Timeout | undefined;
  const onChange = () => {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(() => { void refreshTranscripts().then(pushUi); }, 1500);
  };
  watcher.onDidChange(onChange); watcher.onDidCreate(onChange); watcher.onDidDelete(onChange);
  context.subscriptions.push(watcher);

  // Quota polling: every N seconds while the window is focused, with simple backoff on error.
  let pollTimer: NodeJS.Timeout | undefined;
  let backoffSteps = 0;
  const BACKOFF = [4 * 60_000, 8 * 60_000, 16 * 60_000];
  function scheduleQuotaPoll(): void {
    if (pollTimer) { clearTimeout(pollTimer); }
    const base = vscode.workspace.getConfiguration("claudeUsage").get<number>("pollIntervalSeconds", 120) * 1000;
    const delay = quotaError ? BACKOFF[Math.min(backoffSteps, BACKOFF.length - 1)] : base;
    pollTimer = setTimeout(async () => {
      if (vscode.window.state.focused) {
        await refreshQuota();
        backoffSteps = quotaError ? backoffSteps + 1 : 0;
        pushUi();
      }
      scheduleQuotaPoll();
    }, delay);
  }
  context.subscriptions.push({ dispose: () => pollTimer && clearTimeout(pollTimer) });

  // Initial load
  pushUi();
  void refreshPrices().then(() => refreshAll()).then(scheduleQuotaPoll);
}

export function deactivate(): void { /* subscriptions disposed by VSCode */ }
```

- [ ] **Step 2: Build the bundle**

Run: `npm run build`
Expected: esbuild writes `out/extension.js`, no errors.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full unit suite (no regressions)**

Run: `npm run test:unit`
Expected: all suites PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension.ts
git commit -m "Wire activation: quota poll, transcript indexing, UI surfaces"
```

---

## Task 17: Integration smoke test (`test/integration/`)

**Files:**
- Create: `.vscode-test.mjs`, `test/integration/activation.test.ts`

Verifies the packaged extension activates and registers its commands inside a real VSCode host.

- [ ] **Step 1: Create `.vscode-test.mjs`**

```js
import { defineConfig } from "@vscode/test-cli";
export default defineConfig({
  files: "out-test/integration/**/*.test.js",
  version: "stable",
});
```

- [ ] **Step 2: Add a compile step for integration tests to `package.json` scripts**

Modify `package.json` `scripts` — add:
```json
"compile:test": "tsc -p tsconfig.json --outDir out-test",
"test:integration": "npm run build && npm run compile:test && vscode-test"
```

- [ ] **Step 3: Write `test/integration/activation.test.ts`**

```ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("activation", () => {
  test("registers commands", async () => {
    const ext = vscode.extensions.getExtension("nuvoladigital.claude-code-usage-tracker");
    assert.ok(ext, "extension present");
    await ext!.activate();
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes("claudeUsage.refresh"));
    assert.ok(cmds.includes("claudeUsage.showDashboard"));
    assert.ok(cmds.includes("claudeUsage.openSection"));
  });
});
```

- [ ] **Step 4: Run the integration test**

Run: `npm run test:integration`
Expected: downloads a VSCode build (first run), launches the host, test passes (`1 passing`). If the sandbox cannot launch Electron, note it and run this manually — the unit suite remains the gate.

- [ ] **Step 5: Commit**

```bash
git add .vscode-test.mjs package.json test/integration/activation.test.ts
git commit -m "Add activation integration smoke test"
```

---

## Task 18: README + packaging

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

````markdown
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
````

- [ ] **Step 2: Package the extension**

Run: `npm run package`
Expected: `@vscode/vsce` produces `claude-code-usage-tracker-0.1.0.vsix` (it may warn about a missing LICENSE/repository — acceptable for v1).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Add README and packaging"
```

---

## Task 19: Manual verification in the Extension Development Host

**Files:** none (manual)

- [ ] **Step 1: Launch**

In VSCode, press **F5** (Run Extension). A second VSCode window opens with the extension loaded.

- [ ] **Step 2: Verify surfaces**
- Status bar shows `☁ NN% · …` (or "Log in to Claude Code" if no token).
- The Claude Usage icon appears in the Activity Bar; the tree lists Overview / By project / By model / Quota / Sessions with live numbers.
- Clicking a node opens the dashboard at that section; the Quota view shows the official windows; Overview/By project/By model/Sessions show computed cost from your real transcripts.
- Run **Claude Usage: Refresh** — values update.

- [ ] **Step 3: Record results**

Note anything off (e.g., a model missing from pricing shows cost "n/a") and file follow-ups. No commit unless fixes are made.

---

## Self-review (completed during planning)

- **Spec coverage:** token resolution (Task 3) ✓; quota fetch+parse+errors (Tasks 4–5) ✓; pricing fetch/cache/lookup (Tasks 6–7) ✓; transcript dedup + incremental parse (Tasks 8–9) ✓; aggregation/cost rollups (Task 10) ✓; status bar (Tasks 11–12) ✓; tree (Task 13) ✓; webview dashboard with all 5 views (Tasks 14–15) ✓; activation/polling/watcher/caching/settings/commands (Task 16) ✓; testing — unit throughout + integration smoke (Task 17) ✓; packaging + privacy/caveats README (Task 18) ✓. Non-goals respected (no Chrome ext, no worker threads, no token refresh).
- **Placeholder scan:** every code step contains full code; no TODO/TBD.
- **Type consistency:** `QuotaData`/`QuotaResult`/`UsageRecord`/`UsageSummary`/`PriceMap`/`ModelPrice`/`FileIndexEntry` defined once in Task 2 and used unchanged; `Section` defined in Task 13 and imported by Tasks 15–16; `statusBarText`/`utilizationColor`/`StatusMode` defined in Task 11 and used in Task 12; `indexFile`/`FileStat` defined in Task 9 and used in Task 16; `summarize`/`costOf` defined in Task 10 and used in Task 16.
- **Deviation noted:** webview charts are hand-rolled SVG (no chart-lib dependency) for v1 — isolated in `charts` so a library can replace it later (Task 14 note).
````
