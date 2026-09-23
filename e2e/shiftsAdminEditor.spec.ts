import { gotoRoute, purge, test, expect } from "./fixtures";

// The shift catalog editor (Settings → Shifts) - `schedule.spec.ts` proves the roster can mint a shift
// inline while assigning it, but never opens THIS editor, so none of its own guardrails or its live preview
// are exercised anywhere: two shifts sharing a name are indistinguishable on the roster grid, a shift whose
// break outlasts it is nonsense, and a shift that "ends" at or before it starts is how a night shift is
// expressed here - the form has to say which of those it is, and what the shift actually pays, before it is
// saved rather than after.
test("the shift editor refuses a duplicate name, a same-time span and an over-long break, and prices a night shift", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const stamp = Date.now();
  const nameA = `E2E shift a ${stamp}`;
  const nameB = `E2E shift b ${stamp}`;
  const paths: string[] = [];

  try {
    await gotoRoute(page, "settings/shifts");

    // Shift A: an ordinary day shift, saved first so its name is there to collide with.
    await page.getByRole("button", { name: "New shift" }).first().click();
    let form = page.getByRole("dialog");
    await form.getByLabel("Name").fill(nameA);
    const create = form.getByRole("button", { name: "Create", exact: true });
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(nameA)).toBeVisible({ timeout: 30_000 });

    // Shift B: opened fresh, and walked through every refusal before it is ever valid to save.
    await page.getByRole("button", { name: "New shift" }).first().click();
    form = page.getByRole("dialog");
    const submit = form.getByRole("button", { name: "Create", exact: true });

    // Same name as A: caught on the field itself, not left for the server to 409 on.
    await form.getByLabel("Name").fill(nameA);
    await expect(form.getByText("Another shift already has this name.")).toBeVisible();
    await expect(submit).toBeDisabled();

    await form.getByLabel("Name").fill(nameB);
    await expect(form.getByText("Another shift already has this name.")).toHaveCount(0);

    // Same start and end: not a valid span at all.
    await form.getByLabel("End").fill("09:00");
    await expect(form.getByText("Pick a different end time.")).toBeVisible();
    await expect(submit).toBeDisabled();

    // A default day shift (09:00-18:00, 9h on site) with a break that outlasts it.
    await form.getByLabel("End").fill("18:00");
    await form.getByLabel("Unpaid break", { exact: false }).fill("600");
    await expect(form.getByText("Shorter than the shift.")).toBeVisible();
    await expect(submit).toBeDisabled();

    // The "Night" preset: crosses midnight, so the form has to say so and price the span (8h) minus its
    // own 30m break (7h 30m paid) rather than a negative or a full day.
    await page.getByRole("button", { name: /^Night/ }).click();
    await expect(form.getByText("ends next day")).toBeVisible();
    await expect(form.getByText("7h 30m paid")).toBeVisible();
    await expect(form.getByText("8h on site", { exact: false })).toBeVisible();
    await expect(form.getByText("30m unpaid break", { exact: false })).toBeVisible();
    // The preset re-named the shift too, since the name was still untouched at "b ..." from typing above -
    // no: the name was explicitly typed (nameB), so the preset must NOT have overwritten it.
    await expect(form.getByLabel("Name")).toHaveValue(nameB);

    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByText(nameB)).toBeVisible({ timeout: 30_000 });
    // The catalog row itself repeats the same math: paid length beside the times, and the overnight badge.
    const rowB = page.locator("div").filter({ hasText: nameB }).filter({ hasText: "overnight" }).first();
    await expect(rowB).toContainText("7h 30m");
  } finally {
    const res = await page.request.get("/v1/shifts?page_size=200");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
      for (const s of results.filter((r) => r.name === nameA || r.name === nameB)) paths.push(s.path);
    }
    for (const p of paths) await purge(page, p);
  }
});
