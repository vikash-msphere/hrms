import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Predefined ticket checklists (Settings → Tickets) - nothing in the suite has ever created one, so neither
// half of the feature has run: the admin editor (a checklist is a name plus one item per line, saved only
// once it's actually been touched) or the point of having one at all - picking it from the "Add from
// checklist…" picker seeds the new ticket's own todo list with its items, in one press instead of typing
// each one by hand.
test("a predefined checklist is edited in Settings, then seeds a new ticket's todos", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E checklist ${Date.now()}`;
  const items = ["Create email account", "Assign a laptop", "Add to payroll"];

  // This panel is a shared org catalog and the row picked below is "the last one". A half-finished row left by
  // an earlier run sits after the one this run adds and quietly becomes the row it edits, so the baseline is
  // MADE rather than assumed.
  await sweepChecklists(page);

  await gotoRoute(page, "settings/ticket-checklists");
  // The row itself is the delete button's own parent (a sibling of the name/items column, not a wrapper
  // around it) - going up from the button is the one unambiguous way to it with no name to filter on yet.
  const deleteButtons = page.getByRole("button", { name: "Delete checklist" });
  const before = await deleteButtons.count();
  await page.getByRole("button", { name: "Add checklist" }).click();
  await expect(deleteButtons).toHaveCount(before + 1, { timeout: 30_000 });
  const row = deleteButtons.last().locator("xpath=..");

  await row.getByRole("textbox").first().fill(name);
  await row.getByRole("textbox").last().fill(items.join("\n"));
  await row.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page, "Checklist saved")).toBeVisible({ timeout: 15_000 });

  let ticketPath: string | undefined;
  try {
    await gotoRoute(page, "tickets", "Support");
    const subject = `E2E checklist ticket ${Date.now()}`;
    await page.getByRole("button", { name: "New ticket" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Subject").fill(subject);
    await form.getByLabel("Category").click();
    await page.getByRole("option").first().click();

    // The template, applied: every item lands as its own todo before the ticket is ever raised.
    await form.getByText("Add from checklist…").click();
    await page.getByRole("option", { name }).click();
    for (const item of items) await expect(form.getByText(item)).toBeVisible();

    await form.getByRole("button", { name: "Raise ticket" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    const listed = await page.request.get("/v1/tickets?page_size=100");
    const { results = [] } = (await listed.json()) as { results?: { path: string; subject?: string }[] };
    const created = results.find((t) => t.subject === subject);
    expect(created, "the ticket is not in the collection").toBeTruthy();
    ticketPath = created!.path;

    // The list omits the checklist to stay cheap - the Get is what actually landed on the record, not just
    // what the dialog showed before it was sent.
    const got = await page.request.get(`/v1/${ticketPath}`);
    expect(got.status(), await got.text()).toBe(200);
    const full = (await got.json()) as { todos?: { text: string }[] };
    const todoTexts = (full.todos ?? []).map((t) => t.text);
    for (const item of items) expect(todoTexts).toContain(item);
  } finally {
    if (ticketPath) await purge(page, ticketPath);
    const listedCl = await page.request.get("/v1/ticket-checklists?page_size=100", { headers: SPA_HEADERS });
    if (listedCl.ok()) {
      const { results: cls = [] } = (await listedCl.json()) as { results?: { path: string; display_name?: string }[] };
      const cl = cls.find((c) => c.display_name === name);
      if (cl) await purge(page, cl.path);
    }
    await sweepChecklists(page);
  }
});

/** Every checklist this spec could have left behind, on the way in as well as out. */
async function sweepChecklists(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/ticket-checklists?page_size=100", { headers: SPA_HEADERS });
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; display_name?: string }[] };
  for (const c of results.filter((r) => (r.display_name ?? "").startsWith("E2E checklist") || r.display_name === "New checklist")) {
    await purge(page, c.path);
  }
}
