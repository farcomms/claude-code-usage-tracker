import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuota } from "../src/quotaClient";

const load = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", f), "utf8"));

describe("parseQuota", () => {
  it("maps all buckets and extra usage", () => {
    const q = parseQuota(load("quota-full.json"), "2026-06-11T19:00:00Z");
    expect(q.fiveHour).toEqual({ utilization: 42, resetsAt: "2026-06-11T20:00:00Z" });
    expect(q.sevenDayOpus).toEqual({ utilization: 88, resetsAt: "2026-06-18T00:00:00Z" });
    expect(q.extraUsage).toEqual({
      isEnabled: true, monthlyLimit: 5000, usedCredits: 1234, utilization: 24.68, currency: "USD",
    });
    expect(q.fetchedAt).toBe("2026-06-11T19:00:00Z");
  });

  it("sets missing buckets to null", () => {
    const q = parseQuota(load("quota-partial.json"), "2026-06-11T19:00:00Z");
    expect(q.fiveHour?.utilization).toBe(10);
    expect(q.sevenDay).toBeNull();
    expect(q.extraUsage).toBeNull();
  });
});
