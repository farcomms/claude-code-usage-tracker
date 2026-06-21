import {
  UsageRecord, EditRecord, PriceMap, ModelPrice, TokenCounts, CostedTotals,
  ProjectRollup, ModelRollup, DayRollup, SessionRollup, UsageSummary,
} from "./types";
import { priceForModel } from "./pricing";

const ZERO: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation,
});
const sumTokens = (t: TokenCounts): number => t.input + t.output + t.cacheRead + t.cacheCreation;

export function costOf(t: TokenCounts, p: ModelPrice): number {
  return t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheCreation * p.cacheWrite;
}

function dayOf(iso: string): string { return (iso || "").slice(0, 10); }

interface Acc {
  tokens: TokenCounts; cost: number; costKnown: boolean;
  linesAdded: number; linesRemoved: number; linesAddedCode: number;
}
const emptyAcc = (): Acc => ({
  tokens: { ...ZERO }, cost: 0, costKnown: true,
  linesAdded: 0, linesRemoved: 0, linesAddedCode: 0,
});
function addRecord(acc: Acc, r: UsageRecord, prices: PriceMap): void {
  acc.tokens = addTokens(acc.tokens, r.tokens);
  const price = priceForModel(r.model, prices);
  if (price) { acc.cost += costOf(r.tokens, price); }
  else { acc.costKnown = false; }
}
function addEdit(acc: Acc, e: EditRecord): void {
  acc.linesAdded += e.linesAdded;
  acc.linesRemoved += e.linesRemoved;
  if (e.isCode) { acc.linesAddedCode += e.linesAdded; }
}
function toTotals(acc: Acc): CostedTotals {
  return {
    tokens: acc.tokens, totalTokens: sumTokens(acc.tokens), cost: acc.cost, costKnown: acc.costKnown,
    linesAdded: acc.linesAdded, linesRemoved: acc.linesRemoved, linesAddedCode: acc.linesAddedCode,
  };
}

export function summarize(records: UsageRecord[], prices: PriceMap, now: Date, edits: EditRecord[] = []): UsageSummary {
  const total = emptyAcc(), today = emptyAcc(), week = emptyAcc(), month = emptyAcc();
  const proj = new Map<string, Acc & { projectPath: string; lastActive: string }>();
  const model = new Map<string, Acc>();
  const day = new Map<string, Acc>();
  const sess = new Map<string, Acc & { project: string; start: string; end: string; messages: number }>();
  const hour = new Map<number, number>();   // hourEpochMs -> total tokens

  const startToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  const startWeek = startToday - 6 * 86400000;
  const startMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  const ensureProj = (e: { project: string; projectPath: string; timestamp: string }) => {
    if (!proj.has(e.project)) { proj.set(e.project, Object.assign(emptyAcc(), { projectPath: e.projectPath, lastActive: e.timestamp })); }
    return proj.get(e.project)!;
  };
  const ensureSess = (e: { sessionId: string; project: string; timestamp: string }) => {
    if (!sess.has(e.sessionId)) { sess.set(e.sessionId, Object.assign(emptyAcc(), { project: e.project, start: e.timestamp, end: e.timestamp, messages: 0 })); }
    return sess.get(e.sessionId)!;
  };

  for (const r of records) {
    addRecord(total, r, prices);
    const ts = Date.parse(r.timestamp);
    if (!Number.isNaN(ts)) {
      if (ts >= startToday) { addRecord(today, r, prices); }
      if (ts >= startWeek) { addRecord(week, r, prices); }
      if (ts >= startMonth) { addRecord(month, r, prices); }
      const hk = Math.floor(ts / 3600000) * 3600000;
      hour.set(hk, (hour.get(hk) ?? 0) + sumTokens(r.tokens));
    }
    if (!proj.has(r.project)) { proj.set(r.project, Object.assign(emptyAcc(), { projectPath: r.projectPath, lastActive: r.timestamp })); }
    const pa = proj.get(r.project)!; addRecord(pa, r, prices);
    if (r.timestamp > pa.lastActive) { pa.lastActive = r.timestamp; }

    if (!model.has(r.model)) { model.set(r.model, emptyAcc()); }
    addRecord(model.get(r.model)!, r, prices);

    const d = dayOf(r.timestamp);
    if (!day.has(d)) { day.set(d, emptyAcc()); }
    addRecord(day.get(d)!, r, prices);

    if (!sess.has(r.sessionId)) { sess.set(r.sessionId, Object.assign(emptyAcc(), { project: r.project, start: r.timestamp, end: r.timestamp, messages: 0 })); }
    const sa = sess.get(r.sessionId)!; addRecord(sa, r, prices); sa.messages += 1;
    if (r.timestamp < sa.start) { sa.start = r.timestamp; }
    if (r.timestamp > sa.end) { sa.end = r.timestamp; }
  }

  for (const e of edits) {
    addEdit(total, e);
    const ts = Date.parse(e.timestamp);
    if (!Number.isNaN(ts)) {
      if (ts >= startToday) { addEdit(today, e); }
      if (ts >= startWeek) { addEdit(week, e); }
      if (ts >= startMonth) { addEdit(month, e); }
    }
    const pa = ensureProj(e); addEdit(pa, e);
    if (e.timestamp > pa.lastActive) { pa.lastActive = e.timestamp; }

    if (!model.has(e.model)) { model.set(e.model, emptyAcc()); }
    addEdit(model.get(e.model)!, e);

    const d = dayOf(e.timestamp);
    if (!day.has(d)) { day.set(d, emptyAcc()); }
    addEdit(day.get(d)!, e);

    const sa = ensureSess(e); addEdit(sa, e);
    if (e.timestamp && e.timestamp < sa.start) { sa.start = e.timestamp; }
    if (e.timestamp > sa.end) { sa.end = e.timestamp; }
  }

  const byProject: ProjectRollup[] = [...proj.entries()]
    .map(([project, a]) => ({ project, projectPath: a.projectPath, lastActive: a.lastActive, ...toTotals(a) }))
    .sort((x, y) => y.cost - x.cost || y.totalTokens - x.totalTokens);
  const byModel: ModelRollup[] = [...model.entries()]
    .map(([m, a]) => ({ model: m, ...toTotals(a) })).sort((x, y) => y.cost - x.cost);
  const byDay: DayRollup[] = [...day.entries()]
    .map(([d, a]) => ({ day: d, ...toTotals(a) })).sort((x, y) => x.day.localeCompare(y.day));
  const sessions: SessionRollup[] = [...sess.entries()]
    .map(([sessionId, a]) => ({ sessionId, project: a.project, start: a.start, end: a.end, messages: a.messages, ...toTotals(a) }))
    .sort((x, y) => y.end.localeCompare(x.end));

  const tokenByHour: Array<[number, number]> = [...hour.entries()].sort((a, b) => a[0] - b[0]);

  return { totals: toTotals(total), today: toTotals(today), week: toTotals(week), month: toTotals(month), byProject, byModel, byDay, sessions, tokenByHour };
}
