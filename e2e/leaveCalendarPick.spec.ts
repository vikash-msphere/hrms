import { gotoRoute, nextWeekday, test, expect } from "./fixtures";

// Choosing leave on the calendar rather than typing dates.
//
// The request dialog has two date inputs and, under them, the control people actually use: a month grid where
// the first press starts a range and the second closes it. It is the one part of filing leave that a keyboard
// user and a mouse user reach differently, and everything it does is browser-only - the days it draws come
// from the org's working week and its holidays, the range it bands is state in the page, and the number of
// days the request will cost is recomputed from the two ends as they are picked.
//
// `leaveDuration` types the dates into the inputs, which is the same request by a different road and says
// nothing about the grid. `holidays` owns the calendar page. What is pinned here is the picker: a range
// picked in the grid reaching the inputs, the cost following it, and the days being named for a reader who
// cannot see the banding.
test("a range picked on the grid fills the dates and prices itself", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("manager");

  await gotoRoute(page, "leave-requests", "Leaves");
  await page.getByRole("button", { name: "Request leave" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Request leave" })).toBeVisible({ timeout: 30_000 });

  // Every day carries its own date, which is what lets this press a particular day rather than "the
  // fourteenth cell". By `data-ymd` and not by name: the NAME is the spoken date ("Monday, 28 September
  // 2026"), formatted for whoever is reading it, so matching on it would be this spec asserting the runner's
  // locale agrees with the browser's. What the day IS does not move.
  const day = (ymd: string) => form.locator(`button[data-ymd="${ymd}"]`);
  await expect(form.locator("button[data-ymd]").first()).toBeVisible({ timeout: 30_000 });

  // TWO ADJACENT DAYS THE ORG ACTUALLY CHARGES FOR, taken from the grid rather than from the calendar.
  //
  // "A weekday" is not the same question: a weekday the org has declared a holiday costs nothing, so a pair
  // picked by skipping only Saturdays and Sundays prices at one day whenever the second of them lands on one -
  // which is a real answer from the app and a broken premise in the spec, firing on whichever weeks of the
  // year the seeded holidays happen to fall in (2 October did it). And the pair has to be adjacent on the
  // CALENDAR, not merely consecutive among working days: a Friday-Monday pair costs the same two days but the
  // panel then also says "2 weekend/holiday days in between don't count", so the cost line no longer reads as
  // that sentence alone.
  //
  // `data-day` is the grid's own word for what a day is worth ("work", "half", "weekend", "holiday"), in the
  // four the leave arithmetic itself uses (domain/leave.ts). Barred days are left out: a policy window cannot
  // be picked at all.
  const chargeable = await form
    .locator('button[data-day="work"]:not([disabled]), button[data-day="half"]:not([disabled])')
    .evaluateAll((els, from) =>
      els
        .map((el) => ({ ymd: el.getAttribute("data-ymd") ?? "", kind: el.getAttribute("data-day") ?? "" }))
        .filter((d) => d.ymd >= from)
        .sort((a, b) => a.ymd.localeCompare(b.ymd)),
      // A fortnight out, so the grid is drawing an ordinary month rather than today's part-spent one.
      nextWeekday(14),
    );
  const nextDay = (ymd: string) => {
    const at = new Date(`${ymd}T00:00:00Z`);
    return new Date(at.getTime() + 86_400_000).toISOString().slice(0, 10);
  };
  const pair = chargeable.findIndex(
    (d, i) => d.kind === "work" && chargeable[i + 1]?.kind === "work" && chargeable[i + 1]?.ymd === nextDay(d.ymd),
  );
  expect(pair, `the two months on screen offer no two adjacent working days:\n${JSON.stringify(chargeable)}`).toBeGreaterThanOrEqual(0);
  const start = chargeable[pair]!.ymd;
  const end = chargeable[pair + 1]!.ymd;

  // The first press opens the range, the second closes it. The inputs are the proof it reached the form: they
  // are what the request is actually filed from.
  await day(start).click();
  await expect(form.getByLabel("Start date")).toHaveValue(start);
  await day(end).click();
  await expect(form.getByLabel("End date")).toHaveValue(end);

  // Banded, and said out loud: a picked day reads as pressed for anybody not looking at the tint.
  await expect(day(start)).toHaveAttribute("aria-pressed", "true");
  await expect(day(end)).toHaveAttribute("aria-pressed", "true");

  // And priced from the two ends: two working days, computed in the page from the org's week.
  await expect(form.getByText(/^2 days of leave$/)).toBeVisible({ timeout: 30_000 });

  // Picking a single day again collapses the range rather than extending it - the press that follows "I only
  // need the Monday after all".
  await day(start).click();
  await expect(form.getByLabel("End date")).toHaveValue(start);
  await expect(form.getByText(/^1 day of leave$/)).toBeVisible({ timeout: 30_000 });

  // Nothing was filed: this spec is about the picker, and it leaves the person's balance where it found it.
  // Escape (with the draft guard's own Discard answered too) has proven unreliable at actually closing a
  // dialog under load elsewhere in this suite - a reload is unconditional, so it is what clears a stuck one.
  await expect(async () => {
    if (!(await page.getByRole("dialog").count())) return;
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog").getByRole("button", { name: /^(Discard|Leave)$/ });
    if (await discard.count()) await discard.first().click();
    if (await page.getByRole("dialog").count()) await page.reload();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  expect(await filedOn(page, start), "the picker filed a request by itself").toBeFalsy();
});

/** The next Mon-Fri strictly after `day`, as the grid names its cells. */
/**
 * A request THIS PERSON filed starting on `day` - there should be none.
 *
 * Scoped to their own employee, because the reader here is a manager and the list they get back is their whole
 * team's: anybody else's leave starting on the day this spec happened to pick reads as "the picker filed a
 * request by itself", and at sixteen workers somebody else's leave lands on most days.
 */
async function filedOn(page: import("@playwright/test").Page, day: string): Promise<string | undefined> {
  const me = await page.request.get("/v1/users/me");
  if (!me.ok()) return undefined;
  const { employee } = (await me.json()) as { employee?: string };
  const res = await page.request.get("/v1/leave-requests?page_size=100");
  if (!res.ok()) return undefined;
  const { results = [] } = (await res.json()) as { results?: { path: string; start_date?: string; employee?: string }[] };
  return results.find((r) => r.start_date === day && r.employee === employee)?.path;
}
