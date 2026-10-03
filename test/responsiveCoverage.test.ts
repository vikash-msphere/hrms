/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Responsive coverage for the whole front end.
//
// The app is used on a phone as much as on a laptop, and the failures that matter there are not subtle: a
// table with no scroll box makes the entire PAGE scroll sideways; a row of fixed columns that add up to more
// than the viewport simply cannot be read; a dialog that states its own height overrides the shared
// keyboard-aware geometry and hides its own Save button behind the keys. Each of those is invisible in a
// desktop browser and each one had at least one instance in this codebase.
//
// So the conventions in docs/06-responsive-ui.md are pinned here rather than left to review. Every rule below
// is a rule a reviewer cannot reliably check by eye across ~230 files, and every allowlist entry is a claim
// that the pattern is fine for a stated reason.
//
// The scans are deliberately blunt (regex over source, not an AST). Blunt is the point: a precise rule nobody
// can read gets an allowlist entry instead of a fix.
const web = import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

const files = Object.entries(web);
const name = (path: string) => path.replace(/^.*web\/src\//, "");

// Strip comments before scanning: this file's own rules are quoted in the docs and in explanatory comments
// next to the code they justify, and a scan that reads its own counter-examples reports them as violations.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("responsive coverage", () => {
  // A bare <table> is sized by its content, so it widens its ANCESTORS until something clips or scrolls. With
  // no scroll box anywhere above it, that something is the page: the whole layout scrolls sideways on a phone
  // and the top bar detaches from the content. Any overflow value works - `overflow-y-auto` computes
  // `overflow-x: auto` per spec when the other axis is not `visible`.
  it("every raw <table> sits inside a scroll container", () => {
    const offenders = files
      .filter(([, src]) => code(src).includes("<table"))
      .filter(([, src]) => !/overflow-(x-|y-)?auto|overflow-(x-|y-)?scroll|overflow-hidden/.test(code(src)))
      .map(([p]) => name(p))
      // ui/table.tsx IS the scroll container (it wraps every <table> it renders). Chart.tsx's table carries
      // the chart's numbers for a reader who cannot see the SVG, inside an `sr-only` WRAPPER that clips it -
      // see the next check for why the class cannot go on the table itself.
      .filter((p) => p !== "components/ui/table.tsx" && p !== "components/common/Chart.tsx");
    expect(offenders, "wrap the table in a div with overflow-x-auto - see docs/06-responsive-ui.md").toEqual([]);
  });

  // `sr-only` hides a box by shrinking it to 1px and clipping it, and a `<table>` is the one element that
  // refuses the first half: a table cannot be laid out narrower than its own min-content, whatever `width`
  // says. So the class leaves a full-width invisible table in the page, which widens the document with
  // nothing to see in it - a page that pans sideways over blank space wherever `overflow-x: clip` is not
  // supported, and an inflated `scrollWidth` everywhere else. It cost every page with a chart on it.
  // The fix is a wrapper: a plain block DOES take the 1px, and its own `overflow: hidden` contains the table.
  it("sr-only is on a wrapper, never on a table", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/<table[^>]*className=(?:"([^"]*)"|\{[^}]*?"([^"]*)"[^}]*\})/g)) {
        const cls = `${m[1] ?? ""} ${m[2] ?? ""}`;
        if (/\bsr-only\b/.test(cls)) offenders.push(`${name(path)}: ${cls.trim()}`);
      }
    }
    expect(offenders, "put sr-only on a wrapping <div> - a table ignores the 1px width it sets").toEqual([]);
  });

  // A scroll box stops a table breaking the PAGE, but it does not make the table readable: on a phone the
  // reader gets two of six columns and a sideways gesture nobody performs, with the headings scrolling away
  // from the values they label. So a hand-written table also has to say what it does below `sm` - either
  // `.table-stack` (labelled rows, see index.css) or its own phone layout behind a `sm:`/`useMedia` switch.
  //
  // The allowlist is for the surfaces where a grid IS the content and scrolling is the honest answer, the
  // same way a kanban board scrolls: a role × collection permission matrix, a roster of people × days, a
  // week grid of projects × days. Add an entry only with that kind of reason.
  it("every hand-written table stacks or scrolls deliberately on a phone", () => {
    const MATRIX = [
      // roles across the top, collections down the side - stacking it would print one row per cell
      "components/common/PermissionsPanel.tsx",
      // people × days; the sticky name column is what makes it usable, and it narrows on a phone already
      "pages/Schedule.tsx",
      // scope × twelve months of budget utilisation - a year heat-map, which stacking would turn into a
      // twelve-line list per scope
      "pages/ExpenseBudgets.tsx",
      // short parse-preview lists inside a dialog: two or three narrow columns, no headings to lose
      "components/assets/BulkAddAssets.tsx",
      "components/holidays/BulkAddDialog.tsx",
      "components/holidays/CopyYearDialog.tsx",
      // a two-column name/amount breakdown, which already reads as a list at any width
      "components/common/EmployeeSettlement.tsx",
      // a chart's `sr-only` data equivalent: never painted, so it has no phone layout to get wrong
      "components/common/Chart.tsx",
      // the primitive itself, and the surfaces that render their own phone layout instead of a table
      "components/ui/table.tsx",
      "pages/Timesheets.tsx",
      // the day-by-day history swaps its table for `DayCards` below `sm` - the phone layout is a different
      // component, not a stacked table. (Attendance.tsx itself is no longer here: the one table left on it,
      // the team period grid, stacks.)
      "components/common/AttendanceHistory.tsx",
    ];
    const offenders = files
      .filter(([, src]) => /<table[\s>]/.test(code(src)))
      .filter(([, src]) => !code(src).includes("table-stack"))
      .map(([p]) => name(p))
      .filter((p) => !MATRIX.includes(p));
    expect(offenders, "add `table-stack` (or a phone layout of its own) - see docs/06-responsive-ui.md").toEqual([]);
  });

  // A stacked cell states its own heading, because the `thead` that carried it is not on screen. A row of
  // bare values with no labels is the failure this rule exists to prevent, so every `<td>` in a stacking
  // table needs either a `data-label` or a reason to be label-less (the row title, an action cluster, a
  // `colSpan` note) - which is exactly the set of cells that carry no heading in the table either.
  it("stacked tables label their cells", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      if (!code(src).includes("table-stack")) continue;
      const cells = code(src).match(/<td\b[^>]*>/g) ?? [];
      const labelled = cells.filter((c) => c.includes("data-label")).length;
      // Every table has SOME label-less cells by design; a stacking table with none at all is one where the
      // labels were never added.
      if (labelled === 0) offenders.push(name(path));
    }
    expect(offenders, "give each stacked <td> a data-label - see docs/06-responsive-ui.md").toEqual([]);
  });

  // Card padding is two-step - 16px on a phone, 24px from `sm` up (components/ui/card.tsx) - because a card
  // that spends 48px of a 328px screen on its own margins is spending 15% of the phone on nothing. The two
  // steps are two classes, and tailwind-merge resolves conflicts PER BREAKPOINT: a call site that overrides
  // the padding with a bare `p-0` drops the unprefixed half and silently keeps `sm:p-6`, so the card ends up
  // padded at one width and flush at the other. An override therefore has to state both steps.
  it("card padding overrides state both breakpoints", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/<Card(?:Header|Content|Footer)\s+className="([^"]*)"/g)) {
        const cls = m[1] ?? "";
        for (const token of cls.split(/\s+/)) {
          const box = /^(p|px|py)-/.exec(token);
          if (!box) continue;
          const axis = box[1]!;
          // `sm:` twin for the same axis, or a broader `sm:p-` that covers it.
          const covered = new RegExp(`(^|\\s)sm:(${axis}|p)-`).test(cls);
          if (!covered) offenders.push(`${name(path)}: ${token} in "${cls}"`);
        }
      }
    }
    expect(offenders, "state the sm: step too (e.g. `p-0 sm:p-0`) - see components/ui/card.tsx").toEqual([]);
  });

  // `grid-cols-[a_b_c]` with three or more FIXED tracks is a row that cannot narrow. Three 8rem columns plus
  // gutters need ~400px before the flexible column gets anything, which is more than a phone has. Such a
  // template has to be introduced at a breakpoint (`sm:grid-cols-[…]`) with a stacked layout underneath.
  it("no unbreakpointed grid template with 3+ fixed tracks", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/(^|[\s"'`])(grid-cols-\[[^\]]+\])/g)) {
        const cls = m[2]!;
        // A responsive one is written `sm:grid-cols-[…]`; the capture above excludes the prefix, so a prefixed
        // occurrence is identified by what immediately precedes it.
        if (/[:]$/.test(m[1] ?? "")) continue;
        const tracks = cls.slice("grid-cols-[".length, -1).split("_");
        const fixed = tracks.filter((t) => /^\d+(\.\d+)?(rem|px|ch)$/.test(t)).length;
        if (fixed >= 3) offenders.push(`${name(path)}: ${cls}`);
      }
    }
    expect(offenders, "introduce the fixed template at sm: and stack below it").toEqual([]);
  });

  // `grid-cols-[auto,1fr]` compiles to `grid-template-columns: auto,1fr`, which is invalid CSS: browsers drop
  // the whole declaration and the element silently becomes a single column on every screen. Tailwind turns
  // underscores into spaces, so `[auto_1fr]` is the intended spelling. Commas are legal only inside a
  // function - minmax(0,1fr), clamp(…) - so those are stripped before the check.
  it("no comma-separated grid template (invalid CSS, silently dropped)", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/grid-cols-\[[^\]]+\]/g)) {
        const withoutFns = m[0]!.replace(/[a-z-]+\([^)]*\)/g, "F");
        if (withoutFns.includes(",")) offenders.push(`${name(path)}: ${m[0]}`);
      }
    }
    expect(offenders, "use underscores between tracks: grid-cols-[auto_1fr]").toEqual([]);
  });

  // A dialog that states its own height or width overrides the shared phone geometry in ui/dialog.tsx - which
  // is what insets the panel from the screen edges and gives up height to the on-screen keyboard. Unprefixed,
  // the panel ends up wider than its slot and its footer sits behind the keys. Prefix the ceiling with `sm:`
  // and the phone keeps the bottom-sheet behaviour.
  it("no dialog sets its own height/width without an sm: prefix", () => {
    const offenders: string[] = [];
    // Only the geometry that fights the sheet: a height ceiling, or a viewport-relative width. `max-w-lg` and
    // friends are fine - the sheet's own `inset-x-4` already bounds the width on a phone.
    const BAD = /(?<![a-z:-])(max-h-\[|h-\[(?:\d|calc)|w-\[(?:min\()?\d+vw)/;
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/<(?:Dialog|Sheet)Content[^>]*className=(?:"([^"]*)"|\{[^}]*\})/g)) {
        const cls = m[1];
        if (!cls) continue; // a cn(...) expression - checked by eye, too noisy to parse here
        for (const token of cls.split(/\s+/)) {
          if (token.startsWith("sm:") || token.startsWith("md:") || token.startsWith("lg:")) continue;
          if (BAD.test(token)) offenders.push(`${name(path)}: ${token}`);
        }
      }
    }
    expect(offenders, "prefix the ceiling with sm: so the phone keeps the sheet geometry").toEqual([]);
  });

  // The touch variants the components depend on. `coarse:` in particular is load-bearing: dozens of controls
  // state their touch target with it, and if the screen were dropped from the config those classes would
  // silently generate nothing - every one of those targets would quietly go back to being too small, with no
  // build error to notice.
  //
  it("the touch/PWA variants exist in the Tailwind config", () => {
    const cfg = import.meta.glob("../web/src/index.css", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >;
    const src = Object.values(cfg)[0] ?? "";
    expect(src, "the Tailwind config must be readable for this gate to mean anything").not.toBe("");
    for (const [variant, query] of [
      ["coarse", "pointer: coarse"],
      ["standalone", "display-mode: standalone"],
      ["short", "max-height: 480px"],
    ]) {
      expect(src, `the ${variant}: variant is used across the app`).toContain(`@custom-variant ${variant} (@media (${query}))`);
    }
  });

  // A hover-reveal control is invisible on a touch screen while still occupying its box, so tapping it is a
  // blind hit on something the user cannot see. index.css handles that centrally for the whole app, so no
  // component should be re-solving it locally - two had, before the central rule existed, and per-site copies
  // are how a convention quietly becomes optional again.
  it("no component re-implements the touch hover-reveal workaround", () => {
    const offenders = files
      .filter(([, src]) => /\[@media\(pointer:coarse\)\]:opacity-100/.test(code(src)))
      .map(([p]) => name(p));
    expect(offenders, "index.css already forces group-hover reveals visible on a coarse pointer").toEqual([]);
  });

  // Anything docked to the bottom of the viewport on a phone has to clear the home indicator; otherwise it
  // lands under the gesture bar, where a tap either does nothing or leaves the app.
  it("bottom-docked elements clear the phone home indicator", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/(?<![a-z:-])(?:fixed|sticky)[^"'`]*?\bbottom-(\d+|\[[^\]]+\])/g)) {
        const token = m[0].slice(m[0].lastIndexOf("bottom-"));
        // Cleared if it is a calc that reserves room, or if a md:/sm: variant states the desktop value
        // separately (which is how the phone value gets to be the larger one).
        if (token.includes("safe-area-inset-bottom")) continue;
        if (/bottom-(0|\[0)/.test(token)) continue; // flush-to-edge is for viewport chrome, not page content
        const line = code(src).slice(Math.max(0, m.index! - 200), m.index! + 200);
        if (/md:bottom-|sm:bottom-|safe-area-inset-bottom/.test(line)) continue;
        offenders.push(`${name(path)}: ${token}`);
      }
    }
    expect(
      offenders,
      "add calc(1.75rem + env(safe-area-inset-bottom)) on a phone and md:bottom-<n> for the desktop value",
    ).toEqual([]);
  });

  // Every `env(safe-area-inset-*)` in the app - the docked bars' padding, the sheet footers, the dialog
  // gutters, the standalone status-bar inset - evaluates to 0 unless the viewport meta opts into painting
  // under the device's own chrome. The whole safe-area layer is written against that one attribute, and
  // dropping it would not break a build or fail any other check here: it would just quietly zero every inset
  // and letterbox the installed app, which is exactly how it went unnoticed the first time.
  it("the viewport meta opts into the safe-area insets", () => {
    const html = import.meta.glob("../web/index.html", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >;
    const src = Object.values(html)[0] ?? "";
    expect(src, "index.html must be readable for this gate to mean anything").not.toBe("");
    expect(src, "without viewport-fit=cover every env(safe-area-inset-*) in the app reads 0").toContain("viewport-fit=cover");
  });

  // An icon-only button says nothing to a screen reader: its whole content is an <svg aria-hidden> and the
  // accessible name comes out empty, so it is announced as "button" and nothing else. There were 31 of these.
  // The name can come from aria-label, a title, an aria-labelledby, or an sr-only span - any of the four.
  it("icon-only buttons have an accessible name", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      if (name(path) === "components/ui/button.tsx") continue;
      for (const m of code(src).matchAll(/<Button\b[\s\S]*?<\/Button>/g)) {
        const el = m[0];
        if (!/size="icon"/.test(el)) continue;
        if (/aria-label|aria-labelledby|title=|sr-only/.test(el)) continue;
        offenders.push(`${name(path)}: ${el.replace(/\s+/g, " ").slice(0, 60)}`);
      }
    }
    expect(offenders, 'give the button an aria-label (or an sr-only span) naming what it does').toEqual([]);
  });

  // A dialog long enough to scroll must scroll its BODY, not the whole panel. When the panel scrolls, its
  // footer scrolls with it - so on a phone the Save button of a twelve-field form sits below the fold of its
  // own dialog, and the way to find it is to scroll past every field first. `scrollBody` + <DialogBody> keeps
  // the title and the actions still while the fields move between them. 15 dialogs were built the other way.
  it("long dialogs pin their footer", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      if (name(path) === "components/ui/dialog.tsx") continue;
      for (const m of code(src).matchAll(/<DialogContent[\s\S]*?<\/DialogContent>/g)) {
        const el = m[0];
        if (/scrollBody/.test(el)) continue;
        if (!/<DialogFooter/.test(el)) continue; // no actions to strand
        const fields = (el.match(/<Field\b|<Input\b|<Textarea\b|<Select\b|<Combobox\b|<MoneyInput\b/g) ?? []).length;
        if (fields >= 5) offenders.push(`${name(path)}: ${fields} fields`);
      }
    }
    expect(offenders, "add `scrollBody` to DialogContent and wrap the fields in <DialogBody>").toEqual([]);
  });

  // A search box is not prose. Left as a plain text input a phone capitalises the first letter, autocorrects
  // the surname you are looking for into a word it knows, and offers a Return key rather than a Search one.
  // `type="search"` is where all of that is decided (ui/input.tsx applies the rest from it).
  it("search inputs are typed as search", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/<Input\b[^>]*placeholder="Search[^"]*"[^>]*>/g)) {
        if (!/type="search"/.test(m[0])) offenders.push(`${name(path)}: ${m[0].replace(/\s+/g, " ").slice(0, 70)}`);
      }
    }
    expect(offenders, 'give a search box type="search" - see docs/06-responsive-ui.md').toEqual([]);
  });
});

