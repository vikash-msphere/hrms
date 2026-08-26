/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Confirmation coverage for consequential actions.
//
// A decision verb - approve, reject, cancel, pay, revoke, disable… - lands in somebody else's notifications,
// moves money or time off, and cannot be taken back from the button that made it. Those had drifted into bare
// one-click handlers across a dozen pages while the pages next to them asked first, so this gate pins the
// convention: the function that fires a decision verb must also ask.
//
// The scan is heuristic and deliberately blunt: it takes each `invoke(…, "<verb>")` call site, walks back to
// the start of the enclosing function, and looks for a confirmation in between (a `confirm(` call, the shared
// `confirmDecision` helper, or a comment saying the confirmation already happened upstream). Blunt is the
// point - a precise AST rule that nobody can read gets an allowlist entry rather than a fix.
const web = import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// Verbs that decide something for somebody else, or that cannot be walked back the way they were made.
const DECISION = [
  "approve", "reject", "cancel", "pay", "disburse", "revoke", "publish", "unpublish", "disable",
  "rescind", "decline", "award", "advance", "route", "complete", "verify",
];
// `[^\n]` rather than `[^)]`: real call sites nest parens (`invoke("x/" + idOf(r.path), "approve", …)`), and
// a `)`-terminated scan silently matched none of them - which made an earlier version of this gate pass while
// finding nothing at all.
const CALL = new RegExp(String.raw`invoke\([^\n]*?["'](${DECISION.join("|")})["']`, "g");
// What counts as having asked: the shared helper, a direct confirm, or a note that a dialog already did it.
const ASKED = /confirmDecision\(|\bconfirm\(\{|await confirm\(|already confirmed|its own dialog|confirmation upstream/;

// path suffix -> reason. An entry here is a claim that the action is confirmed some other way.
const ALLOW: Record<string, string> = {
  // The custody dialogs ARE the confirmation: a scan (or an explicit "I can't scan it" note) is collected in
  // the dialog, and its primary button performs the verb that the whole dialog exists to perform.
  "components/assets/AssetCustody.tsx": "the dialog collects the scan; its button is the confirmation",
  // Stocktake asks before an UNSCANNED sighting; a real scan is itself the deliberate act, and a confirm per
  // item would make a hundred-item walk-through unusable.
  "components/assets/Stocktake.tsx": "confirms the unscanned path; a scan is the deliberate act",
};
const allowed = (path: string) => Object.keys(ALLOW).some((suffix) => path.endsWith(suffix));

// The enclosing function body, approximated: from the nearest `function`/arrow-assignment above the call.
function enclosing(src: string, at: number): string {
  const before = src.slice(0, at);
  const start = Math.max(
    before.lastIndexOf("function "),
    before.lastIndexOf("=> {"),
    before.lastIndexOf("onClick"),
  );
  return src.slice(Math.max(0, start), at);
}

describe("consequential actions ask first", () => {
  it("every decision verb is fired from a handler that confirms", () => {
    const misses: string[] = [];
    for (const [path, src] of Object.entries(web)) {
      if (allowed(path)) continue;
      for (const m of src.matchAll(CALL)) {
        const body = enclosing(src, m.index ?? 0);
        if (!ASKED.test(body)) misses.push(`${path.replace("../", "")}: ${m[1]}`);
      }
    }
    expect(misses, `decision verbs fired with no confirmation: ${misses.join(", ")}`).toEqual([]);
  });

  it("the allowlist has no dead entries", () => {
    const paths = Object.keys(web);
    const dead = Object.keys(ALLOW).filter((suffix) => !paths.some((p) => p.endsWith(suffix)));
    expect(dead, `allowlisted files that no longer exist: ${dead.join(", ")}`).toEqual([]);
  });
});
