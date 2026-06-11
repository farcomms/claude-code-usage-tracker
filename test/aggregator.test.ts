import { describe, it, expect } from "vitest";
import { costOf, summarize } from "../src/aggregator";
import { UsageRecord, PriceMap } from "../src/types";

const prices: PriceMap = {
  "claude-opus-4-8": { input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 },
};

function rec(over: Partial<UsageRecord>): UsageRecord {
  return {
    requestId: "r", messageId: "m", model: "claude-opus-4-8", timestamp: "2026-06-11T10:00:00Z",
    project: "Proj", projectPath: "/p", sessionId: "s",
    tokens: { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 }, ...over,
  };
}

describe("costOf", () => {
  it("sums per-token costs", () => {
    const c = costOf({ input: 1000, output: 1000, cacheRead: 2000, cacheCreation: 400 }, prices["claude-opus-4-8"]);
    // 1000*5e-6 + 1000*25e-6 + 2000*5e-7 + 400*6.25e-6 = 0.005 + 0.025 + 0.001 + 0.0025 = 0.0335
    expect(c).toBeCloseTo(0.0335, 6);
  });
});

describe("summarize", () => {
  it("rolls up by project/model/day and totals with cost", () => {
    const recs = [
      rec({ project: "A", model: "claude-opus-4-8" }),
      rec({ project: "B", model: "claude-opus-4-8", timestamp: "2026-06-10T10:00:00Z" }),
    ];
    const s = summarize(recs, prices, new Date("2026-06-11T12:00:00Z"));
    expect(s.totals.totalTokens).toBe(4000);
    expect(s.byProject.map((p) => p.project).sort()).toEqual(["A", "B"]);
    expect(s.byModel[0].model).toBe("claude-opus-4-8");
    expect(s.byDay.map((d) => d.day)).toContain("2026-06-11");
    expect(s.today.totalTokens).toBe(2000);
    expect(s.totals.cost).toBeGreaterThan(0);
    expect(s.totals.costKnown).toBe(true);
  });

  it("flags costKnown=false when a model has no price", () => {
    const s = summarize([rec({ model: "mystery-model" })], prices, new Date("2026-06-11T12:00:00Z"));
    expect(s.totals.costKnown).toBe(false);
    expect(s.totals.cost).toBe(0);
  });

  it("builds sessions with message counts and time span", () => {
    const recs = [
      rec({ sessionId: "s1", timestamp: "2026-06-11T10:00:00Z" }),
      rec({ sessionId: "s1", requestId: "r2", timestamp: "2026-06-11T10:05:00Z" }),
    ];
    const s = summarize(recs, prices, new Date("2026-06-11T12:00:00Z"));
    expect(s.sessions[0]).toMatchObject({ sessionId: "s1", messages: 2, start: "2026-06-11T10:00:00Z", end: "2026-06-11T10:05:00Z" });
  });
});
