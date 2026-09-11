import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The other shared row action `catalogEditors.spec.ts` (create) and its own Delete extension don't reach:
// `useLifecycle`'s Disable/Enable. Five catalogs get it (`SoftDeleteRowActions` renders it unconditionally
// whenever a `lifecycle` prop is passed) and have a dedicated toggle spec for none of it - vendors, the two
// expense/reimbursement category panels and all three document toggles are covered elsewhere; departments,
// leave types, pay components, asset categories and pay periods are not. One loop, same reasoning as the
// create and delete sweeps: the failure this protects against is in the shared component, not any one page.
type Toggled = {
  route: string;
  heading: string;
  tab?: string;
  collection: string;
  label: string; // useLifecycle's own label, capitalized for the toast
  data: Record<string, unknown>;
};

const CATALOGS: Toggled[] = [
  { route: "settings/departments", heading: "Departments", collection: "departments", label: "Department", data: { display_name: "Dept" } },
  { route: "settings/leave-types", heading: "Leave Types", collection: "leave-types", label: "Leave type", data: { display_name: "Leave" } },
  { route: "settings/pay-components", heading: "Pay Components", collection: "pay-components", label: "Pay component", data: { display_name: "Comp", kind: "earning", method: "fixed" } },
  { route: "settings/asset-tags", heading: "Asset Tags", tab: "Categories", collection: "asset-categories", label: "Category", data: { display_name: "Cat" } },
  {
    route: "pay-periods", heading: "Pay Periods", collection: "pay-periods", label: "Pay period",
    // A year no other payroll-lane spec touches (see the year ledger in `payrollBankFile.spec.ts` and
    // `operationsJobRun.spec.ts`), so this row is never mistaken for one a run has been built against.
    data: { display_name: "Period", period_start: "2033-05-01", period_end: "2033-05-31", pay_date: "2033-05-31" },
  },
];

test("disabling and re-enabling a row works on every catalog that offers it", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). What each catalog's row and menu read back is what this test
  // proves, and every one of those reads is asserted below; a console line from a request retried behind that
  // is not its failure - and this walks five catalogs, so it is open on a lane far longer than most specs.
  allowConsoleErrors(page, /status of 503|status of 500/i);
  const stamp = Date.now();
  const failures: string[] = [];

  for (const cat of CATALOGS) {
    const name = `E2E toggle ${(cat.data.display_name as string)} ${stamp}`;
    let path: string | undefined;
    try {
      const made = await page.request.post(`/v1/${cat.collection}`, { headers: SPA_HEADERS, data: { ...cat.data, display_name: name } });
      expect(made.status(), await made.text()).toBe(200);
      path = ((await made.json()) as { path: string }).path;

      await gotoRoute(page, cat.route, cat.heading);
      if (cat.tab) await page.getByRole("tab", { name: cat.tab }).click();
      const row = page.locator("tbody tr").filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Pay components (and salary structures, elsewhere) mount `SplitStaleBanner`, which pushes the table
      // down a beat AFTER first paint once its own background dry-run answers - so the row this test just
      // asked for can still slide out from under a click computed before that lands. A brief settle first,
      // rather than letting the click race a banner that may or may not show up.
      await page.waitForTimeout(500);

      await openActions(row);
      await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
      await expect(toast(page, `${cat.label} disabled`)).toBeVisible({ timeout: 30_000 });
      // Radix's own modal-lock release on close is deferred a tick (dialog.tsx `useReleasePointerLock`) - the
      // very next Actions click can otherwise land while the page is still nominally locked to the mouse.
      await page.waitForTimeout(300);
      // Read back on the wire, not assumed from a badge - not every one of these tables draws a visible
      // "Disabled" indicator on the row (`vendorDisableToggle.spec.ts` proves the effect elsewhere - the
      // vendor picker - rather than a row badge, for the same reason).
      await expect
        .poll(async () => {
          const r = await page.request.get(`/v1/${path}`);
          return r.ok() ? ((await r.json()) as { disabled?: boolean }).disabled : undefined;
        }, { timeout: 30_000 })
        .toBe(true);

      // And the menu agrees: disabled, so there is nothing left to disable, only to enable back. A genuine
      // reload rather than a second live re-open: pay components specifically leaves the Actions trigger
      // unclickable to a same-page second open (a leftover Radix artifact from the first dropdown's close
      // that a plain settle-wait does not clear), and `row` is a lazy locator that re-resolves fine against
      // the fresh DOM either way.
      await page.reload();
      if (cat.tab) await page.getByRole("tab", { name: cat.tab }).click();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await openActions(row);
      await expect(page.getByRole("menuitem", { name: "Disable", exact: true })).toHaveCount(0);
      await page.getByRole("menuitem", { name: "Enable", exact: true }).click();
      await expect(toast(page, `${cat.label} enabled`)).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => {
          const r = await page.request.get(`/v1/${path}`);
          return r.ok() ? ((await r.json()) as { disabled?: boolean }).disabled : undefined;
        }, { timeout: 30_000 })
        .toBe(false);
    } catch (e) {
      failures.push(`${cat.collection}: ${(e as Error).message.split("\n")[0]}`);
      await page.keyboard.press("Escape");
    }
    if (path) await purge(page, path);
  }

  expect(failures, `catalogs whose disable/enable did not work:\n${failures.join("\n")}`).toEqual([]);
});

