// Pure helpers for hierarchical resource codes (docs/archive/plan.txt section 0).
//
// A `code` is the INTERNAL structured matching/scoping key: base32 [Crockford, no i/l/o/u] segments joined by '-',
// e.g. "04-1c-0a9-0kf" (dept-subdept-employee-leaf). It is never on the wire (the random `id` is).
// These functions are pure (no I/O) so the matcher and allocator are unit-testable in isolation.

// Crockford-style base32 (no ambiguous i/l/o/u), the SAME alphabet as the wire id (lib/wireid.ts) so
// both identifiers share one mental model. Codes are internal (never on the wire); lowercase-only keeps
// matching free of case/collation pitfalls.
const B32 = "0123456789abcdefghjkmnpqrstvwxyz"; // 32 chars
const B32_RE = /^[0-9a-hjkmnp-tv-z]+$/;

export function encodeBase32(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error("encodeBase32: non-negative integer required");
  if (n === 0) return "0";
  let s = "";
  while (n > 0) {
    s = B32.charAt(n % 32) + s;
    n = Math.floor(n / 32);
  }
  return s;
}

export function decodeBase32(s: string): number {
  if (!B32_RE.test(s)) throw new Error(`decodeBase32: invalid base32 segment "${s}"`);
  let n = 0;
  for (const ch of s) n = n * 32 + B32.indexOf(ch);
  return n;
}

// Join a parent code with this entity's own segment. Top-level entities pass parent = null.
export function compose(parent: string | null, ownSeg: string): string {
  return parent ? `${parent}-${ownSeg}` : ownSeg;
}

export function segments(code: string): string[] {
  return code.split("-");
}

// Delimiter-boundary-aware containment: is `code` equal to scope `prefix`, or nested under it?
// "04" covers "04", "04-1c", "04-1c-0a9"; it does NOT cover "041" or "041-x" (the boundary stops it).
//
// AN EMPTY PREFIX MATCHES NOTHING. It used to match everything, on the reading that "no scope" means
// "unscoped" - but every caller here is asking a containment question on behalf of an access decision, and
// for those the empty string is never a deliberate "all", it is a value that went missing. The unscoped case
// has its own spelling (`**` / `*` in a grant pattern), handled at the permission layer and never routed
// through this function.
//
// Concretely, `true` made three fail-OPEN paths in domain/permissions.ts#matchToken, each one turning a
// self- or dept-scoped grant into an org-wide one:
//   - a caller whose `employees.code` is `''` (the column is nullable TEXT with no CHECK, and `''` is not
//     NULL, so the `!== null` guard there let it through) matched `me` against every row in the collection;
//   - a code beginning with `-` gives `deptOf` an empty dept, so `my-dept` matched everything;
//   - a pattern written `-*` asks for the prefix `''`, and matched everything.
// None is reachable through codeAlloc today. That is the point: this is the function that must not be the
// one place a missing value reads as authority, and "deny" is the only safe answer to a question whose
// subject is absent.
export function isUnder(prefix: string, code: string): boolean {
  if (prefix === "") return false;
  return code === prefix || code.startsWith(prefix + "-");
}

// The ancestor codes of `code`, from the top segment down to `code` itself (inclusive). E.g.
// "04-002-001" -> ["04", "04-002", "04-002-001"]. Used as the EXACT IN-narrowing set for per-object user
// rules: a rule whose match_code is any ancestor of the requested object's code is a candidate (a share on
// a parent covers its descendants); the engine then does the precise isUnder match. No SQL prefix needed.
export function ancestorsOf(code: string): string[] {
  const out: string[] = [];
  let acc = "";
  for (const seg of segments(code)) {
    acc = acc ? `${acc}-${seg}` : seg;
    out.push(acc);
  }
  return out;
}

