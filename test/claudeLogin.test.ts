import { describe, it, expect } from "vitest";
import { readLogin, oauthOf, withOauth, claudeJsonPath, defaultSource, writeCredentials, writeOauthAccount, keychainAddCommand, parseKeychainAccount } from "../src/accounts/claudeLogin";
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
  it("prefers an existing credentials file over the Keychain on macOS", () => {
    expect(defaultSource(fakeLogin({ platform: "darwin", files: { [CRED_FILE]: creds("left") } }).deps))
      .toEqual({ kind: "file", path: CRED_FILE });
  });
  it("uses the existing Keychain account attribute", () => {
    expect(defaultSource(fakeLogin({ platform: "darwin", keychain: { account: "someone", secret: creds("k") } }).deps))
      .toEqual({ kind: "keychain", account: "someone" });
  });
});

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
