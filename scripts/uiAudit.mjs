#!/usr/bin/env node
// Per-surface UI/UX audit over every .tsx in web/src.
//
// This is a REPORT, not a gate. `test/responsiveCoverage.test.ts` holds the rules that are settled enough to
// fail a build; this holds the questions a person still has to answer, and it answers them for every file at
// once so a sweep has an order rather than a hunch:
//
//   - does this surface say anything about a phone at all, and if not, does it write any layout that would
//     need to?
//   - does it say anything about a wide screen, and which of its grids of three or more columns stop adapting
//     at `xl` or below, so that past 1280px their cells only stretch (docs/06-responsive-ui.md, rule 32)?
//   - does a page carry all three states (waiting, empty, failed), or does it claim one while another is true?
//
// Run: node scripts/uiAudit.mjs [--verbose]
// Written for a sweep, so the default output is the findings; --verbose adds the per-file layout rows that
// were judged safe, which is what makes "nothing to do here" auditable rather than asserted.
import fs from "node:fs";
import path from "node:path";

const ROOT = "web/src";
const VERBOSE = process.argv.includes("--verbose");

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".tsx")) files.push(p);
  }
})(ROOT);

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Brace-aware end of a JSX opening tag. A regex cannot do this: an arrow function in an attribute
// (`onClick={() => …}`) contains the `>` that would be taken for the end of the tag, and an apostrophe inside
// a template literal ("You've used all your picks") opens a string that never closes.
function tagEnd(src, from) {
  let depth = 0;
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return i;
  }
  return src.length;
}
function* tags(src, names) {
  const rx = new RegExp(`<(${names.join("|")})\\b`, "g");
  let m;
  while ((m = rx.exec(src))) {
    const end = tagEnd(src, m.index + m[0].length);
    yield { line: src.slice(0, m.index).split("\n").length, el: src.slice(m.index, end + 1), end: end + 1 };
    rx.lastIndex = end + 1;
  }
}
const classOf = (el) => {
  const m = /className=(?:"([^"]*)"|\{cn\(([\s\S]*?)\)\}|\{`([^`]*)`\})/.exec(el);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").replace(/\s+/g, " ");
};

// A calendar week and an emoji sheet are grids whose column count IS the content; they never step.
const FIXED_BY_MEANING = /grid-cols-(7|8)\b/;

// Findings that have been looked at and accepted, with the reason. Keyed `file:kind`. Same convention as the
// allowlists in test/responsiveCoverage.test.ts: an entry is a claim someone made, not a silencer - if the
// reason stops being true, delete the entry rather than the finding.
const ACCEPTED = {
  // Rule 19: a horizontal scroller is right where the grid IS the content. Both of these are declared
  // scrollers with a scroll-shadow affordance; the min-width is what keeps the cells legible inside them.
  "components/calendar/TeamGrid.tsx:wide-fixed": "people × days matrix, in its own scroller",
  "components/common/TeamTimeline.tsx:wide-fixed": "people × days timeline, in its own scroller",
  // Three columns of TEXT. A grid only breaks a phone when its tracks state widths; this is 1fr label +
  // 2fr value, and text wraps.
  "components/common/Skeletons.tsx:grid-3-no-step": "the placeholder for label/value detail rows",
  // Small square tiles whose stated size already fits: 3 × 96px in a popover, 6 × 28px + gaps = 208px.
  "components/common/KudosArtPicker.tsx:grid-3-no-step": "3 art tiles in a popover, fits a phone",
  "pages/LeaveTypes.tsx:grid-3-no-step": "6 colour swatches at 28px = 208px, fits a phone",
  // These three hand their load state to RequestsHistoryTabs, which wraps the table in <DataState>. The
  // scan sees the page, not the component it delegates to.
  "pages/Leaves.tsx:no-loading-state": "delegates to RequestsHistoryTabs → DataState",
  "pages/Overtime.tsx:no-loading-state": "delegates to RequestsHistoryTabs → DataState",
  "pages/RemoteWork.tsx:no-loading-state": "delegates to RequestsHistoryTabs → DataState",
  // Detail pages, not lists: there is no set that can be empty, only a record that may not exist.
  "pages/EmployeeProfile.tsx:no-empty-state": "a record page, not a list",
  "pages/Profile.tsx:no-empty-state": "a record page, not a list",
  // A failed template read falls back to DEFAULT_PAYSLIP_TEMPLATE, which is a better answer than an error
  // panel: the designer still opens, on the defaults, and saving fixes the row.
  "pages/PayslipDesignTab.tsx:no-error-state": "falls back to the default template",
  // Each settings panel owns its own read and its own failure; the hub has no read to fail.
  "pages/Settings.tsx:no-error-state": "panels own their reads",
  // Rule 32: grids that keep their last step on a wide screen, each for a reason other than oversight.
  "pages/Settings.tsx:grid-stops-at-xl": "hub cards inside Settings' own max-w-5xl column, which a wide screen does not widen; and four font fields (the .map fills a <select>)",
  "pages/Operations.tsx:grid-stops-at-xl": "three fixed scheduled tasks (CRONS): three across already fills the row",
  "components/calendar/QuarterGrid.tsx:grid-stops-at-xl": "always three months, one per column from xl",
  "components/common/IllustrationPicker.tsx:grid-stops-at-xl": "inside the picker dialog, whose width is the dialog's, not the page's",
};

