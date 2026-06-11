import { describe, it, expect } from "vitest";
import { formatDuration, formatUsd, formatTokens, statusBarText, utilizationColor } from "../src/format";
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
  it("5h mode shows pct + countdown", () => {
    expect(statusBarText(quota(42, 70), "5h", now)).toBe("$(cloud) 42% · 2h 14m");
  });
  it("7d mode", () => {
    expect(statusBarText(quota(42, 70), "7d", now)).toContain("7d 70%");
  });
  it("both mode", () => {
    expect(statusBarText(quota(42, 70), "both", now)).toBe("$(cloud) 5h 42% · 7d 70%");
  });
});

describe("utilizationColor", () => {
  it("thresholds at 60/80", () => {
    expect(utilizationColor(quota(50, 0), "5h")).toBeUndefined();
    expect(utilizationColor(quota(65, 0), "5h")).toBe("statusBarItem.warningBackground");
    expect(utilizationColor(quota(85, 0), "5h")).toBe("statusBarItem.errorBackground");
  });
});
