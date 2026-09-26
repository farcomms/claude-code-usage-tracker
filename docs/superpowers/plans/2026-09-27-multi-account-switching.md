# Multi-Account Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save every Claude account the user logs into, switch Claude Code's real login between saved accounts from VS Code, and show the active account on the status bar.

**Architecture:** New plain-logic modules in `src/accounts/`. They never import `vscode`; file, Keychain, HTTP and clock access are passed in as a `deps` object, the same pattern `credentials.ts` uses. That lets Vitest test them against in-memory fakes. A switch re-saves the current login, renews the target's token if it's about to expire, writes the target's credentials and then its `oauthAccount` block, reads everything back to confirm, and rolls back to the previous account if any step fails. The `vscode`-facing pieces are a new status-bar item, three commands and small label changes. They're wired in `extension.ts`.

**Tech Stack:** TypeScript, VS Code Extension API (`engines.vscode` ^1.90: `context.secrets`, `QuickPickItemKind.Separator`), Node 20 global `fetch`, esbuild, Vitest, `@vscode/test-cli`.

**Spec:** `docs/superpowers/specs/2026-09-27-multi-account-switching-design.md`. Read it first; section numbers below refer to it.

## Global Constraints

- Branch: `feat/statusbar-7d-percent`. Commit after every task. Commit messages have **no** `Co-Authored-By` trailer (user preference).
- No new runtime dependencies. Node built-ins and the VS Code API only.
- Tokens (`accessToken`, `refreshToken`, raw credentials) are never logged, printed, shown in the UI, or written to `globalState`, settings or any file except Claude Code's own credential location. Saved copies live only in `context.secrets`.
- `accountUuid` (from `oauthAccount`) is the identity of an account everywhere.
- Credentials and `oauthAccount` blocks are stored and written back **verbatim**. Only the fields we read are typed; unknown keys must pass through untouched.
- Token endpoint `https://platform.claude.com/v1/oauth/token`, client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, request body JSON `{ grant_type: "refresh_token", refresh_token, client_id, scope }` (read from Claude Code 2.1.178; confirmed by Task 1).
- Renewal happens only when `expiresAt` is missing or within **5 minutes** (`300000` ms). The **active** account's token is never renewed.
- Status-bar priorities: account item **101**, quota badge **100** (account shows to the left).
- All commands have `"category": "Claude Usage"` and titles without the `Claude Usage: ` prefix.
- New setting `claudeUsage.account.display`: `"email" | "name" | "off"`, default `"email"`.
- `npm run lint` is already broken on `main` (the ESLint config has no TypeScript parser) and is not a gate. The gates are `npm run test:unit`, `npx tsc --noEmit -p tsconfig.json` and `npm run build`.
- Version bump to `0.3.0` happens **last** (Task 10), per the user.

## Review Focus

1. **Claude Code rewrites `~/.claude.json` constantly.** A read-modify-write that reuses an earlier copy of the file would silently drop Claude Code's own changes. Expected: `writeOauthAccount` re-reads the file at the moment it writes and keeps every key it didn't set. Pinned in Task 3 ("re-reads the file at write time").
2. **A running Claude Code session writes the old account back after a switch** (it renews its in-memory token). Expected: the UI simply shows that account again, its fresh tokens are saved, and the other account's saved copy is untouched. Pinned in Task 6 ("a session writing A back after a switch").
3. **The macOS Keychain write "succeeds" but changes nothing** (`security -i` can exit 0 when its inner command fails). Expected: the read-back check catches it and the previous account is restored. Pinned in Task 6 ("silent Keychain no-op").
4. **Login detected half-written during Add Account**: Claude Code updates `oauthAccount` and the credentials at slightly different moments. Expected: the new account is saved only once its account ID *and* its access token both differ from the starting login, so B's identity is never paired with A's tokens. Pinned in Task 7 ("ignores a half-written login").
5. **Saved account with odd data**: no email (only a display name, or nothing), or a saved login with no tokens at all. Expected: the label falls back to display name, then a short ID prefix; switching to a token-less login offers "Log in again" and doesn't crash. Pinned in Task 5 ("falls back when email is missing") and Task 6 ("saved login with no tokens").

---

## File structure

```
src/
├─ types.ts                    # MODIFY: account types; QuotaData.accountUuid
├─ credentials.ts              # MODIFY: export credentialFilePaths
├─ format.ts                   # MODIFY: accountLabel, accountDetail, formatAgo, quotaForAccount
├─ accountStatusBar.ts         # CREATE: the account status-bar item (vscode)
├─ treeProvider.ts             # MODIFY: "Quota — <email>" label
├─ dashboard/panel.ts          # MODIFY: DashboardState.account
├─ extension.ts                # MODIFY: wiring, commands, auto-save on refresh
└─ accounts/
   ├─ claudeLogin.ts           # CREATE: read/write Claude Code's current login
   ├─ tokenRefresh.ts          # CREATE: renew a saved account's token
   ├─ accountStore.ts          # CREATE: saved accounts (SecretStorage + index)
   ├─ switcher.ts              # CREATE: syncActive, switchTo, waitForNewLogin
   └─ menu.ts                  # CREATE: switcher QuickPick items (pure)
media/dashboard.js             # MODIFY: quota heading shows account
package.json                   # MODIFY: commands, category, setting, version (Task 10)
README.md                      # MODIFY: privacy, caveats, settings
.vscodeignore                  # MODIFY: exclude scripts/**
scripts/verify-account-switching.mjs   # CREATE: manual pre-flight check (Task 1)
test/
├─ helpers/fakeLogin.ts        # CREATE: in-memory LoginDeps
├─ helpers/memoryStores.ts     # CREATE: in-memory SecretStore / KeyValueStore
├─ claudeLogin.test.ts         # CREATE
├─ tokenRefresh.test.ts        # CREATE
├─ accountStore.test.ts        # CREATE
├─ switcher.test.ts            # CREATE
├─ waitForNewLogin.test.ts     # CREATE
├─ menu.test.ts                # CREATE
├─ format.test.ts              # MODIFY
└─ integration/activation.test.ts   # MODIFY
```

---

### Task 1: Pre-flight check with two real accounts (gate)

This settles the spec's §2 assumptions 1–4 before anything else is built. **The user runs it**; the implementer prepares the script, commits it, hands the user the instructions below, and **stops until the user reports the result.**

**Files:**
- Create: `scripts/verify-account-switching.mjs`
- Modify: `.vscodeignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a yes/no answer on whether a saved refresh token survives logging in as another account, plus confirmation of the token endpoint, the field names, and whether `claude /login` works as a startup argument. Record the answers in the task's final message; Task 9's `LOGIN_COMMAND` depends on the last one.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// Manual pre-flight for multi-account switching (spec §2). Never prints a token.
//
//   1. While logged in as account A:   node scripts/verify-account-switching.mjs snapshot
//   2. Log in as account B:            claude /login
//   3. Then:                           node scripts/verify-account-switching.mjs check
//
// `check` uses up A's snapshotted refresh token (renewal rotates it), so log in
// as A again normally afterwards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SNAP = path.join(os.homedir(), ".claude-usage-verify.json");
const envDir = process.env.CLAUDE_CONFIG_DIR;
const credFiles = [...(envDir ? [path.join(envDir, ".credentials.json")] : []), path.join(os.homedir(), ".claude", ".credentials.json")];
const claudeJson = envDir ? path.join(envDir, ".claude.json") : path.join(os.homedir(), ".claude.json");

function readCreds() {
  for (const p of credFiles) {
    try { return { where: `file ${p}`, json: JSON.parse(fs.readFileSync(p, "utf8")) }; } catch { /* next */ }
  }
  if (process.platform === "darwin") {
    try {
      const raw = cp.execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      return { where: "macOS Keychain", json: JSON.parse(raw) };
    } catch { /* none */ }
  }
  return null;
}
const tokensOf = (c) => c?.claudeAiOauth ?? (c?.accessToken ? c : null);
function account() {
  try { return JSON.parse(fs.readFileSync(claudeJson, "utf8")).oauthAccount ?? null; } catch { return null; }
}

const cmd = process.argv[2];
if (cmd === "snapshot") {
  const c = readCreds(), t = tokensOf(c?.json), a = account();
  if (!t?.refreshToken || !a?.accountUuid) { console.log("No complete Claude Code login found. Log in with `claude` first."); process.exit(1); }
  fs.writeFileSync(SNAP, JSON.stringify({ uuid: a.accountUuid, email: a.emailAddress, refreshToken: t.refreshToken, scopes: t.scopes ?? [] }), { mode: 0o600 });
  console.log(`Saved a snapshot of ${a.emailAddress ?? a.accountUuid}.`);
  console.log(`Credentials found in: ${c.where}; shape: ${c.json.claudeAiOauth ? "{ claudeAiOauth: {...} }" : "flat"}`);
  console.log(`Credential fields: ${Object.keys(t).sort().join(", ")}`);
  console.log(`oauthAccount fields: ${Object.keys(a).sort().join(", ")}`);
  console.log("\nNow run `claude /login`, log in as a DIFFERENT account, then run this script with `check`.");
} else if (cmd === "check") {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(SNAP, "utf8")); } catch { console.log("No snapshot. Run `snapshot` first."); process.exit(1); }
  const now = account();
  if (!now || now.accountUuid === snap.uuid) { console.log(`Still logged in as ${snap.email}. Log in as a different account first.`); process.exit(1); }
  const body = { grant_type: "refresh_token", refresh_token: snap.refreshToken, client_id: CLIENT_ID };
  if (snap.scopes.length) { body.scope = snap.scopes.join(" "); }
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  fs.unlinkSync(SNAP);
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (res.status === 200 && typeof j?.access_token === "string") {
    console.log(`YES: ${snap.email}'s saved refresh token still works after logging in as ${now.emailAddress ?? now.accountUuid}.`);
    console.log(`Response fields: ${Object.keys(j).sort().join(", ")}; expires_in = ${j.expires_in}s; new refresh_token returned: ${typeof j.refresh_token === "string"}`);
    console.log(`\nLog in as ${snap.email} again with \`claude /login\` when you want it back (this check used up its snapshotted token).`);
  } else {
    console.log(`NO: token endpoint answered HTTP ${res.status}${j?.error ? ` (${j.error})` : ""}.`);
    console.log(j?.error === "invalid_grant"
      ? "The saved refresh token was revoked by logging in as another account."
      : "This may be an endpoint/request problem rather than revocation; report this output.");
  }
} else {
  console.log("Usage: node scripts/verify-account-switching.mjs snapshot|check");
}
```

- [ ] **Step 2: Keep the script out of the packaged extension**

Append to `.vscodeignore`:

```
scripts/**
```

- [ ] **Step 3: Check it runs**

Run: `node scripts/verify-account-switching.mjs`
Expected: `Usage: node scripts/verify-account-switching.mjs snapshot|check`

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-account-switching.mjs .vscodeignore
git commit -m "Add manual pre-flight check for multi-account switching"
```

- [ ] **Step 5: Hand over to the user and STOP**

Ask the user to run, in their own terminal:
1. While logged in as account A: `node scripts/verify-account-switching.mjs snapshot`, and share the output (it prints field names only).
2. `claude /login`. Does it go straight into the login flow when given as an argument? Log in as account B.
3. `node scripts/verify-account-switching.mjs check`, and share the output.
4. Log back in as whichever account they want active.

Continue to Task 2 **only if** step 3 printed `YES`. Then:
- Update `LOGIN_COMMAND` in Task 9 if `claude /login` did not work as an argument (use `claude`, and add the "Type /login in the terminal" notice described there).
- If the field names differ from spec §2, fix the types in Task 2 before writing them.

If it printed `NO` with `invalid_grant`, stop and return to the user: the design needs rethinking.

---

### Task 2: Account types and reading Claude Code's current login

**Files:**
- Modify: `src/types.ts` (append; add one field to `QuotaData`)
- Modify: `src/credentials.ts:19-25` (export `credentialFilePaths`)
- Create: `src/accounts/claudeLogin.ts`
- Create: `test/helpers/fakeLogin.ts`
- Test: `test/claudeLogin.test.ts`

**Interfaces:**
- Consumes: `credentialFilePaths(d: Pick<CredentialDeps, "env" | "homedir">): string[]` from `src/credentials.ts`.
- Produces (later tasks rely on these exact names):
  - types `OauthTokens`, `OauthAccount`, `CredentialSource`, `LiveLogin`, `SavedAccountSecret`, `SavedAccountMeta`; `QuotaData.accountUuid?: string | null`
  - `KEYCHAIN_SERVICE`, `interface LoginDeps`, `claudeJsonPath(d)`, `oauthOf(raw): OauthTokens | null`, `withOauth(raw, tokens): string`, `readLogin(d): LiveLogin | null`, `defaultSource(d): CredentialSource`
  - test helpers `fakeLogin(opts)`, `FakeLogin`, `creds(token, extra?)`, `claudeJson(account, other?)`, `CLAUDE_JSON`, `CRED_FILE`

- [ ] **Step 1: Add the types**

Append to `src/types.ts`:

```ts
// ---------- Accounts ----------
/** The token-bearing object in Claude Code's credentials JSON. Unknown keys pass through. */
export interface OauthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;          // epoch ms
  scopes?: string[];
  subscriptionType?: string | null;
  [k: string]: unknown;
}
/** `oauthAccount` from Claude Code's .claude.json. Unknown keys pass through. */
export interface OauthAccount {
  accountUuid: string;
  emailAddress?: string;
  displayName?: string;
  organizationName?: string;
  [k: string]: unknown;
}
export type CredentialSource = { kind: "file"; path: string } | { kind: "keychain"; account: string };
/** Claude Code's current login, exactly as stored. */
export interface LiveLogin {
  credentialsRaw: string;
  oauthAccount: OauthAccount;
  source: CredentialSource;
}
/** What SecretStorage holds per saved account. */
export interface SavedAccountSecret {
  credentialsRaw: string;
  oauthAccount: OauthAccount;
}
/** Token-free index entry kept in globalState. */
export interface SavedAccountMeta {
  accountUuid: string;
  email: string;               // falls back to displayName, then a uuid prefix
  displayName: string | null;
  organizationName: string | null;
  subscriptionType: string | null;
  lastUsedAt: string | null;   // ISO
}
```

In `QuotaData`, after `fetchedAt: string;          // ISO` add:

