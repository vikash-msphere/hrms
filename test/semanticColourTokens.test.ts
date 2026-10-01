/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// One vocabulary for "this is fine / this needs attention / this is wrong".
//
// WHAT WENT WRONG. The app defines `--success`, `--warning` and `--destructive` in web/src/index.css, both
// themes, wired to the brand palette - and then says the same three things a second way, by hand:
// `text-amber-600 dark:text-amber-400` instead of `text-warning`, `text-emerald-600 dark:text-emerald-400`
// instead of `text-success`, `text-rose-600 dark:text-rose-400` instead of `text-destructive`. Which one a
// page uses is a coin flip: `warning` appears in 63 files and raw amber in 50, `success` in 33 and raw
// emerald in 26. The hand-rolled pair does not follow the org's theme, and it re-states its own dark variant
// at every site, which is a thing that gets forgotten.
//
// WHAT IS NOT A VIOLATION. A CATEGORICAL ramp is not a status. Ticket priority (low/medium/high/urgent),
// timeline event kinds (birthday, joiner, anniversary) and org-chart markers legitimately need distinct
// hues, and collapsing "high priority" onto `destructive` would make it indistinguishable from "urgent".
// Those keep the raw palette. So does a single decorative accent - a gold trophy, a pink cake - which is not
// claiming a status at all, and which this check never matched: the signature below is the light/dark PAIR,
// which is what somebody writes when they are reproducing a token by hand.
//
// THE LEDGER. The files below were already doing this when the rule was written. They are not exempt
// forever - each needs triaging into "semantic, convert it" or "categorical, and here is why" - but they are
// grandfathered so that the rule can bite on NEW code today. The list only ever shrinks; adding to it is the
// thing this test exists to stop.

/** `text-<family>-NNN dark:text-<family>-NNN` - somebody reproducing a semantic token by hand. */
const HAND_ROLLED = /text-(amber|emerald|rose|red)-\d{3}\s+dark:text-(amber|emerald|rose|red)-\d{3}/;

const LEDGER = new Set([
  "components/access/permMatrix.ts",
  "lib/analytics.ts",
  "lib/assetRequests.ts",
  "lib/assetTags.ts",
  "lib/entityKinds.ts",
  "components/access/AclModal.tsx",
  "components/access/FineRulesEditor.tsx",
  "components/access/SubjectPermissionsDialog.tsx",
  "components/assets/AssetTagPrinter.tsx",
  "components/assets/BulkAddAssets.tsx",
  "components/assets/SerialScanPanel.tsx",
  "components/assets/Stocktake.tsx",
  "components/common/ActivityFeed.tsx",
  "components/common/ApiKeysPanel.tsx",
  "components/common/EmployeeCompensation.tsx",
  "components/common/MyCompensation.tsx",
  "components/common/PermissionsPanel.tsx",
  "components/common/ProfileCompleteness.tsx",
  "components/common/ProofField.tsx",
  "components/common/RolesPanel.tsx",
  "components/common/SignDocumentDialog.tsx",
  "components/common/SignedPdfViewer.tsx",
  "components/common/SplitStaleBanner.tsx",
  "components/common/TeamTimeline.tsx",
  "components/common/TimeRangeField.tsx",
  "components/common/TruncationNotice.tsx",
  "components/notifications/NotificationRow.tsx",
  "lib/notificationMeta.tsx",
  "pages/Assets.tsx",
  "pages/BankFormats.tsx",
  "pages/Boards.tsx",
  "pages/CheckIns.tsx",
  "pages/Documents.tsx",
  "pages/Events.tsx",
  "pages/Holidays.tsx",
  "pages/OrgChart.tsx",
  "pages/Overtime.tsx",
  "pages/PayComponents.tsx",
  "pages/ReviewCycles.tsx",
  "pages/Schedule.tsx",
  "pages/Settings.tsx",
  "pages/ShiftsAdmin.tsx",
  "pages/Suggestions.tsx",
  "pages/TeamAnalytics.tsx",
  "pages/Tickets.tsx",
  "pages/Workflows.tsx",
]);

const web = import.meta.glob("../web/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
/** "../web/src/pages/Goals.tsx" -> "pages/Goals.tsx". */
const rel = (k: string) => k.replace("../web/src/", "");
// Comments out first: the modules that explain this rule quote the pattern it bans, and a check that reads
// its own documentation as a violation is a check that teaches people to stop writing the documentation.
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const handRolled = (src: string) => HAND_ROLLED.test(code(src));

describe("status colour has one vocabulary", () => {
  it("no new file reproduces a semantic token by hand", () => {
    const offenders = Object.entries(web)
      .filter(([k, src]) => !LEDGER.has(rel(k)) && handRolled(src))
      .map(([k]) => `${rel(k)}: writes its own light/dark pair - use text-warning / text-success / text-destructive, or explain why it is a categorical ramp and add it to the ledger`);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the ledger names only files that are still doing it", () => {
    // A ledger that outlives the debt is a ledger nobody trusts. When a file is cleaned up its entry has to
    // go with it, or the next person reads the list as "44 files we gave up on" rather than "44 left".
    const stale = [...LEDGER].filter((f) => {
      const src = web[`../web/src/${f}`];
      return src !== undefined && !handRolled(src);
    });
    expect(stale, `cleaned up - remove from the ledger:\n${stale.join("\n")}`).toEqual([]);
  });

  it("the ledger names only files that exist", () => {
    const missing = [...LEDGER].filter((f) => web[`../web/src/${f}`] === undefined);
    expect(missing, `renamed or deleted - remove from the ledger:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the goal surfaces are on the tokens", () => {
    // The module this rule was found in, kept clean by name: it is the one a regression would come back
    // through, because its chips are shared by six pages.
    for (const f of ["lib/goalState.ts", "components/common/GoalChips.tsx", "pages/Goals.tsx", "components/common/EmployeePerformance.tsx"]) {
      const src = web[`../web/src/${f}`];
      expect(typeof src, `${f} is not where this test thinks it is`).toBe("string");
      expect(handRolled(src!), f).toBe(false);
    }
  });
});
