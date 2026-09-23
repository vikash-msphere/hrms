import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Handing a laptop to somebody.
//
// Custody in this app is deliberately not "IT ticked a box": assigning an asset does not make the register
// say the person HAS it - the row waits for the holder to prove custody by scanning the tag.
// `test/assetTags.test.ts` and `test/assetCustody` own the tag secret and the state machine. What only a
// browser shows is the register's form keeping itself consistent (choosing a holder moves the status out of
// "in stock" by itself, so an asset can never be both assigned and in stock) and the row then reading back
// as assigned-but-unconfirmed.
test("assigning an asset moves it out of stock and waits for the holder to confirm", async ({ as }) => {
  test.setTimeout(120_000);
  const it = await as("hr");
  const name = `E2E Laptop ${Date.now()}`;

  const category = await assetCategory(it);

  await gotoRoute(it, "assets", "Assets");
  await it.getByRole("button", { name: "Add asset" }).first().click();
  const form = it.getByRole("dialog");
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Category").click();
  // NOT `exact`: this picker labels each option with the category's auto-assigned tag code after the name
  // ("E2E assets category 1789… (E2E)"), so an exact match never lands. The generated name carries a
  // timestamp, which is what makes the substring unambiguous.
  await it.getByRole("option", { name: category.name }).click();

  // Who is holding it. Picking somebody flips the status out of "in stock" by itself - the form keeps the
  // two fields consistent so an asset can never be both assigned and in stock.
  await form.getByLabel("Assigned to").click();
  await it.getByPlaceholder(/Search/).last().fill("Eve");
  await expect(it.getByRole("option", { name: /Eve Employee/ })).toBeVisible();
  await it.keyboard.press("Enter");
  await form.getByRole("button", { name: /^(Add asset|Save|Add)/ }).last().click();
  await expect(it.getByRole("dialog")).toHaveCount(0);

  const row = it.locator("tbody tr").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Eve Employee");
  // Not "assigned, done": the register says it is waiting on the holder, which is the whole point of
  // proving custody by scan rather than by assertion.
  await expect(row).toContainText(/Awaiting|Pending|scan/i);

  await purge(it, await assetPath(it, name));
  await purge(it, category.path);
});

/**
 * The category an asset has to be filed under - ALWAYS a fresh one this spec owns.
 *
 * It used to reuse the first listed category that did not demand a serial, and the dialog then picked
 * `option.first()` regardless, which is not necessarily the row this resolved. Both halves were unsafe: the
 * asset catalogue in this lane is mostly other specs' fixtures (`assetRequests`, `assetTagPdf`,
 * `assetTagPrinterQueue` and `cancelOwnRequest` each create an `E2E …` category and purge it when they
 * finish), so the pick could be a row about to be deleted, or `assetSerialRequired`'s `requires_serial` one -
 * the exact category the comment below exists to avoid. Owning the row and picking it BY NAME settles both.
 */
async function assetCategory(page: import("@playwright/test").Page): Promise<{ path: string; name: string }> {
  // `requires_serial: false` deliberately: a category that demands one refuses the asset
  // ("a serial number is required for …") for a reason nothing here is about.
  const name = `E2E assets category ${Date.now()}`;
  const made = await page.request.post("/v1/asset-categories", {
    headers: SPA_HEADERS,
    data: { display_name: name, requires_serial: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  return { path: ((await made.json()) as { path: string }).path, name };
}

/** The wire path of the asset this spec added. */
async function assetPath(page: import("@playwright/test").Page, name: string): Promise<string> {
  const res = await page.request.get("/v1/assets?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string; display_name?: string }[] };
  const row = results.find((a) => (a.name ?? a.display_name) === name);
  if (!row) throw new Error(`e2e: the asset "${name}" is not in the register`);
  return row.path;
}
