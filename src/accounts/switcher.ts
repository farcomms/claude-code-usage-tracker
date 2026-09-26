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
  } catch {
    // Swallow errors and check what actually read back
  }
  // Verify restoration by reading back
  const now = readLogin(login);
  const restored = now?.oauthAccount.accountUuid === before.oauthAccount.accountUuid
    && oauthOf(now.credentialsRaw)?.accessToken === oauthOf(before.credentialsRaw)?.accessToken;
  return fail("write-failed", message, restored);
}
