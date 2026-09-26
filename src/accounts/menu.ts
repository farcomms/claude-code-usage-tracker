import { SavedAccountMeta } from "../types";
import { accountDetail, formatAgo } from "../format";

export type MenuAction =
  | { kind: "active" } | { kind: "switch"; uuid: string }
  | { kind: "add" } | { kind: "remove" } | { kind: "separator" };
export interface MenuItem { label: string; description?: string; action: MenuAction }

/** Spec §5.2: the active account (✓) first, the rest by most recent use, then actions. */
export function switcherItems(accounts: SavedAccountMeta[], activeUuid: string | null, nowMs: number): MenuItem[] {
  const active = accounts.find((a) => a.accountUuid === activeUuid);
  const others = accounts
    .filter((a) => a.accountUuid !== activeUuid)
    .sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
  const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");

  const items: MenuItem[] = [];
  if (active) {
    items.push({ label: `$(check) ${active.email}`, description: join(accountDetail(active), "active"), action: { kind: "active" } });
  }
  for (const a of others) {
    const used = a.lastUsedAt ? `last used ${formatAgo(nowMs - Date.parse(a.lastUsedAt))}` : "never used here";
    items.push({ label: `$(blank) ${a.email}`, description: join(accountDetail(a), used), action: { kind: "switch", uuid: a.accountUuid } });
  }
  if (items.length > 0) { items.push({ label: "", action: { kind: "separator" } }); }
  items.push({ label: "$(add) Add account…", action: { kind: "add" } });
  if (others.length > 0) { items.push({ label: "$(trash) Remove saved account…", action: { kind: "remove" } }); }
  return items;
}
