/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// THE TWO QUERY PARSERS MUST NOT DISAGREE ABOUT A PARAMETER THE ACCESS GATE READS.
//
// src/http/query.ts exists because this app has two ways to read a query string and they once gave different
// answers. `new URL(req.url).searchParams` (the WHATWG parser, what middleware/authz.ts decides from) splits
// the fragment off first; Hono's `c.req.query()` scanned from the first `?` to the end of the string. So
// `DELETE /v1/<collection>/<id>#?force=true` had no query at all by the gate's reading and `force=true` by
// the handler's: GATED as an ordinary soft delete, EXECUTED as the irreversible cascading purge.
//
// The fix was two-sided, and the half that is a property of the code rather than a promise about a dependency
// is this one: anything the authz middleware reads, its handler reads through http/query.ts. `force` was
// converted at the time; `?resource` on the activity feed - which decides whether that request is gated by
// READ on one entity or by the org-wide `audit` capability - was missed for a while, and nothing noticed.
//
// This is what notices. It derives the gated set from middleware/authz.ts itself, so a NEW gated parameter is
// covered the moment it is written, without anyone remembering this file exists.
const src = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const read = (path: string): string => {
  const hit = src[path];
  if (!hit) throw new Error(`gatedQueryParamDrift: ${path} not found - update the glob`);
  return hit;
};

/** Every query parameter middleware/authz.ts makes an access decision from. */
function gatedParams(): Set<string> {
  const authz = read("../src/middleware/authz.ts");
  const names = new Set<string>();
  // `url.searchParams.get("x")` / `searchParams.get('x')` - the WHATWG read, which is the gate's read.
  for (const [, name] of authz.matchAll(/searchParams\.get\(\s*["']([\w-]+)["']\s*\)/g)) names.add(name!);
  return names;
}

/** Handler/service files that read `c.req.query("<name>")` for one of those parameters. */
function hononicReaders(names: Set<string>): { file: string; param: string }[] {
  const out: { file: string; param: string }[] = [];
  for (const [file, text] of Object.entries(src)) {
    if (file.startsWith("../src/middleware/")) continue; // the gate itself, and the wire edges
    for (const [, name] of text.matchAll(/\breq\.query\(\s*["']([\w-]+)["']\s*\)/g)) {
      if (names.has(name!)) out.push({ file, param: name! });
    }
  }
  return out;
}

describe("a query parameter the authz gate reads is read through http/query.ts everywhere", () => {
  it("finds the gated parameters (the scan itself still works)", () => {
    const names = gatedParams();
    // Both of the parameters this rule is currently about. Asserted so a refactor that renames or restructures
    // the middleware fails HERE - loudly - rather than quietly reducing the scan to an empty set that passes.
    expect([...names].sort()).toEqual(["force", "resource"]);
  });

  it("no handler reads one of them with Hono's parser", () => {
    const offenders = hononicReaders(gatedParams());
    expect(
      offenders.map((o) => `${o.file} reads "${o.param}" via c.req.query() - use queryParam() from http/query.ts`),
    ).toEqual([]);
  });

  it("http/query.ts is still the WHATWG reader the gate uses", () => {
    // The whole guarantee rests on this file reading the query the same way middleware/authz.ts does. If it
    // ever switched to Hono's parser, every conversion above would be pointing at the wrong thing.
    expect(read("../src/http/query.ts")).toContain("new URL(c.req.url).searchParams");
  });
});
