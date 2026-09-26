import { CredentialSource, LiveLogin, SavedAccountMeta } from "../types";
import { LoginDeps, defaultSource, oauthOf, readLogin, withOauth, writeCredentials, writeOauthAccount } from "./claudeLogin";
import { AccountStore } from "./accountStore";
import { HttpPost, needsRefresh, refreshCredentials } from "./tokenRefresh";

/** How long a login must stay unchanged before it is trusted enough to save. */
export const STABLE_READ_MS = 1500;

/**
 * Read the login twice, STABLE_READ_MS apart. Claude Code writes credentials and
 * `oauthAccount` at slightly different moments during `/login`, so a single read
 * can pair one account's identity with another's tokens. Stable means both reads
 * agree (both null, or the same credentials and account).
 */
async function readStable(login: LoginDeps, sleep: (ms: number) => Promise<void>):
    Promise<{ live: LiveLogin | null; stable: boolean }> {
  const first = readLogin(login);
  await sleep(STABLE_READ_MS);
  const live = readLogin(login);
  const stable = first && live
    ? first.credentialsRaw === live.credentialsRaw && first.oauthAccount.accountUuid === live.oauthAccount.accountUuid
    : first === live;
  return { live, stable };
}

/** The saved account whose access or refresh token matches these credentials', or null. */
export async function tokenOwner(store: AccountStore, credentialsRaw: string): Promise<string | null> {
  const t = oauthOf(credentialsRaw);
  if (!t) { return null; }
  for (const m of store.list()) {
    const s = await store.get(m.accountUuid);
    const saved = s ? oauthOf(s.credentialsRaw) : null;
    if (saved && (saved.accessToken === t.accessToken || (t.refreshToken && saved.refreshToken === t.refreshToken))) {
      return m.accountUuid;
    }
  }
  return null;
}

/**
 * Save a stable login unless its tokens belong to a different saved account
 * (e.g. A's identity with B's tokens after a failed rollback): saving that
 * would overwrite A's only refresh token. Returns whether the login's tokens
 * and identity match.
 */
async function saveIfMatched(store: AccountStore, live: LiveLogin): Promise<boolean> {
  const owner = await tokenOwner(store, live.credentialsRaw);
  if (owner !== null && owner !== live.oauthAccount.accountUuid) { return false; }
  await store.save({ credentialsRaw: live.credentialsRaw, oauthAccount: live.oauthAccount });
  return true;
}

/**
 * Save Claude Code's current login: adds new accounts and keeps the active
 * account's saved copy current as Claude Code rotates its tokens. It never
 * renews the active token: that would log out running Claude Code sessions.
 * Saves only a stable, matched login (see readStable, saveIfMatched).
 */
export async function syncActive(
  login: LoginDeps, store: AccountStore, sleep: (ms: number) => Promise<void>,
): Promise<LiveLogin | null> {
  const { live, stable } = await readStable(login, sleep);
  if (live && stable) { await saveIfMatched(store, live); }
  return live;
}

export interface SwitchDeps {
  login: LoginDeps;
  store: AccountStore;
  httpPost: HttpPost;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
export type SwitchFailure = "not-saved" | "expired" | "refresh-failed" | "write-failed" | "login-changing";
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
  //    A login that is mid-change is neither saved nor switched away from.
  const { live: before, stable } = await readStable(d.login, d.sleep);
  if (!stable) { return fail("login-changing", "Claude Code's login is changing right now; try again in a moment", null); }
  const matched = before ? await saveIfMatched(d.store, before) : false;
  // Already active, unless the live tokens are another account's: then write the target's.
  if (before?.oauthAccount.accountUuid === uuid && matched) { return { ok: true, account: meta() }; }

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

  // 3–4. Credentials first, then the account block. Only the token object is
  //      swapped into the live blob, so other entries in it (e.g. MCP servers'
  //      OAuth tokens) keep their current values.
  const dest = before?.source ?? defaultSource(d.login);
  const written = withOauth(before?.credentialsRaw ?? credentialsRaw, oauthOf(credentialsRaw)!);
  try { writeCredentials(d.login, dest, written); } catch (e) { return fail("write-failed", errMsg(e), null); }
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
  } catch {
    // Swallow errors and check what actually read back
  }
  // Verify restoration by reading back
  const now = readLogin(login);
  const restored = now?.oauthAccount.accountUuid === before.oauthAccount.accountUuid
    && oauthOf(now.credentialsRaw)?.accessToken === oauthOf(before.credentialsRaw)?.accessToken;
  return fail("write-failed", message, restored);
}

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
