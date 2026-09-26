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
