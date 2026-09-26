# Multi-Account Switching — Design

**Date:** 2026-09-27
**Status:** Approved design (pre-implementation)
**Branch:** `feat/statusbar-7d-percent` (ships in 0.3.0 alongside the status-bar 7-day percentage)

---

## 1. Goal

Let a user keep several Claude accounts on one machine and switch Claude Code between them from VS Code:

- **Save** every account the user logs into (automatically), plus an explicit **Add account** command.
- **Switch** Claude Code's actual login to any saved account in two clicks. The `claude` CLI, and the quota view that follows it, move to that account.
- **Show** the current account's email (or name) on the status bar.

Success: with two saved accounts, clicking the account item and picking the other account leaves `claude` running as that account, with the quota badge showing that account's numbers, and no browser login.

### Out of scope

- Per-account usage/cost. Local transcripts (`~/.claude/projects/*.jsonl`) don't record which account made a request, so usage and cost stay machine-wide. Only quota is per-account.
- An accounts section in the sidebar or dashboard. The status bar and the command palette are enough.
- Renewing the **active** account's token (see §4.3).

---

## 2. Key facts the design relies on

Claude Code keeps its login in two places:

| What | Where |
|---|---|
| OAuth credentials `{ claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, subscriptionType, … } }` | macOS: Keychain generic password, service `Claude Code-credentials`, account = OS username. Elsewhere: `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json`. |
| Account identity `oauthAccount: { accountUuid, emailAddress, displayName, organizationName, … }` | `~/.claude.json`. That file holds much else, all of which must be preserved. |

Refresh tokens **rotate**: renewing a token returns a new refresh token and invalidates the old one. Consequences:

- A saved copy of the **active** account goes stale whenever Claude Code renews it, so the extension keeps re-saving it (§4.3).
- The extension must never renew the active account's token, or running Claude Code sessions get logged out.
- A renewed token pair must be saved **before** anything else can fail.

### Assumptions to verify before building the rest (manual, with two real accounts)

1. **Critical:** logging in as account B via `/login` does **not** revoke account A's refresh token. If it does, saved accounts can't be switched back to and the feature doesn't work as designed. Verify first.
2. The token endpoint and request shape Claude Code uses for renewal (§4.4) are as described, or can be found in the installed Claude Code.
3. `claude /login` given as a startup argument opens the login flow. Fallback: launch `claude` and tell the user to type `/login`.
4. The exact field names in `oauthAccount` and `claudeAiOauth` match §2. Credentials and account blocks are stored verbatim, so only the fields the code reads (`accountUuid`, `emailAddress`, `displayName`, `organizationName`, `accessToken`, `refreshToken`, `expiresAt`, `subscriptionType`) matter.
5. Updating the Keychain item with `security add-generic-password -U` doesn't trigger an access prompt that breaks the flow.

---

## 3. Components

New folder `src/accounts/`. Like `credentials.ts`, each module takes its side effects (file reads and writes, Keychain, HTTP, clock) as an injected `deps` object, so it can be unit-tested with fakes.

### 3.1 `claudeLogin.ts` — Claude Code's current login

- `readLogin(deps): LiveLogin | null` → `{ credentialsRaw: string, credentials: object, oauthAccount: object, accountUuid: string }`. It reads credentials in the same order as `credentials.ts` (`CLAUDE_CONFIG_DIR` file → `~/.claude` file → macOS Keychain) and reads `oauthAccount` from `~/.claude.json`. It returns `null` if either part is missing.
- `writeCredentials(deps, raw: string)` writes to the same location the credentials were read from. On macOS that's the Keychain, via `security -i` with the command sent over **stdin** and the password hex-encoded with `-X`, so the secret never appears on a command line and needs no quote escaping. Otherwise the file is written with mode `0600` using a temp file plus rename.
- `writeOauthAccount(deps, account: object)` reads `~/.claude.json`, replaces only the `oauthAccount` key and writes it back through a temp file plus rename. Every other key is kept unchanged.

### 3.2 `accountStore.ts` — saved accounts

- **Secrets** live in `context.secrets` under key `claudeUsage.account.<accountUuid>`, with value `{ credentialsRaw, oauthAccount }`.
- **Index** lives in `globalState` under `claudeUsage.accounts` as `SavedAccountMeta[]`: `{ accountUuid, email, displayName, organizationName, subscriptionType, lastUsedAt }`. It contains **no tokens**.
- API: `list()`, `get(uuid)`, `save(login)` (inserts, or updates only if content changed), `remove(uuid)`, `touch(uuid)`.

