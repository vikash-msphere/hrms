import { gotoRoute, personId, test, expect, type Role } from "./fixtures";

// WHOSE RECORD IS THIS, AND WHAT OF IT MAY I SEE.
//
// The tabs of an employee record are per-person surfaces, and the thing that decides each of them is not
// "does this caller hold `attendance.read`" - every employee holds that, because every employee clocks in.
// The capability set the SPA gates on is SCOPE-STRIPPED (src/domain/permissions.ts stripScope), so the
// self-service half of attendance, goals, reviews, payslips and one's own tax is spelled exactly like an
// org-wide grant. Gated on that string, Attendance, Performance, Posts and Compensation rendered on EVERY
// colleague's record for every caller who could open it at all - empty, because the list services scope the
// rows, but offered, with Edit and Verify inside them. `piiTabAccess.spec.ts` covers the sub-resource half of
// the same question (Identity).
//
// So the gate asks the breadth instead (users/me `caller_access.read_scopes`, computed from the grant by
// domain/access.ts callerScopes), and this pins the answer per role against the SEEDED grants. Each
// expectation below is a line of src/domain/grants.ts, so a grant change that moves a tab fails here with the
// role and the tab named.
const EXPECTED: Record<string, { subject: Role; shown: string[]; hidden: string[]; performance: string[]; clock: boolean }> = {
  manager: {
    subject: "employee", // a member of the manager fixture's own department
    // attendance / goals / reviews at `my-dept`, and the board everyone reads.
    shown: ["Attendance", "Performance", "Posts"],
    clock: true, // `attendance.my-dept.**`: the day-by-day log is on the Attendance tab
    // Pay is payroll's: a line manager holds no compensation, bonuses, settlements, payslips or tax grant, so
    // the whole tab goes - where before the stripped `employees.tax.read` off their OWN record opened it.
    // Documents for the same reason one level down: `personal-documents` is self-service for everybody
    // (grants.ts), so a report's file is not a manager's to list and the tab that listed nothing is gone.
    hidden: ["Compensation", "Documents"],
    performance: ["Goals", "Tasks", "Reviews"],
  },
  payroll: {
    subject: "employee",
    // Payslips + compensation + `employees.*.tax.**`. Performance is here for ONE reason, and it is a grant
    // rather than an accident: `cards.**` is deliberately all-breadth for everybody (grants.ts OWN_WORK - a
    // board whose columns show only your own cards is a private to-do list), so the Tasks half is public.
    // Attendance is here for the requests, not the clock: payroll holds `overtime-requests.**` and
    // `late-early-requests.**` (they are paid and docked on), and those are listed on that tab - it is where the
    // approvals inbox opens one (lib/resourceRoute.ts `requestRoute`).
    shown: ["Compensation", "Performance", "Attendance"],
    // Payroll reads nobody's clock but their own, so the tab carries no day-by-day log. Nor anybody's personal
    // file: they hold `personal-documents` read at `own` like every employee, and the write that fills
    // somebody's file is HR's.
    clock: false,
    hidden: ["Documents"],
    performance: ["Tasks"], // and NOT Goals or Reviews, which payroll holds at `own`
  },
};
const PERFORMANCE_CARDS = ["Goals", "Tasks", "Reviews"] as const;

test.describe("an employee record shows the tabs the caller's grant actually reaches", () => {
  for (const [viewer, { subject: subjectRole, shown, hidden, performance, clock }] of Object.entries(EXPECTED)) {
    test(`${viewer} sees ${shown.join(", ")} and not ${hidden.join(", ")} on a colleague's record`, async ({ as }) => {
      test.setTimeout(180_000);
      // The subject's id comes from an admin's directory: the viewer's own list may be scoped narrower.
      const admin = await as("super");
      const subject = await personId(admin, subjectRole);

      const page = await as(viewer as Role);
      await gotoRoute(page, `employees/${subject}`);
      await expect(page.getByRole("tab", { name: "Profile", exact: true })).toBeVisible({ timeout: 30_000 });

      for (const tab of shown) {
        await expect(
          page.getByRole("tab", { name: tab, exact: true }),
          `${viewer} was not offered "${tab}" on a colleague's record, though the grant reaches it`,
        ).toBeVisible({ timeout: 30_000 });
      }
      for (const tab of hidden) {
        await expect(
          page.getByRole("tab", { name: tab, exact: true }),
          `${viewer} was offered "${tab}" on a colleague's record with no grant past their own rows`,
        ).toHaveCount(0);
      }

      // And the URL is not a way round the tab bar: a segment the viewer has no tab for falls back to Profile.
      for (const tab of hidden) {
        await gotoRoute(page, `employees/${subject}/${tab.toLowerCase()}`);
        await expect(
          page.getByRole("tab", { name: tab, exact: true }),
          `…/${tab.toLowerCase()} served "${tab}" to ${viewer}`,
        ).toHaveCount(0);
      }

      // Inside the open panel, not the whole page: a card title is a `CardTitle` div rather than a heading
      // (components/ui/card.tsx), and "Goals" is also a nav entry.
      const panel = page.getByRole("tabpanel");

      // The Attendance tab is two gates: the clock log is `attendance`, the request cards are each their own
      // collection. A viewer there for the requests alone must not be shown the person's days.
      await gotoRoute(page, `employees/${subject}/attendance`);
      await expect(page.getByRole("tab", { name: "Attendance", exact: true })).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
      if (clock) {
        await expect(panel.getByText("Attendance", { exact: true }), `${viewer} was not shown the attendance log`).toBeVisible({ timeout: 30_000 });
      } else {
        await expect(panel.getByText("Attendance", { exact: true }), `${viewer} was shown a colleague's attendance log`).toHaveCount(0);
      }

      // One tab down: Performance is three cards behind one gate, and each card carries its own. Payroll
      // opening it must get the board half and neither the goals nor the reviews of the person they are
      // running pay for.
      await gotoRoute(page, `employees/${subject}/performance`);
      for (const card of PERFORMANCE_CARDS) {
        const title = panel.getByText(card, { exact: true });
        if (performance.includes(card)) {
          await expect(title, `${viewer} was not shown the ${card} card`).toBeVisible({ timeout: 30_000 });
        } else {
          await expect(title, `${viewer} was shown a colleague's ${card} with no grant past their own`).toHaveCount(0);
        }
      }
    });
  }

  // The server half, which the tabs above only reflect: a narrow caller asking about somebody else is
  // answered EMPTY rather than refused, because `?employee=` narrows within the caller's scope and never
  // widens it. That is what kept the over-offered tabs from being a disclosure, and it has to keep holding.
  // (A caller with NO grant on the collection at all is refused outright, which is the other correct shape -
  // both roles below hold the collection self-scoped, which is the case this is about.)
  test("a per-employee filter narrows within the caller's scope, it never widens it", async ({ as }) => {
    test.setTimeout(180_000);
    const admin = await as("super");
    const subject = await personId(admin, "employee");

    const checks: [Role, string][] = [
      ["payroll", `/v1/attendance?employee=employees/${subject}`], // payroll clocks in like everyone, for themselves
      ["manager", `/v1/payslips?employee=employees/${subject}`], // a manager reads their own slips and no others
    ];
    for (const [role, path] of checks) {
      const page = await as(role);
      const res = await page.request.get(path);
      expect(res.status(), `${role} GET ${path} should answer, scoped`).toBe(200);
      const body = (await res.json()) as { results?: unknown[] };
      expect(body.results ?? [], `${role} read a colleague's rows through ${path}`).toEqual([]);
    }
  });
});
