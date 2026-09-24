// A short stamp for "these are the caller's permissions". It exists so a client can be told that what it has
// stored no longer belongs to it.
//
// WHY. A serialized row is not raw data: it carries the per-object `access.can` hints (http/accessHint.ts) and
// the field redactions (http/fieldAccess.ts) that were computed for whoever fetched it. So a cached row goes
// wrong two ways - the record changes, or the CALLER'S RIGHTS OVER IT change - and only the first is a write to
// its collection. Narrowing a rule, changing someone's role, moving them to another department: none of it
// touches the rows, so `GET /v1/changes` had nothing to report and a client went on serving them. Worse for a
// collection the caller has just lost entirely, which cannot even be named in the answer (the route filters it
// to what they may list), so its stored copy was trusted forever.
//
// WHY THIS AND NOT A TIMESTAMP. The obvious version is "when did the policy tables last change", but that is
// both too broad and too narrow: too broad because one org-wide rule edit would purge every user's cache, and
// too narrow because it misses the caller's own department move, which re-scopes every `dept` and `me` rule
// without touching a policy table at all.
//
// The compiled grant IS the answer to "what may this caller do", and the auth read has already loaded it - so
// this costs no query. Hashed over the grant plus the caller's own scope key (their employee code, which is
// what dept- and self-scoped rules match on, and which the code cascade rewrites when they move), it changes
// exactly when the caller's effective access changes and at no other time.
//
// Plus the manifest's redacted-field list (`policy.redacted_fields`), which also rides the auth read. A field
// newly listed there disappears from rows for every caller whose grant does not reach it, WITHOUT any grant
// changing - so a stamp over the grant alone let those callers go on serving stored rows that still carried
// the field.
import type { Grant } from "./permissions";
import { fnv1a64 } from "../lib/fnv";

/**
 * Canonical text for a grant: sorted, so two structurally identical grants compiled in different rule order
 * hash the same. Without this the version would flicker between requests and the client would purge its cache
 * for no reason.
 */
function canonical(grant: Grant, scopeKey: string | null, redacted: Record<string, string[]>): string {
  const levels = Object.entries(grant.levels ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pattern, level]) => `${pattern}=${level}`)
    .join(",");
  const allow = [...(grant.allow ?? [])].sort().join(",");
  const deny = [...(grant.deny ?? [])].sort().join(",");
  const fields = Object.entries(redacted)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([collection, keys]) => `${collection}=${[...keys].sort().join("+")}`)
    .join(",");
  return `${scopeKey ?? ""}|${levels}|${allow}|${deny}|${fields}`;
}

/** The caller's access version. Changes when their grant, their scope key or the redacted-field list does;
 *  stable otherwise.
 *
 *  Hashed 64-bit (lib/fnv.ts) rather than 32: this value is an IDENTITY that decides whether a stored payload
 *  may still be served, so a collision means rows carrying the redactions and access hints of permissions the
 *  caller no longer holds. See that file for why the extra lane is worth its one pass. */
export const authzVersion = (grant: Grant, employeeCode: string | null, redacted: Record<string, string[]> = {}): string =>
  fnv1a64(canonical(grant, employeeCode, redacted));
