import { gotoRoute, test, expect } from "./fixtures";

// What the app leaves on the machine, and what signing out takes away.
//
// This is only observable from a browser. The app caches what it reads so a reload costs no D1 reads
// (web/src/lib/clientStore.ts), which means an ordinary session ends with this person's colleagues, their org's
// configuration and their own drafts sitting in browser storage - on a machine that may be shared, or may not
// belong to the org at all. Signing out used to end the session and leave every byte of that behind.
//
// Two properties, both of which need a real browser to check: the cache genuinely fills during use, and
// signing out genuinely empties it.

/** Everything the app owns in this browser: the record store's database, plus its localStorage keys. */
const storedState = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const databases = (await indexedDB.databases?.()) ?? [];
    const rows = await new Promise<number>((resolve) => {
      const req = indexedDB.open("hrms");
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) return resolve(0);
        const all = db.transaction("meta", "readonly").objectStore("meta").getAll();
        all.onsuccess = () => resolve((all.result as unknown[]).length);
        all.onerror = () => resolve(0);
      };
      req.onerror = () => resolve(0);
    });
    return {
      dbNames: databases.map((d) => d.name).filter(Boolean) as string[],
      records: rows,
      localKeys: Object.keys(localStorage),
      sessionKeys: Object.keys(sessionStorage),
    };
  });

test("caches what it reads, then takes it off the machine on sign-out", async ({ as }) => {
  const page = await as("super");
  // Two pages, so several collections are read and stored: the directory is the heaviest thing the app caches
  // and the one a reload most wants back.
  await gotoRoute(page, "dashboard");
  await gotoRoute(page, "employees");
  await expect(page.getByRole("heading", { name: /directory/i })).toBeVisible();

  // The cache fills. Records are written on an idle callback, and the reconciliation point is written only once
  // `GET /v1/changes` answers, so poll for BOTH rather than assume either one's timing - asserting the sync key
  // off a single read of the state was a rotating flake, since a busy stack can land the change feed after the
  // records.
  await expect
    .poll(async () => {
      const s = await storedState(page);
      return s.records > 0 && s.localKeys.some((k) => k.startsWith("hrms.sync:")); // the reconciliation point
    }, { timeout: 20_000 })
    .toBe(true);

  // Two stubs, for two reasons that are both about not testing something else here.
  //
  // `/auth/logout` is stubbed because the real one stamps a session cut-off on this seeded user, which refuses
  // every OTHER spec's cookie for them - a shared-fixture landmine, and the server's revocation already has its
  // own coverage (test/googleAuth.test.ts). What is under test is what the CLIENT does before that request, and
  // it does it either way.
  await page.route("**/auth/logout", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signin_url: "/auth/login" }) }));
  // And `/auth/login`, because signing out ends by navigating to wherever signing in happens again - in Google
  // mode an external redirect. Stubbed, the browser stays on this origin, and storage is per-origin.
  await page.route("**/auth/login**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>signed out</title>" }));

  // The avatar in the top bar is the only route to sign out; its title is "<name> · <role>", which is the one
  // stable thing about it whatever the seeded person is called.
  const loggedOut = page.waitForResponse((r) => r.url().includes("/auth/logout"));
  await page.locator('button[title*="·"]').first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  // The purge is awaited BEFORE this request goes out, so a logout response means it has already happened.
  await loggedOut;
  await page.waitForURL(/\/auth\/login/, { timeout: 15_000 });
  await page.waitForLoadState("load");

  const after = await storedState(page);
  expect(after.records, "cached rows, faces and snapshots are gone").toBe(0);
  expect(after.sessionKeys, "and any in-progress drafts with them").toEqual([]);
  // The theme is the one thing kept: it is a visual preference rather than anything about the person, and
  // dropping it would flash the wrong palette at whoever signs in next.
  expect(after.localKeys.filter((k) => k !== "theme")).toEqual([]);
});
