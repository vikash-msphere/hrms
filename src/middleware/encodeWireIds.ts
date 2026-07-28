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
  "employees", "departments", "users", "holidays", "holiday-selections", "leave-types",
  "leave-requests", "leave-balances", "org-documents", "personal-documents", "announcements", "pay-components", "pay-periods",
  "payroll-runs", "payslips", "compensation", "positions", "bonuses", "assets", "settlements", "leave-encashments", "operations", "reimbursements", "reimbursement-categories",
  "expenses", "expense-categories", "vendors", "expense-budgets",
  "attendance", "attendance-regularizations", "cron-runs", "tickets", "ticket-checklists", "events", "goals", "boards", "cards", "sprints", "review-cycles", "reviews", "review-feedback", "transitions", "transition-tasks", "check-ins", "benefit-plans", "dependents", "benefit-enrollments", "shifts", "shift-assignments", "projects", "time-entries", "loans", "tax-declarations", "pay-grades", "salary-structures", "document-acknowledgements", "compliance-events", "compliance-rules", "background-checks", "overtime-requests", "remote-work-requests", "approval-delegations", "notice-periods", "suggestions", "notifications", "referrals", "job-requisitions", "candidates", "applications", "interviews", "interview-feedback", "offers",
  "letter-templates",
  "automations", "event-log", "automation-runs", "workflow-instances",
]);

// `<collection>/<13-char base32 id>` with an optional trailing `:verb` (photo/download style).
const REF_RE = /^([a-z][a-z-]*)\/([0-9a-hj-km-np-tv-z]{13})(:[a-zA-Z]+)?$/;

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
