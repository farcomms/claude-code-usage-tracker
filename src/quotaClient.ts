import { QuotaBucket, QuotaData, ExtraUsage } from "./types";

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
