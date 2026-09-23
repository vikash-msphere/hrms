import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Seeding a year of holidays, which nobody does one dialog at a time.
//
// Both of these are parsers with a preview, and the preview is the whole design: the failure worth guarding
// against is not a rejected line, it is a line that parsed into the WRONG DATE and got created anyway. So the
// pasted list is parsed as it is typed and shown back as rows - each one saying what it became, which lines
// cannot be read, and which dates the calendar already has - and the year copy shows every date it is about
// to write with the weekday it will land on, editable, because a fixed date moves weekday every year and a
// movable one (Holi, Eid, Diwali) does not follow the date at all.
//
// `lib/holidayBulk.ts` is where the parsing lives and it is unit-tested there. None of the above is: it only
// exists once the strings are rendered as a table beside the box they were typed into.
test.describe("holidays in bulk", () => {
  test("a pasted list is previewed line by line, then added", async ({ as }) => {
    test.setTimeout(240_000);
    const page = await as("hr");
    // The housekeeping is done as super: a hard purge (`?force=true`) on the org calendar is an admin's to
    // make, not HR's - as HR it is refused with a 403 and the rows pile up, occupying the dates the next run
    // needs (which is exactly how this spec started failing on its second run).
    const admin = await as("super");
    // Two years out, so this can never collide with a seeded holiday or with the optional day
    // `holidays.spec.ts` puts in next year's calendar.
    const year = new Date().getUTCFullYear() + 2;
    const stamp = Date.now() % 100000;
    const first = `E2E BulkAdd One ${stamp}`;
    const second = `E2E BulkAdd Two ${stamp}`;
    // Its own name prefix AND its own dates: the copy test below runs beside this one, and two tests writing
    // the same date would each see the other's row as "already added" - and each purge would take the other's
    // rows away mid-test.
    await purgeLeftovers(admin, "E2E BulkAdd");

    // On the year the paste is dated, so the rows it writes are on screen rather than filtered out of the
    // view - the page's year filter rides the URL query (`?year=`).
    await gotoRoute(page, `holidays?year=${year}`, "Holiday Calendar");
    await openBulk(page);
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Add many holidays" })).toBeVisible();

    // The format is easier to copy than to read, so the empty box offers a worked example - and the preview
    // then explains what each part of it did.
    await form.getByRole("button", { name: "Fill in the example to edit" }).click();
    // By cell, not by text: the same words are the textarea's own placeholder, so a text match finds the box
    // as well as the row it produced - and the row is the thing being asserted.
    await expect(form.getByRole("cell", { name: "Republic Day" })).toBeVisible();
    await expect(form.getByText("Optional").first()).toBeVisible();
    await expect(form.getByText("Half day").first()).toBeVisible();
    await expect(form.getByText("Mumbai").last()).toBeVisible();

    // This spec's own lines: one plain, one optional and half-day with a location, and one that cannot be
    // read at all. A line the parser rejects must be NAMED rather than dropped silently, or a pasted year
    // quietly becomes eleven months.
    const box = form.getByRole("textbox").first();
    await box.fill([`${year}-03-04  ${first}`, `05/12/${year} | ${second} | optional | half day | Pune`, "not a holiday at all"].join("\n"));

    await expect(form.getByRole("cell", { name: first })).toBeVisible();
    await expect(form.getByRole("cell", { name: second })).toBeVisible();
    await expect(form.getByRole("cell", { name: /not a holiday at all/ })).toBeVisible();
    // The footer is the honest count: what will be written, and what still needs a human.
    await expect(form.getByText("2 to add · 1 line to fix")).toBeVisible();

    await form.getByRole("button", { name: /^Add 2 holidays/ }).click();
    // The toast is the app SAYING it wrote them; the closed dialog and the rows below are it having written
    // them. A toast expires on its own timer, so on a lane slow enough for the write to take a while it can be
    // gone by the time anything asks - which is a missed notification, not a failed paste. So it is given a
    // short look and the outcome is proven by what the calendar holds: both pasted rows, and a second paste
    // that finds them already there.
    await toast(page, "Added 2 holidays").waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByText(second).first()).toBeVisible({ timeout: 30_000 });

    // On the calendar behind the dialog, in the year they were dated - a paste that landed in the wrong year
    // would be invisible here and wrong everywhere else.
    await expect(page.getByText(first).first()).toBeVisible({ timeout: 30_000 });

    // Pasted again, the same lines are recognised as already there rather than written twice: the preview
    // compares against the dates the calendar holds, and the submit has nothing left to do.
    await openBulk(page);
    const again = page.getByRole("dialog");
    await again.getByRole("textbox").first().fill(`${year}-03-04  ${first}`);
    await expect(again.getByText("Already added - skipped")).toBeVisible();
    await expect(again.getByText("0 to add · 1 already there")).toBeVisible();
    await expect(again.getByRole("button", { name: /^Add .*holiday/ })).toBeDisabled();

    // Nothing is written on the way out, and a box with typing in it asks before it throws the typing away.
    await again.getByRole("button", { name: "Cancel" }).click();
    const discard = page.getByRole("dialog");
    if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
      await discard.getByRole("button", { name: /Discard|Leave/ }).click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    await purgeLeftovers(admin, "E2E BulkAdd");
  });

  test("a year is copied forward with its dates editable and its weekdays named", async ({ as }) => {
    test.setTimeout(240_000);
    const page = await as("hr");
    const admin = await as("super"); // see the note on the paste test: only an admin may purge the calendar

    const year = new Date().getUTCFullYear() + 2;
    const stamp = Date.now() % 100000;
    const name = `E2E BulkCopy ${stamp}`;
    await purgeLeftovers(admin, "E2E BulkCopy");

    // A holiday to copy, filed over the wire: this test is about the copy, not about the add form. Its own
    // date, so the paste test running beside it never sees this row (or has it taken away mid-test).
    const source = await addHoliday(page, name, `${year}-06-11`);

    await gotoRoute(page, `holidays?year=${year}`, "Holiday Calendar");
    await page.getByRole("button", { name: "More ways to add holidays" }).click();
    await page.getByRole("menuitem", { name: "Copy a year" }).click();
    const form = page.getByRole("dialog");
    await expect(form.getByRole("heading", { name: "Copy a year of holidays" })).toBeVisible();

    // From the year this spec's holiday is in, into the next one.
    await form.getByLabel("Copy from").click();
    await page.getByRole("option", { name: String(year) }).click();
    await expect(form.getByLabel("Into")).toHaveValue(String(year + 1));

    // Every row says where it came from and what weekday the copy lands on - the two things that decide
    // whether the copied date is right, and neither of which the source date can tell you.
    const row = form.locator("tr").filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("was 06-11");
    await expect(row.locator('input[type="date"]')).toHaveValue(`${year + 1}-06-11`);

    // One toggle for the whole list, because "copy everything except two" is otherwise a dozen clicks. Off,
    // there is nothing to copy and the button says so by being shut.
    await form.getByRole("checkbox", { name: /^Clear every holiday$/ }).click();
    await expect(form.getByRole("button", { name: `Copy into ${year + 1}` })).toBeDisabled();

    // Only this spec's row back on: copying the whole calendar forward would leave a year of duplicated
    // seed holidays behind for every other spec that opens this page.
    await form.getByRole("checkbox", { name: `Copy ${name}` }).click();
    await expect(form.getByText(`1 of ${await rowCount(form)} selected`).first()).toBeVisible();
    await form.getByRole("button", { name: `Copy into ${year + 1}` }).click();
    await expect(toast(page, `Copied 1 holiday into ${year + 1}`)).toBeVisible({ timeout: 60_000 });

    // And the copy is a real row in the next year, not just a line in a dialog.
    const copied = await holidayByName(page, name, `${year + 1}-06-11`);
    expect(copied).toBeTruthy();

    // Copied again, the same row is recognised as already there and starts unticked - "copy again" is never
    // destructive, and never silently doubles the calendar.
    await page.getByRole("button", { name: "More ways to add holidays" }).click();
    await page.getByRole("menuitem", { name: "Copy a year" }).click();
    const twice = page.getByRole("dialog");
    await twice.getByLabel("Copy from").click();
    await page.getByRole("option", { name: String(year) }).click();
    await expect(twice.locator("tr").filter({ hasText: name }).getByText(`Already in ${year + 1}`)).toBeVisible({ timeout: 30_000 });
    await twice.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    await purge(admin, copied!);
    await purge(admin, source);
  });
});

