import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// A recurring statutory obligation: one rule that keeps a year of filings on the calendar.
//
// `compliance.spec.ts` covers a one-off item. This is the other half of the page, and the half nobody looks
// at until it is wrong: PF is due every month forever, and typing twelve rows by hand is how a month gets
// missed. `test/complianceRecurrence.test.ts` owns the date arithmetic - which day a short month clamps to,
// where a quarterly cycle lands.
//
// What only a browser shows is the form reading its own schedule back BEFORE it is saved. A recurrence is
// unfalsifiable at the moment it is typed: "quarterly, day 15, from April" looks right whatever it means, and
// the mistake surfaces in July when a filing nobody expected is overdue. So the dialog prints the next
// filings as DATES and re-prints them as the frequency changes - and the quarterly cycle's anchor month is a
// field that does not exist until it is needed. Then, on the calendar behind it, the occurrences that rule
// generated, each marked as belonging to a rule and each saying that editing it changes only itself.
test("a recurring rule reads its schedule back, then fills the calendar with its occurrences", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const title = `E2E rule ${Date.now() % 100000}`;

  await gotoRoute(page, "compliance", "Compliance Calendar");
  await sweep(page);
  await page.getByRole("button", { name: "Recurring rules" }).click();
  await page.getByRole("button", { name: "Add rule" }).first().click();

  const form = page.getByRole("dialog");
  await form.getByLabel("Obligation").fill(title);
  await form.getByLabel("Authority / area").fill("EPFO");
  await form.getByLabel("Due day").fill("15");

  // Monthly: three consecutive filings, and the sentence says what happens after them. This is the whole
  // point of the preview - the dates are the only thing that can be checked by eye.
  const preview = form.getByText(/^Next filings: /);
  await expect(preview).toContainText(", then every month.", { timeout: 30_000 });
  const monthly = await dueDates(preview);
  expect(monthly.length, "the preview should read back several filings, not one").toBeGreaterThan(2);
  expect(monthsApart(monthly)).toEqual([1, 1]);

  // Quarterly needs a cycle start month, and a form that asked for it up front would be asking a question
  // that has no meaning for the monthly rule everybody actually writes - so the field appears with the
  // answer that needs it, and the preview re-reads on the new schedule.
  await expect(form.getByLabel("Cycle start month")).toHaveCount(0);
  await form.getByLabel("Frequency").click();
  await page.getByRole("option", { name: "Quarterly", exact: true }).click();
  await expect(form.getByLabel("Cycle start month")).toBeVisible({ timeout: 30_000 });
  await expect(preview).toContainText(", then every 3 months.", { timeout: 30_000 });
  expect(monthsApart(await dueDates(preview))).toEqual([3, 3]);

  // Back to the monthly rule this spec files, and saved.
  await form.getByLabel("Frequency").click();
  await page.getByRole("option", { name: "Monthly", exact: true }).click();
  await expect(preview).toContainText(", then every month.", { timeout: 30_000 });
  await form.getByRole("button", { name: "Add rule", exact: true }).click();
  await expect(toast(page, "Recurring rule added")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // The rule is on the rules table, with the schedule spelled out rather than left as three stored fields.
  await expect(page.locator("tbody tr").filter({ hasText: title })).toContainText("Monthly · day 15", { timeout: 30_000 });

  // And the calendar behind it now carries the filings the rule generated - which is the thing the rule
  // exists to do, and is not visible anywhere on the rules table.
  await page.getByRole("button", { name: "List" }).click();
  const occurrences = page.locator("tbody tr").filter({ hasText: title });
  await expect(occurrences.first()).toBeVisible({ timeout: 30_000 });
  expect(await occurrences.count(), "a year of filings, not one").toBeGreaterThan(2);
  // Marked as belonging to a rule, so nobody wonders where a filing they never typed came from.
  await expect(occurrences.first().getByLabel("Recurring")).toBeVisible();

  // Opening one says what editing it will and will not do: a correction to September's challan number must
  // not silently become a change to every month ahead.
  await occurrences.first().getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page.getByRole("dialog").getByText(/Editing this occurrence changes only this one/)).toBeVisible({ timeout: 30_000 });
  await abandonDialog(page);

  await sweep(page);
});

type Page = import("@playwright/test").Page;

/**
 * The dates the preview printed, in order.
 *
 * Cut at ", then every", not at the first comma: the app formats a date as "15 Sep 2026", so splitting on
 * commas reads one filing where there are three - and a length assertion then fails for a reason that has
 * nothing to do with the page.
 */
async function dueDates(preview: import("@playwright/test").Locator): Promise<Date[]> {
  const text = await preview.innerText();
  const listed = text.match(/Next filings:\s*([\s\S]*?),\s*then every/)?.[1] ?? "";
  const dates = listed.split("·").map((d) => new Date(d.trim())).filter((d) => !Number.isNaN(+d));
  expect(dates.length, `could not read dates out of "${text}"`).toBeGreaterThan(0);
  return dates;
}

/** How many months lie between each printed filing and the next - the shape of the schedule, not its values. */
function monthsApart(dates: Date[]): number[] {
  return dates.slice(1).map((d, i) => {
    const prev = dates[i]!;
    return (d.getFullYear() - prev.getFullYear()) * 12 + (d.getMonth() - prev.getMonth());
  });
}

/** Close a form that has been filled in - a dirty dialog asks first (see draftGuard.spec.ts). */
async function abandonDialog(page: Page) {
  await expect(async () => {
    if (!(await page.getByRole("dialog").count())) return;
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog").getByRole("button", { name: /Discard|Leave/ });
    if (await discard.count()) await discard.first().click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }).toPass({ timeout: 30_000 });
}

/**
 * Take out every rule any run of this spec has written, AND the occurrences it generated.
 *
 * Purging a rule does not take its occurrences with it (they are ordinary calendar items once generated, and
 * a filed one is a record of something that really happened), so a spec that only deleted the rule would
 * leave a year of filings on the calendar per run.
 */
async function sweep(page: Page) {
  const [rules, events] = await Promise.all([
    page.request.get("/v1/compliance-rules?page_size=200"),
    page.request.get("/v1/compliance-events?page_size=200"),
  ]);
  // Exact shape, not a prefix: this spec's own titles are `E2E rule <digits>` and nothing else, and a plain
  // `startsWith("E2E rule ")` also matches `complianceRuleDelete.spec.ts`'s "E2E rule delete <digits>" - a
  // shared prefix that let this sweep hard-purge that spec's row out from under its own still-running test.
  const mine = (res: import("@playwright/test").APIResponse) =>
    res.ok()
      ? res.json().then(({ results = [] }: { results?: { path: string; title?: string }[] }) =>
          results.filter((r) => /^E2E rule \d+$/.test(r.title ?? "")).map((r) => r.path))
      : Promise.resolve([] as string[]);
  for (const path of [...(await mine(events)), ...(await mine(rules))]) await purge(page, path);
}
