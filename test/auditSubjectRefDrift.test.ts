/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// A resource ref written into audit meta must actually name a resource.
//
// WHY THIS EXISTS. Seventeen call sites across six services carried `employee: `employees/`` - a template
// literal whose interpolation was never filled in. Nothing failed: `subjectOf` (lib/audit.ts) reads the ref,
// finds an empty id half and returns null, so the row was written with `subject_id` unset. tsc cannot see it
// (the expression is a perfectly good string), and no runtime assertion fires (an absent subject is legal -
// plenty of acts are about no one). The outbound edge does not catch it either: encodeWireIds only rewrites a
// ref whose id is exactly 13 base32 characters, so the broken string travels out untouched.
//
// What it cost is the one thing `subject_id` exists for. `?subject=employees/<token>` means "everything that
// happened to this person", and it silently omitted their expense approvals and payments, their loan
// disbursement, their leave-encashment approval and their tax verification - the money decisions the filter is
// most often opened to find.
//
// So this gate reads the source rather than the behaviour: a ref of the form `<collection>/` with nothing
// after the slash is always the unfinished edit, never a deliberate value. An act about nobody omits the key.
const modules = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// A TEMPLATE literal holding `<collection>/` and nothing else: the interpolation was never written. Only
// backticks, deliberately - a plain-quoted `"employees/"` is a prefix constant, used with startsWith/slice
// all over the access and activity code, and is not a ref being built. A real ref is `employees/${id}`; a
// literal settings path (`settings/attendance`) has a tail.
const EMPTY_REF = /`([a-z][a-z-]+)\/`/g;

describe("audit meta refs name a resource", () => {
  it("no service writes a resource ref with an empty id", () => {
    const offenders: string[] = [];
    for (const [path, src] of Object.entries(modules)) {
      src.split("\n").forEach((raw, i) => {
        // Prose uses backticks too (`image/` in a content-type note), so drop comment text before matching:
        // a `//` tail, and a JSDoc/block continuation line, which is every commented backtick in the tree.
        const line = raw.replace(/\/\/.*$/, "");
        if (/^\s*(\*|\/\*)/.test(raw)) return;
        for (const m of line.matchAll(EMPTY_REF)) offenders.push(`${path.replace("../", "")}:${i + 1} -> ${m[1]}/`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
