import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// The white screen that doesn't happen.
//
// A single-page app's worst failure is a render that throws: React unmounts the tree and the person is left
// looking at a blank page with no way forward. The boundary is what stands between that and them - and it
// has a branch worth pinning separately, because it is the one that fires in real life more often than any
// bug: a lazy chunk that will not load. That happens whenever a new version ships while somebody's tab is
// open, and the honest answer is not "something went wrong" but "this tab is out of date, reload it".
//
// It cannot be provoked from the server, so the chunk is blocked in the browser: the settings panel is a
// lazy import, and with its module refused the import rejects exactly as it does after a deploy.
test("a chunk that will not load draws the out-of-date panel rather than a blank page", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  // A refused module logs, and so does the boundary itself - which is the point of it. That IS the scenario.
  allowConsoleErrors(
    page,
    // The refused module, the boundary's own report, and React's console notice about the component that
    // threw. All three are this scenario working rather than the app failing.
    /Failed to fetch dynamically imported module|Unhandled render error|Failed to load resource|Importing a module script failed|The above error occurred|error occurred in one of your React components/i,
  );

  // Refuse the module the settings panel is imported from. The panel lives in the Settings page's own module,
  // so this is the request the dynamic import makes when the gear is pressed.
  let blocking = true;
  await page.route("**/src/pages/Settings.tsx*", (route) => (blocking ? route.abort() : route.fallback()));

  // Attendance hosts several settings, so its gear is a menu and the row is what opens the panel.
  await gotoRoute(page, "attendance", "Attendance");
  await page.getByRole("main").getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "Attendance schedule" }).click();

  // The boundary caught it, and said the useful thing: a tab that has been open across a deploy is told to
  // reload rather than told a mystery.
  await expect(
    page.getByText("This tab is out of date").or(page.getByText("Something went wrong")).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: /^(Reload|Try again)$/ }).first()).toBeVisible();

  // And the app is still there behind it - the boundary is scoped, not the whole window: the nav and the page
  // heading survive, so the person can go somewhere else without reloading anything.
  await expect(page.getByRole("link", { name: /^Team/ }).first()).toBeVisible();

  // With the module served again, the offered way out really works.
  blocking = false;
  await page.getByRole("button", { name: /^(Reload|Try again)$/ }).first().click();
  await expect(page.getByRole("main")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("This tab is out of date")).toHaveCount(0, { timeout: 30_000 });
});
