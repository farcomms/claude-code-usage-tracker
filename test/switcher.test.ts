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

  it("a failed account write that never landed still reads back as A: restored true", async () => {
    const { login, store, d } = setup({ failWrite: (p) => p === CLAUDE_JSON });
    await saveB(store);
    expect(await switchTo("uuid-b", d)).toMatchObject({ ok: false, reason: "write-failed", restored: true });
    expect(liveUuid(login)).toBe("uuid-a");
    expect(fileToken(login)).toBe("tok-a");
  });

  it("rollback reported as not restored when the Keychain rollback silently does nothing", async () => {
    let m = 0;
    const { login, store, d } = setup({
      platform: "darwin", files: { [CLAUDE_JSON]: claudeJson(A) },
      keychain: { account: "u", secret: creds("tok-a") },
      failWrite: (p) => p === CLAUDE_JSON && m++ === 0,
    });
    // Wrap keychainWrite: first write (B) succeeds, second (rollback A) is noop
    let n = 0;
    const orig = login.deps.keychainWrite;
    login.deps.keychainWrite = (a, s) => { if (n++ === 0) orig(a, s); };
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

  it("nobody logged in on macOS with a leftover credentials file: writes where Claude Code reads first", async () => {
    const { login, store, d } = setup({
      platform: "darwin",
      files: { [CLAUDE_JSON]: claudeJson(null), [CRED_FILE]: creds("left") },
      keychain: null,
    });
    await saveB(store);
    expect((await switchTo("uuid-b", d)).ok).toBe(true);
    expect(liveUuid(login)).toBe("uuid-b");
    expect(fileToken(login)).toBe("tok-b");
    expect(login.keychain).toBeNull();
  });
});