// The immediate child segment of `code` relative to `parentCode`. For a flat resource (parentCode
// null) that is the whole single-segment code; for a child it is the one segment just past the parent.
// Returns null if `code` is not actually a child of `parentCode`.
export function childSeg(code: string, parentCode: string | null): string | null {
  if (parentCode === null) return segments(code)[0] ?? null;
  if (code === parentCode || !isUnder(parentCode, code)) return null;
  return code.slice(parentCode.length + 1).split("-")[0] ?? null;
}

// `count` consecutive child codes in ONE pass, for a create that makes many rows at once (twenty identical
// adapters received in a box). Calling nextChildCode in a loop cannot do this: it only ever sees the siblings
// it was handed, so every call would return the same leaf. Same allocation rules as the single form - max+1,
// sequential, never reused - so a run is contiguous and interleaves correctly with earlier singles.
export function nextChildCodes(siblingCodes: (string | null | undefined)[], parentCode: string | null, minWidth: number, count: number): string[] {
  let max = maxSeg(childSegsOf(siblingCodes, parentCode));
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(compose(parentCode, padSeg(++max, minWidth)));
  return out;
}

// Compose the next child code under `parentCode` (null = top-level/flat), given the codes of the
// existing siblings in that scope. Unifies flat allocation (parentCode null) and hierarchical
// allocation. Pure: the caller fetches the sibling codes; this picks the next free leaf and composes.
export function nextChildCode(siblingCodes: (string | null | undefined)[], parentCode: string | null, minWidth: number): string {
  return nextChildCodes(siblingCodes, parentCode, minWidth, 1)[0]!;
}

/**
 * The highest child segment in use under `parentCode`, as a number; -1 when the scope is empty.
 *
 * Exported so the allocator can SEED its counter (schema `code_sequences`) from whatever a scope already
 * holds. That read happens once per scope; after it, allocation is arithmetic on the counter rather than a
 * pass over every sibling.
 */
export function maxChildSeg(siblingCodes: (string | null | undefined)[], parentCode: string | null): number {
  return maxSeg(childSegsOf(siblingCodes, parentCode));
}

/** The child code for a given sequence value - the inverse of `maxChildSeg`, for a counter-driven allocator. */
export function childCodeAt(parentCode: string | null, value: number, minWidth: number): string {
  return compose(parentCode, padSeg(value, minWidth));
}

// Allocate the next own-segment within a scope, given the sibling segments already in use.
// Sequential (max+1, never reused even across gaps), base32, left-padded to `minWidth`, and spilling to
// a wider segment once the width is exhausted. Raising `minWidth` later does not rewrite existing codes.
export function nextSeg(existingSegs: string[], minWidth: number): string {
  return padSeg(maxSeg(existingSegs) + 1, minWidth);
}

function childSegsOf(siblingCodes: (string | null | undefined)[], parentCode: string | null): string[] {
  const segs: string[] = [];
  for (const c of siblingCodes) {
    if (!c) continue;
    const seg = childSeg(c, parentCode);
    if (seg) segs.push(seg);
  }
  return segs;
}

// A segment this alphabet cannot read is SKIPPED, not thrown on.
//
// Every allocation in the app decodes its siblings to find the next free leaf, so one unreadable stored code
// used to fail every create in that scope - not the row with the bad code, all of them, with a 500 and nothing
// an operator could do from the app. That is not hypothetical: scripts/genSeed.ts once emitted codes in base36,
// whose alphabet includes `i`, and the next holiday anybody added came back 500 for exactly this reason. The
// seeds are base32 now, but a hand-edited row or an import can put one back.
//
// Skipping is safe because a malformed segment is not part of the sequence this is measuring: it cannot be the
// max of a well-formed run, and the UNIQUE index on `code` is what actually guarantees the result is free.
function maxSeg(segs: string[]): number {
  let max = -1;
  for (const s of segs) {
    let v: number;
    try {
      v = decodeBase32(s);
    } catch {
      continue;
    }
    if (v > max) max = v;
  }
  return max;
}

function padSeg(value: number, minWidth: number): string {
  const seg = encodeBase32(value);
  return seg.length >= minWidth ? seg : "0".repeat(minWidth - seg.length) + seg;
}
