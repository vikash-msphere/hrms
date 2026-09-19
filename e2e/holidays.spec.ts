import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// The holiday calendar: one org-wide list, two audiences.
//
// HR's half is the editor, and the thing worth checking there is the clash guard - two holidays on one date
// is the mistake that gets made, and the form has to say so on the date rather than at the server. The
// employee's half is the optional holiday: a day they choose out of an allowance, which the row's own button
// takes and gives back. And the calendar leaves the app as a file: `lib/ics.ts` builds the feed in the
// browser and hands it over through a blob, so the only place the bytes exist is here.
test.describe("holidays", () => {
  test("HR adds a holiday, is warned about a clash, and an employee takes the optional day", async ({ as }) => {
    const hr = await as("hr");
    const employee = await as("employee");
    // The housekeeping is done as super, not HR: a hard purge (`?force=true`) on the org calendar is refused
    // to HR with a 403, and `purge` swallows that - so as HR this spec quietly left a holiday behind on every
    // run and the clash guard below was one rerun away from firing on the wrong row.
    const admin = await as("super");
    const name = `E2E Optional Day ${Date.now()}`;
    // A run that died half way leaves its holiday behind; the clash guard below would then fire on the
    // wrong row, so start from a calendar with none of this spec's leftovers on it.
    await purgeLeftovers(admin);
    // A date next year, so it can never collide with a seeded holiday or with a leave the other specs file.
    const date = `${new Date().getUTCFullYear() + 1}-11-07`;

    await gotoRoute(hr, "holidays", "Holiday Calendar");
    await hr.getByRole("button", { name: "Add holiday" }).first().click();
    const form = hr.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Add holiday" })).toBeVisible();
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Date", { exact: true }).fill(date);
    // Optional, so the employee half of this spec has something to pick.
    await form.getByRole("combobox").first().click();
    await hr.getByRole("option", { name: "Optional" }).click();
    await form.getByRole("button", { name: "Add holiday", exact: true }).click();
    await expect(toast(hr, "Holiday added")).toBeVisible();

    // The clash guard: the same date again is refused ON THE FIELD, before anything is sent.
    await hr.getByRole("button", { name: "Add holiday" }).first().click();
    const second = hr.getByRole("dialog");
    await second.getByLabel("Name").fill(`${name} (again)`);
    await second.getByLabel("Date", { exact: true }).fill(date);
    await second.getByLabel("Date", { exact: true }).blur();
    await expect(second.getByText(new RegExp(`${escapeRe(name)} is already on this date`))).toBeVisible();
    await expect(second.getByRole("button", { name: "Add holiday", exact: true })).toBeEnabled(); // a warning, not a block
    await hr.keyboard.press("Escape");
    // A touched dialog asks before it throws away what was typed (draftGuard owns that rule).
    const discard = hr.getByRole("dialog");
    const discardBtn = discard.getByRole("button", { name: /Discard|Leave/ });
    if (await discardBtn.count()) await discardBtn.first().click();

    // The employee's half: an optional holiday is theirs to take. The year rides in the URL query, so the
    // page can be linked straight to the year the holiday is in.
    await gotoRoute(employee, `holidays?year=${date.slice(0, 4)}`, "Holiday Calendar");
    // The list view: the same holidays as rows, where a pick belongs to exactly one of them.
    await employee.getByRole("group", { name: "Holiday view" }).getByRole("button", { name: "List" }).click();
    const row = employee.locator("tbody tr").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Select" }).click();
    await expect(toast(employee, `Selected ${name}`)).toBeVisible();
    await expect(row.getByRole("button", { name: /Selected/ })).toBeVisible();

    // And back off again, so a rerun starts from an unused allowance. Giving a pick back is NOT symmetrical
    // with taking one - the allowance is capped and the deadline can pass, so it asks first.
    await row.getByRole("button", { name: /Selected/ }).click();
    const giveUp = employee.getByRole("dialog");
    await expect(giveUp.getByText(`Give up ${name}?`)).toBeVisible();
    await giveUp.getByRole("button", { name: "Give it up" }).click();
    await expect(toast(employee, `Deselected ${name}`)).toBeVisible();

    await purge(admin, await holidayPath(hr, name));
  });

  test("the calendar downloads as a real .ics feed", async ({ as }) => {
    const page = await as("employee");
    await gotoRoute(page, "holidays", "Holiday Calendar");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download as calendar file" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.ics$/);
    const path = await download.path();
    if (!path) throw new Error("the export produced no file");
    const { readFile } = await import("node:fs/promises");
    const ics = (await readFile(path)).toString("utf8");
    // A calendar file, not an empty one: the wrapper, and at least one dated event inside it.
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
  });
});

/** Take out every holiday this spec has ever added, whatever run added it. */
async function purgeLeftovers(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/holidays?page_size=100");
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name: string }[] };
  for (const h of results.filter((x) => x.display_name.startsWith("E2E Optional Day"))) await purge(page, h.path);
}

/** The wire path of a holiday by name, for taking it back out. */
async function holidayPath(page: import("@playwright/test").Page, name: string): Promise<string> {
  const res = await page.request.get("/v1/holidays?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name: string }[] };
  const row = results.find((h) => h.display_name === name);
  if (!row) throw new Error(`e2e: the holiday "${name}" is not in the collection`);
  return row.path;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
