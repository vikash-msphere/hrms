import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// What a structure's percentage lines add up to - the number that decides whether an employee's CTC can even
// be split under it. `catalogEditors.spec.ts` proves the catalog takes a row; this proves the arithmetic
// that row is FOR: a percent-of-basic component claims exactly its rate whether or not a line here overrides
// it, the claims add up live as a rate is typed, and 100% or more is refused - the failure the component's
// own comment says would otherwise wait until somebody's compensation revision to show up.
test("a structure's percentage lines total live, and 100% of basic is refused", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const compName = `E2E percent comp ${Date.now()}`;
  const structName = `E2E structure ${Date.now()}`;

  const made = await page.request.post("/v1/pay-components", {
    headers: SPA_HEADERS,
    data: { display_name: compName, kind: "earning", method: "percent_base", rate: 50, recurring: true, in_ctc: true },
  });
  expect(made.status(), await made.text()).toBe(200);
  const comp = (await made.json()) as { path: string };

  try {
    await gotoRoute(page, "settings/salary-structures");
    // `.first()`: the toolbar button. An EMPTY table offers the very same action again in its placeholder
    // (DataTable takes one `createBtn` for both `toolbar` and `emptyAction`), and this catalog starts empty.
    await page.getByRole("button", { name: "New structure" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name").fill(structName);

    await form.getByText("Add earning component…").click();
    await page.getByRole("option", { name: new RegExp(compName) }).click();

    // The line's OWN rate is blank (the placeholder alone says "50% of base"), and the total already claims
    // the component's own rate without anyone typing one in.
    const line = form.locator("div").filter({ hasText: compName }).last();
    await expect(line.locator('input[type="number"]')).toHaveValue("");
    await expect(form.getByText("50% of basic")).toBeVisible();

    const rate = line.locator('input[type="number"]');
    await rate.fill("110");
    await expect(form.getByText("110% of basic")).toBeVisible();
    await expect(form.getByText("Over 100% of basic - no CTC can be split under this structure. Trim a rate.")).toBeVisible();
    const submit = form.getByRole("button", { name: "Create", exact: true });
    await expect(submit).toBeDisabled();

    await rate.fill("90");
    await expect(form.getByText("90% of basic")).toBeVisible();
    await expect(form.getByText(/Over 100%/)).toHaveCount(0);
    await expect(submit).toBeEnabled();
    await submit.click();
    // A structure whose lines feed the CTC build-up leaves every existing employee's basic / special-allowance
    // split out of date, so the app asks whether to re-apply it. Declined: this spec is about the arithmetic in
    // the form, and saying yes would rewrite a hundred people's compensation to prove it.
    const reapply = page.getByRole("dialog").filter({ hasText: "Re-apply the split to existing employees?" });
    await expect(reapply).toBeVisible({ timeout: 30_000 });
    await reapply.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    const row = page.locator("tbody tr").filter({ hasText: structName });
    await expect(row).toBeVisible({ timeout: 30_000 });
  } finally {
    await purgeStructure(page, structName);
    await purge(page, comp.path);
  }
});

async function purgeStructure(page: import("@playwright/test").Page, name: string): Promise<void> {
  const res = await page.request.get("/v1/salary-structures?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  const row = results.find((s) => s.display_name === name);
  if (row) await purge(page, row.path);
}