```ts
  accountUuid?: string | null; // account the snapshot was fetched for (absent in pre-0.3.0 caches)
```

- [ ] **Step 2: Export `credentialFilePaths`**

In `src/credentials.ts`, replace

```ts
function credentialFilePaths(d: CredentialDeps): string[] {
```

with

```ts
export function credentialFilePaths(d: Pick<CredentialDeps, "env" | "homedir">): string[] {
```

- [ ] **Step 3: Write the test helper**

Create `test/helpers/fakeLogin.ts`:

```ts
import { LoginDeps } from "../../src/accounts/claudeLogin";

export const CLAUDE_JSON = "/home/u/.claude.json";
export const CRED_FILE = "/home/u/.claude/.credentials.json";

export interface FakeLogin {
  deps: LoginDeps;
  files: Map<string, string>;
  keychain: { account: string; secret: string } | null;
  writes: string[];            // targets written, in order: a file path or "keychain"
}

export interface FakeLoginOpts {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  keychain?: { account: string; secret: string } | null;
  /** Return true to make the write to this target (path or "keychain") throw. */
  failWrite?: (target: string) => boolean;
  /** Keychain writes "succeed" but change nothing (like `security -i` swallowing an error). */
  keychainNoop?: boolean;
}

export function fakeLogin(opts: FakeLoginOpts = {}): FakeLogin {
  const files = new Map(Object.entries(opts.files ?? {}));
  const f: FakeLogin = { files, keychain: opts.keychain ?? null, writes: [], deps: undefined as unknown as LoginDeps };
  f.deps = {
    env: opts.env ?? {},
    homedir: () => "/home/u",
    platform: opts.platform ?? "linux",
    username: () => "u",
    readFileText: (p) => files.get(p) ?? null,
    writeFileAtomic: (p, text) => {
      f.writes.push(p);
      if (opts.failWrite?.(p)) { throw new Error(`EACCES: ${p}`); }
      files.set(p, text);
    },
    keychainRead: () => f.keychain,
    keychainWrite: (account, secret) => {
      f.writes.push("keychain");
      if (opts.failWrite?.("keychain")) { throw new Error("keychain write failed"); }
      if (!opts.keychainNoop) { f.keychain = { account, secret }; }
    },
  };
  return f;
}

export function creds(accessToken: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: {
    accessToken, refreshToken: `r-${accessToken}`, expiresAt: 10_000_000,
    scopes: ["user:inference", "user:profile"], subscriptionType: "max", ...extra,
  } });
}

export function claudeJson(
  account: Record<string, unknown> | null,
  other: Record<string, unknown> = { numStartups: 7, projects: { "/p": { allowedTools: [] } } },
): string {
  return JSON.stringify(account ? { ...other, oauthAccount: account } : other);
}
```

- [ ] **Step 4: Write the failing tests**

Create `test/claudeLogin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readLogin, oauthOf, withOauth, claudeJsonPath, defaultSource } from "../src/accounts/claudeLogin";
import { fakeLogin, creds, claudeJson, CLAUDE_JSON, CRED_FILE } from "./helpers/fakeLogin";

const A = { accountUuid: "uuid-a", emailAddress: "a@x.com", displayName: "A" };

describe("readLogin", () => {
  it("reads credentials from ~/.claude/.credentials.json and the account from ~/.claude.json", () => {
    const f = fakeLogin({ files: { [CRED_FILE]: creds("tok-a"), [CLAUDE_JSON]: claudeJson(A) } });
    const l = readLogin(f.deps);
    expect(l?.oauthAccount).toEqual(A);
    expect(oauthOf(l!.credentialsRaw)?.accessToken).toBe("tok-a");
    expect(l?.source).toEqual({ kind: "file", path: CRED_FILE });
  });

  it("uses CLAUDE_CONFIG_DIR for both files when set", () => {
    const f = fakeLogin({
      env: { CLAUDE_CONFIG_DIR: "/cfg" },
      files: { "/cfg/.credentials.json": creds("tok-env"), "/cfg/.claude.json": claudeJson(A) },
    });
    expect(claudeJsonPath(f.deps)).toBe("/cfg/.claude.json");
    expect(readLogin(f.deps)?.source).toEqual({ kind: "file", path: "/cfg/.credentials.json" });
  });

  it("falls back to the macOS Keychain and remembers its account attribute", () => {
    const f = fakeLogin({
      platform: "darwin",
      files: { [CLAUDE_JSON]: claudeJson(A) },
      keychain: { account: "someone", secret: creds("tok-kc") },
    });
    const l = readLogin(f.deps);
    expect(l?.source).toEqual({ kind: "keychain", account: "someone" });
    expect(oauthOf(l!.credentialsRaw)?.accessToken).toBe("tok-kc");
  });

  it("ignores the Keychain on other platforms", () => {
    const f = fakeLogin({ files: { [CLAUDE_JSON]: claudeJson(A) }, keychain: { account: "u", secret: creds("t") } });
    expect(readLogin(f.deps)).toBeNull();
  });

  it("returns null when oauthAccount is missing", () => {
    const f = fakeLogin({ files: { [CRED_FILE]: creds("tok-a"), [CLAUDE_JSON]: claudeJson(null) } });
    expect(readLogin(f.deps)).toBeNull();
  });

  it("returns null when .claude.json is not valid JSON", () => {
    const f = fakeLogin({ files: { [CRED_FILE]: creds("tok-a"), [CLAUDE_JSON]: "{oops" } });
    expect(readLogin(f.deps)).toBeNull();
  });
});

describe("oauthOf / withOauth", () => {
  it("reads both the nested and the flat credentials shape", () => {
    expect(oauthOf(creds("n"))?.accessToken).toBe("n");
    expect(oauthOf(JSON.stringify({ accessToken: "flat" }))?.accessToken).toBe("flat");
    expect(oauthOf("{}")).toBeNull();
    expect(oauthOf("not json")).toBeNull();
  });

  it("replaces tokens but keeps the shape and unknown keys", () => {
    const nested = JSON.stringify({ claudeAiOauth: { accessToken: "old", rateLimitTier: "x" }, other: 1 });
    const out = JSON.parse(withOauth(nested, { accessToken: "new", rateLimitTier: "x" }));
    expect(out).toEqual({ claudeAiOauth: { accessToken: "new", rateLimitTier: "x" }, other: 1 });

    const flat = JSON.stringify({ accessToken: "old", keep: true });
    expect(JSON.parse(withOauth(flat, { accessToken: "new", keep: true }))).toEqual({ accessToken: "new", keep: true });
  });
});

describe("defaultSource", () => {
  it("is the Keychain under the OS username on macOS", () => {
    expect(defaultSource(fakeLogin({ platform: "darwin" }).deps)).toEqual({ kind: "keychain", account: "u" });
  });
  it("is the first credentials file elsewhere", () => {
    expect(defaultSource(fakeLogin().deps)).toEqual({ kind: "file", path: CRED_FILE });
    expect(defaultSource(fakeLogin({ env: { CLAUDE_CONFIG_DIR: "/cfg" } }).deps))
      .toEqual({ kind: "file", path: "/cfg/.credentials.json" });
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run test/claudeLogin.test.ts`
Expected: FAIL, because `../src/accounts/claudeLogin` doesn't exist.

- [ ] **Step 6: Implement the read side**

Create `src/accounts/claudeLogin.ts`:

