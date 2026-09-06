// Pure, dependency-free. Given a record (raw DB row OR a serialized wire resource), produce a short descriptive
// label for the activity feed — computed ONCE at write time and stored on the audit row (`entity_name`), never
// re-read. It is a point-in-time SNAPSHOT: what the record was when the event happened, not its current state.
//
// Callers pass EITHER a Drizzle row (camelCase keys, dates as epoch-ms integers or Date objects) OR a serialized
// response (snake_case fields, dates as ISO strings). `get()` reads a snake_case name in either shape; the value
// helpers accept number | Date | ISO string. It reads ONLY on-row columns — never joins / resolves refs (no
// extra reads). The feed already shows the ACTOR name and, where a service sets `meta.employee`, the subject
// ("for <name>", client-resolved from cache), so the label carries the record's own specifics (dates /
// description / kind), not the person. Returns undefined when nothing beyond the resource type is known.

type Rec = Record<string, unknown>;

// Read a snake_case field from a row that may use snake_case (serialized) OR camelCase (Drizzle) keys.
const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const get = (row: Rec, snake: string): unknown => (snake in row ? row[snake] : row[camel(snake)]);

const txt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n) + "…" : s);
// "12 Mar" from an epoch-ms integer / Date (raw row) or a YYYY-MM-DD(…) string (serialized). "" if absent.
const shortDate = (v: unknown): string => {
  const d = v instanceof Date ? v : typeof v === "number" && v > 0 ? new Date(v) : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(v.slice(0, 10) + "T00:00:00") : null;
  return d && !isNaN(+d) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
};
const dateRange = (a: unknown, b: unknown): string => {
  const s = shortDate(a), e = shortDate(b);
  return s && e ? (s === e ? s : `${s} – ${e}`) : s || e || "";
};

// First name-ish field present (employees join first+last). Used for catalogs / named records.
function nameColumn(collection: string, row: Rec): string | undefined {
  if (collection === "employees") {
    const n = `${get(row, "first_name") ?? ""} ${get(row, "last_name") ?? ""}`.trim();
    return n || undefined;
  }
  for (const k of ["display_name", "name", "title", "subject", "label", "check_type", "reference_no"]) {
    const v = get(row, k);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

// Per-collection labelers for transactional rows with no name column — a concrete on-row FACT (a date range, a
// description, a kind), or undefined to fall through to type-only.
type Labeler = (r: Rec) => string | undefined;
const u = (s: string) => s || undefined;
const LABELERS: Record<string, Labeler> = {
  "leave-requests": (r) => u(dateRange(get(r, "start_date"), get(r, "end_date"))),
  "overtime-requests": (r) => u(shortDate(get(r, "date"))),
  "remote-work-requests": (r) => u(dateRange(get(r, "start_date"), get(r, "end_date"))),
  "attendance-regularizations": (r) => u(shortDate(get(r, "date"))),
  "time-entries": (r) => u(shortDate(get(r, "date"))),
  "shift-assignments": (r) => u(shortDate(get(r, "date"))),
  "check-ins": (r) => u(shortDate(get(r, "meeting_date"))),
  "settlements": (r) => u(shortDate(get(r, "settlement_date"))),
  "benefit-enrollments": (r) => u(shortDate(get(r, "effective_date"))),
  // A revision's own fact is the date it takes effect - which is also what tells two revisions of the same
  // salary apart in the feed, since the row carries no name of any kind.
  "compensation": (r) => u(shortDate(get(r, "effective_from"))),
  "notice-periods": (r) => u(shortDate(get(r, "last_working_day"))),
  "reimbursements": (r) => u(clip(txt(get(r, "description")))),
  "expenses": (r) => u(clip(txt(get(r, "description")) || txt(get(r, "invoice_number")))),
  "loans": (r) => u(txt(get(r, "kind"))),
  "bonuses": (r) => u(txt(get(r, "kind"))),
  "expense-budgets": (r) => u(txt(get(r, "period_key"))),

  // Rows with no name column of any kind. Without an entry here the feed can only say "Review" or "Offer" -
  // true, and useless the moment there are two of them. Each labeler names the one on-row fact that tells this
  // record apart from its siblings: a date for the dated, a state for the stateful, the person or thing it is
  // ABOUT for the rest. Never a joined value - the label is computed at write time from the row in hand, and a
  // read to decorate an audit entry is a read this app does not have to spare.
  "applications": (r) => u([txt(get(r, "stage")), txt(get(r, "status"))].filter(Boolean).join(" · ")),
  "approval-delegations": (r) => u(dateRange(get(r, "from_date"), get(r, "to_date"))),
  "attendance": (r) => u(shortDate(get(r, "date"))),
  "cron-runs": (r) => u([txt(get(r, "cron")), txt(get(r, "status"))].filter(Boolean).join(" · ")),
  "holiday-selections": (r) => u(shortDate(get(r, "created_at"))),
  "interview-feedback": (r) => u(txt(get(r, "recommendation"))),
  "leave-encashments": (r) => u(txt(get(r, "state"))),
  // The offer's own dates; its candidate lives on the application it points at, which is a join away.
  "offers": (r) => u(shortDate(get(r, "offer_date")) || txt(get(r, "status"))),
  "operations": (r) => u(txt(get(r, "kind"))),
  "payslips": (r) => u(shortDate(get(r, "created_at"))),
  // Effective-dated history, same as compensation: the date it takes effect is what distinguishes revisions.
  "positions": (r) => u(shortDate(get(r, "effective_from"))),
  "referrals": (r) => u(txt(get(r, "candidate_name"))),
  "review-feedback": (r) => u(txt(get(r, "state"))),
  "reviews": (r) => u(txt(get(r, "state"))),
  "users": (r) => u(txt(get(r, "email"))),
  // A rule has no name, and `subject` (which nameColumn would otherwise pick up) is a role name at best and a
  // users uuid at worst. The label names the two facts that tell one rule from another - who it is for and
  // which collection it reaches - with the subject dropped for a user rule, where the uuid says nothing and
  // `meta.subject_label` carries the person.
  "access-rules": (r) => u([txt(get(r, "subject_kind")) === "user" ? "" : txt(get(r, "subject")), txt(get(r, "namespace")) || txt(get(r, "collection"))].filter(Boolean).join(" → ")),
  // A request/balance/run is about a thing the row only holds an id for. The STATE is the honest on-row fact,
  // and it is also the one that changes - which is what a trail is read for.
  "asset-requests": (r) => u(txt(get(r, "state"))),
  "document-acknowledgements": (r) => u(shortDate(get(r, "acknowledged_time"))),
  "leave-balances": (r) => u(txt(String(get(r, "balance_days") ?? "")) && `${get(r, "balance_days")} days`),
  "payroll-runs": (r) => u(txt(get(r, "state"))),
};

// The label for a record. A per-collection labeler wins for transactional rows (so a stray name-ish column can't
// preempt the intended fact); otherwise the record's name column (catalogs / named records).
export function describeRow(collection: string, row: Rec | null | undefined): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  return LABELERS[collection]?.(row) ?? nameColumn(collection, row);
}