### 3.3 `tokenRefresh.ts` — renewing a saved account's token

- `needsRefresh(creds, now)`: true when `expiresAt` is within 5 minutes of `now`, or missing.
- `refresh(creds, httpPost, now)` → `{ ok: true, credentials } | { ok: false, kind: "expired" | "network" | "bad-response" }`. A 400 or 401 with `invalid_grant` maps to `expired`. The result merges the new `accessToken`, `refreshToken` and `expiresAt` into a copy of the stored `claudeAiOauth` and keeps the rest.
- The endpoint URL and client ID are named constants next to `USAGE_URL`, with a comment saying they're undocumented (see §2, assumption 2).

### 3.4 `switcher.ts` — switching

- `switchTo(targetUuid, deps)` → `{ ok: true } | { ok: false, reason, restored: boolean }`. Implements §4.1.
- `syncActive(deps)`: auto-save and re-save (§4.3). Returns the active account's meta, or `null`.

### 3.5 `accountStatusBar.ts` — the account item

- `StatusBarItem` aligned right with **priority 101**, so it sits to the **left** of the quota badge (priority 100): `[ $(account) you@gmail.com ] [ ✱ 42% · 2h 14m · 70% ]`.
- Clicking it runs `claudeUsage.switchAccount`.

### 3.6 Changes to existing code

- `extension.ts`: create the store, the switcher and the account item. Call `syncActive` inside `refreshQuota()` before the fetch. Register the commands (§6).
- `format.ts`: add `accountLabel(meta, mode)` for the status-bar text.
- The `QuotaData` cache records `accountUuid`. If the cached snapshot belongs to a different account than the active one, it's thrown away and not shown (§5.4).
- `credentials.ts` is unchanged. The quota fetch keeps reading the live login, so it follows a switch automatically.

---

## 4. Flows

### 4.1 Switching from A to B

1. **Re-save the current login.** Run `readLogin`, then `store.save`. If it's an account that wasn't saved yet, it gets saved now, so a switch never loses an account. Keep this as `snapshotA`.
2. **Load B** from the store. If `needsRefresh`, call `refresh`:
   - If it fails with `expired`, stop with nothing written. Show *"b@x.com's saved login has expired"* with a **Log in again** button that runs Add account.
   - If it fails with `network` or `bad-response`, stop with nothing written and report the error.
   - If it succeeds, **save the renewed B to the store immediately**, before any other step.
3. **Write B's credentials** with `writeCredentials`. If that fails, stop and report. Nothing has changed.
4. **Write B's `oauthAccount`** with `writeOauthAccount`. If that fails, go to rollback.
5. **Verify** by calling `readLogin` again. The `accountUuid` and `accessToken` must match B. If not, go to rollback.
6. `store.touch(B)`, refresh the quota and the UI, then show *"Switched to b@x.com. Restart any running Claude Code sessions so they pick it up."*

**Rollback:** write back `snapshotA`'s credentials and `oauthAccount`, then report the original error. If the rollback fails as well, say so clearly, including that A is still saved and can be switched back to from the menu.

A progress notice (*"Switching to b@x.com…"*) is shown for the whole flow. Only one switch or add can run at a time.

### 4.2 Adding an account

1. Re-save the current login (step 1 of §4.1).
2. Open a VS Code terminal named **"Claude login"** that runs `claude /login`.
3. Check `readLogin` every 2 seconds, for at most 5 minutes. When `accountUuid` differs from the one at the start, save the new account, touch it, refresh the quota and UI, and show *"Added b@x.com"*. Stop checking if the terminal is closed or the time runs out. No error is shown in either case.
4. If nobody was logged in at the start, any login found counts as the new account.

### 4.3 Auto-save (`syncActive`)

This runs on every quota refresh: startup, each poll, and window focus.

- **No login:** the account item shows *Not logged in*.
- **Account not saved yet:** save it.
- **Account saved, but its credentials changed** (Claude Code renewed them): update the saved copy.
- **Never** renew the active account's token.

### 4.4 Token renewal request (to be confirmed, §2, assumption 2)

`POST` to Claude Code's OAuth token endpoint with JSON body `{ grant_type: "refresh_token", refresh_token, client_id }`. The response is `{ access_token, refresh_token, expires_in, … }`, and `expiresAt = now + expires_in * 1000`.

### 4.5 Removing a saved account

