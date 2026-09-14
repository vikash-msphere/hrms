import { gotoRoute, purge, test, expect } from "./fixtures";

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// The notice-period form's own date arithmetic - `timeOffAdmin.spec.ts` proves a notice can be recorded, but
// only ever fills in a last working day well after the notice date, so none of the shape here has ever run:
// a last working day can't be BEFORE the notice was given, the days-of-notice count shown is worked out live
// rather than left for the reader to subtract, a same-day exit gets its own warning (their login goes today),
// and pulling the notice date forward past an already-picked last working day drags that day along with it
// rather than silently leaving an invalid range sitting in the form.
test("the notice-period form computes notice length, warns on same-day exits, and refuses a last working day before the notice", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");

  await gotoRoute(page, "notice-periods", "Notice Periods");
  await page.getByRole("button", { name: "Record notice" }).first().click();
  const form = page.getByRole("dialog");

  await form.getByLabel("Employee").click();
  await page.getByPlaceholder(/Search|Select/).last().fill("Ethan Martin");
  await expect(page.getByRole("option", { name: /Ethan Martin/ })).toBeVisible();
  await page.keyboard.press("Enter");

  const submit = form.getByRole("button", { name: "Record", exact: true });
  const noticeDate = await form.getByLabel("Notice given").inputValue();
  const lwdField = form.getByLabel("Last working day");

  // Nothing to save yet: no last working day picked.
  await expect(submit).toBeDisabled();

  // Before the notice was given: refused on the field, and the reason banner agrees.
  await lwdField.fill(addDays(noticeDate, -1));
  await expect(form.getByText("Before the notice date.")).toBeVisible();
  await expect(form.getByText("The last working day can't be before the notice date.")).toBeVisible();
  await expect(submit).toBeDisabled();

  // Same day as the notice: a valid, if unusual, request - their own warning, not the "before" error.
  await lwdField.fill(noticeDate);
  await expect(form.getByText("Before the notice date.")).toHaveCount(0);
  await expect(form.getByText("0 days of notice.")).toBeVisible();
  await expect(form.getByText("Same-day exit:", { exact: false })).toBeVisible();
  await expect(submit).toBeEnabled();

  // Ten days out: the count follows, and the same-day banner clears.
  await lwdField.fill(addDays(noticeDate, 10));
  await expect(form.getByText("10 days of notice.")).toBeVisible();
  await expect(form.getByText("Same-day exit:", { exact: false })).toHaveCount(0);

  // Pulling the notice date past the last working day already picked drags that day forward with it -
  // an invalid range is never left sitting in the form for the reader to notice and fix by hand.
  const laterNotice = addDays(noticeDate, 15);
  await form.getByLabel("Notice given").fill(laterNotice);
  await expect(lwdField).toHaveValue(laterNotice);

  // Settled on a real, ten-day notice, and this time it's saved.
  await lwdField.fill(addDays(laterNotice, 10));
  await expect(form.getByText("10 days of notice.")).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  try {
    await expect(page.locator("tbody tr").filter({ hasText: "Ethan Martin" }).first()).toBeVisible({ timeout: 30_000 });

    // Already serving notice: a second one for the same person is edited, not duplicated - so the picker
    // that just offered them stops offering them.
    await page.getByRole("button", { name: "Record notice" }).first().click();
    const second = page.getByRole("dialog");
    await second.getByLabel("Employee").click();
    await page.getByPlaceholder(/Search|Select/).last().fill("Ethan Martin");
    await expect(page.getByText("No matches.")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  } finally {
    const res = await page.request.get("/v1/notice-periods?page_size=200");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; employee?: string }[] };
      const empRes = await page.request.get("/v1/employees?page_size=200");
      const { results: emps = [] } = (await empRes.json()) as { results?: { path: string; first_name?: string; last_name?: string }[] };
      const ethan = emps.find((e) => e.first_name === "Ethan" && e.last_name === "Martin");
      if (ethan) for (const n of results.filter((r) => r.employee === ethan.path)) await purge(page, n.path);
    }
  }
});
