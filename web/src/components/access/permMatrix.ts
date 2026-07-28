// Shared bits for the role/user permission editors (the Permissions matrix and the per-subject dialog).
import { api } from "@/api";
import { fetchMeRaw } from "@/useMe";

// One access rule (the unified resource; same shape the ACL modal uses).
export type AccessRule = {
  path: string;
  subject_kind: "role" | "user";
  subject: string;
  collection: string;
  scope: string;
  scope_ref?: string;
  field?: string;
  level?: string;
  verb?: string;
  effect: string;
  etag?: string;
};

// Cell options: the read<write<admin ladder, "none" (no rule) and "deny" (blocks, wins).
export const CELL = ["none", "read", "write", "admin", "deny"] as const;

// Curated resource collections shown as rows; the live rules can add any others not listed here.
export const BASE_COLLECTIONS = [
  "employees", "departments", "compensation", "payroll-runs", "payslips", "pay-components", "pay-grades", "salary-structures", "pay-periods",
  "reimbursements", "reimbursement-categories", "leave-requests", "leave-types", "leave-balances",
  "holidays", "holiday-selections", "announcements", "org-documents", "personal-documents", "document-acknowledgements",
  "users", "operations", "settings",
  // Virtual capability: gates who may see the per-entity ACTIVITY trail (ANDed with reading the record). Scope
  // (own/dept/all) narrows which records' activity; the optional Field picks ONE target collection.
  "activity",
];

export const labelOf = (c: string) => c.replace(/-/g, " ").replace(/^\w/, (m) => m.toUpperCase());

// Page through ALL access-rules (the server caps a page at 100 and there can be more), so a matrix/editor
// reflects every rule rather than just the first page.
export async function fetchAllAccessRules(): Promise<AccessRule[]> {
  const all: AccessRule[] = [];
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ max_page_size: "100" });
    if (token) params.set("page_token", token);
    const page = await api<{ results: AccessRule[]; next_page_token?: string }>(`/access-rules?${params.toString()}`);
    all.push(...page.results);
    token = page.next_page_token;
  } while (token);
  return all;
}

// Collections to offer for a subject: the base set plus any collection the subject already has a rule on.
export function collectionsForRules(rules: AccessRule[]): string[] {
  const set = new Set(BASE_COLLECTIONS);
  for (const r of rules) if (r.collection && r.collection !== "*" && r.collection !== "**") set.add(r.collection);
  return [...set].sort();
}

// Scopes a fine-grained rule can target without picking a specific object (exact/subtree are added via the
// in-context manage-access icons, which know the object).
export const SCOPES = [
  { value: "all", label: "All (org-wide)" },
  { value: "self", label: "Own (self)" },
  { value: "dept", label: "Department" },
] as const;

// The grantable scope tiers per collection come from the BACKEND policy manifest (carried on users/me as
// access.scopes), not a parallel hardcoded list - so the chips always reflect what the engine actually
// honors. Cached once per session (the map is global + static for the session).
let scopeCapsCache: Record<string, string[]> | null = null;
export async function fetchScopeCapabilities(): Promise<Record<string, string[]>> {
  if (scopeCapsCache) return scopeCapsCache;
  // Reuse the single shared /users/me request (see useMe.fetchMeRaw) instead of issuing a second one.
  const me = await fetchMeRaw();
  scopeCapsCache = me?.access?.scopes ?? {};
  return scopeCapsCache;
}

// Canonical narrowest-first ordering for the scope chips. `exact`/`subtree` are object-anchored (offered only
// when an object is in scope - they pin to it via scope_ref); `self`/`dept`/`all` are subject-relative.
const SCOPE_ORDER = ["exact", "subtree", "self", "dept", "all"] as const;
const SCOPE_LABELS: Record<string, string> = { exact: "This one", subtree: "This & below", self: "Own", dept: "Department", all: "All" };
// Per-collection label tweaks (value -> label) for collections whose scoping reads differently. Tickets are
// owner-coded with category-based sharing, so own-vs-all is framed for support rather than Own/Department.
const SCOPE_LABEL_OVERRIDES: Record<string, Record<string, string>> = {
  tickets: { self: "Raised by me", all: "All tickets" },
};
const scopeLabel = (collection: string, value: string) => SCOPE_LABEL_OVERRIDES[collection]?.[value] ?? SCOPE_LABELS[value] ?? value;

// The scope chips to offer when granting on a target, NARROWEST FIRST (first entry = the default selection).
// The subject-relative tiers come from the collection's backend capability set (default: "all" only); the
// object-anchored tiers (`exact`, plus `subtree` where the collection supports it) are added when an object is
// in scope. `caps` is the map from fetchScopeCapabilities. Used by the ACL modal so every access icon offers
// exactly the relevant (engine-honored) scopes instead of a hardcoded "all".
export function scopesForCollection(collection: string, hasObject: boolean, caps: Record<string, string[]>): { value: string; label: string }[] {
  const tiers = new Set(caps[collection] ?? ["all"]);
  const out: { value: string; label: string }[] = [];
  for (const v of SCOPE_ORDER) {
    if (v === "exact") { if (hasObject) out.push({ value: v, label: scopeLabel(collection, v) }); continue; }
    if (v === "subtree") { if (hasObject && tiers.has("subtree")) out.push({ value: v, label: scopeLabel(collection, v) }); continue; }
    if (tiers.has(v)) out.push({ value: v, label: scopeLabel(collection, v) });
  }
  if (out.length === 0) out.push({ value: "all", label: scopeLabel(collection, "all") }); // defensive: always grantable
  return out;
}

// Human-readable scope of an existing rule (covers exact/subtree for display even though we don't author them here).
export function scopeText(r: AccessRule): string {
  switch (r.scope) {
    case "self": return "own";
    case "dept": return "department";
    case "exact": return r.scope_ref ? `object ${r.scope_ref.split("/").pop()}` : "object";
    case "subtree": return "subtree";
    default: return "all";
  }
}

// Human-readable permission of a rule: the custom verb, the level, or a deny.
export function permText(r: AccessRule): string {
  if (r.verb) return r.verb;
  if (r.effect === "deny") return "deny";
  return r.level ?? "allow";
}