```ts
import { credentialFilePaths } from "../credentials";
import { CredentialSource, LiveLogin, OauthAccount, OauthTokens } from "../types";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface LoginDeps {
  env: Record<string, string | undefined>;
  homedir: () => string;
  platform: NodeJS.Platform;
  username: () => string;
  readFileText: (path: string) => string | null;     // null if missing/unreadable
  writeFileAtomic: (path: string, text: string) => void;   // temp file + rename; throws on failure
  keychainRead: () => { account: string; secret: string } | null;
  keychainWrite: (account: string, secret: string) => void; // throws on failure
}

export function claudeJsonPath(d: Pick<LoginDeps, "env" | "homedir">): string {
  const dir = d.env.CLAUDE_CONFIG_DIR;
  return dir && dir.length > 0 ? `${dir}/.claude.json` : `${d.homedir()}/.claude.json`;
}

function parse(raw: string | null): any {
  if (!raw) { return null; }
  try { return JSON.parse(raw); } catch { return null; }
}

/** The token-bearing object: `claudeAiOauth`, or the top level in the older flat shape. */
export function oauthOf(credentialsRaw: string): OauthTokens | null {
  const j = parse(credentialsRaw);
  const t = j?.claudeAiOauth ?? j;
  return t && typeof t.accessToken === "string" ? (t as OauthTokens) : null;
}

/** Swap in new tokens, keeping the credentials' shape and every other key. */
export function withOauth(credentialsRaw: string, tokens: OauthTokens): string {
  const j = parse(credentialsRaw) ?? {};
  return JSON.stringify(j.claudeAiOauth ? { ...j, claudeAiOauth: tokens } : { ...j, ...tokens });
}

function readOauthAccount(d: LoginDeps): OauthAccount | null {
  const a = parse(d.readFileText(claudeJsonPath(d)))?.oauthAccount;
  return a && typeof a.accountUuid === "string" ? (a as OauthAccount) : null;
}

/** Claude Code's current login, looked up in the same order as `resolveToken`. */
export function readLogin(d: LoginDeps): LiveLogin | null {
  const oauthAccount = readOauthAccount(d);
  if (!oauthAccount) { return null; }
  for (const path of credentialFilePaths(d)) {
    const raw = d.readFileText(path);
    if (raw && oauthOf(raw)) { return { credentialsRaw: raw, oauthAccount, source: { kind: "file", path } }; }
  }
  if (d.platform === "darwin") {
    const kc = d.keychainRead();
    if (kc && oauthOf(kc.secret)) {
      return { credentialsRaw: kc.secret, oauthAccount, source: { kind: "keychain", account: kc.account } };
    }
  }
  return null;
}

/** Where to write credentials when nobody is logged in: where Claude Code looks first. */
export function defaultSource(d: LoginDeps): CredentialSource {
  return d.platform === "darwin"
    ? { kind: "keychain", account: d.username() }
    : { kind: "file", path: credentialFilePaths(d)[0] };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/claudeLogin.test.ts test/credentials.test.ts`
Expected: PASS (all). `credentials.test.ts` still passes after the export change.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/credentials.ts src/accounts/claudeLogin.ts test/helpers/fakeLogin.ts test/claudeLogin.test.ts
git commit -m "Accounts: read Claude Code's current login"
```

---

### Task 3: Writing Claude Code's login, and the production deps

**Files:**
- Modify: `src/accounts/claudeLogin.ts` (append)
- Test: `test/claudeLogin.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's `LoginDeps`, `claudeJsonPath`, `KEYCHAIN_SERVICE`.
- Produces: `writeCredentials(d, source, raw): void` (throws), `writeOauthAccount(d, account): void` (throws), `keychainAddCommand(account, secret): string`, `parseKeychainAccount(attrs): string | null`, `defaultLoginDeps(): LoginDeps`.

- [ ] **Step 1: Write the failing tests**

Append to `test/claudeLogin.test.ts` (and add `writeCredentials, writeOauthAccount, keychainAddCommand, parseKeychainAccount` to its import from `../src/accounts/claudeLogin`):

```ts
describe("writeCredentials", () => {
  it("writes to the file it came from", () => {
    const f = fakeLogin();
    writeCredentials(f.deps, { kind: "file", path: CRED_FILE }, creds("new"));
    expect(oauthOf(f.files.get(CRED_FILE)!)?.accessToken).toBe("new");
  });
  it("writes to the Keychain under the given account attribute", () => {
    const f = fakeLogin({ platform: "darwin" });
    writeCredentials(f.deps, { kind: "keychain", account: "someone" }, creds("new"));
    expect(f.keychain?.account).toBe("someone");
    expect(oauthOf(f.keychain!.secret)?.accessToken).toBe("new");
  });
});

describe("writeOauthAccount", () => {
  const B = { accountUuid: "uuid-b", emailAddress: "b@x.com" };

  it("changes only oauthAccount and keeps every other key", () => {
    const f = fakeLogin({ files: { [CLAUDE_JSON]: claudeJson(A) } });
    const before = JSON.parse(f.files.get(CLAUDE_JSON)!);
    writeOauthAccount(f.deps, B);
    const after = JSON.parse(f.files.get(CLAUDE_JSON)!);
    expect(after.oauthAccount).toEqual(B);
    delete before.oauthAccount; delete after.oauthAccount;
    expect(after).toEqual(before);
  });

  it("re-reads the file at write time, so Claude Code's latest changes survive", () => {
    const f = fakeLogin({ files: { [CLAUDE_JSON]: claudeJson(A) } });
    readLogin(f.deps); // an earlier read…
    f.files.set(CLAUDE_JSON, claudeJson(A, { numStartups: 8, tipsHistory: { a: 1 } })); // …then Claude Code writes
    writeOauthAccount(f.deps, B);
    const after = JSON.parse(f.files.get(CLAUDE_JSON)!);
    expect(after.numStartups).toBe(8);
    expect(after.tipsHistory).toEqual({ a: 1 });
  });

  it("throws when .claude.json is missing or not JSON", () => {
    expect(() => writeOauthAccount(fakeLogin().deps, B)).toThrow();
    expect(() => writeOauthAccount(fakeLogin({ files: { [CLAUDE_JSON]: "{oops" } }).deps, B)).toThrow();
  });
});

describe("Keychain helpers", () => {
  it("builds a `security -i` command with the secret hex-encoded, never in plain text", () => {
    const secret = creds("tok-secret");
    const cmd = keychainAddCommand("someone", secret);
    expect(cmd).toBe(`add-generic-password -U -a "someone" -s "Claude Code-credentials" -X ${Buffer.from(secret, "utf8").toString("hex")}\n`);
    expect(cmd).not.toContain("tok-secret");
  });
  it("rejects account names that would break the command's quoting", () => {
    expect(() => keychainAddCommand('a"b', "s")).toThrow();
    expect(() => keychainAddCommand("a\nb", "s")).toThrow();
  });
  it("parses the acct attribute from `security find-generic-password` output", () => {
    const out = 'keychain: "/Users/u/Library/Keychains/login.keychain-db"\nattributes:\n    "acct"<blob>="someone"\n    "svce"<blob>="Claude Code-credentials"\n';
    expect(parseKeychainAccount(out)).toBe("someone");
    expect(parseKeychainAccount("nothing here")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/claudeLogin.test.ts`
Expected: FAIL, because `writeCredentials` and the others aren't exported.

- [ ] **Step 3: Implement**

Append to `src/accounts/claudeLogin.ts`:

