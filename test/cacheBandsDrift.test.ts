/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Every value the Worker holds in memory is checked against the cache counters (src/lib/cacheGenerations.ts):
// that is what lets it be held for weeks, and what the "Clear caches" button (services/cacheFlush.ts) reaches
// in EVERY instance. A plain `cached(key, ttl, ...)` call anywhere else would be a cache the counters never
// reload and the button never clears in the other instances - correct only for as long as its TTL, and
// invisible to both. So `cached` itself is called from exactly two places: the cache, and the counters.
//
// Comments are blanked first (a note that mentions `cached(` is prose, not a call), string literals are left
// alone. Same `?raw` glob as test/bootstrapBoundary.test.ts, since the worker test pool has no node:fs.
const worker = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const ALLOWED = new Set(["../src/lib/cache.ts", "../src/lib/cacheGenerations.ts"]);

function stripComments(src: string): string {
  const out = src.split("");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === ch) break;
      }
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      for (; i < src.length && src[i] !== "\n"; i++) out[i] = " ";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      for (; i < src.length; i++) {
        const end = src[i] === "*" && src[i + 1] === "/";
        if (src[i] !== "\n") out[i] = " ";
        if (end) { out[i + 1] = " "; i++; break; }
      }
      continue;
    }
  }
  return out.join("");
}

const CALL = /\bcached\s*[(<]/;

describe("server caches all ride the counters", () => {
  it("the scan sees the sources it guards", () => {
    expect(Object.keys(worker).length).toBeGreaterThan(100);
    for (const p of ALLOWED) expect(worker[p], p).toBeTruthy();
  });

  it("nothing outside lib/cache.ts and lib/cacheGenerations.ts calls `cached` directly - use `generational`", () => {
    const offenders = Object.entries(worker)
      .filter(([p, src]) => !ALLOWED.has(p) && CALL.test(stripComments(src)))
      .map(([p]) => p.replace(/^\.\.\//, ""));
    expect(offenders).toEqual([]);
  });
});