const report = [];
for (const p of files) {
  const src = strip(fs.readFileSync(p, "utf8"));
  const name = p.replace(`${ROOT}/`, "");
  const f = { name, findings: [], safeRows: [] };
  const add = (kind, line, detail) => f.findings.push({ kind, line, detail });

  f.phoneAware = /\bsm:|useMedia\(|coarse:|isPhone|max-sm:/.test(src);
  f.wideAware = /\b(lg:|xl:|2xl:|3xl:)/.test(src);

  for (const t of tags(src, ["div", "section", "header", "footer", "nav", "ul", "form", "aside", "main", "span", "p", "label", "dl", "table"])) {
    const cls = classOf(t.el);
    if (!cls) continue;

    // A non-wrapping flex row whose children state widths cannot narrow to a phone.
    if (/\bflex\b/.test(cls) && !/flex-col|flex-wrap/.test(cls)) {
      const widths = [...cls.matchAll(/(?:^|\s)(?:w|min-w|basis)-\[?(\d+)/g)];
      if (widths.length >= 2 && !/min-w-0/.test(cls)) add("flex-row-fixed", t.line, cls.slice(0, 80));
      else if (VERBOSE && /gap-/.test(cls)) f.safeRows.push(`${t.line}: ${cls.slice(0, 70)}`);
    }
    // Three or more columns with no phone step.
    const g = cls.match(/(?:^|\s)grid-cols-(\d+)/);
    if (g && Number(g[1]) >= 3 && !/\b(sm|md|lg|xl):grid-cols-/.test(cls) && !FIXED_BY_MEANING.test(cls)) {
      add("grid-3-no-step", t.line, cls.slice(0, 80));
    }
    // A card grid whose ladder stops at `xl` or below with three or more columns and nothing for a wide screen:
    // past 1280px its cards only get wider. Either it adds columns (`2xl:grid-cols-fill`, rule 32), steps to a
    // divisor of a fixed count (`3xl:grid-cols-6`), or it is accepted below with the reason it should not.
    // Only grids whose children are mapped from data (a `.map(` straight after the tag): a row of four form
    // fields is a fixed set, and four across is its finished layout at any width.
    const steps = [...cls.matchAll(/(?:^|\s)(?:sm|md|lg|xl):grid-cols-(\d+)\b/g)].map((m) => Number(m[1]));
    const mapped = src.slice(t.end, t.end + 400).includes(".map(");
    if (mapped && steps.length && Math.max(...steps) >= 3 && !/\b(2xl|3xl):grid-cols-/.test(cls) && !FIXED_BY_MEANING.test(cls)) {
      add("grid-stops-at-xl", t.line, cls.slice(0, 80));
    }
    // An absolute track in a grid template with no breakpoint prefix.
    for (const m of cls.matchAll(/(?:^|\s)(?:(sm|md|lg|xl|2xl):)?grid-cols-\[([^\]]+)\]/g)) {
      if (!m[1] && /\d+(px|rem)/.test(m[2])) add("grid-abs-track", t.line, m[0].trim().slice(0, 70));
    }
    // `vh` counts the space behind a mobile browser's own chrome; `dvh` is the corrected unit.
    for (const m of cls.matchAll(/(?:^|\s)(?:max-|min-)?h-\[[^\]]*\bvh\b[^\]]*\]/g)) add("vh-not-dvh", t.line, m[0].trim());
    // A stated width wider than the ~328px of content column a 360px phone has, with no breakpoint.
    for (const m of cls.matchAll(/(?:^|\s)(?:(sm|md|lg|xl|2xl):)?(w|min-w)-\[(\d+)(px|rem)\]/g)) {
      const px = m[4] === "rem" ? Number(m[3]) * 16 : Number(m[3]);
      if (!m[1] && px > 340) add("wide-fixed", t.line, m[0].trim());
    }
  }

  // A page that lists things needs all three answers: waiting, empty, failed. Claiming one while another is
  // true is the bug this catches - "You're all caught up" rendered before a single queue had been read.
  if (name.startsWith("pages/") && /<DataTable\b|<table\b|\.map\(/.test(src)) {
    if (!/<DataState\b|state === "loading"|\bloading\b|<\w*Skeleton\b|loaded/.test(src)) add("no-loading-state", 0, "");
    if (!/<EmptyState\b|emptyTitle|length === 0/.test(src)) add("no-empty-state", 0, "");
    if (!/<DataState\b|error/.test(src)) add("no-error-state", 0, "");
  }

  report.push(f);
}

// Split the findings into open ones and the ones already argued about.
let acceptedCount = 0;
for (const f of report) {
  f.findings = f.findings.filter((x) => {
    if (!ACCEPTED[`${f.name}:${x.kind}`]) return true;
    acceptedCount++;
    return false;
  });
}

const totals = {};
for (const f of report) for (const x of f.findings) totals[x.kind] = (totals[x.kind] ?? 0) + 1;
console.log(`accepted (see ACCEPTED in this file for the reason each): ${acceptedCount}`);

console.log(`surfaces scanned: ${report.length}`);
console.log(`  phone-aware: ${report.filter((f) => f.phoneAware).length}   wide-aware: ${report.filter((f) => f.wideAware).length}`);
if (Object.keys(totals).length === 0) console.log("\nno findings");
else {
  console.log("\ntotals:");
  for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);
  console.log("\nby file:");
  for (const f of report.filter((f) => f.findings.length).sort((a, b) => b.findings.length - a.findings.length)) {
    console.log(`\n${f.name}  [${f.findings.length}]`);
    for (const x of f.findings) console.log(`   ${x.kind}${x.line ? ":" + x.line : ""}  ${x.detail}`);
  }
}

if (VERBOSE) {
  console.log("\nsurfaces with no phone-specific code (each one's own layout rows, for review):");
  for (const f of report.filter((f) => !f.phoneAware && f.safeRows.length)) {
    console.log(`\n${f.name}`);
    for (const r of f.safeRows) console.log(`   ${r}`);
  }
}
