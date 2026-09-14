import { gotoRoute, personPath, purge, test, expect, toast } from "./fixtures";

// A verification check, walked from ordered to closed.
//
// `backgroundChecks.spec.ts` covers the create form's one clever affordance (the standard set). This is
// what happens to a check for the rest of its life, and all of it lives in the row's own menu: pending
// offers "start it", an open check offers the two ways it can end, and a closed one offers neither. The
// menu is built per row from the status, so the whole state machine is a rendering decision - there is no
// verb to refuse a bad move, which is exactly why the menu has to be right.
//
// The other half is the form refusing to let the org pay twice: ordering a check that is already open for
// the same person and the same type is money spent on an answer already coming, and the warning is computed
// in the browser from the rows on the page as the form is filled - no server round trip, so nothing outside
// the rendered form can see it.
//
// A different person from `backgroundChecks.spec.ts` on purpose: both specs write to one table in a lane
// that runs them at the same time, and a row picked by employee name has to be unambiguously this spec's.
test("a check is started, closed, and offers only the moves its status allows", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const person = "Mara Manager";
  // The wire path of that person, which is how a leftover check is recognised - the table renders a name,
  // and the API answers in refs.
  const personRef = await personPath(page, "manager");
  // Stamped on the order so the row this spec walks is unmistakably this spec's: the lane is run repeatedly
  // against one database (`E2E_KEEP_DB=1`), and a `.first()` on the person's name would happily pick up a
  // check an earlier run left behind and assert the state machine against that instead.
  const vendor = `E2E flow ${Date.now()}`;

  await gotoRoute(page, "background-checks", "Background Verification");
  // A run that died half way leaves an OPEN check on this person, and the last assertion here is that the
  // form stops warning once nothing is open - which that leftover would break.
  await sweep(page, personRef);

  await page.getByRole("button", { name: "Add check" }).first().click();
  await pickEmployee(page, person);
  await page.getByRole("dialog").getByLabel("Vendor / agency").fill(vendor);
  await page.getByRole("dialog").getByRole("button", { name: "Add check", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  const row = page.locator("tbody tr").filter({ hasText: vendor }).first();
  await expect(row).toContainText("Pending", { timeout: 30_000 });

  // Ordering the same check again, while the first one is still open, is paying twice for one answer - and
  // the form says so while it is being filled rather than after it is submitted.
  await page.getByRole("button", { name: "Add check" }).first().click();
  await pickEmployee(page, person);
  await expect(page.getByRole("dialog").getByText(/is already pending/)).toBeVisible({ timeout: 30_000 });
  await abandonDialog(page);

  // Pending: the only move that starts anything is offered, along with the two ways a check can end.
  await expect(menuItems(page, row)).resolves.toEqual(
    expect.arrayContaining(["Mark in progress", "Mark clear", "Mark discrepancy"]),
  );
  await page.getByRole("menuitem", { name: "Mark in progress" }).click();
  await expect(toast(page, "Marked in progress")).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("In progress", { timeout: 30_000 });

  // Started: it cannot be started again. A menu that still offered it would be offering a move that does
  // nothing but reset the clock the ageing column counts.
  const running = await menuItems(page, row);
  expect(running).not.toContain("Mark in progress");
  expect(running).toContain("Mark clear");
  expect(running).toContain("Mark discrepancy");
  await page.getByRole("menuitem", { name: "Mark clear" }).click();
  await expect(toast(page, "Marked clear")).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("Clear", { timeout: 30_000 });

  // Cleared is the end of it: neither outcome is offered again, so a finished verification cannot be
  // quietly re-marked from a row menu. (Editing it is still there - a correction is a deliberate act.)
  const closed = await menuItems(page, row);
  expect(closed).not.toContain("Mark clear");
  expect(closed).not.toContain("Mark discrepancy");
  expect(closed).not.toContain("Mark in progress");
  await closeMenu(page);

  // A closed check is now the OLD one, so the form no longer warns about ordering another - the warning is
  // about work already in flight, not about history.
  await page.getByRole("button", { name: "Add check" }).first().click();
  await pickEmployee(page, person);
  await expect(page.getByRole("dialog").getByText(/is already/)).toHaveCount(0);
  await abandonDialog(page);

  await sweep(page, personRef);
});

type Page = import("@playwright/test").Page;

/** Fill the create form's employee field, which is a search-as-you-type picker rather than a select. */
async function pickEmployee(page: Page, name: string) {
  const form = page.getByRole("dialog");
  await form.getByLabel("Employee").click();
  await page.getByPlaceholder(/Search|Select/).last().fill(name);
  await expect(page.getByRole("option", { name })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Enter");
}

/**
 * Close a create form that has been filled in.
 *
 * A dirty dialog asks before it evaporates (`draftGuard.spec.ts` owns that behaviour), so backing out is
 * two presses - and which one is needed depends on whether the guard has armed yet.
 */
async function abandonDialog(page: Page) {
  await expect(async () => {
    const dialog = page.getByRole("dialog").first();
    if (!(await dialog.count())) return;
    // By the BUTTON, not by Escape. A toast is a dismissable layer of its own and it is in front: the "Check
    // added" toast from the row this form is warning about is still on screen here, so Escape closed the
    // TOAST and left the dialog exactly where it was - then the guard never armed, there was nothing to
    // discard, and the loop spent its whole budget dismissing toasts.
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
    if (await discard.count()) await discard.first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }).toPass({ timeout: 30_000 });
}

/** Open one row's menu and read what it offers - the state machine, as the reader meets it. */
async function menuItems(page: Page, row: import("@playwright/test").Locator): Promise<string[]> {
  await row.getByRole("button", { name: "Actions" }).click();
  const items = page.getByRole("menuitem");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  return items.allInnerTexts().then((texts) => texts.map((t) => t.trim()));
}

/**
 * Dismiss the row menu, and wait until it has really gone.
 *
 * An open menu is a full-page overlay, so the next press - the page's own "Add check" - lands on nothing
 * while it is up. The Escape is retried rather than sent once: the key goes to whatever holds focus, and a
 * menu opened while the page was still settling does not always have it.
 */
async function closeMenu(page: Page) {
  await expect(async () => {
    const menu = page.getByRole("menu");
    if (await menu.count()) await menu.first().press("Escape");
    await expect(page.getByRole("menuitem")).toHaveCount(0);
  }).toPass({ timeout: 30_000 });
}

/**
 * Establish this spec's precondition: nobody has an OPEN check of this kind on this person.
 *
 * Two passes, and the second is the one that matters. Sweeping by this spec's own vendor tag misses a row it
 * created but never got to tag - a run killed between picking the employee and typing the vendor - and one
 * such row is permanently poisonous here: the last assertion is that the form STOPS warning once nothing is
 * open, and a stray pending check on the same person and type makes it warn forever, in every future run.
 * So the precondition is asserted rather than assumed.
 *
 * Scoped to one person and one check type rather than "everything on the page": `backgroundChecks.spec.ts`
 * writes to this table at the same time, on somebody else, and a blanket purge would delete the rows it is
 * half way through counting.
 */
async function sweep(page: Page, employee: string) {
  const res = await page.request.get("/v1/background-checks?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as {
    results?: { path: string; vendor?: string; employee?: string; check_type?: string; status?: string }[];
  };
  const stale = results.filter(
    (r) =>
      (r.vendor ?? "").startsWith("E2E flow ")
      || (r.employee === employee && r.check_type === "identity" && (r.status === "pending" || r.status === "in_progress")),
  );
  for (const c of stale) await purge(page, c.path);
}
