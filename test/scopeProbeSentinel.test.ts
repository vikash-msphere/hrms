import { describe, it, expect } from "vitest";
import { actorScope, actorVerbScope, SCOPE_PROBE_CODE, SCOPE_PROBE_LEAF } from "../src/domain/access";
import { decodeBase32, encodeBase32, nextChildCode, nextSeg, segments } from "../src/domain/codes";
import type { Grant } from "../src/domain/permissions";
import type { AppUser } from "../src/env";

// The two list-breadth probes (domain/access.ts actorScope / actorVerbScope) decide how much of EVERY
// collection a caller sees by asking decide() about a code that is deliberately not a real row. The whole
// argument is that no real row can ever BE that code: if one could, a per-object share on that single row would
// read as "an unscoped grant", and the caller would get the entire collection.
//
// That was an unasserted assumption sitting under every list in the app. These pin it.

const CALLER = "04-002-001"; // dept 04, sub-dept 002, employee 001
const actor = (grant: Grant): Pick<AppUser, "grant" | "employeeCode"> => ({ grant, employeeCode: CALLER });
const levels = (l: Record<string, "read" | "write" | "admin">): Grant => ({ levels: l, allow: [] });
const allow = (a: string[]): Grant => ({ levels: {}, allow: a });

describe("the scope probe's code cannot be a real code", () => {
  it("is one flat segment, so no scoped code can equal it", () => {
    // A dept/employee/owner-scoped code is composed as `<parent>-<seg>` (domain/codes.compose), so it always
    // has two or more segments. A single-segment probe is therefore outside the whole scoped namespace - which
    // is the half of the argument that holds no matter how many rows the app ever has.
    expect(segments(SCOPE_PROBE_CODE)).toHaveLength(1);
    expect(SCOPE_PROBE_CODE).not.toContain("-");
    expect(segments(`04-002-${SCOPE_PROBE_LEAF}`).length).toBeGreaterThan(1);
  });

  it("is the last value of its width, so only an absurd row count could reach it", () => {
    // Codes are sequential base32 counters. `zzzzz` is 32^5-1 and `zzzz` is 32^4-1: the very last value that
    // fits, i.e. the 33,554,432nd row of one flat namespace and the 1,048,576th row under one parent.
    expect(decodeBase32(SCOPE_PROBE_CODE)).toBe(32 ** SCOPE_PROBE_CODE.length - 1);
    expect(decodeBase32(SCOPE_PROBE_LEAF)).toBe(32 ** SCOPE_PROBE_LEAF.length - 1);
    expect(decodeBase32(SCOPE_PROBE_CODE)).toBeGreaterThan(33_000_000);
  });

  it("cannot be produced by padding a smaller counter", () => {
    // The allocator's only shaping is a LEFT PAD with '0' (domain/codes.padSeg), and encodeBase32 never emits a
    // leading '0' above zero. So a segment of the probe's width that does not start with '0' is the minimal
    // encoding of its value - there is exactly ONE counter value that spells the probe, and it is the one above.
    // This is what rules out the near miss: a narrow allocator (width 2 or 3) widening its way into it.
    const onlyCode = 32 ** SCOPE_PROBE_CODE.length - 2; // the sibling max that makes the NEXT code the probe
    const onlyLeaf = 32 ** SCOPE_PROBE_LEAF.length - 2;
    for (const width of [2, 3, 5]) {
      for (const n of [0, 1, 31, 32, 1023, 1024, 32767, 32768, 1_048_573, 1_048_575, 33_554_429, 33_554_431]) {
        const seg = nextSeg([encodeBase32(n)], width);
        if (n !== onlyCode) expect(seg, `width ${width} after ${n}`).not.toBe(SCOPE_PROBE_CODE);
        if (n !== onlyLeaf) expect(seg, `width ${width} after ${n}`).not.toBe(SCOPE_PROBE_LEAF);
      }
    }
    // ...and the one value that WOULD spell each of them, stated rather than hidden: this is the row count the
    // invariant is buying, so if the allocator ever changed shape these two lines are where the claim breaks.
    expect(nextSeg([encodeBase32(onlyCode)], 2)).toBe(SCOPE_PROBE_CODE);
    expect(nextSeg([encodeBase32(onlyLeaf)], 2)).toBe(SCOPE_PROBE_LEAF);
  });

  it("is not what a fresh or realistically-sized namespace allocates", () => {
    expect(nextChildCode([], null, 2)).toBe("00");
    expect(nextChildCode([], "04-002", 3)).toBe("04-002-000");
    // A sweep over the first few thousand rows of a namespace: sequential, zero-padded, never the probe.
    for (let n = 0; n < 3000; n++) {
      expect(nextChildCode([encodeBase32(n)], null, 2)).not.toBe(SCOPE_PROBE_CODE);
      expect(nextChildCode([`04-002-${encodeBase32(n)}`], "04-002", 3)).not.toBe(`04-002-${SCOPE_PROBE_LEAF}`);
    }
  });
});

