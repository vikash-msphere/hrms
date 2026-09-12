// Outbound edge: the app works in internal ids; the wire shows idCodec tokens. This walks a JSON
// response and rewrites every `<collection>/<internal-id>` string (path, refs, photo `:verb` keys)
// to `<collection>/<token>`. The internal id is exactly 13 Crockford-base32 chars, and only known
// resource collections are touched, so display strings / keys (settings/<key>) never match.
// The pagination cursor carries a token already (built in the service), so it is not an id string here.
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import type { IdCodec } from "../lib/idCodec";

// Collections whose item path is an internal id (key-based settings/preferences are excluded).
export const ENCODABLE = new Set<string>([
  "api-keys",
  "employees", "departments", "users", "holidays", "holiday-selections", "leave-types",
  "leave-requests", "leave-balances", "org-documents", "personal-documents", "announcements", "pay-components", "pay-periods",
  "payroll-runs", "payslips", "compensation", "positions", "bonuses", "assets", "asset-categories", "asset-requests", "stocktakes", "settlements", "leave-encashments", "operations", "reimbursements", "reimbursement-categories",
  "expenses", "expense-categories", "vendors", "expense-budgets",
  "attendance", "attendance-regularizations", "cron-runs", "tickets", "ticket-checklists", "events", "goals", "goal-templates", "boards", "cards", "sprints", "review-cycles", "reviews", "review-feedback", "transitions", "transition-tasks", "check-ins", "benefit-plans", "dependents", "benefit-enrollments", "shifts", "shift-assignments", "projects", "time-entries", "loans", "tax-declarations", "pay-grades", "salary-structures", "document-acknowledgements", "compliance-events", "compliance-rules", "background-checks", "overtime-requests", "remote-work-requests", "approval-delegations", "notice-periods", "suggestions", "notifications", "referrals", "job-requisitions", "candidates", "applications", "interviews", "interview-feedback", "offers",
  "letter-templates", "letterheads", "table-views",
  "automations", "event-log", "automation-runs", "workflow-instances",
  // THE TWO THAT ARE NOT IN `TABLES`, and that is exactly why they were missing.
  //
  // test/wireRegistry.test.ts holds this set against `RESOURCE_COLLECTIONS` (= the keys of the authz resolver's
  // TABLES map), which is what catches a new COLLECTION that forgets to register here. Neither of these is in
  // that map - `access-rules` is its own management surface and `activity` is the audit trail - so both fell
  // outside the check while still serializing `path: <collection>/<uuid>` straight off a `pk()`, i.e. the
  // 13-char internal id in the clear (http/serialize.ts toAccessRuleResource / toActivityResource).
  //
  // `access-rules` was internally contradictory about it too: its list pages through keysetPage, which has
  // always tokenized the cursor's uuid half under this very collection name - so one response carried an
  // opaque `next_page_token` beside raw ids in every `path`. And it is the ACL surface, which is the last
  // place to leave publishing primary keys.
  //
  // Listing them here fixes both directions at once: the outbound edge tokenizes the path, and the inbound
  // edge (middleware/decodeWireIds) decodes it back, so `DELETE /v1/access-rules/<token>` resolves and the
  // `{ rule: "access-rules/<token>" }` body the four-eyes verbs take is decoded like any other ref.
  "access-rules", "activity",
]);

// `<collection>/<13-char base32 id>` with an optional tail: a `:verb` (photo/download style) or one more
// path segment (a deep link into a web route, e.g. a notification's `announcements/<id>/view`). The tail
// rides through untouched; only the id segment is rewritten, so a link never carries an internal id out.
const REF_RE = /^([a-z][a-z-]*)\/([0-9a-hj-km-np-tv-z]{13})(:[a-zA-Z]+|\/[a-z][a-z-]*)?$/;

const MAX_DEPTH = 40; // bound recursion (responses are server-generated, but stay symmetric with the decoder)

// Collect every (collection, id) referenced by id-shaped strings under `node`.
export function collectRefs(node: unknown, acc: Set<string>, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (typeof node === "string") {
    const m = REF_RE.exec(node);
    if (m && ENCODABLE.has(m[1]!)) acc.add(`${m[1]}/${m[2]}`);
  } else if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, acc, depth + 1);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectRefs(v, acc, depth + 1);
  }
}

// Rewrite id-shaped strings using a `${collection}/${id}` -> token map (token replaces the id segment).
export function rewriteRefs<T>(node: T, map: Map<string, string>, depth = 0): T {
  if (depth > MAX_DEPTH) return node;
  if (typeof node === "string") {
    const m = REF_RE.exec(node);
    if (m && ENCODABLE.has(m[1]!)) {
      const token = map.get(`${m[1]}/${m[2]}`);
      if (token) return (`${m[1]}/${token}${m[3] ?? ""}` as unknown) as T;
    }
    return node;
  }
  if (Array.isArray(node)) return node.map((v) => rewriteRefs(v, map, depth + 1)) as unknown as T;
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = rewriteRefs(v, map, depth + 1);
    return out as T;
  }
  return node;
}

// Encode every collected ref id -> token (deduped), then rewrite the tree.
export async function encodeWireIds<T>(codec: IdCodec, body: T): Promise<T> {
  const refs = new Set<string>();
  collectRefs(body, refs);
  if (refs.size === 0) return body;
  const map = new Map<string, string>();
  await Promise.all(
    [...refs].map(async (ref) => {
      const slash = ref.indexOf("/");
      const collection = ref.slice(0, slash);
      const id = ref.slice(slash + 1);
      map.set(ref, await codec.encode(collection, id));
    })
  );
  return rewriteRefs(body, map);
}

// Middleware: rewrite internal ids -> tokens on JSON responses (runs after the handler on /v1/*).
export const encodeWireIdsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (!c.res.headers.get("content-type")?.includes("application/json")) return;
  const body = await c.res.json();
  const encoded = await encodeWireIds(c.get("deps").idCodec, body);
  const headers = new Headers(c.res.headers);
  headers.delete("content-length"); // body length changed; let the runtime recompute
  c.res = new Response(JSON.stringify(encoded), { status: c.res.status, headers });
};
