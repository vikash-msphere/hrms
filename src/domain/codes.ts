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
// An empty prefix matches everything (the "**" / unscoped case is handled at the permission layer).
export function isUnder(prefix: string, code: string): boolean {
  if (prefix === "") return true;
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

// Compose the next child code under `parentCode` (null = top-level/flat), given the codes of the
// existing siblings in that scope. Unifies flat allocation (parentCode null) and hierarchical
// allocation. Pure: the caller fetches the sibling codes; this picks the next free leaf and composes.
export function nextChildCode(siblingCodes: (string | null | undefined)[], parentCode: string | null, minWidth: number): string {
  const segs: string[] = [];
  for (const c of siblingCodes) {
    if (!c) continue;
    const seg = childSeg(c, parentCode);
    if (seg) segs.push(seg);
  }
  return compose(parentCode, nextSeg(segs, minWidth));
}

// Allocate the next own-segment within a scope, given the sibling segments already in use.
// Sequential (max+1, never reused even across gaps), base32, left-padded to `minWidth`, and spilling to
// a wider segment once the width is exhausted. Raising `minWidth` later does not rewrite existing codes.
export function nextSeg(existingSegs: string[], minWidth: number): string {
  let max = -1;
  for (const s of existingSegs) {
    const v = decodeBase32(s);
    if (v > max) max = v;
  }
  const next = encodeBase32(max + 1);
  return next.length >= minWidth ? next : "0".repeat(minWidth - next.length) + next;
}