// ============================================================================================
// Two rules about a RELATIONSHIP - what a row contains - rather than about one element.
//
// These read the file as indented lines rather than as a parse tree. The obvious tool would be the
// TypeScript parser, and it cannot be used here: this suite runs in the Cloudflare workers pool,
// where `typescript` fails to load (it wants `node:os`). The fallback is sound because the front end
// is Prettier-formatted at a fixed two-space step, so a child element is a line indented exactly two
// spaces past its parent's - and blunt-but-readable is this file's whole approach anyway.
//
// What that costs, stated plainly: an element whose className sits on a different line from its tag
// is not counted, so both checks UNDER-report. They exist to stop a fixed class of bug coming back,
// not to prove the absence of it.
// ============================================================================================
describe("responsive coverage (rows)", () => {
  // Tailwind's `w-N` scale is N * 0.25rem. A 360px phone minus the shell's `px-4` on both sides
  // leaves 328px of content column. The threshold is 320 rather than 328 so a row that exactly fills
  // the column is not reported as a failure.
  const PHONE_CONTENT_PX = 320;

  type Line = { n: number; indent: number; text: string };
  const linesOf = (src: string): Line[] =>
    code(src)
      .split("\n")
      .map((raw, i) => ({ n: i + 1, indent: raw.length - raw.trimStart().length, text: raw.trim() }));

  // The class tokens written on one line. Good enough for these two rules: the rows they are about
  // are single-line elements, which is exactly why they were easy to get wrong.
  const classesOn = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(/class[nN]ame=(?:"([^"]*)"|\{[^}]*?"([^"]*)"[^}]*\})/g)) {
      out.push(m[1] ?? m[2] ?? "");
    }
    return out.join(" ").split(/\s+/).filter(Boolean);
  };

  const SCROLL_OR_CLIP = /^(?:sm:|md:|lg:|xl:)?overflow(?:-[xy])?-(?:auto|scroll|hidden|clip)$/;
  const isRow = (cls: string[]) =>
    cls.includes("flex") &&
    !cls.includes("flex-col") &&
    !cls.some((c) => /^(?:sm:|md:|lg:|xl:)?flex-wrap$/.test(c)) &&
    !cls.some((c) => SCROLL_OR_CLIP.test(c));

  // The lines nested under `at`, and of those the ones that behave as its direct children.
  //
  // "Behave as" because a child is often not written as one: `{rows.map((r) => (` and `{cond && (`
  // sit between a row and the element they render, and that element still occupies a track in the
  // row. So one level of expression wrapper is treated as transparent - a tag two steps in counts as
  // a child when the step above it is an expression line rather than a tag.
  const nested = (ls: Line[], at: number) => {
    const own = ls[at]!.indent;
    let end = at + 1;
    while (end < ls.length && (ls[end]!.text === "" || ls[end]!.indent > own)) end++;
    const inner = ls.slice(at + 1, end);
    const wrapperIndents = new Set(
      inner.filter((l) => l.indent === own + 2 && !l.text.startsWith("<")).map(() => own + 2),
    );
    const children = inner.filter(
      (l) =>
        l.text.startsWith("<") &&
        (l.indent === own + 2 || (l.indent === own + 4 && wrapperIndents.has(own + 2))),
    );
    return { inner, children };
  };

  // The arithmetic nobody does at review time. A `w-40` select beside a `w-32` select beside three
  // 32px icon buttons is 384px of DECLARED width before a single gap, in a 328px column - and it
  // looks perfectly reasonable in an editor on a 27-inch screen. Six rows in this app were built
  // that way; `.editor-row` (index.css) is the shape they were rewritten into.
  it("no non-wrapping row states more width than a phone has", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      const ls = linesOf(src);
      for (let i = 0; i < ls.length; i++) {
        if (!ls[i]!.text.startsWith("<") || !isRow(classesOn(ls[i]!.text))) continue;
        let sum = 0;
        for (const child of nested(ls, i).children) {
          let widest = 0;
          for (const c of classesOn(child.text)) {
            const scale = /^w-(\d+(?:\.\d+)?)$/.exec(c);
            if (scale) widest = Math.max(widest, Number(scale[1]) * 4);
            const arb = /^(?:min-)?w-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(c);
            if (arb) widest = Math.max(widest, arb[2] === "rem" ? Number(arb[1]) * 16 : Number(arb[1]));
          }
          sum += widest;
        }
        if (sum > PHONE_CONTENT_PX) offenders.push(`${name(path)}:${ls[i]!.n}: ~${Math.round(sum)}px stated`);
      }
    }
    expect(
      offenders,
      "let the row wrap (`editor-row`), or state the wide values from `sm:` up - see docs/06-responsive-ui.md",
    ).toEqual([]);
  });

  // `truncate` on a DIRECT flex child already works, and it is worth knowing why: truncate sets
  // `overflow: hidden`, and a flex item whose overflow is not `visible` has an automatic minimum size
  // of zero rather than its min-content width. It is free to shrink, so the ellipsis appears.
  //
  // Put one wrapper in between and that stops being true. The wrapper's own overflow IS visible, so
  // its automatic minimum size is its min-content width - and the min-content width of a nowrap
  // string is the whole string. The wrapper is never offered less room than the full label wants, the
  // truncate inside it therefore never fires, and the row grows until the page scrolls sideways.
  // `min-w-0` on the wrapper is the fix, and it is the single most common responsive bug in this
  // codebase's history.
  it("no flex-1 wrapper blocks the truncate inside it", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      const ls = linesOf(src);
      for (let i = 0; i < ls.length; i++) {
        if (!ls[i]!.text.startsWith("<") || !isRow(classesOn(ls[i]!.text))) continue;
        for (const child of nested(ls, i).children) {
          const cls = classesOn(child.text);
          if (!cls.includes("flex-1") && !cls.includes("grow") && !cls.includes("w-full")) continue;
          if (cls.includes("min-w-0") || cls.includes("shrink-0") || cls.includes("truncate")) continue;
          if (cls.some((c) => SCROLL_OR_CLIP.test(c))) continue;
          const at = ls.indexOf(child);
          const holdsNowrap = nested(ls, at).inner.some((l) =>
            classesOn(l.text).some((c) => c === "truncate" || c === "whitespace-nowrap"),
          );
          if (holdsNowrap) offenders.push(`${name(path)}:${child.n}`);
        }
      }
    }
    expect(offenders, "add `min-w-0` to the wrapper so the truncate inside it can fire").toEqual([]);
  });

  // The floor that makes all of the above possible. An <input>/<textarea> has an intrinsic width from
  // its `size`/`cols` attribute (~170px), and a select/combobox trigger from its widest option label -
  // and that intrinsic width becomes the automatic minimum size of the flex item. Without `min-w-0`
  // in these primitives no amount of care at the call site keeps a filter row on one screen, and the
  // failure is spread over ~90 call sites instead of being visible in one place.
  it("the shrinkable form primitives keep their zeroed width floor", () => {
    for (const [file, token] of [
      ["components/ui/input.tsx", "min-w-0"],
      ["components/ui/textarea.tsx", "min-w-0"],
      ["components/ui/select.tsx", "min-w-0"],
      ["components/ui/combobox.tsx", "min-w-0"],
      // A tooltip has no intrinsic width limit of its own: several here explain a whole rule, and
      // left alone that sentence is laid out as one line running off the side of a phone.
      ["components/ui/tooltip.tsx", "max-w-["],
    ] as const) {
      const src = files.find(([p]) => name(p) === file)?.[1] ?? "";
      expect(src, `${file} must be readable for this gate to mean anything`).not.toBe("");
      expect(code(src), `${file} needs ${token} - see docs/06-responsive-ui.md`).toContain(token);
    }
  });

  // A TabsList overridden into `grid grid-cols-N` throws away the two things the primitive gives it:
  // a scrolling strip, and scroll-the-active-tab-into-view. It also cannot work, because a trigger's
  // label is `whitespace-nowrap` while an equal `minmax(0,1fr)` track is under no obligation to fit
  // it - so "Swimlanes" simply spills out of its own quarter of the bar.
  it("no TabsList is overridden into a fixed grid", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/<TabsList[^>]*className="([^"]*)"/g)) {
        const cls = m[1] ?? "";
        if (!/\bgrid\b/.test(cls)) continue;
        // Two tabs of a word or two each do fit; the failure starts where the labels do not.
        if (/\bgrid-cols-2\b/.test(cls)) continue;
        offenders.push(`${name(path)}: ${cls}`);
      }
    }
    expect(offenders, "drop the grid - a plain TabsList already scrolls its strip").toEqual([]);
  });

  // The same failure one level down, and the one that actually shipped: a flex item's default is
  // `flex-shrink: 1`, so in a strip that scrolls sideways the items do not overflow the box and make
  // it scroll - they are squeezed narrower than their own content first. A `whitespace-nowrap` label
  // in a squeezed box cannot reflow either, so the text paints outside its border and over the item
  // beside it: on a phone the Employees tab bar read "Org chOnboarding". `shrink-0` is the whole fix,
  // and it has to be on the item, not on the strip.
  //
  // The scan reads the strip's whole subtree rather than the line below it, because the item is often
  // not written as a child at all - the tab bar here builds its link in a `const link = (...)` inside
  // a `.map()`, three levels of expression away from the strip. A nowrap element is excused when it,
  // or something between it and the strip, already says it will not shrink (`shrink-0`, `flex-none`)
  // or says it is meant to (`truncate`, `min-w-0`, where the ellipsis is the intended outcome).
  it("nothing inside a horizontal scroller can be squeezed under its own label", () => {
    const SCROLLS_X = (cls: string[]) => cls.some((c) => /^(?:sm:|md:|lg:|xl:)?overflow-x-(?:auto|scroll)$/.test(c));
    const isScrollRow = (cls: string[]) =>
      cls.includes("flex") &&
      !cls.includes("flex-col") &&
      !cls.some((c) => /^(?:sm:|md:|lg:|xl:)?flex-wrap$/.test(c)) &&
      SCROLLS_X(cls);
    // An element's opening tag: from its `<` line to the line that closes the tag at the same indent.
    // Both ends matter - the tag carries a cn() class list built over several lines (which is exactly
    // where the two bugs here hid), and the element's children start after it.
    // A blank line is skipped rather than treated as an outdent: `code()` blanks a comment line in
    // place, and this app comments the rules it applies INSIDE a cn() call - so a stray blank in the
    // middle of an opening tag is the normal case here, not the exception.
    const openingTag = (ls: Line[], at: number) => {
      const own = ls[at]!.indent;
      let end = at;
      if (!/\/?>$/.test(ls[at]!.text)) {
        for (let i = at + 1; i < ls.length; i++) {
          if (ls[i]!.text === "") continue;
          if (ls[i]!.indent < own) break;
          end = i;
          if (ls[i]!.indent === own && /\/?>$/.test(ls[i]!.text)) break;
        }
      }
      return { end, classes: classesOn(ls.slice(at, end + 1).map((l) => l.text).join(" ")) };
    };
    const SETTLED = (cls: string[]) =>
      cls.includes("truncate") ||
      cls.includes("min-w-0") ||
      cls.some((c) => /^(?:sm:|md:|lg:|xl:)?(?:shrink-0|flex-none)$/.test(c));
    // Everything under the strip, to the line where its own indent resumes.
    const subtree = (ls: Line[], at: number, tagEnd: number) => {
      const own = ls[at]!.indent;
      let end = tagEnd + 1;
      while (end < ls.length && (ls[end]!.text === "" || ls[end]!.indent > own)) end++;
      return end;
    };
    const offenders: string[] = [];
    for (const [path, src] of files) {
      const ls = linesOf(src);
      for (let i = 0; i < ls.length; i++) {
        if (!ls[i]!.text.startsWith("<")) continue;
        const strip = openingTag(ls, i);
        if (!isScrollRow(strip.classes)) continue;
        const stop = subtree(ls, i, strip.end);
        for (let at = strip.end + 1; at < stop; at++) {
          if (!ls[at]!.text.startsWith("<") || ls[at]!.text.startsWith("</")) continue;
          const cls = openingTag(ls, at).classes;
          if (!cls.includes("whitespace-nowrap") || SETTLED(cls)) continue;
          // Walk out to the strip through the enclosing tags (each one being the nearest preceding
          // tag at a smaller indent). One of them saying "I do not shrink" settles this element too.
          let covered = false;
          for (let up = at - 1, lim = ls[at]!.indent; up > i && lim > ls[i]!.indent; up--) {
            const l = ls[up]!;
            if (!l.text.startsWith("<") || l.text.startsWith("</") || l.indent >= lim) continue;
            lim = l.indent;
            if (SETTLED(openingTag(ls, up).classes)) { covered = true; break; }
          }
          if (!covered) offenders.push(`${name(path)}:${ls[at]!.n}`);
        }
      }
    }
    expect(offenders, "add `shrink-0` to the child - see docs/06-responsive-ui.md").toEqual([]);
  });
  // A box that scrolls sideways has to SAY so. On a desktop the scrollbar and the hover-summoned
  // overflow do that for free; on a phone there is neither, so a table wider than the screen is
  // indistinguishable from a table with three columns missing - and the columns nobody knows about are
  // the money ones at the right-hand end. `.scroll-shadow-x` (index.css) is the app's answer: a
  // CSS-only fade at whichever edge still has content past it, no scroll listener.
  //
  // Sixteen scrollers in this app had none. Line-based like the rest of this suite, so a class list
  // built across several lines by cn() is not seen - it under-reports rather than misfires.
  it("horizontal scrollers advertise themselves", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      code(src)
        .split("\n")
        .forEach((raw, i) => {
          if (!/overflow-x-(auto|scroll)/.test(raw)) return;
          if (/scroll-shadow-x/.test(raw)) return;
          // A <pre> is exempt: a code block that scrolls is a well-known shape, and a soft fade over
          // monospace on a tinted ground reads as a rendering fault rather than as an affordance.
          if (/<pre\b/.test(raw)) return;
          offenders.push(`${name(path)}:${i + 1}`);
        });
    }
    expect(offenders, "add `scroll-shadow-x` (and `--scroll-ground` if not on the page background)").toEqual([]);
  });

  // A wait is a layout, not a sentence. A centred "Loading…" collapses its container to two lines and then
  // snaps to full height when the data lands, so on a phone the reader loses the panel they just opened, and
  // on a slow connection the screen reads as empty rather than as busy. `components/common/Skeletons.tsx`
  // holds a shape for each of the things this app waits for (a form, a detail list, a table, a row list, a
  // card feed, a tile grid, a metric band, a lazy settings panel); `DataState` is the wrapper that picks the
  // default one. 27 sites here rendered the sentence instead.
  it("a wait renders a shaped placeholder, not the word Loading", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      // The app-boot splash is the one legitimate use: there is no layout yet to hold the place of, and the
      // brand mark plus the app's name is the correct thing to show while the shell itself is arriving.
      if (name(path) === "App.tsx") continue;
      code(src)
        .split("\n")
        .forEach((raw, i) => {
          // Text, not state: `state === "loading"`, `setLoading`, a `loading` prop are all fine. This is the
          // string rendered as a child of an element - or handed to a component as the thing to display,
          // which is how a wait ends up drawn as a zero state (the notifications page rendered an
          // `<EmptyState title="Loading…">`: a dashed box and a "nothing here" illustration, for something
          // that was on its way).
          if (!/>\s*Loading[\s.…]/.test(raw) && !/\b(title|emptyTitle|label|heading)=\{?"Loading/.test(raw)) return;
          if (/sr-only/.test(raw)) return; // the off-screen label a skeleton carries for a screen reader
          // "Loading MORE" is the other thing entirely: content is already on screen, its geometry is
          // already right, and what is being reported is progress appending to it. A spinner is the correct
          // shape for that, and a skeleton below the last row would read as rows that had arrived.
          if (/\bmore\b/i.test(raw)) return;
          offenders.push(`${name(path)}:${i + 1}`);
        });
    }
    expect(offenders, "render a skeleton from components/common/Skeletons.tsx (or wrap in <DataState>)").toEqual([]);
  });

  // Three states look identical from the data alone: a list that is empty, a list that has not arrived, and a
  // list whose read failed - all three are zero rows. A page that renders a zero state without being able to
  // tell them apart therefore states the most confident of the three as fact, and it is the one most likely
  // to be wrong. The approvals inbox said "You're all caught up" before a single queue had been read (and
  // again when a queue failed), the notifications page said "You're all caught up" the same way, and the bank
  // formats panel answered "No banks yet" to a server it could not reach.
  //
  // So a page that shows an EmptyState must also carry a load discriminator. Components are exempt: a
  // presentational one is handed its rows and its parent owns the states (the leave calendar's month grid and
  // agenda list are only rendered past their parent's loading branch).
  it("a page that can be empty can tell empty from loading", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      if (!name(path).startsWith("pages/")) continue;
      const c = code(src);
      if (!/<EmptyState\b/.test(c)) continue;
      // `state={…}` counts: the page holds a load state and hands it to the component that renders the list
      // (Leaves/Overtime/RemoteWork pass theirs to RequestsHistoryTabs, which wraps the table in DataState).
      // Delegating the three states is fine; not having them is not.
      if (/<DataState\b|state === "loading"|state === "error"|\bstate=\{|\bloaded\b|\bloading\b|Skeleton\b|<Suspense\b/.test(c)) continue;
      offenders.push(name(path));
    }
    expect(offenders, "gate the zero state on a load state - <DataState>, or a skeleton while it arrives").toEqual([]);
  });

  // A click handler on a <div> is a control only a pointer can reach. Touch is fine with it; a keyboard is
  // not - there is no tab stop, Enter and Space do nothing, and a screen reader announces a group of text.
  // Three of the app's primary interactions were built this way: opening a kanban card (so a keyboard could
  // not reach a single card on the board), expanding a day on the attendance sheet, and expanding an
  // employee's lines in the payroll run review.
  //
  // The fix is usually a real <button>; where the element must stay a <div> or a <tr> (a table row cannot be
  // a button without losing its row semantics) it needs `tabIndex={0}`, an Enter/Space `onKeyDown`, and a
  // role or `aria-expanded` saying what it is.
  //
  // Reading a JSX opening tag needs brace awareness, not a regex: an arrow function inside an attribute
  // (`onClick={() => …}`) contains the `>` that a regex would take for the end of the tag.
  it("a clickable element can be reached by a keyboard", () => {
    const POINTER_SURFACE = [
      // The drawer scrim. Escape closes the drawer and focus is trapped inside it, so the scrim is
      // deliberately not a tab stop - it would be one more thing to tab past to leave.
      "components/layout/Sidebar.tsx",
      // Click-to-place a signature on a rendered PDF page, and the sticker sheet's slot grid: both are
      // coordinate surfaces, where the keyboard equivalent is a different feature (the slot grid has its
      // own menu). Stated here rather than left to look like an oversight.
      "components/common/PdfSignaturePlacer.tsx",
      "components/assets/AssetTagPrinter.tsx",
    ];
    const TAGS = ["div", "span", "li", "td", "tr", "p", "section", "article", "header"];
    // The end of an opening tag: the first `>` that is not inside a brace expression or an attribute string.
    // Quotes are only tracked at brace depth 0, where they are JSX attribute strings. Inside a brace the
    // content is JavaScript, whose apostrophes ("You've used all your picks", in a template literal) would
    // otherwise open a string that swallows the rest of the file - and since the `>` test only applies at
    // depth 0, nothing is lost by not lexing in there.
    const tagEnd = (src: string, from: number) => {
      let depth = 0;
      let quote = "";
      for (let i = from; i < src.length; i++) {
        const ch = src[i]!;
        if (quote) { if (ch === quote) quote = ""; continue; }
        if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === ">" && depth === 0) return i;
      }
      return src.length;
    };
    const offenders: string[] = [];
    for (const [path, src] of files) {
      if (POINTER_SURFACE.includes(name(path))) continue;
      const c = code(src);
      const open = new RegExp(`<(${TAGS.join("|")})\\b`, "g");
      for (const m of c.matchAll(open)) {
        const el = c.slice(m.index, tagEnd(c, m.index + m[0].length) + 1);
        if (!el.includes("onClick=")) continue;
        if (/onKeyDown|role="(button|checkbox|radio|option|menuitem|tab)"/.test(el)) continue;
        // A handler that only swallows the event is not a control - it stops a click reaching a clickable
        // ancestor, which is the opposite of adding an interaction.
        if (/onClick=\{\(\w+\)\s*=>\s*\w+\.(stopPropagation|preventDefault)\(\)\}/.test(el)) continue;
        offenders.push(`${name(path)}:${c.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders, "make it a <button>, or give it tabIndex + an Enter/Space onKeyDown + a role").toEqual([]);
  });

  // The app bar is `sticky top-0` and 3.5rem tall at z-30. Anything else that pins to the PAGE therefore has
  // to start below it: pinned at `top-2` a bar does not stay on screen, it parks behind the app bar and
  // disappears - which is what the Approvals bulk-decision bar and the Settings section nav both did, each at
  // precisely the moment (a long scrolled list, a long settings page) the pinning existed for.
  //
  // A small offset is only correct when the element pins inside a scroll box of its own, which the allowlist
  // names one by one. The rule for a page is `top-16` (4rem: the bar plus a small gap).
  it("page-level sticky elements clear the app bar", () => {
    const OWN_SCROLLER = [
      "components/ui/sheet.tsx", //             the sheet header, above SheetBody's scroller
      "components/access/SubjectPermissionsDialog.tsx", // group headings inside a max-h-[55dvh] list
      "components/layout/TopBar.tsx", //        the app bar itself, which is what everything else clears
      "components/common/DataTable.tsx", //     column headers inside the table's max-h-[68dvh] container
      "components/common/TeamTimeline.tsx", //  day headers inside the timeline's max-h-[560px] box
      "components/common/PostComposer.tsx", //  composer header inside the dialog's own scroll body
    ];
    const offenders: string[] = [];
    for (const [path, src] of files) {
      if (OWN_SCROLLER.includes(name(path))) continue;
      code(src)
        .split("\n")
        .forEach((raw, i) => {
          if (!/sticky top-(0|1|2|3)(\.5)?\b/.test(raw)) return;
          // A <thead> only ever pins inside its own table's scroll box; the bounded-container rule for those
          // is checked by reading the container, not by this line.
          if (/<thead\b/.test(raw)) return;
          offenders.push(`${name(path)}:${i + 1}`);
        });
    }
    expect(offenders, "use `sticky top-16` (or allowlist it as pinning inside its own scroller)").toEqual([]);
  });

  // A Radix tooltip is a HOVER surface, and a touch is not hover - Radix even treats `pointerdown` as a
  // dismissal, so on a phone tapping the trigger is the one gesture guaranteed not to show it. That is right
  // for a tooltip that repeats a button's own label, and wrong for one hanging off an inert trigger, which is
  // the shape of a tooltip that carries the ONLY copy of something: an icon standing for a sentence, a bar
  // standing for its numbers, a legend. Those pass `tapToOpen` and render as a tap-driven popover on a coarse
  // pointer (see components/ui/tooltip.tsx).
  //
  // Detected by the trigger's shape: `asChild` around a bare <span> is the inert case, since anything with an
  // action of its own is a <button>, an <a>, or a component that renders one.
  it("a tooltip on an inert trigger can be opened by a tap", () => {
    // The allowlist is for a trigger that is inert but sits INSIDE something that is not: a tap there belongs
    // to the parent, and a popover opening on the way would fight it. The test for adding an entry is whether
    // what the tooltip says is reachable by that parent's own action.
    const OPENS_ITS_OWN_DETAIL = [
      // Every chip on a kanban tile - priority, checklist, department, linked docs, staleness, assignee. The
      // tile's job is to open the card, and the card shows all of it in full.
      "pages/Boards.tsx",
    ];
    const offenders: string[] = [];
    for (const [path, src] of files) {
      if (name(path) === "components/ui/tooltip.tsx") continue;
      if (OPENS_ITS_OWN_DETAIL.includes(name(path))) continue;
      for (const m of code(src).matchAll(/<Tooltip(\s[^>]*)?>\s*<TooltipTrigger asChild>\s*<span\b/g)) {
        if (/tapToOpen/.test(m[1] ?? "")) continue;
        offenders.push(`${name(path)}: ${m[0].replace(/\s+/g, " ").slice(0, 60)}`);
      }
    }
    expect(offenders, "add `tapToOpen` to the <Tooltip> - its text is unreachable on a phone without it").toEqual([]);
  });

  // A card header that turns into a row - `flex-row justify-between`, a title on the left and an action
  // button on the right - is the app's most repeated layout, and on a phone it is a fixed-width row: a
  // button's label does not wrap, so its min-content width is the whole label, and a title that is one long
  // word does not shrink below its own. When title + actions exceed the card, a non-wrapping row does not
  // clip or scroll inside the card - it widens the card, the page, and the document, and the whole layout
  // pans sideways with the action button hanging off the right edge. That is what the Compensation tab's
  // "Revise" button did at 390px.
  //
  // `flex-wrap` is the whole fix: the actions drop to a second line when they no longer fit and the row is
  // unchanged wherever it does fit. It costs nothing to carry, so the rule is unconditional rather than
  // allowlisted per header.
  it("a flex-row card header wraps", () => {
    const offenders: string[] = [];
    for (const [path, src] of files) {
      for (const m of code(src).matchAll(/<CardHeader[^>]*className="([^"]*)"/g)) {
        const cls = m[1]!;
        if (!/\bflex-row\b/.test(cls)) continue;
        if (/\bflex-wrap\b/.test(cls)) continue;
        // A header that is a COLUMN on a phone and a row from `sm` up has already answered the question a
        // different way - it never lays the title and the actions side by side at the width where they would
        // not fit. `sm:flex-row` on a `flex-col` base is that shape.
        if (/\bflex-col\b/.test(cls)) continue;
        offenders.push(`${name(path)}: ${cls}`);
      }
    }
    expect(offenders, "add `flex-wrap` (and a `gap-2`, since space-y does nothing across a wrap)").toEqual([]);
  });
});
