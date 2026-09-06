import { gotoRoute, purge, test, expect } from "./fixtures";

// The project catalog editor (Settings → Projects) - `catalogEditors.spec.ts` proves every catalog panel,
// this one included, still takes a plain new row; it never fills in a client, a code, or touches Billable
// or Status, so none of THIS panel's own rules are exercised anywhere: a project is picked by NAME on a
// timesheet and reconciled by CODE on an invoice, so a repeat of either is refused before it ever reaches
// the server, a typed code is normalised to upper case as it's typed (it's pasted into invoices), and
// archiving a project changes what the form says it does rather than just flipping a badge.
test("the project editor refuses a duplicate name and code, upper-cases a typed code, and archiving changes what the form says", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now();
  const nameA = `E2E project a ${stamp}`;
  const nameB = `E2E project b ${stamp}`;
  const codeA = `EA${stamp % 100000}`;

  try {
    await gotoRoute(page, "settings/projects");

    // Project A: saved first with a code, so both its name and its code are there to collide with.
    await page.getByRole("button", { name: "New project" }).first().click();
    let form = page.getByRole("dialog");
    await form.getByLabel("Name", { exact: true }).fill(nameA);
    await form.getByLabel("Code (optional)").fill(codeA.toLowerCase());
    await expect(form.getByLabel("Code (optional)")).toHaveValue(codeA);
    const createA = form.getByRole("button", { name: "Create", exact: true });
    await expect(createA).toBeEnabled();
    await createA.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(nameA)).toBeVisible({ timeout: 30_000 });

    // Project B: walked through every refusal before it is ever valid to save.
    await page.getByRole("button", { name: "New project" }).first().click();
    form = page.getByRole("dialog");
    const submit = form.getByRole("button", { name: "Create", exact: true });

    await form.getByLabel("Name", { exact: true }).fill(nameA);
    await expect(form.getByText("Another project already has this name.")).toBeVisible();
    await expect(submit).toBeDisabled();

    await form.getByLabel("Name", { exact: true }).fill(nameB);
    await expect(form.getByText("Another project already has this name.")).toHaveCount(0);
    await expect(submit).toBeEnabled();

    // Same code as A, typed lower-case - upper-cased live, and refused for the same reason a repeat name is.
    await form.getByLabel("Code (optional)").fill(codeA.toLowerCase());
    await expect(form.getByLabel("Code (optional)")).toHaveValue(codeA);
    await expect(form.getByText("Another project already uses this code.")).toBeVisible();
    await expect(submit).toBeDisabled();

    const codeB = `EB${stamp % 100000}`;
    await form.getByLabel("Code (optional)").fill(codeB.toLowerCase());
    await expect(form.getByText("Another project already uses this code.")).toHaveCount(0);
    await expect(submit).toBeEnabled();

    // Active by default: anyone can log time against it.
    await expect(form.getByText("Anyone can pick this project on their timesheet.")).toBeVisible();
    // Archived: the hint changes to say what archiving actually does - past time stays, new time can't land.
    await form.getByRole("button", { name: "archived" }).click();
    await expect(form.getByText("Stays on past timesheets, but nobody can log new time against it.")).toBeVisible();
    await expect(form.getByText("Anyone can pick this project on their timesheet.")).toHaveCount(0);

    // Not billable: the row behind this dialog should carry no "Billable" badge once saved.
    await form.locator("label", { hasText: "Billable" }).getByRole("checkbox").click();

    await submit.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    // `.last()`, not `.first()`: every ancestor up to #root also contains both words, and document order puts
    // the ancestors first - the deepest match is the badge line that belongs to this project alone.
    const rowB = page.locator("div").filter({ hasText: nameB }).filter({ hasText: "Archived" }).last();
    await expect(rowB).toBeVisible({ timeout: 30_000 });
    await expect(rowB).not.toContainText("Billable");
  } finally {
    const res = await page.request.get("/v1/projects?page_size=200");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
      for (const p of results.filter((r) => r.name === nameA || r.name === nameB)) await purge(page, p.path);
    }
  }
});
