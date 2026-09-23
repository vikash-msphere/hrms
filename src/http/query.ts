// Query parameters read the way the ACCESS GATE reads them.
//
// The app has two query parsers and they did not agree. `new URL(req.url).searchParams` is the WHATWG
// parser: it splits the fragment off first, so `?a=1#&b=2` carries no `b`. Hono's `c.req.query()` scans the
// raw URL from the first `?` to the end of the string, so the same request DOES have `b` - and for
// `/x#?force=true`, which has no query string at all by the WHATWG reading, Hono reported `force=true`.
//
// That was a privilege escalation, not a style point. The authz middleware decides whether a DELETE is the
// `admin`-gated hard purge from `?force=true`, and reads it with `new URL()`. The collection factory's DELETE
// handler read the same parameter with `c.req.query()`. So `DELETE /v1/<collection>/<id>#?force=true` was
// GATED as an ordinary `write` soft delete and then EXECUTED as a hard purge - the irreversible one, cascading
// to every FK child the collection declares - and slipped past the API-key scope ceiling, which is computed
// from the same `force`. Verified end to end: a caller holding only `write` got 403 for `?force=true` and 204
// with the row gone for `#?force=true`.
//
// Two fixes, because either alone is a guarantee resting on something invisible:
//
//   1. package.json pins hono >= 4.13.5, which fixes ITS parser (GHSA-crvj-82cr-hjcx). That is what makes the
//      ~70 per-route `c.req.query()` readers correct, since they have no access decision riding on them and
//      converting all of them would be churn rather than safety.
//   2. Anything the authz middleware ALSO reads is read here, by the same parser the gate used. A version
//      range is a promise about a dependency; this is a property of the code. The pair of readers that must
//      agree is small and named, so keep it that way: if a new parameter is ever gated in
//      middleware/authz.ts, its handler reads it through this file.
//
// The inbound wire-id edge (middleware/decodeWireIds.ts) and the list validator (http/listEtag.ts) read the
// query with `new URL()` too. A parameter smuggled past a `#` therefore reached handlers undecoded and stayed
// out of the ETag key - both fail closed rather than open, and both are fixed by the version pin.
import type { Context } from "hono";

/** The request's query parameters, fragment excluded - the same view middleware/authz.ts decides from. */
export function searchParams(c: Context<any>): URLSearchParams {
  return new URL(c.req.url).searchParams;
}

/** One query parameter, or undefined when absent. Fragment excluded - see the header. */
export function queryParam(c: Context<any>, name: string): string | undefined {
  return searchParams(c).get(name) ?? undefined;
}

/** Is this flag present and literally `"true"`? The spelling the API documents (`?force=true`). */
export function queryFlag(c: Context<any>, name: string): boolean {
  return queryParam(c, name) === "true";
}
