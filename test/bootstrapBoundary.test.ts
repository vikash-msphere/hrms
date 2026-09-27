/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// The running app reads its configuration from the database - roles, grants, the policy manifest, settings -
// and bootstrap/ only fills a fresh database once. So nothing the Worker or the SPA ships may import from
// bootstrap/: an import there is the app reading seed data at runtime instead of what the org configured,
// which is exactly the failure this folder's split exists to rule out.
//
// Import specifiers are string literals, so comments are blanked first (a doc comment naming a bootstrap file
// is prose, not an import) and the literals are left alone. Same `?raw` glob as test/auditRefCollection.test.ts,
// since the worker test pool has no node:fs.
const worker = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const spa = import.meta.glob(["../web/src/**/*.ts", "../web/src/**/*.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

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

// `from "../../bootstrap/..."`, `import("../bootstrap/...")`, `import "../bootstrap/..."`.
const BOOTSTRAP_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`](?:\.\.?\/)+bootstrap\//;

const offenders = (files: Record<string, string>) =>
  Object.entries(files)
    .filter(([, src]) => BOOTSTRAP_IMPORT.test(stripComments(src)))
    .map(([p]) => p.replace(/^\.\.\//, ""));

describe("bootstrap/ is seed data, never read at runtime", () => {
  it("the scan sees the sources it guards", () => {
    expect(Object.keys(worker).length).toBeGreaterThan(100);
    expect(Object.keys(spa).length).toBeGreaterThan(100);
  });
  it("no Worker source imports from bootstrap/", () => {
    expect(offenders(worker)).toEqual([]);
  });
  it("no SPA source imports from bootstrap/", () => {
    expect(offenders(spa)).toEqual([]);
  });
});
