import { gotoRoute, personId, purge, test, expect, toast } from "./fixtures";

// Praising a colleague, from anywhere in the app.
//
// Kudos is deliberately not a page you have to find: it is a button in the top bar, always visible to
// anybody who holds the verb, and pressing it takes you to the board with the composer already in kudos
// mode. That hand-off - a global action that navigates AND hands the destination an intent it picks up on
// mount - is the browser-only half (`quickCreate` pins the same mechanism for the "+" menu). `test/kudos.ts`
// owns the points and the wall.
test("kudos is given from the top bar and lands on the board", async ({ as }) => {
  const giver = await as("hr");
  const message = `E2E kudos ${Date.now()}`;

  await gotoRoute(giver, "dashboard");

  // The top-bar button, from a page that has nothing to do with the board.
  await giver.getByRole("button", { name: "Give kudos" }).click();

  // It navigated to the board AND opened the composer in kudos mode - the intent survived the navigation.
  const form = giver.getByRole("dialog");
  await expect(form.getByRole("heading", { name: /kudos/i })).toBeVisible();

  // The recipient picker: named by its own placeholder rather than by the field label, because the "To"
  // field also holds the colleague/team switch and so has no single control to bind a label to.
  await form.getByRole("button", { name: "Select a colleague…" }).click();
  await giver.getByPlaceholder("Search colleagues…").fill("Eve");
  await expect(giver.getByRole("option", { name: /Eve Employee/ })).toBeVisible();
  await giver.keyboard.press("Enter");
  // The message box sits under a formatting toolbar, so the field's label has no single control to bind to;
  // the textarea is the only one in the dialog.
  await form.locator("textarea").first().fill(message);
  await form.getByRole("button", { name: "Send kudos" }).click();
  await expect(toast(giver, /Kudos sent/)).toBeVisible();

  // On the wall, naming who it is for.
  const card = giver.locator("div.shadow-card").filter({ hasText: message }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Eve Employee");

  await purge(giver, await kudosPath(giver, message));
});

// The same hand-off, from a person's own profile - where the recipient is already in hand. The top-bar
// button opens the composer on an empty picker; this one carries WHO in the intent, so the praise starts
// written rather than starting with a search for somebody you are already looking at. Scoped to <main>
// because the top-bar button is on this page too and answers to the same name.
test("kudos given from a profile arrives with that person already filled in", async ({ as }) => {
  const giver = await as("hr");
  const eve = await personId(giver, "employee");

  await gotoRoute(giver, `employees/${eve}`);
  // "Kudos" on the record page, not "Give kudos": the header's action row is a set of short labels sharing
  // one width (Kudos / Emergency / Org chart), and the verb is in the tooltip.
  await giver.getByRole("main").getByRole("button", { name: "Kudos", exact: true }).click();

  const form = giver.getByRole("dialog");
  await expect(form.getByRole("heading", { name: /kudos/i })).toBeVisible();
  // The picker shows the person instead of its "Select a colleague…" placeholder: the intent survived the
  // navigation carrying the employee path, and the composer opened on it.
  await expect(form.getByRole("button", { name: /Eve Employee/ })).toBeVisible();
});

/** The wire path of the kudo this spec gave. */
async function kudosPath(page: import("@playwright/test").Page, message: string): Promise<string> {
  const res = await page.request.get("/v1/announcements?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; body?: string }[] };
  const row = results.find((a) => (a.body ?? "").includes(message));
  if (!row) throw new Error("e2e: the kudo is not on the board");
  return row.path;
}
