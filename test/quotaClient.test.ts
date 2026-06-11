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

import { fetchQuota, HttpResponse } from "../src/quotaClient";

const okResp = (body: unknown): HttpResponse => ({ status: 200, body: JSON.stringify(body) });

describe("fetchQuota", () => {
  it("returns no-token error when token is null", async () => {
    const r = await fetchQuota({ token: null }, async () => okResp({}), () => "2026-06-11T19:00:00Z");
    expect(r).toEqual({ ok: false, error: { kind: "no-token", message: expect.any(String) } });
  });

  it("returns parsed data on 200", async () => {
    const r = await fetchQuota({ token: "t" }, async () => okResp(load("quota-full.json")), () => "2026-06-11T19:00:00Z");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.fiveHour?.utilization).toBe(42); }
  });

  it("maps 401 -> unauthorized", async () => {
    const r = await fetchQuota({ token: "t" }, async () => ({ status: 401, body: "" }), () => "x");
    expect(r).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
  });

  it("maps 403 -> forbidden", async () => {
    const r = await fetchQuota({ token: "t" }, async () => ({ status: 403, body: "" }), () => "x");
    expect(r).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("maps 429 -> rate-limited", async () => {
    const r = await fetchQuota({ token: "t" }, async () => ({ status: 429, body: "" }), () => "x");
    expect(r).toMatchObject({ ok: false, error: { kind: "rate-limited" } });
  });

  it("maps a thrown error -> network", async () => {
    const r = await fetchQuota({ token: "t" }, async () => { throw new Error("boom"); }, () => "x");
    expect(r).toMatchObject({ ok: false, error: { kind: "network" } });
  });
});
