import { SPA_HEADERS, fileLeave, gotoRoute, patchSettings, purge, test, expect, toast } from "./fixtures";

// ⌘K: the only way into a lot of this app.
//
// `test/globalSearch.test.ts` proves the server side - the FTS index, the per-collection scoping the
// middleware decides, what a given caller is allowed to match. What it cannot prove is that the keystroke
// opens anything, that typing reaches the search, that results render grouped, or that Enter lands you on
// the thing you picked. That chain is four separate pieces of browser behaviour and no other test touches
// any of it.
test.describe("global search", () => {
  test("the shortcut opens it, and Enter goes where it says", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    // ControlOrMeta so this is the same test on a mac laptop and a linux CI runner.
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");
    await expect(search).toBeVisible();

    await search.fill("vendors");
    // The palette highlights its first row; Enter takes it.
    await expect(page.getByRole("option").filter({ hasText: "Vendors" }).first()).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/vendors/);
    await expect(page.getByRole("main")).toContainText("Vendors");
  });

  test("it searches the data, not just the menu", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");
    await search.fill("Eve Employee");

    // A seeded person, found through the search index rather than the static page/action list - which is the
    // half of the palette that needs a server round trip to work at all.
    await expect(page.getByRole("option").filter({ hasText: "Eve Employee" }).first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();
  });

  test("a synonym finds what the typed word does not", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");

    // "MacBook" is on no row; the seeded "Laptop stand" reimbursement is reached only through the synonym
    // group (src/domain/searchQuery.ts).
    await search.fill("macbook");
    await expect(page.getByRole("option").filter({ hasText: "Laptop stand" }).first()).toBeVisible();
  });

  test("a long group shows its top rows, and See all narrows to that type", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");

    // The seeded letter templates are well over five, so the group is capped with a See all row.
    await search.fill("letter");
    const seeAll = page.getByRole("option").filter({ hasText: "See all letter templates" });
    await expect(seeAll).toBeVisible();
    await seeAll.click();

    // The palette stays open and re-asks the same words of that one type.
    await expect(search).toHaveValue("in:letter-templates letter");
    await expect(page.getByRole("option").filter({ hasText: "Letter template" })).not.toHaveCount(0);
    await expect(seeAll).toHaveCount(0);
    // Narrowed to one type, the rest of the app - pages, settings, people - is out of the answer.
    await expect(page.getByText("Go to", { exact: true })).toHaveCount(0);
  });

  test("a misspelt name is offered as the person it was one slip from", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");

    // "Emplyee" matches nothing - the index matches prefixes, not slips - so the palette falls back to the
    // directory it already holds.
    await search.fill("Emplyee");
    await expect(page.getByText("Did you mean", { exact: true })).toBeVisible();
    await expect(page.getByRole("option").filter({ hasText: "Eve Employee" }).first()).toBeVisible();
  });

  test("a search that led somewhere is offered again on the empty box", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    const search = page.getByPlaceholder("Search people, records, pages and settings…");
    await page.keyboard.press("ControlOrMeta+k");
    await search.fill("vendors");
    await page.getByRole("option").filter({ hasText: "Vendors" }).first().click();
    await expect(page).toHaveURL(/\/vendors/);

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByText("Recent searches", { exact: true })).toBeVisible();
    await page.getByRole("group", { name: "Recent searches" }).getByRole("option", { name: /vendors/i }).click();
    await expect(search).toHaveValue("vendors");
  });

  test("a board task is found by its key", async ({ as }) => {
    const page = await as("super");
    const stamp = Date.now();
    const prefix = `K${String(stamp).slice(-4)}`;
    const board = (await (await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E key board ${stamp}`, task_prefix: prefix } })).json()) as { path: string };
    const card = (await (await page.request.post("/v1/cards", { headers: SPA_HEADERS, data: { board: board.path, title: `E2E keyed card ${stamp}`, column_key: "backlog" } })).json()) as { path: string; key?: string };
    try {
      expect(card.key, "the board issues keys with its prefix").toMatch(new RegExp(`^${prefix}-\\d+$`));
      await gotoRoute(page, "dashboard");
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByPlaceholder("Search people, records, pages and settings…").fill(card.key!);
      await expect(page.getByRole("option").filter({ hasText: `E2E keyed card ${stamp}` }).first()).toBeVisible();
    } finally {
      await purge(page, card.path);
      await purge(page, board.path);
    }
  });

  test("a search that finds nothing offers to raise a ticket with those words", async ({ as }) => {
    const page = await as("employee");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByPlaceholder("Search people, records, pages and settings…").fill("zqxwvk toner");
    const offer = page.getByRole("option").filter({ hasText: 'Raise a support ticket: "zqxwvk toner"' });
    await expect(offer).toBeVisible();
    await offer.click();
    await expect(page).toHaveURL(/\/tickets/);
    await expect(page.getByPlaceholder("What do you need help with?")).toHaveValue("zqxwvk toner");
  });

  test("a pending request can be approved from its result, after a confirm", async ({ as }) => {
    test.setTimeout(120_000);
    const employee = await as("employee");
    const reason = `E2E palette decide ${Date.now()}`;
    const path = await fileLeave(employee, reason);
    const hr = await as("hr");
    try {
      await gotoRoute(hr, "dashboard");
      await hr.keyboard.press("ControlOrMeta+k");
      await hr.getByPlaceholder("Search people, records, pages and settings…").fill(reason);
      // The leave request's own row - its badge says what it is. (A bare match on the reason could also hit an
      // offer that quotes the typed words back, which is how an earlier version of this test pressed Tab on
      // the wrong row.)
      const leaveRow = hr.getByRole("option").filter({ hasText: reason }).filter({ hasText: "Leave request" });
      await expect(leaveRow).toHaveCount(1, { timeout: 30_000 });
      // It is the only result, so it is the highlighted one; Tab opens its actions.
      await expect(leaveRow).toHaveAttribute("aria-selected", "true");
      await hr.keyboard.press("Tab");
      const approve = hr.getByRole("option").filter({ hasText: `Approve: ${reason}` });
      await expect(approve).toBeVisible({ timeout: 15_000 });
      await expect(hr.getByRole("option").filter({ hasText: `Reject: ${reason}` })).toBeVisible();
      await approve.click();
      // The decision asks first, exactly as the approvals page does.
      const confirmDialog = hr.getByRole("dialog").filter({ hasText: "Approve this request?" });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(toast(hr, "Approved")).toBeVisible();
      const after = (await (await employee.request.get(`/v1/${path}`)).json()) as { state?: string };
      expect(after.state).toBe("APPROVED");
    } finally {
      const sup = await as("super");
      await purge(sup, path);
    }
  });

  test("an org's own synonym, saved in Settings, is searched with", async ({ as }) => {
    const page = await as("super");
    try {
      // Arrives the way Search insights sends it: a group started for the word that found nothing.
      await gotoRoute(page, "settings/search-synonyms?add=zeusday");
      const group = page.getByRole("textbox", { name: /Synonym group/ }).last();
      await expect(group).toHaveValue("zeusday, ");
      await group.fill("zeusday, casual");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(toast(page, "Saved")).toBeVisible();

      await page.keyboard.press("ControlOrMeta+k");
      await page.getByPlaceholder("Search people, records, pages and settings…").fill("zeusday");
      // The seeded "Casual" leave type holds no such word; the org's group is what connects them.
      await expect(page.getByRole("option").filter({ hasText: "Casual" }).first()).toBeVisible();
    } finally {
      await patchSettings(page, "search-synonyms", () => ({ groups: [] }));
    }
  });

  test("status and date filters narrow the records", async ({ as }) => {
    test.setTimeout(90_000);
    const employee = await as("employee");
    const reason = `E2E filtered leave ${Date.now()}`;
    const path = await fileLeave(employee, reason);
    try {
      await gotoRoute(employee, "dashboard");
      await employee.keyboard.press("ControlOrMeta+k");
      const search = employee.getByPlaceholder("Search people, records, pages and settings…");
      const row = employee.getByRole("option").filter({ hasText: reason });
      await search.fill(`status:pending ${reason}`);
      await expect(row.first()).toBeVisible({ timeout: 30_000 });
      await search.fill(`status:approved ${reason}`);
      await expect(employee.getByText("No matches", { exact: false }).first()).toBeVisible();
      await expect(row).toHaveCount(0);
      // Filed just now, so it is inside "after last year" and outside "before last year".
      const lastYear = new Date().getUTCFullYear() - 1;
      await search.fill(`after:${lastYear}-01 ${reason}`);
      await expect(row.first()).toBeVisible();
      await search.fill(`before:${lastYear}-01 ${reason}`);
      await expect(row).toHaveCount(0);
    } finally {
      const sup = await as("super");
      await purge(sup, path);
    }
  });
});