describe("a per-object grant never widens the probed breadth", () => {
  // An ACL share is an EXACT-code rule on one object (accessRules builds `<col>.<code>.**`). It must raise
  // access to that object and nothing else - in particular it must not answer the probe, because the probe's
  // answer is the WHERE clause for the caller's whole list.
  const share = "leave-requests.04-003-001.**"; // somebody else's row, in another sub-dept

  it("read: a self grant plus a share is still own", () => {
    expect(actorScope(actor(levels({ "leave-requests.me.**": "read" })), "leave-requests")).toBe("own");
    expect(actorScope(actor(levels({ "leave-requests.me.**": "read", [share]: "read" })), "leave-requests")).toBe("own");
  });

  it("read: a dept grant plus a share is still dept", () => {
    expect(actorScope(actor(levels({ "leave-requests.my-dept.**": "read" })), "leave-requests")).toBe("dept");
    expect(actorScope(actor(levels({ "leave-requests.my-dept.**": "read", [share]: "read" })), "leave-requests")).toBe("dept");
  });

  it("read: only an unscoped grant reads all", () => {
    expect(actorScope(actor(levels({ "leave-requests.**": "read" })), "leave-requests")).toBe("all");
  });

  it("verb: the same three answers, probed the same way", () => {
    const verbShare = "leave-requests.04-003-001.approve";
    expect(actorVerbScope(actor(allow([])), "leave-requests", "approve")).toBeNull();
    expect(actorVerbScope(actor(allow(["leave-requests.me.approve"])), "leave-requests", "approve")).toBe("own");
    expect(actorVerbScope(actor(allow(["leave-requests.me.approve", verbShare])), "leave-requests", "approve")).toBe("own");
    expect(actorVerbScope(actor(allow(["leave-requests.my-dept.approve"])), "leave-requests", "approve")).toBe("dept");
    expect(actorVerbScope(actor(allow(["leave-requests.my-dept.approve", verbShare])), "leave-requests", "approve")).toBe("dept");
    expect(actorVerbScope(actor(allow(["leave-requests.*.approve"])), "leave-requests", "approve")).toBe("all");
    // A share alone grants the verb on that ONE row; the breadth of the caller's queue is still nothing.
    expect(actorVerbScope(actor(allow([verbShare])), "leave-requests", "approve")).toBeNull();
  });

  // The sharp edge, stated so it can never be a surprise: a rule pinned to the probe code itself DOES read as
  // "all", in both probes. That is not a defect to fix here - it is precisely why the invariants above matter,
  // since the only way such a rule could be authored is a real object whose code is the probe.
  it("a rule pinned to the probe code itself would report all - which is why no row may have that code", () => {
    expect(actorScope(actor(levels({ [`leave-requests.${SCOPE_PROBE_CODE}.**`]: "read" })), "leave-requests")).toBe("all");
    expect(actorVerbScope(actor(allow([`leave-requests.${SCOPE_PROBE_CODE}.approve`])), "leave-requests", "approve")).toBe("all");
  });
});
