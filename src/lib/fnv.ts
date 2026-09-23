// FNV-1a, as a 64-bit value in base36.
//
// NOT a security primitive, and it does not need to be: every caller hashes a string the server re-derives on
// every request and never trusts one back (domain/authzVersion.ts, http/listEtag.ts, middleware/auth.ts's
// session id). The session id is the one whose input is not public - it carries the caller's internal user id -
// and it holds for the same reason rather than a different one: that input has the full 64 bits of entropy the
// id was minted with, so there is no small space to walk. What this is not is a keyed MAC, so nothing may
// depend on a client being unable to COMPUTE one of these from facts it already knows.
//
// WHY 64 BITS AND NOT 32. Both callers use their hash as an IDENTITY that decides whether a payload may be
// reused: `authzVersion` says "these are still the same rights", and `listEtag` folds it together with the
// request key so a `304 Not Modified` means "you already hold this exact answer". A collision there is not a
// wrong-looking string, it is a stale answer served as a current one - rows carrying the field redactions and
// access hints computed under permissions the caller no longer has. At 32 bits that is ~1 in 4 billion per
// comparison, which is small but is a correctness risk taken for nothing: the second lane below costs one more
// pass over a string that is already short, and takes the space to a size where a chance collision is not a
// thing to reason about.
//
// Two INDEPENDENT lanes rather than a BigInt 64-bit multiply: `Math.imul` is the only exact 32-bit multiply JS
// has, and mixing lanes with different offset bases gives 64 bits of state without leaving Number arithmetic.
// The second lane's basis is FNV's own 32-bit offset with the bits inverted, so the two lanes never start in
// the same place and a string cannot drive them in lockstep.
const PRIME = 0x01000193;
const BASIS_A = 0x811c9dc5;
const BASIS_B = ~0x811c9dc5 >>> 0;

/** 64-bit FNV-1a of `s`, base36, zero-padded per lane so the two halves cannot run together ambiguously. */
export function fnv1a64(s: string): string {
  let a = BASIS_A;
  let b = BASIS_B;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, PRIME);
    // The second lane consumes the code unit byte-swapped, so two strings that collide in lane A are not
    // driven through the same sequence of states in lane B.
    b = Math.imul(b ^ ((c >>> 8) | ((c & 0xff) << 8)), PRIME);
  }
  return `${(a >>> 0).toString(36).padStart(7, "0")}${(b >>> 0).toString(36).padStart(7, "0")}`;
}
