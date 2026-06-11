import { ModelPrice, PriceMap } from "./types";

export function normalizePrices(raw: any): PriceMap {
  const out: PriceMap = {};
  if (!raw || typeof raw !== "object") { return out; }
  for (const [key, v] of Object.entries<any>(raw)) {
    if (!v || typeof v.input_cost_per_token !== "number" || typeof v.output_cost_per_token !== "number") { continue; }
    out[key] = {
      input: v.input_cost_per_token,
      output: v.output_cost_per_token,
      cacheRead: v.cache_read_input_token_cost ?? 0,
      cacheWrite: v.cache_creation_input_token_cost ?? 0,
    };
  }
  return out;
}

export function priceForModel(model: string, prices: PriceMap): ModelPrice | null {
  if (prices[model]) { return prices[model]; }
  if (prices[`anthropic/${model}`]) { return prices[`anthropic/${model}`]; }
  // suffix match (e.g. provider-prefixed keys)
  const hit = Object.keys(prices).find((k) => k.endsWith(`/${model}`));
  return hit ? prices[hit] : null;
}

export type Fetcher = (url: string) => Promise<string>;
export interface LoadResult { prices: PriceMap; fromCache: boolean; }

export async function loadPrices(url: string, fetchText: Fetcher, cached: PriceMap | null): Promise<LoadResult> {
  try {
    const prices = normalizePrices(JSON.parse(await fetchText(url)));
    if (Object.keys(prices).length === 0) { throw new Error("empty price map"); }
    return { prices, fromCache: false };
  } catch {
    return { prices: cached ?? {}, fromCache: cached != null };
  }
}

export function defaultFetcher(): Fetcher {
  return async (url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try { const r = await fetch(url, { signal: ctrl.signal }); return await r.text(); }
    finally { clearTimeout(t); }
  };
}