The menu lists saved accounts **except the active one**; otherwise auto-save would re-add it on the next refresh. Removing deletes the secret and its index entry. It never touches Claude Code's login.

---

## 5. UI

### 5.1 Status bar

- **Text:** set by `claudeUsage.account.display`:
  - `email` (default)
  - `name`: `displayName`, falling back to the email if missing
  - `off`: item hidden
- **Not logged in:** `$(account) Not logged in`. Clicking it runs Add account.
- **Tooltip:** `you@gmail.com · Your Name · Personal · Max`, then *"Click to switch accounts"*.
- **Colors:** none. The quota badge stays the only colored item.

### 5.2 Switcher (QuickPick)

```
  ✓ you@gmail.com            Your Name · Max · active
    work@company.com         Work Name · Team · last used 3d ago
  ─────────────────────────
  + Add account…
  🗑 Remove saved account…
```

- The active account comes first and is marked ✓. Picking it does nothing.
- The other accounts are sorted by `lastUsedAt`, most recent first.

### 5.3 Quota label

The sidebar's Quota label and the dashboard's Quota tab heading show the account they belong to, e.g. *"Quota — you@gmail.com"*.

### 5.4 Quota cache after a switch

The cached `QuotaData` records the account it was fetched for. If that account isn't the active one, the badge shows `—` until the new account's quota arrives, rather than showing the previous account's numbers.

---

## 6. Commands (all in the command palette, category `Claude Usage`)

| Command ID | Title | Notes |
|---|---|---|
| `claudeUsage.switchAccount` | Switch Account | New. Opens the §5.2 QuickPick. |
| `claudeUsage.addAccount` | Add Account | New. Runs §4.2. |
| `claudeUsage.removeAccount` | Remove Saved Account | New. Runs §4.5. |
| `claudeUsage.refresh` | Refresh | Existing. Gains the category. |
| `claudeUsage.showDashboard` | Show Dashboard | Existing. Gains the category. |
| `claudeUsage.openSection` | Open Section | Existing. With no argument (run from the palette), it opens a section QuickPick. |

Existing titles drop their `Claude Usage: ` prefix; the `category` field adds it back in the palette.

New setting: `claudeUsage.account.display`: `"email" | "name" | "off"`, default `"email"`.

---

## 7. Testing

### Unit tests (Vitest, fake deps)

- **`claudeLogin`:**
  - Reads in the right order: `CLAUDE_CONFIG_DIR`, then `~/.claude`, then the Keychain.
  - Returns `null` when either part is missing.
  - `writeOauthAccount` changes only `oauthAccount`; the other keys of `~/.claude.json` are deep-equal before and after.
  - The Keychain write sends the secret via stdin (hex-encoded) and never as a command argument.
- **`accountStore`:**
  - Save, update-only-on-change, list, remove and touch all work.
  - The `globalState` index never contains `accessToken` or `refreshToken`.
- **`tokenRefresh`:**
  - `needsRefresh` checks the 5-minute threshold.
  - The request is correct.
  - A successful response is merged into the stored credentials.
  - `invalid_grant` maps to `expired`; network errors and bad responses map to their own kinds.
- **`switcher`:**
  - A normal switch works.
  - An account that wasn't saved yet is saved during step 1.
  - A renewal failure writes nothing.
  - A renewed token is saved before any write.
  - A credentials-write failure changes nothing.
  - An `oauthAccount` write failure restores A.
  - A failed verification restores A.
  - A rollback failure is reported.
- **`format.accountLabel`:** covers `email`, `name`, the name-to-email fallback, and `off`.

### Integration test

The existing activation test is extended to check that the three new commands are registered.

### Manual check (before the rest of the implementation)

The §2 assumptions, checked with two real accounts:

1. Save A, log in as B, confirm A's saved refresh token still renews.
2. Confirm `claude /login` works as a startup argument.
3. Switch A → B → A and confirm `claude` uses the switched-to account each time.
4. Check that no Keychain prompt appears.

---

## 8. Docs

- **README Privacy:**
  - Saved accounts' tokens live only in VS Code SecretStorage, which the OS keychain encrypts, and never in settings or plain files.
  - The only new network call is token renewal to Anthropic's auth server, made only when switching to an account whose token has expired.
- **README Caveats:**
  - Switching rewrites Claude Code's stored login.
  - Restart any running Claude Code sessions after switching; otherwise one may write the old account back when it renews its token.
  - The token endpoint is undocumented and could change.
  - Usage and cost stay machine-wide.
- **README Settings:** add `claudeUsage.account.display`.
