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

  it("updates refreshTokenExpiresAt when the response includes refresh_token_expires_in", async () => {
    const r = await refreshCredentials(creds("a1", { refreshTokenExpiresAt: 5 }),
      reply(200, { access_token: "a2", refresh_token: "r2", expires_in: 3600, refresh_token_expires_in: 86400 }), NOW);
    expect(oauthOf((r as { credentialsRaw: string }).credentialsRaw)?.refreshTokenExpiresAt).toBe(NOW + 86_400_000);
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
