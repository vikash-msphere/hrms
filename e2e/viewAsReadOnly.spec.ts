import { ROLES, SPA_HEADERS, allowConsoleErrors, gotoRoute, test, expect, userPath } from "./fixtures";

// A simulation may look, never touch.
//
// `viewAs` proves the shell narrows to the simulated person: their nav, their wall. It stops there, and what
// it leaves untested is the rail that makes the whole feature safe to ship - a simulation is READ-ONLY
// (src/lib/viewAs.ts, rail 3), and the browser must not offer a single affordance whose press would exercise
// a right the admin holds while wearing somebody else's face. The client half of that is one deliberate
// exception buried in `AccessAction`: create and method buttons are normally left on screen in access mode
// (an admin manages gates they do not hold), and mid-simulation they must NOT be - the simulated user's own
// answer is what has to be on the page.
//
// So this drives both halves: the buttons disappear even with access mode on, and the server refuses a write
// that carries the simulation header, saying which of the two things is wrong.
test("a simulation hides what it may not press, and the server refuses the write anyway", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  // The refused write below is the subject of this spec, not a symptom.
  allowConsoleErrors(page, /status of 403|Failed to load resource/i);
  const subject = await userPath(page, ROLES.employee);

  await gotoRoute(page, "vendors", "Vendors");
  // The admin's own page, with access mode on: the create button is there (and stays there in access mode
  // even for a collection the caller could not create in, which is the behaviour the simulation must undo).
  await page.locator('header button[title^="Sam Super"]').click();
  await page.getByRole("menuitem", { name: /Access management/ }).click();
  await expect(page.getByRole("button", { name: "New vendor" })).toBeVisible();

  // Start the simulation, from the same place an admin does.
  await page.getByRole("button", { name: /view as/i }).click();
  const picker = page.getByRole("button", { name: "View app as…" });
  await expect(picker).toBeVisible();
  await picker.click();
  await page.getByPlaceholder("Search…").fill(ROLES.employee);
  await expect(page.getByRole("option", { name: /Eve Employee/ }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Viewing as/)).toBeVisible({ timeout: 30_000 });

  // Mid-simulation the page is the subject's: Vendors is nothing an employee holds, so it is the wall - and
  // the create button is gone with the page, access mode or not.
  await gotoRoute(page, "vendors");
  await expect(page.getByText("You don't have access to this")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "New vendor" })).toHaveCount(0);

  // On a page the subject CAN open, the same rule holds for a button the admin would otherwise be offered:
  // the simulated person may raise a ticket, so that one stays; creating a board is not theirs.
  await gotoRoute(page, "tickets", "Support");
  await expect(page.getByRole("button", { name: "New ticket", exact: true })).toBeVisible({ timeout: 30_000 });

  // And the rail underneath it all: a write carrying the simulation header is refused before it reaches a
  // handler, with a message that says which of the two possible refusals this is.
  const refused = await page.request.post("/v1/vendors", {
    headers: { ...SPA_HEADERS, "X-View-As": subject },
    data: { display_name: `E2E should never exist ${Date.now()}` },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.text()).toContain("read-only");

  // Nothing was created by the attempt.
  const vendors = await page.request.get("/v1/vendors?page_size=200");
  expect(await vendors.text()).not.toContain("E2E should never exist");

  // Out again, and the admin's own affordances come back.
  await page.getByRole("button", { name: "stop", exact: true }).click();
  await expect(page.getByText(/Viewing as/)).toHaveCount(0);
  await gotoRoute(page, "vendors", "Vendors");
  await expect(page.getByRole("button", { name: "New vendor" })).toBeVisible({ timeout: 30_000 });
});
