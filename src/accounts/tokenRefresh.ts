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
  if (typeof j.refresh_token_expires_in === "number") { next.refreshTokenExpiresAt = nowMs + j.refresh_token_expires_in * 1000; }
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
