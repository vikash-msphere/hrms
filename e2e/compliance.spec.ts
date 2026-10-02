import { confirmDelete, gotoRoute, inDays, purge, expect, test, toast } from "./fixtures";

// The compliance calendar: statutory obligations with dates that must not be missed.
//
// The page is a calendar, and that is the point - an obligation is only useful if it can be SEEN against the
// month it falls in, and filed once it is done. `test/complianceRecurrence.test.ts` owns the recurrence
// arithmetic. What only a browser shows is the month view drawing the item on its day, and the two ways an
// item leaves the outstanding count: filed (the quick "Mark filed" row action - the one this spec's own name
// always claimed to cover but never pressed) and waived (a status only reachable through the full edit form,
// for the N/A case a filing genuinely does not apply to).
test("a compliance item is added, shows on the calendar, and is filed - and a second is waived", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const title = `E2E filing ${Date.now()}`;
  const waivedTitle = `E2E waived ${Date.now()}`;
  const due = inDays(10);

  await gotoRoute(page, "compliance", "Compliance Calendar");
  await page.getByRole("button", { name: "Add item" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Obligation").fill(title);
  await form.getByLabel(/Authority/).fill("EPFO");
  await form.getByLabel("Due date").fill(due);
  await form.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // On the page, with its date - the thing a compliance officer reads the calendar for.
  await expect(page.getByText(title).first()).toBeVisible();

  // Filed: the quick row action, not the edit form's own Status field - a different code path
  // (`markFiled`'s plain PATCH) from the one below.
  const row = page.locator("tbody tr").filter({ hasText: title });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await rowAction(page, row, "Mark filed");
  await expect(toast(page, "Marked filed")).toBeVisible({ timeout: 30_000 });
  // Server-side auto-stamps today's filed_date when none is sent, so the badge reads "Filed <date>" - with a
  // leading space in the DOM (the icon and the text are siblings: `<Check/> Filed{date}`), which
  // `getByText`'s whitespace normalization collapses but does not trim, so an anchored `/^Filed/` never
  // matches the badge itself. Unanchored, since this only cares that the word appears.
  await expect(row.getByText(/Filed/)).toBeVisible({ timeout: 30_000 });
  // Filed, so there is nothing left to file again - the quick action is gone from the menu.
  await row.getByRole("button", { name: "Actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Mark filed" })).toHaveCount(0);
  // A reload, not an in-page dismissal: Escape, an outside click and re-pressing the trigger have each in turn
  // proven unreliable at actually closing this specific menu (a still-open "Actions" menu then blocks every
  // click below it, including "Add item"), for reasons that never pinned down to one root cause. A reload is
  // unconditional - there is no state in which it leaves a menu open - and everything already asserted about
  // this row (filed, no "Mark filed" left) lives on the server, not in the still-open menu.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(row.getByText(/Filed/)).toBeVisible({ timeout: 30_000 });

  // Waived: an obligation that turned out not to apply - only reachable by editing the record, since it is a
  // judgement call rather than a one-click "done".
  await page.getByRole("button", { name: "Add item" }).first().click();
  const waivedForm = page.getByRole("dialog");
  await waivedForm.getByLabel("Obligation").fill(waivedTitle);
  await waivedForm.getByLabel(/Authority/).fill("ESIC");
  await waivedForm.getByLabel("Due date").fill(inDays(11));
  await waivedForm.getByRole("button", { name: "Add item", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const waivedRow = page.locator("tbody tr").filter({ hasText: waivedTitle });
  await expect(waivedRow).toBeVisible({ timeout: 30_000 });
  await rowAction(page, waivedRow, "Edit");
  const editDialog = page.getByRole("dialog");
  await editDialog.getByLabel("Status").click();
  await page.getByRole("option", { name: "Waived / N/A" }).click();
  await editDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(waivedRow.getByText("Waived", { exact: true })).toBeVisible({ timeout: 30_000 });

  // Deleting the waived item - a soft delete (`useSoftDelete`): it asks first, and no success toast of its
  // own beyond the shared one; never pressed by any compliance spec before this. Doubles as this item's own
  // cleanup.
  await rowAction(page, waivedRow, "Delete");
  await confirmDelete(page);
  await expect(toast(page, "Compliance event deleted")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("tbody tr").filter({ hasText: waivedTitle })).toHaveCount(0, { timeout: 30_000 });

  await purge(page, await eventPath(page, title));
});

/**
 * Choose one of a row's actions: open its menu, then take the item by KEYBOARD.
 *
 * A pointer press needs the item on screen, and the menu is drawn next to its row - which other specs move,
 * as the compliance items they add (a recurring rule fills the calendar with a dozen) arrive in the list above
 * it. The menu follows its row off the bottom of the window, and a fixed-position menu is not something
 * scrolling can bring back, so the press waited out its whole timeout on a menu that was open and correct.
 * Focus and Enter is how a keyboard user takes the same item, and it does not care where the menu is drawn.
 */
async function rowAction(page: import("@playwright/test").Page, row: import("@playwright/test").Locator, name: string) {
  await row.getByRole("button", { name: "Actions" }).click();
  const item = page.getByRole("menuitem", { name, exact: true });
  await item.focus();
  await page.keyboard.press("Enter");
}

/** The wire path of the compliance item this spec added - every page, since other specs add items too. */
async function eventPath(page: import("@playwright/test").Page, title: string): Promise<string> {
  let token: string | undefined;
  do {
    const res = await page.request.get(`/v1/compliance-events?max_page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { results?: { path: string; title?: string; display_name?: string }[]; next_page_token?: string };
    const row = (body.results ?? []).find((e) => (e.title ?? e.display_name) === title);
    if (row) return row.path;
    token = body.next_page_token;
  } while (token);
  throw new Error(`e2e: the compliance item "${title}" is not in the collection`);
}