// Lock is the harder collapse: while locked, `SoftDeleteRowActions` offers ONLY Unlock - Edit, Disable and
// Delete all disappear, because the server blocks edits/deletes on a locked row outright. Only
// `documentLockToggle.spec.ts` has ever pressed Lock anywhere in the suite; these five catalogs share the
// exact same button and have never had it pressed.
test("locking a row collapses its menu to Unlock alone, on every catalog that offers it", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). What each catalog's row and menu read back is what this test
  // proves, and every one of those reads is asserted below; a console line from a request retried behind that
  // is not its failure - and this walks five catalogs, so it is open on a lane far longer than most specs.
  allowConsoleErrors(page, /status of 503|status of 500/i);
  const stamp = Date.now();
  const failures: string[] = [];

  for (const cat of CATALOGS) {
    const name = `E2E lock ${(cat.data.display_name as string)} ${stamp}`;
    let path: string | undefined;
    try {
      const made = await page.request.post(`/v1/${cat.collection}`, { headers: SPA_HEADERS, data: { ...cat.data, display_name: name } });
      expect(made.status(), await made.text()).toBe(200);
      path = ((await made.json()) as { path: string }).path;

      await gotoRoute(page, cat.route, cat.heading);
      if (cat.tab) await page.getByRole("tab", { name: cat.tab }).click();
      const row = page.locator("tbody tr").filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Same settle as the disable/enable test - `SplitStaleBanner`'s own async dry-run can still push the
      // table down after this row first appears.
      await page.waitForTimeout(500);

      await openActions(row);
      await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible();
      await page.getByRole("menuitem", { name: "Lock", exact: true }).click();
      await expect(toast(page, `${cat.label} locked`)).toBeVisible({ timeout: 30_000 });
      // Radix's own modal-lock release on close is deferred a tick (dialog.tsx `useReleasePointerLock`) - the
      // very next Actions click can otherwise land while the page is still nominally locked to the mouse.
      await page.waitForTimeout(300);

      // Collapsed: nothing but the way back out. A genuine reload rather than a live re-open - see the note
      // on the disable/enable test's own second open.
      await page.reload();
      if (cat.tab) await page.getByRole("tab", { name: cat.tab }).click();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await openActions(row);
      await expect(page.getByRole("menu")).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Unlock", exact: true })).toBeVisible();
      for (const gone of ["Edit", "Disable", "Delete"]) {
        await expect(page.getByRole("menuitem", { name: gone, exact: true })).toHaveCount(0);
      }
      await expect
        .poll(async () => {
          const r = await page.request.get(`/v1/${path}`);
          return r.ok() ? ((await r.json()) as { locked?: boolean }).locked : undefined;
        }, { timeout: 30_000 })
        .toBe(true);

      await page.getByRole("menuitem", { name: "Unlock", exact: true }).click();
      await expect(toast(page, `${cat.label} unlocked`)).toBeVisible({ timeout: 30_000 });
      // Restored: the rest of the menu is back.
      await page.reload();
      if (cat.tab) await page.getByRole("tab", { name: cat.tab }).click();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await openActions(row);
      await expect(page.getByRole("menuitem", { name: "Edit" })).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");
    } catch (e) {
      failures.push(`${cat.collection}: ${(e as Error).message.split("\n")[0]}`);
      await page.keyboard.press("Escape");
    }
    if (path) await purge(page, path);
  }

  expect(failures, `catalogs whose lock/unlock did not work:\n${failures.join("\n")}`).toEqual([]);
});

/** Opens the row's "Actions" menu. Closing ANY dropdown/dialog releases Radix's modal pointer-events lock on
 *  `<body>` a tick late (dialog.tsx `useReleasePointerLock`, deferred to its own `setTimeout`) - a click that
 *  follows one closely enough can land while the page still reads as locked to the mouse and silently miss.
 *  Retried as one unit rather than a single extra wait, since how late depends on what closed. */
async function openActions(row: import("@playwright/test").Locator) {
  const page = row.page();
  await expect(async () => {
    await row.getByRole("button", { name: "Actions" }).click({ timeout: 5_000 });
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}
