import { describe, it, expect } from "vitest";
import { formatDuration, formatUsd, formatTokens, statusBarText, utilizationColor, quotaAgeMs, accountLabel, accountDetail, formatAgo, quotaForAccount } from "../src/format";
import { QuotaData } from "../src/types";

function quota(fhUtil: number | null, sdUtil: number | null): QuotaData {
  return {
    fiveHour: fhUtil == null ? null : { utilization: fhUtil, resetsAt: "2026-06-11T20:00:00Z" },
    sevenDay: sdUtil == null ? null : { utilization: sdUtil, resetsAt: "2026-06-18T00:00:00Z" },
    sevenDaySonnet: null, sevenDayOpus: null, sevenDayOauthApps: null, extraUsage: null,
    fetchedAt: "2026-06-11T19:00:00Z",
  };
}

describe("formatDuration", () => {
  it("renders h/m", () => {
    expect(formatDuration(2 * 3600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatDuration(45 * 60_000)).toBe("45m");
    expect(formatDuration(-5)).toBe("now");
  });
});

describe("formatUsd / formatTokens", () => {
  it("formats dollars", () => { expect(formatUsd(4.2)).toBe("$4.20"); expect(formatUsd(0)).toBe("$0.00"); });
  it("formats token counts", () => {
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(9400)).toBe("9.4K");
    expect(formatTokens(420)).toBe("420");
  });
});

describe("statusBarText", () => {
  const now = new Date("2026-06-11T17:46:00Z"); // 2h14m before 20:00 reset
  it("5h mode shows pct + countdown, then 7d pct at the far right", () => {
    expect(statusBarText(quota(42, 70), "5h", now)).toBe("$(claude-logo) 42% · 2h 14m · 70%");
  });
  it("5h mode omits the 7d pct when the 7-day window is missing", () => {
    expect(statusBarText(quota(42, null), "5h", now)).toBe("$(claude-logo) 42% · 2h 14m");
  });
  it("7d mode", () => {
    expect(statusBarText(quota(42, 70), "7d", now)).toContain("7d 70%");
  });
  it("both mode", () => {
    expect(statusBarText(quota(42, 70), "both", now)).toBe("$(claude-logo) 5h 42% · 7d 70%");
  });
});

describe("quotaAgeMs", () => {
  const now = new Date("2026-06-11T19:01:40Z"); // 100s after fixture fetchedAt
  it("computes age from fetchedAt", () => {
    expect(quotaAgeMs(quota(42, 70), now)).toBe(100_000);
  });
  it("is Infinity for null or bad timestamps", () => {
    expect(quotaAgeMs(null, now)).toBe(Infinity);
    expect(quotaAgeMs({ ...quota(1, 1), fetchedAt: "garbage" }, now)).toBe(Infinity);
  });
});

describe("utilizationColor", () => {
  it("always badges; switches to error at 80", () => {
    expect(utilizationColor(null, "5h")).toBeUndefined();
    expect(utilizationColor(quota(50, 0), "5h")).toBe("statusBarItem.warningBackground");
    expect(utilizationColor(quota(65, 0), "5h")).toBe("statusBarItem.warningBackground");
    expect(utilizationColor(quota(85, 0), "5h")).toBe("statusBarItem.errorBackground");
  });
});

describe("account labels", () => {
  const m = { email: "a@x.com", displayName: "Ann", organizationName: "Personal", subscriptionType: "max" };

  it("accountLabel follows the display setting", () => {
    expect(accountLabel(m, "email")).toBe("$(account) a@x.com");
    expect(accountLabel(m, "name")).toBe("$(account) Ann");
    expect(accountLabel({ ...m, displayName: null }, "name")).toBe("$(account) a@x.com");
    expect(accountLabel(m, "off")).toBeNull();
    expect(accountLabel(null, "email")).toBe("$(account) Not logged in");
    expect(accountLabel(null, "off")).toBeNull();
  });

  it("accountDetail joins name, org and capitalised plan, skipping blanks", () => {
    expect(accountDetail(m)).toBe("Ann · Personal · Max");
    expect(accountDetail({ displayName: null, organizationName: null, subscriptionType: "pro" })).toBe("Pro");
    expect(accountDetail({ displayName: null, organizationName: null, subscriptionType: null })).toBe("");
  });

  it("formatAgo", () => {
    expect(formatAgo(30_000)).toBe("just now");
    expect(formatAgo(5 * 60_000)).toBe("5m ago");
    expect(formatAgo(3 * 3_600_000)).toBe("3h ago");
    expect(formatAgo(3 * 86_400_000)).toBe("3d ago");
  });
});

describe("quotaForAccount", () => {
  it("hides a snapshot fetched for another account", () => {
    const q = { ...quota(42, 70), accountUuid: "uuid-a" };
    expect(quotaForAccount(q, "uuid-a")).toBe(q);
    expect(quotaForAccount(q, "uuid-b")).toBeNull();
  });
  it("keeps untagged (pre-0.3.0) snapshots and shows the cache when nobody is logged in", () => {
    const q = quota(42, 70);
    expect(quotaForAccount(q, "uuid-b")).toBe(q);
    const tagged = { ...q, accountUuid: "uuid-a" };
    expect(quotaForAccount(tagged, null)).toBe(tagged);
    expect(quotaForAccount(null, "uuid-a")).toBeNull();
  });
});
