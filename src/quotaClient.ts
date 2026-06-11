import { QuotaBucket, QuotaData, ExtraUsage, QuotaResult } from "./types";

function bucket(raw: any): QuotaBucket | null {
  if (!raw || typeof raw.utilization !== "number") { return null; }
  return { utilization: raw.utilization, resetsAt: raw.resets_at ?? null };
}
function extra(raw: any): ExtraUsage | null {
  if (!raw) { return null; }
  return {
    isEnabled: !!raw.is_enabled,
    monthlyLimit: raw.monthly_limit ?? null,
    usedCredits: raw.used_credits ?? null,
    utilization: raw.utilization ?? null,
    currency: raw.currency ?? null,
  };
}
export function parseQuota(raw: any, fetchedAtIso: string): QuotaData {
  return {
    fiveHour: bucket(raw?.five_hour),
    sevenDay: bucket(raw?.seven_day),
    sevenDaySonnet: bucket(raw?.seven_day_sonnet),
    sevenDayOpus: bucket(raw?.seven_day_opus),
    sevenDayOauthApps: bucket(raw?.seven_day_oauth_apps),
    extraUsage: extra(raw?.extra_usage),
    fetchedAt: fetchedAtIso,
  };
}

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const BETA_HEADER = "oauth-2025-04-20";

export interface HttpResponse { status: number; body: string; }
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

export async function fetchQuota(
  creds: { token: string | null },
  httpGet: HttpGet,
  now: () => string,
): Promise<QuotaResult> {
  if (!creds.token) {
    return { ok: false, error: { kind: "no-token", message: "Log in to Claude Code (run `claude`)." } };
  }
  let resp: HttpResponse;
  try {
    resp = await httpGet(USAGE_URL, {
      "Authorization": `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      "anthropic-beta": BETA_HEADER,
    });
  } catch (e) {
    return { ok: false, error: { kind: "network", message: String((e as Error)?.message ?? e) } };
  }
  if (resp.status === 401) { return { ok: false, error: { kind: "unauthorized", message: "Token expired — start a Claude Code session." } }; }
  if (resp.status === 403) { return { ok: false, error: { kind: "forbidden", message: "This endpoint needs a Claude Pro/Max subscription." } }; }
  if (resp.status === 429) { return { ok: false, error: { kind: "rate-limited", message: "Rate limited — backing off." } }; }
  if (resp.status < 200 || resp.status >= 300) { return { ok: false, error: { kind: "bad-response", message: `HTTP ${resp.status}` } }; }
  try {
    return { ok: true, data: parseQuota(JSON.parse(resp.body), now()) };
  } catch (e) {
    return { ok: false, error: { kind: "bad-response", message: "Unparseable response." } };
  }
}

// Production httpGet using Node's global fetch.
export function defaultHttpGet(): HttpGet {
  return async (url, headers) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      return { status: res.status, body: await res.text() };
    } finally { clearTimeout(t); }
  };
}
