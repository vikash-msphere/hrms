/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// One "today" for the SPA, and one place that does calendar arithmetic.
//
// WHY THIS GATE EXISTS. `web/src/lib/orgDay.ts` says in its own header that it is "the one `todayStr` for the
// whole SPA", and it was not: eleven files had grown their own, and none of them answered the same question.
// Three shapes, each wrong in its own direction:
//
//   new Date().toISOString().slice(0, 10)     the day in UTC
//   new Date().toLocaleDateString("en-CA")    the day on the READER's machine
//   `${d.getFullYear()}-${d.getMonth() + 1}…` the same, spelled out
//
// The server decides in the ORG's timezone (src/services/orgDay.ts). So a picker's `min` offered a date the
// server then refused, a week grid started on the wrong Monday, a "Today" chip wrote yesterday, and two people
// looking at one board sorted the same goal into different quarters. None of it is visible in a test that runs
// at midday UTC, which is why a convention alone did not hold and this is a gate instead.
//
// The rules below are deliberately narrow. They ban the shapes that produce a DAY, and nothing else: an
// instant in ISO form (`new Date().toISOString()` compared against a `*_time` column) is correct and common,
// a long-form date label (`toLocaleDateString(undefined, { weekday: "long" })`) is presentation, and neither
// is touched. What is banned is a day string derived from a clock other than the org's, and any local
// redefinition of a name lib/orgDay already exports.
const web = import.meta.glob("../web/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// The one implementation. Everything here is by definition allowed to look like the thing it defines.
const OWNER = "web/src/lib/orgDay.ts";

// Names lib/orgDay exports. A second definition of one of these is a shadow: the call site reads as though it
// used the shared helper and does not, which is strictly worse than an obviously local name.
const EXPORTS = [
  "todayStr", "orgDayOf", "orgDayFromToday", "thisMonthStr", "thisYearStr",
  "addDaysYmd", "weekdayOf", "weekStartYmd", "daysBetweenYmd", "orgTimezone",
];

type Rule = { name: string; re: RegExp; why: string; allow?: string[]; skipLine?: RegExp };

const RULES: Rule[] = [
  {
    name: "today-from-UTC",
    re: /new Date\(\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/g,
    why: "that is today in UTC. Use `todayStr()` from @/lib/orgDay.",
  },
  {
    name: "today-from-the-browser",
    // "en-CA" is the locale trick for a YYYY-MM-DD out of toLocaleDateString - i.e. a DAY, not a label.
    re: /new Date\(\)\s*\.toLocaleDateString\(\s*["']en-CA["']/g,
    why: "that is today on the reader's machine. Use `todayStr()` from @/lib/orgDay.",
  },
  {
    name: "day-string-from-local-parts",
    // `${x.getFullYear()}-...` - the spelled-out version of the same thing. Matches the template opening
    // only; getUTCFullYear and friends are fine and do not match.
    re: /\$\{[A-Za-z_$][\w$]*\.getFullYear\(\)\}-/g,
    why: "that builds a day from the reader's local parts. Derive it from `todayStr()` and step it with `addDaysYmd`.",
    // A `datetime-local` input's value IS the viewer's wall clock - that is what the control means, and the
    // form then converts it to an instant on submit. Those formatters carry the time-of-day with them, so a
    // `getHours()` on the line is what distinguishes "a moment, locally" from "a calendar day".
    skipLine: /getHours\(\)/,
  },
  {
    name: "local-parts-Date-serialized-as-UTC",
    // The worst of the three, because it looks deliberate: build a Date from LOCAL parts, then read it back
    // with `toISOString()`, which is UTC. The two clocks cancel out to a whole day's error for everyone east
    // of UTC - this is the shape that gave the dashboard a Sunday for its Monday.
    re: /new Date\([^;\n]*?\.get(?:FullYear|Month|Date)\(\)[^;\n]*?\)\s*\.toISOString\(\)/g,
    why: "local parts in, UTC out - those cancel to a one-day error. Work in day strings via @/lib/orgDay.",
  },
  {
    name: "shadowed-orgDay-export",
    re: new RegExp(String.raw`\b(?:const|let|var|function)\s+(?:${EXPORTS.join("|")})\b\s*(?:=(?!\s*(?:${EXPORTS.join("|")})\b)|\()`, "g"),
    why: "that name belongs to @/lib/orgDay. Import it instead of defining a second one (aliasing it - `const addDays = addDaysYmd` - is fine).",
    // lib/attendance.ts is where `weekdayOf` actually lives; orgDay re-exports it rather than copying it.
    allow: ["web/src/lib/attendance.ts"],
  },
];

const rel = (p: string) => p.replace(/^\.\.\//, "");
const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

describe("the SPA has one org day", () => {
  for (const rule of RULES) {
    it(`no ${rule.name}`, () => {
      const hits: string[] = [];
      for (const [path, src] of Object.entries(web)) {
        const p = rel(path);
        if (p === OWNER || rule.allow?.includes(p)) continue;
        for (const m of src.matchAll(rule.re)) {
          // A mention inside a comment is describing the problem, not committing it - every one of these
          // rules is quoted in a header somewhere explaining why it is banned.
          const line = src.split("\n")[lineOf(src, m.index ?? 0) - 1] ?? "";
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
          if (rule.skipLine?.test(line)) continue;
          hits.push(`${p}:${lineOf(src, m.index ?? 0)}  ${line.trim().slice(0, 110)}`);
        }
      }
      expect(hits, `${rule.why}\n\n${hits.join("\n")}`).toEqual([]);
    });
  }

  // The gate is only worth having if it would have caught the drift it was written for. Each of these is a
  // real line that shipped, taken from the files this replaced.
  it("catches the shapes that actually shipped", () => {
    const samples = [
      'const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).toISOString().slice(0, 10);',
      'const todayStr = () => new Date().toLocaleDateString("en-CA");',
      'const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;',
      'const t = new Date().toISOString().slice(0, 10);',
    ];
    for (const s of samples) {
      expect(RULES.some((r) => new RegExp(r.re.source).test(s)), s).toBe(true);
    }
  });

  // ...and does not fire on the things that are correct, which is the half that decides whether anyone keeps
  // it switched on.
  it("leaves correct code alone", () => {
    const fine = [
      'const now = new Date().toISOString();', // an INSTANT, compared against a *_time column
      'const label = new Date(x).toLocaleDateString(undefined, { weekday: "long", month: "long" });',
      'const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));',
      'const addDays = addDaysYmd;', // aliasing the shared helper under a local name
      'const daysBetween = daysBetweenYmd;',
      'const end = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);', // month end, UTC throughout
      'export const todayStr = (): string => localDay(new Date().toISOString(), orgTz);', // the owner itself
    ];
    for (const s of fine) {
      const fired = RULES.filter((r) => new RegExp(r.re.source).test(s)).map((r) => r.name);
      // The last sample is the owner's own line, which is exempted by path rather than by pattern.
      if (s.startsWith("export const todayStr")) continue;
      expect(fired, s).toEqual([]);
    }
  });
});
