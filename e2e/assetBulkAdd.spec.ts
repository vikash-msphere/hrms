import { allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// A delivery, added as a delivery.
//
// Kit does not arrive one at a time: a box of twenty adapters, or a pallet of laptops with a packing list of
// serial numbers. The bulk dialog is the only place in the app where what will be created is COUNTED before
// anything is written - the submit button names the number, and in the serials mode that number comes from
// parsing what somebody pasted, line by line, with the unusable lines called out rather than silently
// dropped. Creating nineteen assets because line 7 was malformed is the failure this exists to prevent.
//
// `test/assetBulk.test.ts` owns the line parser and `test/assetBatchCreate.test.ts` the contiguous tag run.
// What only a browser shows is the dialog: that the mode really swaps what is asked for, that the count on
// the button tracks it, and that the paste ends up as that many records.
test("the bulk dialog counts what it will create, from a quantity or a pasted list", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("it");
  const admin = await as("super"); // the hard purge is an admin's to make
  // A dev Worker restart mid-request on a busy lane, same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.) - the retry below on the submit is what actually recovers from it.
  allowConsoleErrors(page, /status of 500|status of 503/i);
  const stamp = Date.now() % 1_000_000;
  const name = `E2E delivery ${stamp}`;

  await gotoRoute(page, "assets", "Assets");
  await page.getByRole("button", { name: "Add many" }).click();
  const form = page.getByRole("dialog");
  await expect(form.getByText("Add many assets")).toBeVisible();

  // The dialog reopens onto whatever was last typed into it, and that draft outlives this browser - so an
  // earlier run's half-filled delivery is what a counting spec would be counting. Take the notice's own way
  // out when there is a draft to leave; a clean form is the baseline every assertion below assumes.
  const startOver = form.getByRole("button", { name: "Start over" });
  if (await startOver.count()) {
    await startOver.click();
    await expect(startOver).toHaveCount(0);
  }

  // Identical items: the count is set, and the button says what pressing it would do. This is the number
  // people check before committing, so it has to move with the control rather than after the write. Set
  // outright first (the form opens on a sensible delivery size, not on one), then stepped, so the button is
  // seen tracking both controls.
  await form.getByLabel("What they are").fill(name);
  await form.getByRole("button", { name: "5", exact: true }).click();
  await expect(form.getByRole("button", { name: /^Add 5 assets$/ })).toBeVisible({ timeout: 30_000 });
  await form.getByRole("button", { name: "One more" }).click();
  await expect(form.getByRole("button", { name: /^Add 6 assets$/ })).toBeVisible({ timeout: 30_000 });

  // The other mode asks a different question of the same delivery - one line per device - and the count now
  // comes from the lines rather than a stepper.
  await form.getByRole("radio", { name: "Serial numbers", exact: true }).click();
  await expect(form.getByLabel("Name for all of them")).toHaveValue(name);
  const serials = [`E2E-${stamp}-A`, `E2E-${stamp}-B`, `E2E-${stamp}-C`];
  await form.getByPlaceholder(/C02XK1FTQ6LR/).fill(serials.join("\n"));
  await expect(form.getByText(/^3 to add/)).toBeVisible({ timeout: 30_000 });
  await expect(form.getByRole("button", { name: /^Add 3 assets$/ })).toBeVisible();

  // The dialog closing is the write landing; a refusal keeps it open with the reason pinned. Re-pressed on a
  // miss, checked by the serials themselves first: a transient 500 (the same rare dev-Worker-restart hiccup
  // documented elsewhere in this suite) can leave the dialog open with no way to tell, from the client alone,
  // whether the write actually landed before the response was lost - so this checks the register directly
  // before re-pressing, rather than risk creating six records instead of three.
  await expect(async () => {
    if (await page.getByRole("dialog").count()) {
      if ((await bySerial(page, serials)).length === serials.length) return;
      const addBtn = page.getByRole("dialog").getByRole("button", { name: /^Add 3 assets$/ });
      if (await addBtn.count()) await addBtn.click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
  }).toPass({ timeout: 90_000 });

  try {
    // Three records, one per line - not one record with three serials on it, which is what "bulk" means in
    // the systems this replaces.
    const created = await bySerial(page, serials);
    expect(created.map((a) => a.serial).sort(), "one asset per pasted line").toEqual([...serials].sort());
  } finally {
    for (const a of await bySerial(page, serials)) await purge(admin, a.path);
  }
});

/**
 * The assets carrying any of these serial numbers.
 *
 * Paged rather than read in one call: the register is one of the longer collections in the seed, and a spec
 * that looked at the first hundred rows would find its own delivery only until somebody adds a hundred more.
 */
async function bySerial(
  page: import("@playwright/test").Page,
  serials: string[],
): Promise<{ path: string; serial?: string }[]> {
  const found: { path: string; serial?: string }[] = [];
  let token = "";
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const res = await page.request.get(`/v1/assets?page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
    if (!res.ok()) break;
    const body = (await res.json()) as { results?: { path: string; serial_number?: string }[]; next_page_token?: string };
    for (const a of body.results ?? []) {
      if (a.serial_number && serials.includes(a.serial_number)) found.push({ path: a.path, serial: a.serial_number });
    }
    if (found.length === serials.length || !body.next_page_token) break;
    token = body.next_page_token;
  }
  return found;
}
