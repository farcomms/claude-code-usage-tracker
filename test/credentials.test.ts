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
