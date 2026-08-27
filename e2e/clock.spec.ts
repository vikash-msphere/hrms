import { gotoRoute, test, expect, toast } from "./fixtures";

// One clock, wherever you look at it.
//
// Clocking in is offered in three places at once - the top bar button, the dashboard's "my day" card, and the
// Attendance page - and they are deliberately ONE piece of state (web/src/lib/clock.tsx) rather than three
// components each asking the server. The failure that shape exists to prevent is precisely a cross-component
// one: punch in from the top bar and have the dashboard still say "Not clocked in" until a reload. Only a
// browser can look at two surfaces at the same moment.
test("clocking in from the top bar is immediately true everywhere else", async ({ as }) => {
  const page = await as("employee");
  await gotoRoute(page, "dashboard");

  // Scoped to the header: the dashboard card offers the same action with the same name, and telling them
  // apart is the whole point of this test.
  const bar = page.getByRole("banner");
  const card = page.getByRole("main");
  await expect(bar.getByRole("button", { name: /^Clock in$/ })).toBeVisible();
  await expect(card.getByText("Not clocked in")).toBeVisible();

  await bar.getByRole("button", { name: /^Clock in$/ }).click();
  await expect(toast(page, "Clocked in")).toBeVisible();

  // Both surfaces, with no reload and no second read of the server.
  await expect(bar.getByRole("button", { name: /^Clock out/ })).toBeVisible();
  await expect(card.getByText("Clocked in", { exact: true })).toBeVisible();
  await expect(card.getByText("Not clocked in")).toHaveCount(0);

  // And the Attendance page, arrived at while on the clock, starts from the same state rather than its own.
  await gotoRoute(page, "attendance", "Attendance");
  await expect(bar.getByRole("button", { name: /^Clock out/ })).toBeVisible();

  // Clock out again, so a rerun starts where this one did.
  await bar.getByRole("button", { name: /^Clock out/ }).click();
  await expect(toast(page, "Clocked out")).toBeVisible();
  await expect(bar.getByRole("button", { name: /^Clock in$/ })).toBeVisible();
});
