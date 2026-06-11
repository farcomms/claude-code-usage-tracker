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
