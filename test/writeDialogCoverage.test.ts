/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Write modals go through WriteDialog.
//
// Every dialog that creates or updates something needs the same seven things - a discard guard, a draft for
// long forms, the failure pinned in the form, an access scope, a scrolling body, a footer that explains a
// disabled Save, and a history entry so the back gesture closes it. Convention did not hold that line: by the
// time this gate was written, the Money modals had all seven and the People & org ones had none, and nothing
// in the build noticed. `components/common/WriteDialog.tsx` owns the seven, and this test keeps new modals on
// it - a page that hand-rolls the shell again fails here rather than in someone's hands months later.
//
// The scan is deliberately blunt: a file that renders a <DialogTitle> AND awaits a write (create / patch /
// invoke / upload) is a write modal, and must mention WriteDialog. Blunt matters more than exact - a precise
// AST rule nobody reads gets an allowlist entry instead of a fix.
const web = import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const WRITES = /await\s+(create|patch|invoke|upload|remove)\(/;
const HAS_DIALOG = /<DialogTitle/;

// Modals that legitimately don't use the shared shell, each with the reason. Not a parking space for "haven't
// got round to it" - that's MIGRATING below.
const EXEMPT: Record<string, string> = {
  "components/ui/dialog.tsx": "the primitives themselves",
  "components/common/WriteDialog.tsx": "is the shared shell",
  "components/common/confirm.tsx": "a confirmation, not a form",
  "components/common/PhotoAvatar.tsx": "an image cropper: its 'form' is a canvas, and Save is a crop",
  "components/common/EmergencyQuickView.tsx": "one dialog that both reads and edits; the edit pass carries the guard itself",
  "components/common/ApprovalRow.tsx": "a decision prompt (reject with a reason), not a record editor",
  "pages/Approvals.tsx": "same decision prompt, inline on the queue",
  "pages/Dashboard.tsx": "same decision prompt, inline on the widget",
  "components/assets/AssetCustody.tsx": "the dialog IS a scan; its button is the confirmation",
  "components/common/SignDocumentDialog.tsx": "read-then-sign: the document is the body and the tick-box is the form",
  "pages/OrgChart.tsx": "a picker: one click IS the submit, there is no form to guard",
  "components/common/PostComposer.tsx": "composes against a live card in a second column: its own shell, carrying the seven itself",
};

// The backlog. Every entry is a write modal still carrying its own shell, listed so the remaining work is
// visible in the build instead of living in someone's head. Entries come OFF this list as they migrate; the
// second test below fails if one is listed but already migrated, so the list cannot rot.
const MIGRATING = [
  "components/access/AclModal.tsx",
  "components/access/SubjectPermissionsDialog.tsx",
  "components/common/EmployeeBonuses.tsx",
  "components/common/EmployeeCompensation.tsx",
  "components/common/EmployeeSettlement.tsx",
  "components/common/PayrollBonuses.tsx",
  "components/common/PermissionsPanel.tsx",
  "components/common/RequestLeaveDialog.tsx",
  "components/holidays/BulkAddDialog.tsx",
  "components/holidays/CopyYearDialog.tsx",
  "pages/AssetCategories.tsx",
  "pages/Attendance.tsx",
  "pages/BenefitPlansAdmin.tsx",
  "pages/Benefits.tsx",
  "pages/ExpenseBudgets.tsx",
  "pages/ExpenseCategories.tsx",
  "pages/Expenses.tsx",
  "pages/Holidays.tsx",
  "pages/Loans.tsx",
  "pages/PayComponents.tsx",
  "pages/PayGradesAdmin.tsx",
  "pages/PayPeriods.tsx",
  "pages/PayrollRuns.tsx",
  "pages/ReimbursementCategories.tsx",
  "pages/Reimbursements.tsx",
  "pages/SalaryStructuresAdmin.tsx",
  "pages/Schedule.tsx",
  "pages/TaxDeclarations.tsx",
  "pages/Timesheets.tsx",
  "pages/Vendors.tsx",
];

const rel = (p: string) => p.replace("../web/src/", "");
const listed = (path: string, list: string[]) => list.some((suffix) => rel(path) === suffix);

describe("write modals use the shared dialog shell", () => {
  it("no NEW modal hand-rolls the shell", () => {
    const misses: string[] = [];
    for (const [path, src] of Object.entries(web)) {
      if (!HAS_DIALOG.test(src) || !WRITES.test(src)) continue;
      if (src.includes("WriteDialog")) continue;
      if (listed(path, Object.keys(EXEMPT)) || listed(path, MIGRATING)) continue;
      misses.push(rel(path));
    }
    expect(
      misses,
      `these write modals build their own dialog shell - use <WriteDialog> (components/common/WriteDialog.tsx): ${misses.join(", ")}`,
    ).toEqual([]);
  });

  it("the backlog and exemptions have no dead entries", () => {
    const paths = Object.keys(web).map(rel);
    const goneBacklog = MIGRATING.filter((p) => !paths.includes(p));
    const migrated = MIGRATING.filter((p) => {
      const src = web[`../web/src/${p}`];
      return src?.includes("WriteDialog");
    });
    const goneExempt = Object.keys(EXEMPT).filter((p) => !paths.includes(p));
    expect(goneBacklog, `backlog entries for files that no longer exist: ${goneBacklog.join(", ")}`).toEqual([]);
    expect(migrated, `already migrated - remove from MIGRATING: ${migrated.join(", ")}`).toEqual([]);
    expect(goneExempt, `exemptions for files that no longer exist: ${goneExempt.join(", ")}`).toEqual([]);
  });
});
