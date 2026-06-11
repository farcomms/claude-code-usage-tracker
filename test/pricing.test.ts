import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePrices, priceForModel } from "../src/pricing";

const raw = JSON.parse(readFileSync(join(__dirname, "fixtures", "litellm-sample.json"), "utf8"));

describe("normalizePrices", () => {
  it("keeps only entries with input/output costs", () => {
    const m = normalizePrices(raw);
    expect(m["claude-opus-4-8"]).toEqual({ input: 0.000005, output: 0.000025, cacheRead: 0.0000005, cacheWrite: 0.00000625 });
    expect(m["sample_spec"]).toBeUndefined();
  });
});

describe("priceForModel", () => {
  it("matches exact id", () => {
    const m = normalizePrices(raw);
    expect(priceForModel("claude-opus-4-8", m)?.output).toBe(0.000025);
  });
  it("matches with anthropic/ prefix", () => {
    const m = normalizePrices(raw);
    expect(priceForModel("claude-sonnet-4-6", m)?.input).toBe(0.000003);
  });
  it("returns null for unknown model", () => {
    expect(priceForModel("gpt-9", normalizePrices(raw))).toBeNull();
  });
});

import { loadPrices } from "../src/pricing";

describe("loadPrices", () => {
  const fresh = JSON.stringify({ "m": { input_cost_per_token: 1, output_cost_per_token: 2 } });

  it("returns fresh normalized map when fetch succeeds", async () => {
    const r = await loadPrices("http://x", async () => fresh, null);
    expect(r.fromCache).toBe(false);
    expect(r.prices["m"]).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("falls back to cached map on fetch failure", async () => {
    const cached = { m2: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } };
    const r = await loadPrices("http://x", async () => { throw new Error("offline"); }, cached);
    expect(r.fromCache).toBe(true);
    expect(r.prices).toEqual(cached);
  });

  it("returns empty map when fetch fails and no cache", async () => {
    const r = await loadPrices("http://x", async () => { throw new Error("offline"); }, null);
    expect(r.prices).toEqual({});
  });
});
