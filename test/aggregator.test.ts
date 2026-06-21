import { describe, it, expect } from "vitest";
import { costOf, summarize } from "../src/aggregator";
import { UsageRecord, EditRecord, PriceMap } from "../src/types";

function edit(over: Partial<EditRecord>): EditRecord {
  return {
    toolUseId: "t", model: "claude-opus-4-8", timestamp: "2026-06-11T10:00:00Z",
    project: "Proj", projectPath: "/p", sessionId: "s",
    ext: ".ts", isCode: true, linesAdded: 10, linesRemoved: 0, ...over,
  };
}

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

  it("attributes accepted edit lines to totals, project, model, and code-only", () => {
    const recs = [rec({ project: "A", model: "claude-opus-4-8" })];
    const edits = [
      edit({ project: "A", model: "claude-opus-4-8", ext: ".ts", isCode: true, linesAdded: 40, linesRemoved: 5 }),
      edit({ project: "A", model: "claude-opus-4-8", ext: ".md", isCode: false, linesAdded: 100, linesRemoved: 0 }),
    ];
    const s = summarize(recs, prices, new Date("2026-06-11T12:00:00Z"), edits);
    expect(s.totals.linesAdded).toBe(140);
    expect(s.totals.linesAddedCode).toBe(40);   // markdown excluded from code-only
    expect(s.totals.linesRemoved).toBe(5);
    expect(s.today.linesAdded).toBe(140);
    expect(s.byProject[0]).toMatchObject({ project: "A", linesAdded: 140, linesAddedCode: 40 });
    expect(s.byModel[0]).toMatchObject({ model: "claude-opus-4-8", linesAdded: 140 });
  });

  it("counts edit lines even for a project/model with no token records", () => {
    const edits = [edit({ project: "Solo", model: "claude-fable-5", linesAdded: 7 })];
    const s = summarize([], prices, new Date("2026-06-11T12:00:00Z"), edits);
    expect(s.byProject.find((p) => p.project === "Solo")?.linesAdded).toBe(7);
    expect(s.byModel.find((m) => m.model === "claude-fable-5")?.linesAdded).toBe(7);
  });

  it("defaults to zero lines when no edits are passed", () => {
    const s = summarize([rec({})], prices, new Date("2026-06-11T12:00:00Z"));
    expect(s.totals.linesAdded).toBe(0);
    expect(s.totals.linesAddedCode).toBe(0);
  });

  it("buckets total tokens by hour (ascending) for the time-series chart", () => {
    const t = (input: number) => ({ input, output: 0, cacheRead: 0, cacheCreation: 0 });
    const recs = [
      rec({ timestamp: "2026-06-11T10:15:00Z", tokens: t(100) }),
      rec({ requestId: "r2", timestamp: "2026-06-11T10:45:00Z", tokens: t(50) }),
      rec({ requestId: "r3", timestamp: "2026-06-11T12:00:00Z", tokens: t(25) }),
    ];
    const s = summarize(recs, prices, new Date("2026-06-11T13:00:00Z"));
    expect(s.tokenByHour).toEqual([
      [Date.parse("2026-06-11T10:00:00Z"), 150],
      [Date.parse("2026-06-11T12:00:00Z"), 25],
    ]);
  });
});