```ts
export function writeCredentials(d: LoginDeps, source: CredentialSource, credentialsRaw: string): void {
  if (source.kind === "keychain") { d.keychainWrite(source.account, credentialsRaw); return; }
  d.writeFileAtomic(source.path, credentialsRaw);
}

/**
 * Replace only `oauthAccount` in .claude.json. Claude Code rewrites this file
 * often, so it is read fresh here, immediately before writing, never reused.
 */
export function writeOauthAccount(d: LoginDeps, account: OauthAccount): void {
  const path = claudeJsonPath(d);
  const j = parse(d.readFileText(path));
  if (!j || typeof j !== "object") { throw new Error(`${path} is missing or not valid JSON`); }
  j.oauthAccount = account;
  d.writeFileAtomic(path, JSON.stringify(j, null, 2));
}

/**
 * One `security -i` line that creates or updates the item. The secret is
 * hex-encoded (-X), so it needs no quoting and never appears in any process's argv.
 */
export function keychainAddCommand(account: string, secret: string): string {
  if (/["\\\n]/.test(account)) { throw new Error("Unsupported Keychain account name"); }
  const hex = Buffer.from(secret, "utf8").toString("hex");
  return `add-generic-password -U -a "${account}" -s "${KEYCHAIN_SERVICE}" -X ${hex}\n`;
}

/** The `acct` attribute from `security find-generic-password` (no -w) output. */
export function parseKeychainAccount(attrs: string): string | null {
  const m = attrs.match(/"acct"<blob>="([^"]*)"/);
  return m ? m[1] : null;
}

// Production deps factory (used by extension.ts).
export function defaultLoginDeps(): LoginDeps {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const cp = require("node:child_process") as typeof import("node:child_process");
  const security = (args: string[]) => cp.execFileSync("security", args,
    { timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).toString();
  return {
    env: process.env,
    homedir: () => os.homedir(),
    platform: process.platform,
    username: () => os.userInfo().username,
    readFileText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    writeFileAtomic: (p, text) => {
      let mode = 0o600;
      try { mode = fs.statSync(p).mode & 0o777; } catch { /* new file keeps 0600 */ }
      const tmp = `${p}.claude-usage-${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode });
      fs.renameSync(tmp, p);
    },
    keychainRead: () => {
      try {
        const secret = security(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]).trim();
        const account = parseKeychainAccount(security(["find-generic-password", "-s", KEYCHAIN_SERVICE]));
        return { account: account ?? os.userInfo().username, secret };
      } catch { return null; }
    },
    keychainWrite: (account, secret) => {
      cp.execFileSync("security", ["-i"],
        { input: keychainAddCommand(account, secret), timeout: 5000, stdio: ["pipe", "ignore", "pipe"] });
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/claudeLogin.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/accounts/claudeLogin.ts test/claudeLogin.test.ts
git commit -m "Accounts: write Claude Code's login (Keychain via stdin, .claude.json key-only)"
```

---

### Task 4: Renewing a saved account's token

**Files:**
- Create: `src/accounts/tokenRefresh.ts`
- Test: `test/tokenRefresh.test.ts`

**Interfaces:**
- Consumes: `oauthOf`, `withOauth` (Task 2); `HttpResponse` from `src/quotaClient.ts`; `OauthTokens` from `src/types.ts`.
- Produces: `TOKEN_URL`, `CLIENT_ID`, `REFRESH_MARGIN_MS`, `type HttpPost = (url: string, headers: Record<string, string>, body: string) => Promise<HttpResponse>`, `type RefreshResult`, `needsRefresh(tokens, nowMs): boolean`, `refreshCredentials(raw, httpPost, nowMs): Promise<RefreshResult>`, `defaultHttpPost(): HttpPost`.

- [ ] **Step 1: Write the failing tests**

Create `test/tokenRefresh.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { needsRefresh, refreshCredentials, HttpPost, TOKEN_URL, CLIENT_ID } from "../src/accounts/tokenRefresh";
import { oauthOf } from "../src/accounts/claudeLogin";
import { creds } from "./helpers/fakeLogin";

const NOW = 1_000_000;
const reply = (status: number, body: unknown): HttpPost =>
  async () => ({ status, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("needsRefresh", () => {
  it("is true within 5 minutes of expiry, when expired, or when expiresAt is missing", () => {
    expect(needsRefresh({ accessToken: "t", expiresAt: NOW + 4 * 60_000 }, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: "t", expiresAt: NOW - 1 }, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: "t" }, NOW)).toBe(true);
  });
  it("is false with more than 5 minutes left", () => {
    expect(needsRefresh({ accessToken: "t", expiresAt: NOW + 6 * 60_000 }, NOW)).toBe(false);
  });
});

describe("refreshCredentials", () => {
  it("sends Claude Code's refresh request", async () => {
    // An array, not `let seen = null`: TS would narrow a callback-assigned `let` to `never`.
    const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
    const post: HttpPost = async (url, headers, body) => {
      seen.push({ url, headers, body: JSON.parse(body) });
      return { status: 200, body: JSON.stringify({ access_token: "a2", refresh_token: "r2", expires_in: 3600 }) };
    };
    await refreshCredentials(creds("a1"), post, NOW);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(TOKEN_URL);
    expect(seen[0].headers["Content-Type"]).toBe("application/json");
    expect(seen[0].body).toEqual({
      grant_type: "refresh_token", refresh_token: "r-a1", client_id: CLIENT_ID, scope: "user:inference user:profile",
    });
  });

  it("merges the new tokens into the saved credentials and keeps other fields", async () => {
    const r = await refreshCredentials(creds("a1", { rateLimitTier: "tier" }),
      reply(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600, scope: "user:inference" }), NOW);
    expect(r.ok).toBe(true);
    const t = oauthOf((r as { credentialsRaw: string }).credentialsRaw)!;
    expect(t).toMatchObject({ accessToken: "a2", refreshToken: "r2", expiresAt: NOW + 3_600_000,
      scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: "tier" });
  });

  it("keeps the old refresh token when the response doesn't include one", async () => {
    const r = await refreshCredentials(creds("a1"), reply(200, { access_token: "a2", expires_in: 60 }), NOW);
    expect(oauthOf((r as { credentialsRaw: string }).credentialsRaw)?.refreshToken).toBe("r-a1");
  });

  it("maps invalid_grant to expired", async () => {
    const r = await refreshCredentials(creds("a1"), reply(400, { error: "invalid_grant" }), NOW);
    expect(r).toMatchObject({ ok: false, kind: "expired" });
  });

  it("treats a login with no refresh token as expired without calling the network", async () => {
    const post: HttpPost = async () => { throw new Error("should not be called"); };
    const r = await refreshCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "a" } }), post, NOW);
    expect(r).toMatchObject({ ok: false, kind: "expired" });
  });

  it("maps a thrown request to network", async () => {
    const post: HttpPost = async () => { throw new Error("ECONNRESET"); };
    expect(await refreshCredentials(creds("a1"), post, NOW)).toMatchObject({ ok: false, kind: "network", message: "ECONNRESET" });
  });

  it("maps other statuses and malformed bodies to bad-response", async () => {
    expect(await refreshCredentials(creds("a1"), reply(500, "oops"), NOW)).toMatchObject({ ok: false, kind: "bad-response" });
    expect(await refreshCredentials(creds("a1"), reply(200, "not json"), NOW)).toMatchObject({ ok: false, kind: "bad-response" });
    expect(await refreshCredentials(creds("a1"), reply(200, { access_token: "a2" }), NOW)).toMatchObject({ ok: false, kind: "bad-response" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tokenRefresh.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/accounts/tokenRefresh.ts`:

```ts
import { HttpResponse } from "../quotaClient";
import { OauthTokens } from "../types";
import { oauthOf, withOauth } from "./claudeLogin";

// Claude Code's own OAuth token endpoint and client id (read from Claude Code
// 2.1.178). Undocumented, like USAGE_URL, and may change without notice.
export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const REFRESH_MARGIN_MS = 5 * 60_000;

export type HttpPost = (url: string, headers: Record<string, string>, body: string) => Promise<HttpResponse>;
export type RefreshResult =
  | { ok: true; credentialsRaw: string }
  | { ok: false; kind: "expired" | "network" | "bad-response"; message: string };

export function needsRefresh(t: OauthTokens, nowMs: number): boolean {
  return typeof t.expiresAt !== "number" || t.expiresAt - nowMs < REFRESH_MARGIN_MS;
}

/** Exchange the saved refresh token for a new pair. The old refresh token stops working once this succeeds. */
export async function refreshCredentials(credentialsRaw: string, httpPost: HttpPost, nowMs: number): Promise<RefreshResult> {
  const t = oauthOf(credentialsRaw);
  if (!t?.refreshToken) { return { ok: false, kind: "expired", message: "No refresh token saved." }; }
  const body: Record<string, string> = { grant_type: "refresh_token", refresh_token: t.refreshToken, client_id: CLIENT_ID };
  if (Array.isArray(t.scopes) && t.scopes.length > 0) { body.scope = t.scopes.join(" "); }

  let resp: HttpResponse;
  try {
    resp = await httpPost(TOKEN_URL, { "Content-Type": "application/json" }, JSON.stringify(body));
  } catch (e) {
    return { ok: false, kind: "network", message: String((e as Error)?.message ?? e) };
  }
  if ((resp.status === 400 || resp.status === 401) && resp.body.includes("invalid_grant")) {
    return { ok: false, kind: "expired", message: "The saved login was revoked or has expired." };
  }
  if (resp.status !== 200) { return { ok: false, kind: "bad-response", message: `HTTP ${resp.status}` }; }

  let j: any;
  try { j = JSON.parse(resp.body); } catch { return { ok: false, kind: "bad-response", message: "Unparseable token response." }; }
  if (typeof j?.access_token !== "string" || typeof j?.expires_in !== "number") {
    return { ok: false, kind: "bad-response", message: "Unexpected token response." };
  }
  const next: OauthTokens = {
    ...t,
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === "string" ? j.refresh_token : t.refreshToken,
    expiresAt: nowMs + j.expires_in * 1000,
  };
  if (typeof j.scope === "string" && j.scope.length > 0) { next.scopes = j.scope.split(" "); }
  return { ok: true, credentialsRaw: withOauth(credentialsRaw, next) };
}

// Production httpPost using Node's global fetch.
export function defaultHttpPost(): HttpPost {
  return async (url, headers, body) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
      return { status: res.status, body: await res.text() };
    } finally { clearTimeout(t); }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tokenRefresh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts/tokenRefresh.ts test/tokenRefresh.test.ts
git commit -m "Accounts: renew a saved account's token"
```

---

### Task 5: Saved-account store

**Files:**
- Create: `src/accounts/accountStore.ts`
- Create: `test/helpers/memoryStores.ts`
- Test: `test/accountStore.test.ts`

**Interfaces:**
- Consumes: `oauthOf` (Task 2); `SavedAccountSecret`, `SavedAccountMeta` (Task 2).
- Produces: `interface SecretStore`, `interface KeyValueStore`, `ACCOUNTS_INDEX = "claudeUsage.accounts"`, `secretKey(uuid)`, `metaFor(secret, lastUsedAt): SavedAccountMeta`, `class AccountStore` with `list(): SavedAccountMeta[]`, `get(uuid): Promise<SavedAccountSecret | null>`, `save(secret): Promise<"added" | "updated" | "unchanged">`, `remove(uuid): Promise<void>`, `touch(uuid, nowIso): Promise<void>`. `context.secrets` and `context.globalState` satisfy the two interfaces as-is. Test helpers `MemorySecrets`, `MemoryState`.

- [ ] **Step 1: Write the test helpers**

Create `test/helpers/memoryStores.ts`:

```ts
import { KeyValueStore, SecretStore } from "../../src/accounts/accountStore";

export class MemorySecrets implements SecretStore {
  map = new Map<string, string>();
  async get(key: string) { return this.map.get(key); }
  async store(key: string, value: string) { this.map.set(key, value); }
  async delete(key: string) { this.map.delete(key); }
}

export class MemoryState implements KeyValueStore {
  map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown) { this.map.set(key, value); }
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/accountStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AccountStore, ACCOUNTS_INDEX, metaFor, secretKey } from "../src/accounts/accountStore";
import { MemorySecrets, MemoryState } from "./helpers/memoryStores";
import { creds } from "./helpers/fakeLogin";

const A = { accountUuid: "uuid-a", emailAddress: "a@x.com", displayName: "Ann", organizationName: "Personal" };
const secretA = { credentialsRaw: creds("tok-a"), oauthAccount: A };

function fresh() {
  const secrets = new MemorySecrets(), state = new MemoryState();
  return { secrets, state, store: new AccountStore(secrets, state) };
}

describe("AccountStore", () => {
  it("adds, then reports unchanged, then updated when tokens change", async () => {
    const { store } = fresh();
    expect(await store.save(secretA)).toBe("added");
    expect(await store.save(secretA)).toBe("unchanged");
    expect(await store.save({ ...secretA, credentialsRaw: creds("tok-a2") })).toBe("updated");
    expect(store.list()).toHaveLength(1);
    expect(await store.get("uuid-a")).toEqual({ ...secretA, credentialsRaw: creds("tok-a2") });
  });

  it("builds a token-free index entry", async () => {
    const { store, state } = fresh();
    await store.save(secretA);
    expect(store.list()).toEqual([{
      accountUuid: "uuid-a", email: "a@x.com", displayName: "Ann", organizationName: "Personal",
      subscriptionType: "max", lastUsedAt: null,
    }]);
    const indexJson = JSON.stringify(state.map.get(ACCOUNTS_INDEX));
    expect(indexJson).not.toContain("tok-a");
    expect(indexJson).not.toContain("r-tok-a");
  });

  it("keeps lastUsedAt across saves, and touch sets it", async () => {
    const { store } = fresh();
    await store.save(secretA);
    await store.touch("uuid-a", "2026-09-27T10:00:00.000Z");
    await store.save({ ...secretA, credentialsRaw: creds("tok-a2") });
    expect(store.list()[0].lastUsedAt).toBe("2026-09-27T10:00:00.000Z");
  });

  it("removes both the secret and the index entry", async () => {
    const { store, secrets } = fresh();
    await store.save(secretA);
    await store.remove("uuid-a");
    expect(store.list()).toEqual([]);
    expect(secrets.map.has(secretKey("uuid-a"))).toBe(false);
    expect(await store.get("uuid-a")).toBeNull();
  });

  it("returns null for a corrupt secret", async () => {
    const { store, secrets } = fresh();
    secrets.map.set(secretKey("uuid-z"), "{oops");
    expect(await store.get("uuid-z")).toBeNull();
  });
});

describe("metaFor", () => {
  it("falls back when email is missing: display name, then a uuid prefix", () => {
    expect(metaFor({ credentialsRaw: "{}", oauthAccount: { accountUuid: "abcdef123456", displayName: "Bo" } }, null).email).toBe("Bo");
    expect(metaFor({ credentialsRaw: "{}", oauthAccount: { accountUuid: "abcdef123456" } }, null).email).toBe("abcdef12");
    expect(metaFor({ credentialsRaw: "{}", oauthAccount: { accountUuid: "abcdef123456", emailAddress: "" } }, null).email).toBe("abcdef12");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/accountStore.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 4: Implement**

Create `src/accounts/accountStore.ts`:

```ts
import { SavedAccountMeta, SavedAccountSecret } from "../types";
import { oauthOf } from "./claudeLogin";

// Structural subsets of vscode.SecretStorage and vscode.Memento, so this module
// stays free of `vscode` and unit-tests with in-memory fakes.
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export const ACCOUNTS_INDEX = "claudeUsage.accounts";
export const secretKey = (uuid: string): string => `claudeUsage.account.${uuid}`;

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function metaFor(s: SavedAccountSecret, lastUsedAt: string | null): SavedAccountMeta {
  const a = s.oauthAccount;
  return {
    accountUuid: a.accountUuid,
    email: str(a.emailAddress) ?? str(a.displayName) ?? a.accountUuid.slice(0, 8),
    displayName: str(a.displayName),
    organizationName: str(a.organizationName),
    subscriptionType: str(oauthOf(s.credentialsRaw)?.subscriptionType),
    lastUsedAt,
  };
}

/** Saved accounts: secrets in SecretStorage, a token-free index in globalState. */
export class AccountStore {
  constructor(private readonly secrets: SecretStore, private readonly state: KeyValueStore) {}

  list(): SavedAccountMeta[] { return this.state.get<SavedAccountMeta[]>(ACCOUNTS_INDEX) ?? []; }

  async get(uuid: string): Promise<SavedAccountSecret | null> {
    const raw = await this.secrets.get(secretKey(uuid));
    if (!raw) { return null; }
    try { return JSON.parse(raw) as SavedAccountSecret; } catch { return null; }
  }

  async save(s: SavedAccountSecret): Promise<"added" | "updated" | "unchanged"> {
    const uuid = s.oauthAccount.accountUuid;
    const value = JSON.stringify({ credentialsRaw: s.credentialsRaw, oauthAccount: s.oauthAccount });
    const prev = this.list().find((m) => m.accountUuid === uuid);
    if (prev && (await this.secrets.get(secretKey(uuid))) === value) { return "unchanged"; }
    await this.secrets.store(secretKey(uuid), value);
    await this.writeIndex(uuid, metaFor(s, prev?.lastUsedAt ?? null));
    return prev ? "updated" : "added";
  }

  async remove(uuid: string): Promise<void> {
    await this.secrets.delete(secretKey(uuid));
    await this.state.update(ACCOUNTS_INDEX, this.list().filter((m) => m.accountUuid !== uuid));
  }

  async touch(uuid: string, nowIso: string): Promise<void> {
    const m = this.list().find((x) => x.accountUuid === uuid);
    if (m) { await this.writeIndex(uuid, { ...m, lastUsedAt: nowIso }); }
  }

  private async writeIndex(uuid: string, meta: SavedAccountMeta): Promise<void> {
    await this.state.update(ACCOUNTS_INDEX, [...this.list().filter((m) => m.accountUuid !== uuid), meta]);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/accountStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/accounts/accountStore.ts test/helpers/memoryStores.ts test/accountStore.test.ts
git commit -m "Accounts: saved-account store (SecretStorage + token-free index)"
```

---

### Task 6: Auto-save and switching

**Files:**
- Create: `src/accounts/switcher.ts`
- Test: `test/switcher.test.ts`

**Interfaces:**
- Consumes: `readLogin`, `writeCredentials`, `writeOauthAccount`, `oauthOf`, `defaultSource`, `LoginDeps` (Tasks 2–3); `AccountStore` (Task 5); `HttpPost`, `needsRefresh`, `refreshCredentials` (Task 4).
- Produces: `syncActive(login: LoginDeps, store: AccountStore): Promise<LiveLogin | null>`, `interface SwitchDeps { login; store; httpPost; now: () => number }`, `type SwitchFailure = "not-saved" | "expired" | "refresh-failed" | "write-failed"`, `type SwitchResult = { ok: true; account: SavedAccountMeta } | { ok: false; reason: SwitchFailure; message: string; restored: boolean | null }`, `switchTo(uuid, d): Promise<SwitchResult>`. `restored` is `null` when nothing had been written, `true` when the previous login was put back, `false` when putting it back failed or there was nothing to put back.

- [ ] **Step 1: Write the failing tests**

Create `test/switcher.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { switchTo, syncActive, SwitchDeps } from "../src/accounts/switcher";
import { AccountStore } from "../src/accounts/accountStore";
import { oauthOf } from "../src/accounts/claudeLogin";
import { HttpPost } from "../src/accounts/tokenRefresh";
import { fakeLogin, FakeLogin, FakeLoginOpts, creds, claudeJson, CLAUDE_JSON, CRED_FILE } from "./helpers/fakeLogin";
import { MemorySecrets, MemoryState } from "./helpers/memoryStores";

const A = { accountUuid: "uuid-a", emailAddress: "a@x.com" };
const B = { accountUuid: "uuid-b", emailAddress: "b@x.com" };
const noHttp: HttpPost = async () => { throw new Error("unexpected HTTP call"); };

function setup(opts: FakeLoginOpts = {}, httpPost: HttpPost = noHttp) {
  const login = fakeLogin({ files: { [CRED_FILE]: creds("tok-a"), [CLAUDE_JSON]: claudeJson(A) }, ...opts });
  const store = new AccountStore(new MemorySecrets(), new MemoryState());
  const d: SwitchDeps = { login: login.deps, store, httpPost, now: () => 0 };
  return { login, store, d };
}
const saveB = (store: AccountStore, raw = creds("tok-b")) => store.save({ credentialsRaw: raw, oauthAccount: B });
const liveUuid = (l: FakeLogin) => JSON.parse(l.files.get(CLAUDE_JSON)!).oauthAccount?.accountUuid;
const fileToken = (l: FakeLogin) => oauthOf(l.files.get(CRED_FILE) ?? "{}")?.accessToken;
const savedToken = async (store: AccountStore, uuid: string) => oauthOf((await store.get(uuid))!.credentialsRaw)?.accessToken;

describe("syncActive", () => {
  it("auto-saves a logged-in account that isn't saved yet", async () => {
    const { login, store } = setup();
    const live = await syncActive(login.deps, store);
    expect(live?.oauthAccount.accountUuid).toBe("uuid-a");
    expect(store.list().map((m) => m.accountUuid)).toEqual(["uuid-a"]);
  });

  it("returns null and saves nothing when not logged in", async () => {
    const { login, store } = setup({ files: { [CLAUDE_JSON]: claudeJson(null) } });
    expect(await syncActive(login.deps, store)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it("a session writing A back after a switch: A is re-saved, B's saved copy is untouched", async () => {
    const { login, store, d } = setup();
    await saveB(store);
    expect((await switchTo("uuid-b", d)).ok).toBe(true);
    // A running session renews A's token and writes A back:
    login.files.set(CRED_FILE, creds("tok-a-renewed"));
    login.files.set(CLAUDE_JSON, claudeJson(A));
    const live = await syncActive(login.deps, store);
    expect(live?.oauthAccount.accountUuid).toBe("uuid-a");
    expect(await savedToken(store, "uuid-a")).toBe("tok-a-renewed");
    expect(await savedToken(store, "uuid-b")).toBe("tok-b");
  });
});

describe("switchTo", () => {
  it("switches A → B: writes B, keeps other .claude.json keys, re-saves A, marks B used", async () => {
    const { login, store, d } = setup();
    await saveB(store);
    const res = await switchTo("uuid-b", d);
    expect(res).toMatchObject({ ok: true, account: { accountUuid: "uuid-b", lastUsedAt: new Date(0).toISOString() } });
    expect(liveUuid(login)).toBe("uuid-b");
    expect(fileToken(login)).toBe("tok-b");
    expect(JSON.parse(login.files.get(CLAUDE_JSON)!).numStartups).toBe(7);
    expect(store.list().map((m) => m.accountUuid).sort()).toEqual(["uuid-a", "uuid-b"]);
  });

  it("re-saves A's latest tokens before switching away", async () => {
    const { store, d } = setup();
    await store.save({ credentialsRaw: creds("tok-a-stale"), oauthAccount: A });
    await saveB(store);
    await switchTo("uuid-b", d);
    expect(await savedToken(store, "uuid-a")).toBe("tok-a");
  });

  it("does nothing when the target is already active", async () => {
    const { login, d } = setup();
    expect((await switchTo("uuid-a", d)).ok).toBe(true);
    expect(login.writes).toEqual([]);
  });

  it("fails with not-saved for an unknown account and writes nothing", async () => {
    const { login, d } = setup();
    expect(await switchTo("uuid-zzz", d)).toMatchObject({ ok: false, reason: "not-saved", restored: null });
    expect(login.writes).toEqual([]);
  });

  it("saved login with no tokens: expired, nothing written", async () => {
    const { login, store, d } = setup();
    await saveB(store, "{}");
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "expired", restored: null });
    expect(login.writes).toEqual([]);
  });

  it("renews an expiring token and saves it before writing, even if the write then fails", async () => {
    const post: HttpPost = async () => ({ status: 200, body: JSON.stringify({ access_token: "tok-b2", refresh_token: "r2", expires_in: 3600 }) });
    const { login, store, d } = setup({ failWrite: (p) => p === CRED_FILE }, post);
    await saveB(store, creds("tok-b", { expiresAt: 1000 }));
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "write-failed", restored: null });
    expect(await savedToken(store, "uuid-b")).toBe("tok-b2");
    expect(liveUuid(login)).toBe("uuid-a");
  });

  it("renewal rejected: expired, nothing written", async () => {
    const post: HttpPost = async () => ({ status: 400, body: JSON.stringify({ error: "invalid_grant" }) });
    const { login, store, d } = setup({}, post);
    await saveB(store, creds("tok-b", { expiresAt: 1000 }));
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "expired", restored: null });
    expect(login.writes).toEqual([]);
  });

  it("renewal network error: refresh-failed, nothing written", async () => {
    const post: HttpPost = async () => { throw new Error("offline"); };
    const { login, store, d } = setup({}, post);
    await saveB(store, creds("tok-b", { expiresAt: 1000 }));
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "refresh-failed", message: "offline" });
    expect(login.writes).toEqual([]);
  });

  it("credentials write fails: nothing changed, nothing to restore", async () => {
    const { login, store, d } = setup({ failWrite: (p) => p === CRED_FILE });
    await saveB(store);
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "write-failed", restored: null });
    expect(liveUuid(login)).toBe("uuid-a");
    expect(fileToken(login)).toBe("tok-a");
  });

  it("account write fails: A is restored", async () => {
    let n = 0;
    const { login, store, d } = setup({ failWrite: (p) => p === CLAUDE_JSON && n++ === 0 });
    await saveB(store);
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "write-failed", restored: true });
    expect(liveUuid(login)).toBe("uuid-a");
    expect(fileToken(login)).toBe("tok-a");
  });

  it("rollback that also fails is reported as restored: false", async () => {
    const { store, d } = setup({ failWrite: (p) => p === CLAUDE_JSON });
    await saveB(store);
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "write-failed", restored: false });
  });

  it("silent Keychain no-op: read-back catches it and A is restored", async () => {
    const { login, store, d } = setup({
      platform: "darwin", files: { [CLAUDE_JSON]: claudeJson(A) },
      keychain: { account: "u", secret: creds("tok-a") }, keychainNoop: true,
    });
    await saveB(store);
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "write-failed", restored: true });
    expect(liveUuid(login)).toBe("uuid-a");
  });

  it("writes to the Keychain under its existing account attribute", async () => {
    const { login, store, d } = setup({
      platform: "darwin", files: { [CLAUDE_JSON]: claudeJson(A) },
      keychain: { account: "someone", secret: creds("tok-a") },
    });
    await saveB(store);
    expect((await switchTo("uuid-b", d)).ok).toBe(true);
    expect(login.keychain?.account).toBe("someone");
    expect(oauthOf(login.keychain!.secret)?.accessToken).toBe("tok-b");
  });

  it("nobody logged in: writes to Claude Code's default location", async () => {
    const { login, store, d } = setup({ files: { [CLAUDE_JSON]: claudeJson(null) } });
    await saveB(store);
    expect((await switchTo("uuid-b", d)).ok).toBe(true);
    expect(liveUuid(login)).toBe("uuid-b");
    expect(fileToken(login)).toBe("tok-b");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/switcher.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/accounts/switcher.ts`:

```ts
import { CredentialSource, LiveLogin, SavedAccountMeta } from "../types";
import { LoginDeps, defaultSource, oauthOf, readLogin, writeCredentials, writeOauthAccount } from "./claudeLogin";
import { AccountStore } from "./accountStore";
import { HttpPost, needsRefresh, refreshCredentials } from "./tokenRefresh";

/**
 * Save Claude Code's current login: adds new accounts and keeps the active
 * account's saved copy current as Claude Code rotates its tokens. It never
 * renews the active token: that would log out running Claude Code sessions.
 */
export async function syncActive(login: LoginDeps, store: AccountStore): Promise<LiveLogin | null> {
  const live = readLogin(login);
  if (live) { await store.save({ credentialsRaw: live.credentialsRaw, oauthAccount: live.oauthAccount }); }
  return live;
}

export interface SwitchDeps {
  login: LoginDeps;
  store: AccountStore;
  httpPost: HttpPost;
  now: () => number;
}
export type SwitchFailure = "not-saved" | "expired" | "refresh-failed" | "write-failed";
export type SwitchResult =
  | { ok: true; account: SavedAccountMeta }
  | { ok: false; reason: SwitchFailure; message: string; restored: boolean | null };

const fail = (reason: SwitchFailure, message: string, restored: boolean | null): SwitchResult =>
  ({ ok: false, reason, message, restored });
const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

/** Spec §4.1. */
export async function switchTo(uuid: string, d: SwitchDeps): Promise<SwitchResult> {
  const meta = () => d.store.list().find((m) => m.accountUuid === uuid)!;

  // 1. Re-save the current login: its tokens may have rotated, and it's what a rollback restores.
  const before = await syncActive(d.login, d.store);
  if (before?.oauthAccount.accountUuid === uuid) { return { ok: true, account: meta() }; }

  // 2. Load the target, renewing its token if needed. A renewed pair is saved
  //    at once: the old refresh token is already dead.
  const target = await d.store.get(uuid);
  if (!target) { return fail("not-saved", "That account is no longer saved", null); }
  let credentialsRaw = target.credentialsRaw;
  const tokens = oauthOf(credentialsRaw);
  if (!tokens) { return fail("expired", "The saved login is unreadable", null); }
  if (needsRefresh(tokens, d.now())) {
    const r = await refreshCredentials(credentialsRaw, d.httpPost, d.now());
    if (!r.ok) { return fail(r.kind === "expired" ? "expired" : "refresh-failed", r.message, null); }
    credentialsRaw = r.credentialsRaw;
    await d.store.save({ credentialsRaw, oauthAccount: target.oauthAccount });
  }

  // 3–4. Credentials first, then the account block.
  const dest = before?.source ?? defaultSource(d.login);
  try { writeCredentials(d.login, dest, credentialsRaw); } catch (e) { return fail("write-failed", errMsg(e), null); }
  try { writeOauthAccount(d.login, target.oauthAccount); } catch (e) { return rollback(d.login, before, dest, errMsg(e)); }

  // 5. Confirm Claude Code now reads the target.
  const after = readLogin(d.login);
  if (after?.oauthAccount.accountUuid !== uuid
      || oauthOf(after.credentialsRaw)?.accessToken !== oauthOf(credentialsRaw)?.accessToken) {
    return rollback(d.login, before, dest, "Claude Code's login didn't change after writing it");
  }

  // 6.
  await d.store.touch(uuid, new Date(d.now()).toISOString());
  return { ok: true, account: meta() };
}

function rollback(login: LoginDeps, before: LiveLogin | null, dest: CredentialSource, message: string): SwitchResult {
  if (!before) { return fail("write-failed", message, false); }
  try {
    writeCredentials(login, dest, before.credentialsRaw);
    writeOauthAccount(login, before.oauthAccount);
    return fail("write-failed", message, true);
  } catch {
    return fail("write-failed", message, false);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/switcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts/switcher.ts test/switcher.test.ts
git commit -m "Accounts: auto-save the active login and switch with rollback"
```

---

### Task 7: Waiting for a new login (Add Account)

**Files:**
- Modify: `src/accounts/switcher.ts` (append)
- Test: `test/waitForNewLogin.test.ts`

**Interfaces:**
- Consumes: `oauthOf` (Task 2); `LiveLogin` (Task 2).
- Produces: `interface WaitDeps { readLogin: () => LiveLogin | null; sleep: (ms: number) => Promise<void>; now: () => number; cancelled: () => boolean }`, `waitForNewLogin(d: WaitDeps, start: LiveLogin | null, intervalMs?: number, timeoutMs?: number): Promise<LiveLogin | null>` (defaults 2000 and 300000).

- [ ] **Step 1: Write the failing tests**

Create `test/waitForNewLogin.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { waitForNewLogin, WaitDeps } from "../src/accounts/switcher";
import { LiveLogin } from "../src/types";
import { creds, CRED_FILE } from "./helpers/fakeLogin";

const login = (uuid: string, tok: string): LiveLogin =>
  ({ credentialsRaw: creds(tok), oauthAccount: { accountUuid: uuid }, source: { kind: "file", path: CRED_FILE } });

function deps(reads: (LiveLogin | null)[], cancelAfter = Infinity): WaitDeps & { calls: () => number } {
  let t = 0, i = 0;
  return {
    readLogin: () => reads[Math.min(i++, reads.length - 1)],
    sleep: async (ms) => { t += ms; },
    now: () => t,
    cancelled: () => i >= cancelAfter,
    calls: () => i,
  };
}

const A = login("uuid-a", "tok-a");

describe("waitForNewLogin", () => {
  it("returns the new login once the account changes", async () => {
    const d = deps([A, A, login("uuid-b", "tok-b")]);
    expect((await waitForNewLogin(d, A))?.oauthAccount.accountUuid).toBe("uuid-b");
    expect(d.calls()).toBe(3);
  });

  it("ignores a half-written login (new account block, old tokens) until the tokens change too", async () => {
    const d = deps([login("uuid-b", "tok-a"), login("uuid-b", "tok-b")]);
    const got = await waitForNewLogin(d, A);
    expect(got?.credentialsRaw).toBe(creds("tok-b"));
    expect(d.calls()).toBe(2);
  });

  it("returns null after the timeout", async () => {
    const d = deps([A]);
    expect(await waitForNewLogin(d, A, 2000, 10_000)).toBeNull();
    expect(d.calls()).toBe(5);
  });

  it("checks once more after cancel, so closing the terminal right after logging in still counts", async () => {
    const d = deps([login("uuid-b", "tok-b")], 0); // terminal already closed before the first check
    expect((await waitForNewLogin(d, A))?.oauthAccount.accountUuid).toBe("uuid-b");
    expect(d.calls()).toBe(1);
  });

  it("stops when cancelled with no new login", async () => {
    const d = deps([A], 1);
    expect(await waitForNewLogin(d, A)).toBeNull();
    expect(d.calls()).toBe(1);
  });

  it("with nobody logged in at the start, any login counts", async () => {
    const d = deps([null, login("uuid-b", "tok-b")]);
    expect((await waitForNewLogin(d, null))?.oauthAccount.accountUuid).toBe("uuid-b");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/waitForNewLogin.test.ts`
Expected: FAIL, because `waitForNewLogin` isn't exported.

- [ ] **Step 3: Implement**

Append to `src/accounts/switcher.ts`:

```ts
export interface WaitDeps {
  readLogin: () => LiveLogin | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  cancelled: () => boolean;
}

/**
 * Spec §4.2 step 3. A login counts as new only when both the account and its
 * access token differ from `start`: Claude Code writes the two at slightly
 * different moments, and a half-written login would pair B's identity with
 * A's tokens. Checks once more after cancellation, so closing the terminal
 * right after logging in still counts.
 */
export async function waitForNewLogin(
  d: WaitDeps, start: LiveLogin | null, intervalMs = 2000, timeoutMs = 5 * 60_000,
): Promise<LiveLogin | null> {
  const startUuid = start?.oauthAccount.accountUuid ?? null;
  const startToken = start ? oauthOf(start.credentialsRaw)?.accessToken ?? null : null;
  const deadline = d.now() + timeoutMs;
  for (;;) {
    await d.sleep(intervalMs);
    const live = d.readLogin();
    if (live && live.oauthAccount.accountUuid !== startUuid
        && oauthOf(live.credentialsRaw)?.accessToken !== startToken) {
      return live;
    }
    if (d.cancelled() || d.now() >= deadline) { return null; }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/waitForNewLogin.test.ts test/switcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts/switcher.ts test/waitForNewLogin.test.ts
git commit -m "Accounts: wait for a new login during Add Account"
```

---

### Task 8: Labels, the quota/account guard, and the switcher menu

**Files:**
- Modify: `src/format.ts` (append)
- Create: `src/accounts/menu.ts`
- Test: `test/format.test.ts` (append), `test/menu.test.ts`

**Interfaces:**
- Consumes: `SavedAccountMeta`, `QuotaData` (Task 2).
- Produces: `type AccountDisplay = "email" | "name" | "off"`, `accountLabel(meta, mode): string | null`, `accountDetail(meta): string`, `formatAgo(ms): string`, `quotaForAccount(q, activeUuid): QuotaData | null`; `type MenuAction`, `interface MenuItem { label: string; description?: string; action: MenuAction }`, `switcherItems(accounts, activeUuid, nowMs): MenuItem[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/format.test.ts` (and add `accountLabel, accountDetail, formatAgo, quotaForAccount` to its import from `../src/format`):

```ts
describe("account labels", () => {
  const m = { email: "a@x.com", displayName: "Ann", organizationName: "Personal", subscriptionType: "max" };

  it("accountLabel follows the display setting", () => {
    expect(accountLabel(m, "email")).toBe("$(account) a@x.com");
    expect(accountLabel(m, "name")).toBe("$(account) Ann");
    expect(accountLabel({ ...m, displayName: null }, "name")).toBe("$(account) a@x.com");
    expect(accountLabel(m, "off")).toBeNull();
    expect(accountLabel(null, "email")).toBe("$(account) Not logged in");
    expect(accountLabel(null, "off")).toBeNull();
  });

  it("accountDetail joins name, org and capitalised plan, skipping blanks", () => {
    expect(accountDetail(m)).toBe("Ann · Personal · Max");
    expect(accountDetail({ displayName: null, organizationName: null, subscriptionType: "pro" })).toBe("Pro");
    expect(accountDetail({ displayName: null, organizationName: null, subscriptionType: null })).toBe("");
  });

  it("formatAgo", () => {
    expect(formatAgo(30_000)).toBe("just now");
    expect(formatAgo(5 * 60_000)).toBe("5m ago");
    expect(formatAgo(3 * 3_600_000)).toBe("3h ago");
    expect(formatAgo(3 * 86_400_000)).toBe("3d ago");
  });
});

describe("quotaForAccount", () => {
  it("hides a snapshot fetched for another account", () => {
    const q = { ...quota(42, 70), accountUuid: "uuid-a" };
    expect(quotaForAccount(q, "uuid-a")).toBe(q);
    expect(quotaForAccount(q, "uuid-b")).toBeNull();
  });
  it("keeps untagged (pre-0.3.0) snapshots and shows the cache when nobody is logged in", () => {
    const q = quota(42, 70);
    expect(quotaForAccount(q, "uuid-b")).toBe(q);
    const tagged = { ...q, accountUuid: "uuid-a" };
    expect(quotaForAccount(tagged, null)).toBe(tagged);
    expect(quotaForAccount(null, "uuid-a")).toBeNull();
  });
});
```

Create `test/menu.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { switcherItems } from "../src/accounts/menu";
import { SavedAccountMeta } from "../src/types";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const acct = (uuid: string, email: string, lastUsedAt: string | null, extra: Partial<SavedAccountMeta> = {}): SavedAccountMeta =>
  ({ accountUuid: uuid, email, displayName: null, organizationName: null, subscriptionType: null, lastUsedAt, ...extra });

describe("switcherItems", () => {
  it("puts the active account first with a check, others by most recent use, then actions", () => {
    const items = switcherItems([
      acct("old", "old@x.com", "2026-09-20T12:00:00Z"),
      acct("me", "me@x.com", "2026-09-27T11:00:00Z", { displayName: "Me", subscriptionType: "max" }),
      acct("new", "new@x.com", "2026-09-24T12:00:00Z", { organizationName: "Team" }),
      acct("never", "never@x.com", null),
    ], "me", NOW);

    expect(items.map((i) => i.label)).toEqual([
      "$(check) me@x.com", "$(blank) new@x.com", "$(blank) old@x.com", "$(blank) never@x.com",
      "", "$(add) Add account…", "$(trash) Remove saved account…",
    ]);
    expect(items[0]).toMatchObject({ description: "Me · Max · active", action: { kind: "active" } });
    expect(items[1]).toMatchObject({ description: "Team · last used 3d ago", action: { kind: "switch", uuid: "new" } });
    expect(items[3].description).toBe("never used here");
    expect(items[4].action).toEqual({ kind: "separator" });
    expect(items[5].action).toEqual({ kind: "add" });
    expect(items[6].action).toEqual({ kind: "remove" });
  });

  it("with no saved accounts, offers only Add", () => {
    expect(switcherItems([], null, NOW).map((i) => i.action.kind)).toEqual(["add"]);
  });

  it("offers Remove only when there is a non-active account to remove", () => {
    expect(switcherItems([acct("me", "me@x.com", null)], "me", NOW).map((i) => i.action.kind))
      .toEqual(["active", "separator", "add"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/format.test.ts test/menu.test.ts`
Expected: FAIL, because the new exports and module don't exist.

- [ ] **Step 3: Implement the formatters**

Append to `src/format.ts`:

```ts
export type AccountDisplay = "email" | "name" | "off";
type AccountNames = { email: string; displayName: string | null };
type AccountDetails = { displayName: string | null; organizationName: string | null; subscriptionType: string | null };

/** Status-bar text for the account item, or null when it should be hidden. */
export function accountLabel(meta: AccountNames | null, mode: AccountDisplay): string | null {
  if (mode === "off") { return null; }
  if (!meta) { return "$(account) Not logged in"; }
  return `$(account) ${mode === "name" ? (meta.displayName ?? meta.email) : meta.email}`;
}

/** "Your Name · Personal · Max", skipping blanks. */
export function accountDetail(m: AccountDetails): string {
  const plan = m.subscriptionType ? m.subscriptionType[0].toUpperCase() + m.subscriptionType.slice(1) : null;
  return [m.displayName, m.organizationName, plan].filter(Boolean).join(" · ");
}

export function formatAgo(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) { return "just now"; }
  if (mins < 60) { return `${mins}m ago`; }
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// A cached snapshot tagged with a different account belongs to the previous
// login: hide it until the active account's quota arrives. Untagged (pre-0.3.0)
// snapshots, and any snapshot while nobody is logged in, are shown as before.
export function quotaForAccount(q: QuotaData | null, activeUuid: string | null): QuotaData | null {
  if (!q || !q.accountUuid || !activeUuid) { return q; }
  return q.accountUuid === activeUuid ? q : null;
}
```

- [ ] **Step 4: Implement the menu**

Create `src/accounts/menu.ts`:

```ts
import { SavedAccountMeta } from "../types";
import { accountDetail, formatAgo } from "../format";

export type MenuAction =
  | { kind: "active" } | { kind: "switch"; uuid: string }
  | { kind: "add" } | { kind: "remove" } | { kind: "separator" };
export interface MenuItem { label: string; description?: string; action: MenuAction }

/** Spec §5.2: the active account (✓) first, the rest by most recent use, then actions. */
export function switcherItems(accounts: SavedAccountMeta[], activeUuid: string | null, nowMs: number): MenuItem[] {
  const active = accounts.find((a) => a.accountUuid === activeUuid);
  const others = accounts
    .filter((a) => a.accountUuid !== activeUuid)
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");

  const items: MenuItem[] = [];
  if (active) {
    items.push({ label: `$(check) ${active.email}`, description: join(accountDetail(active), "active"), action: { kind: "active" } });
  }
  for (const a of others) {
    const used = a.lastUsedAt ? `last used ${formatAgo(nowMs - Date.parse(a.lastUsedAt))}` : "never used here";
    items.push({ label: `$(blank) ${a.email}`, description: join(accountDetail(a), used), action: { kind: "switch", uuid: a.accountUuid } });
  }
  if (items.length > 0) { items.push({ label: "", action: { kind: "separator" } }); }
  items.push({ label: "$(add) Add account…", action: { kind: "add" } });
  if (others.length > 0) { items.push({ label: "$(trash) Remove saved account…", action: { kind: "remove" } }); }
  return items;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add src/format.ts src/accounts/menu.ts test/format.test.ts test/menu.test.ts
git commit -m "Accounts: status-bar labels, quota/account guard, switcher menu items"
```

---

### Task 9: Wire it into VS Code

**Files:**
- Modify: `package.json` (`contributes.commands`, `contributes.configuration`)
- Create: `src/accountStatusBar.ts`
- Modify: `src/treeProvider.ts:26-40`
- Modify: `src/dashboard/panel.ts:11-17`
- Modify: `media/dashboard.js:2` and `:100`
- Modify: `src/extension.ts`
- Modify: `test/integration/activation.test.ts`

**Interfaces:**
- Consumes: everything above: `AccountStore`, `defaultLoginDeps`, `readLogin`, `defaultHttpPost`, `syncActive`, `switchTo`, `waitForNewLogin`, `switcherItems`, `MenuAction`, `accountLabel`, `accountDetail`, `AccountDisplay`, `quotaForAccount`.
- Produces: commands `claudeUsage.switchAccount`, `claudeUsage.addAccount`, `claudeUsage.removeAccount`; setting `claudeUsage.account.display`; `AccountStatusBar`; `UsageTreeProvider.setData(summary, quota, account: string | null)`; `DashboardState.account: string | null`.

- [ ] **Step 1: Write the failing integration assertion**

In `test/integration/activation.test.ts`, after `assert.ok(cmds.includes("claudeUsage.openSection"));` add:

```ts
    assert.ok(cmds.includes("claudeUsage.switchAccount"));
    assert.ok(cmds.includes("claudeUsage.addAccount"));
    assert.ok(cmds.includes("claudeUsage.removeAccount"));
```

- [ ] **Step 2: Contribute the commands and setting**

In `package.json`, replace the `"commands"` array with:

```json
    "commands": [
      { "command": "claudeUsage.switchAccount", "title": "Switch Account", "category": "Claude Usage", "icon": "$(account)" },
      { "command": "claudeUsage.addAccount", "title": "Add Account", "category": "Claude Usage" },
      { "command": "claudeUsage.removeAccount", "title": "Remove Saved Account", "category": "Claude Usage" },
      { "command": "claudeUsage.refresh", "title": "Refresh", "category": "Claude Usage", "icon": "$(refresh)" },
      { "command": "claudeUsage.showDashboard", "title": "Show Dashboard", "category": "Claude Usage" },
      { "command": "claudeUsage.openSection", "title": "Open Section", "category": "Claude Usage" }
    ],
```

In `contributes.configuration.properties`, after `claudeUsage.currency`, add:

```json
        "claudeUsage.account.display": {
          "type": "string", "enum": ["email", "name", "off"], "default": "email",
          "description": "What the account status-bar item shows: the account's email, its display name, or nothing (hidden)."
        }
```

(Add the comma after the preceding `claudeUsage.currency` block.)

- [ ] **Step 3: Create the account status-bar item**

Create `src/accountStatusBar.ts`:

```ts
import * as vscode from "vscode";
import { SavedAccountMeta } from "./types";
import { accountLabel, accountDetail, AccountDisplay } from "./format";

export class AccountStatusBar {
  private item: vscode.StatusBarItem;
  constructor() {
    // Priority 101 > the quota badge's 100, so this sits to its left.
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  }

  update(account: SavedAccountMeta | null): void {
    const mode = vscode.workspace.getConfiguration("claudeUsage").get<AccountDisplay>("account.display", "email");
    const text = accountLabel(account, mode);
    if (!text) { this.item.hide(); return; }
    this.item.text = text;
    this.item.command = account ? "claudeUsage.switchAccount" : "claudeUsage.addAccount";
    const md = new vscode.MarkdownString();
    if (account) {
      md.appendText([account.email, accountDetail(account)].filter(Boolean).join(" · "));
      md.appendMarkdown("\n\nClick to switch accounts");
    } else {
      md.appendMarkdown("Claude Code isn't logged in.\n\nClick to add an account");
    }
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void { this.item.dispose(); }
}
```

- [ ] **Step 4: Label the Quota section with the account**

In `src/treeProvider.ts`, change `setData` and the quota node:

```ts
  private account: string | null = null;

  setData(summary: UsageSummary | null, quota: QuotaData | null, account: string | null = null): void {
    this.summary = summary; this.quota = quota; this.account = account; this._onDidChange.fire();
  }
```

and replace

```ts
      new SectionNode("quota", "Quota", fh),
```

with

```ts
      new SectionNode("quota", this.account ? `Quota — ${this.account}` : "Quota", fh),
```

In `src/dashboard/panel.ts`, add to `DashboardState` after `stale: boolean;`:

```ts
  account: string | null;      // active account's label, for the Quota heading
```

In `media/dashboard.js`, change line 2 to:

```js
let state = { summary: null, quota: null, error: null, section: "overview", stale: false, account: null };
```

and in the `"quota"` case replace `<h3>Quota windows</h3>` with:

```js
<h3>Quota windows${state.account ? " — " + esc(state.account) : ""}</h3>
```

- [ ] **Step 5: Wire up `extension.ts`**

Imports: change the `./format` import and add the new ones:

```ts
import { quotaAgeMs, quotaForAccount, accountDetail } from "./format";
import { AccountStore } from "./accounts/accountStore";
import { defaultLoginDeps, readLogin } from "./accounts/claudeLogin";
import { defaultHttpPost } from "./accounts/tokenRefresh";
import { syncActive, switchTo, waitForNewLogin } from "./accounts/switcher";
import { switcherItems, MenuAction } from "./accounts/menu";
import { AccountStatusBar } from "./accountStatusBar";
```

and add `SavedAccountMeta` to the `./types` import.

After the `FILE_INDEX` constant add:

```ts
// Task 1 confirmed this opens the login flow directly. (If it hadn't, this would
// be "claude" plus a "Type /login in the terminal" notice in addAccount.)
const LOGIN_COMMAND = "claude /login";
const SECTIONS: { section: Section; label: string }[] = [
  { section: "overview", label: "Overview" }, { section: "quota", label: "Quota" },
  { section: "projects", label: "Project Usage" }, { section: "models", label: "Model Usage" },
  { section: "sessions", label: "Sessions" },
];
```

After `const tree = new UsageTreeProvider();` and its `context.subscriptions.push(...)`, add:

```ts
  const accountBar = new AccountStatusBar();
  const accounts = new AccountStore(context.secrets, context.globalState);
  const loginDeps = defaultLoginDeps();
  let activeAccount: SavedAccountMeta | null = null;
  let accountBusy = false;
  context.subscriptions.push(accountBar);
```

Replace the `DashboardPanel` state getter with:

```ts
    () => ({
      summary, quota: quotaForAccount(quota, activeAccount?.accountUuid ?? null), error: quotaError,
      stale: quotaError != null && quota != null, account: activeAccount?.email ?? null,
    }),
```

Replace `pushUi` with:

```ts
  function pushUi(): void {
    const shown = quotaForAccount(quota, activeAccount?.accountUuid ?? null);
    accountBar.update(activeAccount);
    statusBar.update(shown, quotaError);
    tree.setData(summary, shown, activeAccount?.email ?? null);
    dashboard.update();
  }
```

Replace `refreshQuota` with:

```ts
  // Auto-save (spec §4.3): runs on every quota refresh: startup, poll, focus.
  async function refreshAccount(): Promise<void> {
    try {
      const live = await syncActive(loginDeps, accounts);
      activeAccount = live ? accounts.list().find((m) => m.accountUuid === live.oauthAccount.accountUuid) ?? null : null;
    } catch { /* keep the last known account; saving is retried on the next refresh */ }
  }

  async function refreshQuota(): Promise<void> {
    await refreshAccount();
    const creds = resolveToken(defaultCredentialDeps());
    const res = await fetchQuota({ token: creds.token }, defaultHttpGet(), () => new Date().toISOString());
    if (res.ok) {
      quota = { ...res.data, accountUuid: activeAccount?.accountUuid ?? null }; quotaError = null;
      await context.globalState.update(QUOTA_CACHE, quota);
    } else {
      quotaError = res.error; // keep last-good `quota` for the stale badge
    }
  }
```

Replace the three existing `registerCommand` lines with:

```ts
    vscode.commands.registerCommand("claudeUsage.refresh", () => refreshAll()),
    vscode.commands.registerCommand("claudeUsage.showDashboard", () => dashboard.show()),
    vscode.commands.registerCommand("claudeUsage.openSection", async (section?: Section) => {
      const s = section ?? (await vscode.window.showQuickPick(
        SECTIONS.map((x) => ({ label: x.label, section: x.section })), { placeHolder: "Open a dashboard section" }))?.section;
      if (s) { dashboard.show(s); }
    }),
    vscode.commands.registerCommand("claudeUsage.switchAccount", () => switchAccount()),
    vscode.commands.registerCommand("claudeUsage.addAccount", () => addAccount()),
    vscode.commands.registerCommand("claudeUsage.removeAccount", () => removeAccount()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration("claudeUsage")) { pushUi(); } }),
```

After the window-focus handler (before `// Initial load`), add the account commands:

```ts
  // ---------- Accounts ----------
  async function afterAccountChange(): Promise<void> {
    await refreshQuota();
    if (!quotaError) { backoffSteps = 0; }
    pushUi();
    scheduleQuotaPoll();
  }

  async function switchAccount(): Promise<void> {
    const items = switcherItems(accounts.list(), activeAccount?.accountUuid ?? null, Date.now())
      .map((it): vscode.QuickPickItem & { action: MenuAction } => it.action.kind === "separator"
        ? { label: "", kind: vscode.QuickPickItemKind.Separator, action: it.action }
        : { label: it.label, description: it.description, action: it.action });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "Switch Claude Code account" });
    if (!pick) { return; }
    if (pick.action.kind === "add") { return addAccount(); }
    if (pick.action.kind === "remove") { return removeAccount(); }
    if (pick.action.kind === "switch") { return runSwitch(pick.action.uuid); }
  }

  // One account change at a time. Returns undefined when another is running.
  async function exclusive<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (accountBusy) { void vscode.window.showInformationMessage("An account change is already in progress."); return undefined; }
    accountBusy = true;
    try { return await fn(); } finally { accountBusy = false; }
  }

  async function runSwitch(uuid: string): Promise<void> {
    const target = accounts.list().find((m) => m.accountUuid === uuid);
    if (!target) { return; }
    const res = await exclusive(async () => vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Switching to ${target.email}…` },
      () => switchTo(uuid, { login: loginDeps, store: accounts, httpPost: defaultHttpPost(), now: Date.now })));
    if (!res) { return; }

    if (res.ok) {
      await afterAccountChange();
      void vscode.window.showInformationMessage(
        `Switched to ${res.account.email}. Restart any running Claude Code sessions so they pick it up.`);
    } else if (res.reason === "expired") {
      const again = await vscode.window.showWarningMessage(`${target.email}'s saved login has expired.`, "Log in again");
      if (again) { await addAccount(); }
    } else {
      const tail = res.restored === true ? " Your previous account was restored."
        : res.restored === false ? " Claude Code's login may be incomplete. Run `claude /login` if it stops working." : "";
      void vscode.window.showErrorMessage(`Couldn't switch to ${target.email}: ${res.message}.${tail}`);
      await afterAccountChange();
    }
  }

  async function addAccount(): Promise<void> {
    const added = await exclusive(async () => {
      const start = await syncActive(loginDeps, accounts);
      const term = vscode.window.createTerminal({ name: "Claude login" });
      term.show();
      term.sendText(LOGIN_COMMAND);
      let closed = false;
      const sub = vscode.window.onDidCloseTerminal((t) => { if (t === term) { closed = true; } });
      try {
        const live = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: "Waiting for Claude login…" },
          () => waitForNewLogin({
            readLogin: () => readLogin(loginDeps),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            now: Date.now,
            cancelled: () => closed,
          }, start));
        if (live) {
          await accounts.save({ credentialsRaw: live.credentialsRaw, oauthAccount: live.oauthAccount });
          await accounts.touch(live.oauthAccount.accountUuid, new Date().toISOString());
        }
        return live;
      } finally { sub.dispose(); }
    });
    if (!added) { return; }

    await afterAccountChange();
    const email = accounts.list().find((m) => m.accountUuid === added.oauthAccount.accountUuid)?.email ?? "account";
    void vscode.window.showInformationMessage(`Added ${email}.`);
  }

  async function removeAccount(): Promise<void> {
    const removable = accounts.list().filter((m) => m.accountUuid !== activeAccount?.accountUuid);
    if (removable.length === 0) {
      void vscode.window.showInformationMessage("No saved accounts to remove. The active account can't be removed while it's logged in.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      removable.map((m) => ({ label: m.email, description: accountDetail(m), uuid: m.accountUuid })),
      { placeHolder: "Remove a saved account" });
    if (!pick) { return; }
    const confirm = await vscode.window.showWarningMessage(
      `Remove the saved login for ${pick.label}? This doesn't log you out of Claude Code.`, { modal: true }, "Remove");
    if (confirm !== "Remove") { return; }
    await accounts.remove(pick.uuid);
    pushUi();
  }
```

- [ ] **Step 6: Typecheck, unit-test, build**

Run: `npx tsc --noEmit -p tsconfig.json && npm run test:unit && npm run build`
Expected: no type errors; all unit tests pass; build succeeds.

- [ ] **Step 7: Run the integration test**

Run: `npm run test:integration`
Expected: `activation › registers commands` passes. (It downloads VS Code stable on first run.)

- [ ] **Step 8: Commit**

```bash
git add package.json src/accountStatusBar.ts src/treeProvider.ts src/dashboard/panel.ts media/dashboard.js src/extension.ts test/integration/activation.test.ts
git commit -m "Accounts: status-bar account item, switch/add/remove commands, palette category"
```

---

### Task 10: Docs, version bump, end-to-end check

**Files:**
- Modify: `README.md`
- Modify: `package.json` (`version`), `package-lock.json`

**Interfaces:**
- Consumes: the finished feature.
- Produces: `0.3.0` `.vsix`.

- [ ] **Step 1: Update the README**

In `README.md`, after the first bullet list (the two features), add a third bullet:

```markdown
- **Multiple accounts** — every Claude account you log into is saved; switch Claude Code between them from the status bar (**Claude Usage: Switch Account**), add one with **Claude Usage: Add Account**.
```

Replace the `## Privacy` paragraph with:

```markdown
No telemetry. The only network calls are to `api.anthropic.com` (quota), the configured pricing URL, and — only when you switch to a saved account whose login has expired — Anthropic's auth server (`platform.claude.com`) to renew it. Your transcripts never leave your machine.

Saved accounts' logins are kept only in VS Code's SecretStorage (encrypted by your OS keychain), never in settings or plain files.
```

Append to `## Caveats`:

```markdown
- **Switching accounts rewrites Claude Code's stored login** (the Keychain item or `.credentials.json`, and `oauthAccount` in `~/.claude.json`). Restart any running Claude Code sessions afterwards; otherwise one may write the old account back when it renews its token.
- Renewing a saved account's login uses Claude Code's **undocumented** token endpoint, which may change.
- Usage & cost are **machine-wide**: transcripts don't record which account made each request. Only the quota follows the active account.
```

Replace the `## Settings` line with:

```markdown
`claudeUsage.statusBar.mode`, `claudeUsage.statusBar.colorFrom`, `claudeUsage.clockFormat`, `claudeUsage.pollIntervalSeconds`, `claudeUsage.pricingUrl`, `claudeUsage.currency`, `claudeUsage.account.display` (`email` / `name` / `off`).
```

- [ ] **Step 2: Bump the version to 0.3.0**

Run: `sed -i '' 's/"version": "0.2.0"/"version": "0.3.0"/' package.json && npm install --package-lock-only --silent`
Expected: `package.json` and `package-lock.json` both say `0.3.0` (the lockfile's stale `name` also gets corrected).

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit -p tsconfig.json && npm run test:unit && npm run build && npm run test:integration && npm run package`
Expected: all pass; `farcomms-claude-code-quota-dashboard-0.3.0.vsix` is produced.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json package-lock.json
git commit -m "Multi-account switching docs; bump 0.3.0"
```

- [ ] **Step 5: Manual end-to-end check with the user (spec §7)**

Ask the user to install the `.vsix` (`code --install-extension farcomms-claude-code-quota-dashboard-0.3.0.vsix`), reload, and confirm:
1. The account item shows their email, to the **left** of the quota badge, and the quota badge ends with the 7-day `%`.
2. **Add Account** opens a "Claude login" terminal; after logging in as the second account, "Added …" appears and the account item updates.
3. **Switch Account** → the first account: no browser login, "Switched to …" appears, `claude` in a new terminal runs as that account, and the quota badge shows `—` briefly then that account's numbers.
4. Switch back the other way works too.
5. No macOS Keychain access prompt interrupts a switch (spec §2, assumption 5).
6. **Remove Saved Account** lists only the non-active account and asks for confirmation.
7. Every command appears under "Claude Usage:" in the command palette; **Open Section** from the palette shows a section picker.
8. `claudeUsage.account.display` = `name` / `off` changes or hides the item immediately.
```