/** Open the paste dialog, which lives behind the "more ways to add" menu beside Add holiday. */
async function openBulk(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "More ways to add holidays" }).click();
  await page.getByRole("menuitem", { name: "Add many (paste a list)" }).click();
}

/** How many rows the copy plan holds, so the "N of M selected" line can be checked against it. */
async function rowCount(form: import("@playwright/test").Locator): Promise<number> {
  return form.locator("tbody tr").count();
}

/** File a holiday over the wire, and return its path. */
async function addHoliday(page: import("@playwright/test").Page, name: string, date: string): Promise<string> {
  const res = await page.request.post("/v1/holidays", {
    headers: SPA_HEADERS,
    data: { display_name: name, date, kind: "fixed" },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}

/** The path of a holiday by name and date, or undefined. */
async function holidayByName(
  page: import("@playwright/test").Page,
  name: string,
  date: string,
): Promise<string | undefined> {
  const res = await page.request.get("/v1/holidays?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name: string; date: string }[] };
  return results.find((h) => h.display_name === name && h.date === date)?.path;
}

/** Take out every holiday this test has ever added, whatever run added it - and nobody else's. */
async function purgeLeftovers(page: import("@playwright/test").Page, prefix: string) {
  const res = await page.request.get("/v1/holidays?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name: string }[] };
  for (const h of results.filter((x) => x.display_name.startsWith(prefix))) await purge(page, h.path);
}
