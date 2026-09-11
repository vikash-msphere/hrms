/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// An audit meta helper only turns a foreign key into a `<collection>/<id>` ref when it is TOLD which
// collection the row belongs to - the FK map is read from that collection's Drizzle table (see lib/audit
// fkColumns). Omit the argument and the helper silently emits the raw internal id instead, which is wrong
// twice over: an internal id must never reach the wire, and `00000000031nr` is something no reader and no
// client can resolve, where `employees/<token>` resolves to a person's name in the feed.
//
// The failure is invisible at the call site (the parameter is optional, the types are happy, the response is
// a 200 with an id in it), so it is asserted here instead of remembered. Same `?raw` glob as
// test/singleSource.test.ts, since the worker test pool has no node:fs.
const s1 = import.meta.glob("../src/services/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const s2 = import.meta.glob("../src/routes/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/**
 * The source with every comment blanked out (whitespace of the same length, so line numbers and offsets are
 * still the file's own). A doc comment that spells out a helper call is prose, not a call site.
 */
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

const sources = new Map<string, string>();
for (const [p, src] of [...Object.entries(s1), ...Object.entries(s2)]) sources.set(p.replace(/^\.\.\//, ""), stripComments(src));

/**
 * `${relpath}:${helper}` entries that are knowingly, documentedly allowed.
 *
 * A settings blob is a KV row, not a collection with a table behind it, so there is no FK map to read and
 * nothing to resolve - its values already arrive as refs (`default_department` is stored as
 * `departments/<id>`, see services/settings.ts).
 */
const ALLOW = new Set<string>(["src/services/settings.ts:fieldDiff"]);

/** How many arguments each helper needs before the collection is the next one. */
const HELPERS: Record<string, number> = {
  rowValues: 1,
  createdMeta: 1,
  removedMeta: 1,
  fieldDiff: 3,
  diffMeta: 3,
};

/**
 * The top-level arguments of the call whose `(` sits at `open`, counting commas only at depth zero and
 * skipping anything inside a string or a template literal - `fieldDiff(row, updated, Object.keys(set))` is
 * three arguments, not four, and `{ a: "x, y" }` is one.
 */
function argCount(src: string, open: number): number {
  let depth = 0;
  let args = 1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      for (i++; i < src.length; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return args;
    } else if (ch === "," && depth === 1) args++;
  }
  return args;
}

describe("audit meta helpers are always told their collection", () => {
  it("passes a collection to every meta helper, so a foreign key audits as a ref and not as an internal id", () => {
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const [helper, required] of Object.entries(HELPERS)) {
        const re = new RegExp(`(?<![A-Za-z0-9_$.])${helper}\\s*\\(`, "g");
        for (let m = re.exec(src); m; m = re.exec(src)) {
          const open = m.index + m[0].length - 1;
          // An import/export list or a re-declaration is not a call.
          if (/\b(?:import|export)\b[^\n;]*$/.test(src.slice(Math.max(0, m.index - 200), m.index))) continue;
          if (ALLOW.has(`${path}:${helper}`)) continue;
          if (argCount(src, open) <= required) {
            const line = src.slice(0, m.index).split("\n").length;
            offenders.push(`${path}:${line} ${helper}() with no collection`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
