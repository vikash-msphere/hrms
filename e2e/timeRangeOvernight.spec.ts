import { inDays, gotoRoute, test, expect } from "./fixtures";

// A range that crosses midnight - the one shape `overtime.spec.ts` never asks `TimeRangeField` for.
//
// The field derives the end date from the two times rather than making anyone pick it: type an end time no
// later than the start and it rolls to the next day on its own, marked with an amber moon rather than left to
// read as a same-day range that happens to end before it starts. `overtime.spec.ts` already owns the
// ordinary path (a quick-set chip, a same-day duration); this is the other branch of the same state machine -
// the one a night shift or a graveyard log actually needs.
test("an end time before the start rolls to the next day, marked and timed as one", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("employee");

  await gotoRoute(page, "overtime", "Overtime");
  await page.getByRole("button", { name: "Log overtime" }).first().click();
  const form = page.getByRole("dialog");
  await expect(form.getByRole("heading", { name: "Log overtime" })).toBeVisible();

  // Three days back, so the derived next day is still safely in the past - a form about hours already worked
  // has no business landing on tomorrow.
  await form.getByLabel("Date", { exact: true }).fill(inDays(-3));
  const times = form.getByLabel("Time", { exact: true });
  await times.first().fill("11:00 PM");
  await times.first().blur();
  // Set to a known SAME-day value first, deliberately - the dialog's own seeded end is not this spec's to
  // assume, and the "not overnight" half of the claim needs a state it actually put there itself.
  await times.last().fill("11:30 PM");
  await times.last().blur();

  // Nothing overnight yet - a same-day end still reads as a same-day range.
  await expect(form.locator("span.text-amber-600")).toHaveCount(0);

  await times.last().fill("2:00 AM");
  await times.last().blur();

  // Rolled: the label goes amber, and the duration is measured THROUGH midnight (23:00 to 02:00 is 3 hours,
  // not a negative range and not the 21-hour same-day gap a naive same-day subtraction would read instead).
  await expect(form.locator("span.text-amber-600")).toBeVisible();
  // A span, not the quick-set CHIP that happens to carry the same "3h" text as a button - the duration
  // display and the shortcut that would set an identical range are two different elements on this form.
  await expect(form.locator("span.whitespace-nowrap", { hasText: "3h" })).toBeVisible();
  await expect(times.last()).toHaveValue(/2:00\s*AM/i);

  await page.keyboard.press("Escape");
  const discard = page.getByRole("button", { name: /Discard|Leave/ });
  if (await discard.count()) await discard.first().click();
});
