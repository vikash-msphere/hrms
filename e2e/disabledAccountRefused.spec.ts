import {
  allowConsoleErrors,
  gotoRoute,
  makeThrowawayPerson,
  retireThrowawayPerson,
  toast,
  test,
  expect,
} from "./fixtures";

// Turning an account off, and finding out that it is off.
//
// `userAccessPanel` presses Disable and reads the badge that comes back. That is the admin's side of the
// story and it proves nothing about the only thing that matters: whether the person is actually locked out.
// The promise the confirm dialog makes in so many words - "they are signed out and their next request is
// refused" - has never been held to a live session. It is also the one authorization control with no rule,
// no scope and no grant behind it: `status !== "active"` is checked in the auth middleware before any policy
// is consulted (src/middleware/auth.ts), so no ACL change can restore it and nothing else in the suite
// exercises it end to end.
//
// The subject is a person this spec provisions. Disabling a seeded login would end every other spec running
// beside it.
test("a disabled account is locked out of the app it was using a moment ago", async ({ as }) => {
  test.setTimeout(300_000);
  const admin = await as("super");
  const person = await makeThrowawayPerson(admin, "Disable");

  const theirs = await as({ email: person.email });
  // Every request they make after the switch is refused, and the browser logs each one. That IS the test.
  allowConsoleErrors(theirs, /status of 403|Failed to load resource/i);

  try {
    // A working session first, so what follows is a lock-out rather than an account that never worked.
    await gotoRoute(theirs, "dashboard");
    await expect(theirs.getByRole("complementary").locator('a[href="/dashboard"]')).toBeVisible({ timeout: 30_000 });
    expect((await theirs.request.get("/v1/users/me")).status()).toBe(200);

    // The admin turns it off, through the panel and its confirm.
    await gotoRoute(admin, "settings/users", "Users");
    const row = admin.locator("tbody tr").filter({ hasText: person.email });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Active");
    await row.getByRole("checkbox", { name: "Select row" }).check();
    await admin.getByRole("button", { name: "Disable", exact: true }).click();
    const confirm = admin.getByRole("dialog").filter({ hasText: "Disable the selected accounts?" });
    await expect(confirm).toBeVisible({ timeout: 15_000 });
    await confirm.getByRole("button", { name: "Disable", exact: true }).click();
    await expect(toast(admin, "1 user updated")).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Disabled");

    // Their side. The cookie is still in the jar and still validly signed - the session is stateless - so
    // this is the DB status being consulted on every single request, which is exactly the design.
    const refused = await theirs.request.get("/v1/users/me");
    expect(refused.status()).toBe(403);
    expect(await refused.text()).toContain("disabled");
    // Not just identity: nothing else answers them either.
    expect((await theirs.request.get("/v1/employees?page_size=1")).status()).toBe(403);

    // And the app itself does not boot for them: no shell, no nav, no data behind it. (What the screen SAYS
    // is not asserted here - the app currently treats a refused identity read as "can't reach the server",
    // which is a wording question rather than an access one.)
    await theirs.reload();
    await expect(theirs.getByRole("complementary")).toHaveCount(0, { timeout: 30_000 });
    await expect(theirs.locator('a[href="/employees"]')).toHaveCount(0);
  } finally {
    // The employee goes; the login stays, disabled. Users have no delete route at all - "provisioned when an
    // employee is created, disabled rather than removed" (src/routes/users.ts) - and disabled is the resting
    // state this spec was aiming for anyway.
    await retireThrowawayPerson(admin, person.path);
  }
});
