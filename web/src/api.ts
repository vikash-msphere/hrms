// Single API client. /v1 base, Access cookie, CSRF header, RFC 9457 error parsing.
import { publish, subscribeTopic } from "@/lib/crossTabBus";

export class ApiError extends Error {
  status: number;
  problem: Problem | null;
  constructor(message: string, status: number, problem: Problem | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

export type Problem = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
};

// A 401 behind Cloudflare Access means the Access session lapsed; a hard nav to "/" lets Access re-challenge
// and bounce back. But with no Access in front (local dev / self-host) that reload just re-hits /users/me ->
// 401 -> reload again = a loop. Fire the redirect at most once; after that, fall through to throwing the 401
// so the app can show its in-app "Session expired" screen instead of looping.
let redirectedOn401 = false;
function redirectToLogin() {
  if (redirectedOn401) return;
  redirectedOn401 = true;
  window.location.href = "/";
}
function handle401(): never {
  // Broadcast so every sibling tab of this user bounces to login at once, instead of each discovering the
  // lapsed session via its own doomed request.
  publish("auth", { op: "dead" });
  redirectToLogin();
  throw new ApiError("unauthenticated", 401, null);
}
subscribeTopic<{ op: string }>("auth", (m) => {
  if (m.op === "dead") redirectToLogin();
});

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Requested-By": "hrms-spa", ...(init.headers ?? {}) },
    credentials: "include",
  });
  if (res.status === 401) handle401();
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as Problem | null;
    throw new ApiError(problem?.detail ?? problem?.title ?? res.statusText, res.status, problem);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// After any write, refresh the shared cache for the affected collection(s) so every mounted view updates.
import { invalidateCollections, affectedCollections, broadcastInvalidation } from "@/lib/resourceStore";
async function withInvalidation<T>(path: string, verb: string | undefined, p: Promise<T>): Promise<T> {
  const r = await p;
  // Refetch affected collections we're showing here, then tell sibling tabs about the ones we couldn't (they
  // adopt the ones we did refetch for free via the store's row broadcast).
  broadcastInvalidation(invalidateCollections(affectedCollections(path, verb)));
  return r;
}

