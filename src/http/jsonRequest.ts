// The ONE answer to "does this request carry a JSON body".
//
// It exists because the app has two JSON content types, not one: a create posts `application/json`, and an
// Update sends `application/merge-patch+json` - the type openapi.yaml declares for all 70 Update operations
// and the one web/src/api.ts sends on every PATCH. A check written as `contentType.includes("application/json")`
// answers NO for the second one, because that substring is not in `application/merge-patch+json`.
//
// That is not a style point. The authz middleware's body gate (protected fields, declared references,
// owner-on-create, per-field sub-resource writes) treats "no JSON body" as "no constraint to add", so a
// content-type test that misses merge-patch turned the whole body-level access layer OFF for every PATCH in
// the application while every other layer kept working - invisible, because the gate still fired for POST.
//
// So the inbound wire-id decoder, the body gate and the handlers that read a body directly all ask HERE.
// They cannot disagree about whether there is a body, which is the property that was missing: a handler that
// parses a body the gate declined to inspect is a bypass, whatever the two disagree about.
import type { Context } from "hono";

/**
 * Is this a JSON-family media type (`application/json`, or any `application/…+json` structured suffix)?
 *
 * Deliberately at least as permissive as Hono's own `json` validator, which is what decides whether a
 * handler parses the body: the gate must never skip a body a handler will go on to read. Parameters
 * (`; charset=utf-8`) are ignored and case is normalised.
 */
export function isJsonBody(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}

/**
 * The parsed JSON body of a request a handler reads DIRECTLY (no zValidator), or `{}` when there is none.
 *
 * `c.req.json()` parses whatever bytes arrived regardless of the declared type, so a handler calling it
 * reads a `text/plain` body that the authz body gate skipped. Going through here makes the handler agree
 * with the gate: a body that does not declare itself JSON is not a body. This is also exactly what Hono's
 * `zValidator("json", …)` does for every validated route, so the two lanes now behave the same way.
 */
export async function jsonBody<T = Record<string, unknown>>(c: Context<any>): Promise<T> {
  if (!isJsonBody(c.req.header("content-type"))) return {} as T;
  return (await c.req.json().catch(() => ({}))) as T;
}