// Merge-patch helper for Update. Pass the resource etag for optimistic concurrency.
// `path` is the resource path without a leading slash, e.g. "departments/abc".
export function patch<T>(path: string, body: Record<string, unknown>, etag?: string) {
  return withInvalidation(path, undefined, api<T>(`/${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/merge-patch+json", ...(etag ? { "If-Match": etag } : {}) },
    body: JSON.stringify(body),
  }));
}

import { coalescedGet } from "@/lib/getCoalescer";

// ---- AEP-shaped helpers -----------------------------------------------------

export type AepResource = {
  path: string;
  uid?: string;
  etag?: string;
  create_time?: string;
  update_time?: string;
  delete_time?: string;
  disabled?: boolean;
  locked?: boolean;
  locked_by?: string;
  published?: boolean;
  // Per-object access hint (server-computed; UX only). `can` = verbs the caller may perform on this row;
  // `why` = the SCOPE by which they hold read access (self/dept/subtree/exact/all), shown as provenance.
  access?: { can?: string[]; why?: "all" | "subtree" | "exact" | "self" | "dept" };
};

export type ListResponse<T> = { results: T[]; next_page_token?: string };

/** List a collection. `collection` is the kebab path segment, e.g. "employees". Routed through the GET
 *  coalescer, so all reads fired in the same tick collapse into one /v1/batch:run request. */
export function list<T>(
  collection: string,
  opts: { max?: number; showDeleted?: boolean; q?: string } = {}
): Promise<ListResponse<T>> {
  const params = new URLSearchParams({ max_page_size: String(opts.max ?? 200) });
  if (opts.showDeleted) params.set("show_deleted", "true");
  // Server-side text filter (FTS-backed). Present only when the page offers a search box, so an ordinary
  // list request is byte-identical to before and keeps sharing its cache entry.
  if (opts.q) params.set("q", opts.q);
  return coalescedGet<ListResponse<T>>(`${collection}?${params.toString()}`);
}

export function get<T>(path: string): Promise<T> {
  return coalescedGet<T>(path);
}

/** Execute several GET reads in ONE request via /v1/batch:run. `paths` are full sub-request paths, e.g.
 *  "/v1/leave-requests?max_page_size=200". Returns per-sub {status, body} in order. Reads only - no cache
 *  invalidation. Used to collapse the cold-load fan-out (notifications + the approval collections). */
export async function batchGet(paths: string[]): Promise<{ status: number; body: unknown }[]> {
  if (!paths.length) return [];
  const resp = await api<{ responses: { status: number; body: unknown }[] }>(`/batch:run`, {
    method: "POST",
    body: JSON.stringify({ requests: paths.map((path) => ({ method: "GET", path })) }),
  });
  return resp.responses ?? [];
}

export function create<T>(collection: string, body: Record<string, unknown>): Promise<T> {
  return withInvalidation(collection, undefined, api<T>(`/${collection}`, { method: "POST", body: JSON.stringify(body) }));
}

/** Soft delete (DELETE). The resource is marked deleted and can be restored. */
export function remove(path: string, etag?: string): Promise<void> {
  return withInvalidation(path, undefined, api<void>(`/${path}`, {
    method: "DELETE",
    headers: etag ? { "If-Match": etag } : {},
  }));
}

/** Permanently delete (DELETE ?force=true). Server gates this to super_admin. */
export function purge(path: string, etag?: string): Promise<void> {
  return withInvalidation(path, undefined, api<void>(`/${path}?force=true`, {
    method: "DELETE",
    headers: etag ? { "If-Match": etag } : {},
  }));
}

/** Restore a soft-deleted resource. */
export function restore<T>(path: string): Promise<T> {
  return withInvalidation(path, "restore", api<T>(`/${path}:restore`, { method: "POST" }));
}

/** Upload raw file bytes to a resource's `:upload` custom method, preserving the
 *  original filename (and thus extension) and MIME type via query params. */
export async function upload<T>(path: string, file: File, opts: { verb?: string; params?: Record<string, string> } = {}): Promise<T> {
  const buf = await file.arrayBuffer();
  const params = new URLSearchParams({ file_name: file.name, ...(opts.params ?? {}) });
  if (file.type) params.set("content_type", file.type);
  return withInvalidation(path, opts.verb ?? "upload", api<T>(`/${path}:${opts.verb ?? "upload"}?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buf,
  }));
}

/** Invoke an AEP custom method, e.g. invoke("payroll-runs/abc", "approve", etag). Pass `body` for verbs
 *  that take arguments (e.g. tickets :assign / :comment / :prioritize). */
export function invoke<T>(path: string, verb: string, etag?: string, body?: Record<string, unknown>): Promise<T> {
  return withInvalidation(path, verb, api<T>(`/${path}:${verb}`, {
    method: "POST",
    headers: etag ? { "If-Match": etag } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

type BinaryOpts = { verb?: string; params?: Record<string, string>; body?: Record<string, unknown> };

/** POST a binary-returning custom method and hand back the raw bytes. Shared by `download` (save to disk) and
 *  `blobUrl` (view inline), so both speak the same auth/CSRF/Problem-error contract. */
async function postBinary(path: string, opts: BinaryOpts): Promise<Blob> {
  const qs = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : "";
  const res = await fetch(`/v1/${path}:${opts.verb ?? "download"}${qs}`, {
    method: "POST",
    headers: { "X-Requested-By": "hrms-spa", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    credentials: "include",
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (res.status === 401) handle401();
  if (!res.ok) {
    const problem = (await res.json().catch(() => null)) as Problem | null;
    throw new ApiError(problem?.detail ?? problem?.title ?? res.statusText, res.status, problem);
  }
  return res.blob();
}

/** Fetch a binary custom method for INLINE viewing and return an object URL (feed it to an iframe).
 *  The caller owns the URL and must `URL.revokeObjectURL` it when the viewer closes. */
export async function blobUrl(path: string, opts: BinaryOpts = {}): Promise<string> {
  return URL.createObjectURL(await postBinary(path, opts));
}

/** Download a binary via a `:download` (or custom `verb`) method and trigger a browser save. */
export async function download(path: string, filename: string, opts: BinaryOpts = {}): Promise<void> {
  const blob = await postBinary(path, opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
