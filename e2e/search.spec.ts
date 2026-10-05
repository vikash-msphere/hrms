import { SPA_HEADERS, fileLeave, gotoRoute, makeThrowawayPerson, patchSettings, purge, retireThrowawayPerson, searchBox, searchPanel, searchRecordRead, test, expect, toast } from "./fixtures";

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
    const search = searchBox(page);
    await expect(search).toBeVisible();

    await search.fill("vendors");
    // The palette highlights its first row; Enter takes it.
    await expect(page.getByRole("option").filter({ hasText: "Vendors" }).first()).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/vendors/);
    await expect(page.getByRole("main")).toContainText("Vendors");
  });

  // At this project's 1440 the room between the breadcrumb and the cluster is narrower than the open field's
  // 64rem, so opening it is the crowded case (TopBar.tsx useOpenSearchFit); wide.spec.ts has the roomy one.
  test("opened where the bar is short of room, both sides fade out and the field takes the middle of the bar", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    const bar = page.getByRole("banner");
    const field = bar.locator("[data-search-field]");
    const crumb = bar.getByRole("navigation", { name: "Breadcrumb" });
    const create = bar.getByRole("button", { name: "New", exact: true });
    // The clock comes in once its fetch lands, and takes its slot out of the room - measured before that, the
    // field is wider than it will be a moment later.
    await expect(bar.getByRole("button", { name: /^Clock (in|out)/ })).toBeVisible();
    await expect(field).toBeVisible();
    const before = (await field.boundingBox())!;
    expect(before.width, "the crowded case needs a room narrower than the open field").toBeLessThan(1024);

    await page.keyboard.press("ControlOrMeta+k");
    // Both sides go together, not just the one it reached first.
    await expect(crumb).toBeHidden();
    await expect(create).toBeHidden();
    // With the bar to itself, the field sits in the middle of the BAR (inside its padding) - not of the room
    // between the breadcrumb and the clock, which is off to one side - and is as wide as its cap allows here.
    const middle = await bar.evaluate((h) => {
      const r = h.getBoundingClientRect();
      const s = getComputedStyle(h);
      return (r.left + parseFloat(s.paddingLeft) + r.right - parseFloat(s.paddingRight)) / 2;
    });
    await expect.poll(async () => {
      const b = (await field.boundingBox())!;
      return Math.round(b.x + b.width / 2 - middle);
    }, { message: "centred on the bar" }).toBe(0);
    expect(Math.round((await field.boundingBox())!.width)).toBe(1024);

    // Closed, the bar is as it was, the field back in its place.
    await page.keyboard.press("Escape");
    await expect(crumb).toBeVisible();
    await expect(create).toBeVisible();
    await expect.poll(async () => Math.round((await field.boundingBox())?.x ?? 0)).toBe(Math.round(before.x));
    await expect.poll(async () => Math.round((await field.boundingBox())?.width ?? 0)).toBe(Math.round(before.width));
  });

  test("it searches the data, not just the menu", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");

    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);
    await search.fill("Eve Employee");

    // A seeded person, found through the search index rather than the static page/action list - which is the
    // half of the palette that needs a server round trip to work at all.
    await expect(page.getByRole("option").filter({ hasText: "Eve Employee" }).first()).toBeVisible();

    // Escape puts the results away - the palette closes, or the top bar field's drop-down folds.
    await page.keyboard.press("Escape");
    await expect(searchPanel(page)).toHaveCount(0);
  });

  test("a synonym finds what the typed word does not", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);

    // "MacBook" is on no row; the seeded "Laptop stand" reimbursement is reached only through the synonym
    // group (src/domain/searchQuery.ts).
    await search.fill("macbook");
    await expect(page.getByRole("option").filter({ hasText: "Laptop stand" }).first()).toBeVisible();
  });

  test("a long group shows its top rows, and See all narrows to that type", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);

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
    await expect(page.getByRole("group", { name: "Pages" })).toHaveCount(0);
  });

  test("a category chip narrows the search to its kind, and pressing it again goes back to all", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const panel = searchPanel(page);
    const chip = (name: string) => panel.getByRole("button", { name: new RegExp(`^${name}( \\d+)?$`) });

    // The categories are there before anything is typed, in their fixed order, All on.
    await expect(chip("All")).toHaveAttribute("aria-pressed", "true");
    await expect(chip("Docs")).toBeVisible();

    // The seeded letter templates are well over five, so under All the group is capped with a See all row,
    // and Pages has the Letters page and its settings for the same word.
    await searchBox(page).fill("letter");
    const seeAll = page.getByRole("option").filter({ hasText: "See all letter templates" });
    await expect(seeAll).toBeVisible({ timeout: 30_000 });
    await expect(chip("Docs")).toHaveAccessibleName(/^Docs \d+$/);

    // Docs asks the server for that kind alone - every docs collection, not the letter templates the mixed
    // answer happened to hold - so the group comes back whole, and nothing that is not a doc is listed.
    const narrowed = page.waitForRequest((r) => r.url().includes("/search?") && decodeURIComponent(r.url()).includes("letter-templates") && r.url().includes("in="));
    await chip("Docs").click();
    await narrowed;
    await expect(chip("Docs")).toHaveAttribute("aria-pressed", "true");
    await expect(seeAll).toHaveCount(0);
    expect(await page.getByRole("option").filter({ hasText: "Letter template" }).count()).toBeGreaterThan(5);
    await expect(panel.getByRole("group", { name: "Pages" })).toHaveCount(0);
    // The box keeps only what was typed: a chip is not written into it.
    await expect(searchBox(page)).toHaveValue("letter");

    // Pressed again, it lets go: back to All, capped group and all.
    await chip("Docs").click();
    await expect(chip("All")).toHaveAttribute("aria-pressed", "true");
    await expect(seeAll).toBeVisible();
  });

  test("the Filters menu narrows by whose and when, shows each as a pill, and a pill's x takes it off", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const panel = searchPanel(page);
    await searchBox(page).fill("leave");

    // Mine, from the menu: the request carries it, and the pill says it is on.
    const mine = page.waitForRequest((r) => r.url().includes("/search?") && r.url().includes("mine=1"));
    await panel.getByRole("button", { name: /^Filters/ }).click();
    await page.getByRole("menuitemradio", { name: "Mine" }).click();
    await mine;
    const pill = panel.getByRole("button", { name: "Remove filter: Mine" });
    await expect(pill).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Filters 1/ })).toBeVisible();
    // Typing goes on in the box: the menu hands the focus back to it.
    await expect(searchBox(page)).toBeFocused();
    await expect(searchBox(page)).toHaveValue("leave");

    // The pill's x takes it off again.
    await pill.click();
    await expect(pill).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /^Filters$/ })).toBeVisible();
  });

  test("a misspelt name is offered as the person it was one slip from", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);

    // "Emplyee" matches nothing - the index matches prefixes, not slips - so the palette falls back to the
    // directory it already holds.
    await search.fill("Emplyee");
    await expect(page.getByText("Did you mean", { exact: true })).toBeVisible();
    await expect(page.getByRole("option").filter({ hasText: "Eve Employee" }).first()).toBeVisible();
  });

  test("a search that led somewhere is offered again on the empty box", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    const search = searchBox(page);
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
      // The lit card is read for the preview; let that land before the card is purged below.
      const read = searchRecordRead(page, "cards");
      await searchBox(page).fill(card.key!);
      await expect(page.getByRole("option").filter({ hasText: `E2E keyed card ${stamp}` }).first()).toBeVisible();
      await read;
    } finally {
      await purge(page, card.path);
      await purge(page, board.path);
    }
  });

  test("a search that finds nothing offers to raise a ticket with those words", async ({ as }) => {
    const page = await as("employee");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    await searchBox(page).fill("zqxwvk toner");
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
      await searchBox(hr).fill(reason);
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

  test("the lit result's record shows beside the list, and it can be decided from its own row", async ({ as }) => {
    test.setTimeout(120_000);
    const employee = await as("employee");
    const reason = `E2E palette preview ${Date.now()}`;
    const path = await fileLeave(employee, reason);
    const hr = await as("hr");
    try {
      await gotoRoute(hr, "dashboard");
      await hr.keyboard.press("ControlOrMeta+k");
      await searchBox(hr).fill(reason);
      const leaveRow = hr.getByRole("option").filter({ hasText: reason }).filter({ hasText: "Leave request" });
      await expect(leaveRow).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });

      // The preview: what the record is, without opening it - its status in words, whose it is, its text.
      const preview = hr.getByRole("complementary", { name: "Preview" });
      await expect(preview).toContainText("Pending", { timeout: 15_000 });
      await expect(preview).toContainText("Person");
      await expect(preview).toContainText(reason);

      // Its decisions on the row itself (for a pointer; Tab is the keyboard's way to the same ones), asked first.
      const reject = leaveRow.locator("xpath=..").locator("button", { hasText: "Reject" });
      await expect(reject).toBeVisible();
      await reject.click();
      const confirmDialog = hr.getByRole("dialog").filter({ hasText: /Reject this/ });
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.getByRole("button", { name: "Reject", exact: true }).click();
      await expect(toast(hr, "Rejected")).toBeVisible();
      const after = (await (await employee.request.get(`/v1/${path}`)).json()) as { state?: string };
      expect(after.state).toBe("REJECTED");
    } finally {
      const sup = await as("super");
      await purge(sup, path);
    }
  });

  test("with a category on, the other categories keep counting as the words change", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const panel = searchPanel(page);
    const chip = (name: string) => panel.getByRole("button", { name: new RegExp(`^${name}( \\d+)?$`) });
    await searchBox(page).fill("leave");
    await chip("Time").click();
    await expect(chip("Time")).toHaveAttribute("aria-pressed", "true");
    // New words with Time still on: the other chips are counted against these words too, not left blank.
    await searchBox(page).fill("leave types");
    await expect(chip("Docs")).toHaveAccessibleName(/^Docs \d+$/, { timeout: 30_000 });
    await expect(chip("People")).toHaveAccessibleName(/^People \d+$/);
  });

  test("newest first, the records group by when rather than by kind", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const panel = searchPanel(page);
    // The seeded letter templates: records, and plenty of them, grouped by kind under best match.
    await searchBox(page).fill("letter");
    await expect(panel.getByRole("group", { name: "Letter templates" })).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: /^Filters/ }).click();
    await page.getByRole("menuitemradio", { name: "Newest first" }).click();
    // A seeded row may carry no creation time at all, which is its own group.
    await expect(panel.getByRole("group", { name: /^(Today|Yesterday|This week|This month|Earlier|Date unknown)$/ }).first()).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("group", { name: "Letter templates" })).toHaveCount(0);
  });

  test("a saved search waits in the Saved menu, comes back from it, pins to the chip row, and can be removed", async ({ as }) => {
    const page = await as("super");
    try {
      await gotoRoute(page, "dashboard");
      await page.keyboard.press("ControlOrMeta+k");
      const panel = searchPanel(page);
      const search = searchBox(page);
      await search.fill("in:leave-requests ");

      // Filters → Save this search…: the name field takes the chip row, offering the search's own words.
      await panel.getByRole("button", { name: /^Filters/ }).click();
      await page.getByRole("menuitem", { name: "Save this search…" }).click();
      const name = panel.getByLabel("Save as");
      await expect(name).toBeFocused();
      await expect(name).toHaveValue("Leave requests");
      await name.fill("E2E my leave");
      await name.press("Enter");

      // Saved, not pinned: it is in the Saved menu, not in the chip row.
      const chip = panel.getByRole("button", { name: "E2E my leave", exact: true });
      await expect(toast(page, 'Saved "E2E my leave"')).toBeVisible();
      await expect(chip).toHaveCount(0);
      const savedMenu = panel.getByRole("button", { name: /^Saved \d+$/ });
      await search.fill("vendors");
      await savedMenu.click();
      // From the menu, pressing it puts the whole search back.
      await page.getByRole("menuitem", { name: "E2E my leave", exact: true }).click();
      await expect(search).toHaveValue("in:leave-requests ");

      // Pinned, it takes a chip at the front of the row, which runs it too.
      await savedMenu.click();
      await page.getByRole("menuitem", { name: "Pin E2E my leave" }).click();
      await expect(page.getByRole("menuitem", { name: "Unpin E2E my leave" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(chip).toBeVisible();
      await search.fill("vendors");
      await chip.click();
      await expect(search).toHaveValue("in:leave-requests ");

      // Removing it asks first, as every delete does - and takes the chip with it.
      await panel.getByRole("button", { name: "Options for E2E my leave" }).click();
      await page.getByRole("menuitem", { name: "Remove" }).click();
      const confirmDialog = page.getByRole("dialog").filter({ hasText: 'Remove "E2E my leave"?' });
      await confirmDialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(chip).toHaveCount(0);
      await expect(savedMenu).toHaveCount(0);
    } finally {
      // The super login is shared: leave its saved searches as they were found (none).
      await page.request.patch("/v1/preferences/saved_searches", { headers: SPA_HEADERS, data: { value: { searches: [] } } });
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
      await searchBox(page).fill("zeusday");
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
      const search = searchBox(employee);
      // The leave itself - not the "Search everything for ..." row a filter that finds nothing offers, which
      // carries the same words.
      const row = employee.getByRole("option").filter({ hasText: reason }).filter({ hasNotText: "Search everything" });
      await search.fill(`status:pending ${reason}`);
      await expect(row.first()).toBeVisible({ timeout: 30_000 });
      await search.fill(`status:approved ${reason}`);
      // Narrowed to nothing, the list offers the way out rather than a bare "No matches".
      await expect(employee.getByRole("option").filter({ hasText: `Search everything for "${reason}"` })).toBeVisible();
      await expect(row).toHaveCount(0);
      // Filed just now, so it is inside "after last year" and outside "before last year".
      const lastYear = new Date().getUTCFullYear() - 1;
      await search.fill(`after:${lastYear}-01 ${reason}`);
      await expect(row.first()).toBeVisible();
      await search.fill(`before:${lastYear}-01 ${reason}`);
      await expect(row).toHaveCount(0);
      // Relative days count back from the org's today, and on: is that one day.
      await search.fill(`after:7d ${reason}`);
      await expect(row.first()).toBeVisible();
      await search.fill(`on:today ${reason}`);
      await expect(row.first()).toBeVisible();
      await search.fill(`on:yesterday ${reason}`);
      await expect(row).toHaveCount(0);
      // An exclusion leaves out exactly what the plain filter keeps.
      await search.fill(`-status:pending ${reason}`);
      await expect(row).toHaveCount(0);
      await search.fill(`-in:holidays ${reason}`);
      await expect(row.first()).toBeVisible();
      // Filters with no words list the newest records they name. Not necessarily THIS one: the employee fixture
      // is shared, and other workers file pending leave as the same person while this runs, so the newest few can
      // all be theirs. That the query answers with records at all is the claim; the words above pinned ours.
      await search.fill("in:leave-requests status:pending");
      await expect(employee.getByRole("option").filter({ hasText: /pending/i }).first()).toBeVisible({ timeout: 30_000 });
      await expect(employee.getByText("No matches", { exact: false })).toHaveCount(0);
    } finally {
      const sup = await as("super");
      await purge(sup, path);
    }
  });

  test("filter words complete from what the caller can search", async ({ as }) => {
    const employee = await as("employee");
    await gotoRoute(employee, "dashboard");
    await employee.keyboard.press("ControlOrMeta+k");
    const search = searchBox(employee);
    // While a filter word is typed, the chip row turns into what can come after it.
    const suggestions = employee.getByRole("listbox", { name: /suggestions$/ });

    // status: offers the values the caller's own collections hold (GET /v1/search:vocabulary), in plain words;
    // Tab takes the lit one and leaves the caret after it.
    await search.fill("status:pen");
    await expect(suggestions.getByRole("option").first()).toHaveText("Pending");
    await expect(suggestions.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await employee.keyboard.press("Tab");
    await expect(search).toHaveValue("status:pending ");
    // The word taken is a pill now, saying what it means.
    await expect(employee.getByRole("button", { name: "Remove filter: Status: Pending" })).toBeVisible();

    // in: offers collections by name; picking one with the pointer keeps the box focused for the next word.
    await search.pressSequentially("in:leave");
    await suggestions.getByRole("option", { name: "Leave requests" }).click();
    await expect(search).toHaveValue("status:pending in:leave-requests ");
    await expect(search).toBeFocused();

    // → at the end of the text walks the suggestions, and Enter takes the one it walked to.
    await search.pressSequentially("in:");
    // The kinds re-rank once their totals land (biggest first), so read them after that, not before.
    await expect(suggestions.getByRole("option").first()).toHaveText(/\d\+?$/);
    const second = suggestions.getByRole("option").nth(1);
    // The chip's text ends in its count; the pill names the kind alone.
    const secondName = ((await second.textContent()) ?? "").trim().replace(/\s*[\d,]+\+?$/, "");
    await employee.keyboard.press("ArrowRight");
    await expect(second).toHaveAttribute("aria-selected", "true");
    await employee.keyboard.press("Enter");
    await expect(employee.getByRole("button", { name: `Remove filter: ${secondName}` })).toBeVisible();

    // A pill's x takes its word back out of the box.
    await employee.getByRole("button", { name: "Remove filter: Status: Pending" }).click();
    await expect(search).not.toHaveValue(/status:pending/);

    // A word typed out in full offers nothing, so Enter is left to open a result.
    await search.pressSequentially("is:mine");
    await expect(suggestions).toHaveCount(0);
  });

  test("filter words are styled in the box, lined up with the text, and one that names nothing is flagged", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);
    const query = "laptop in:leeve in:leave-requests is:mine";
    await search.fill(query);
    // A space typed after the last word, so nothing is mid-completion and every filter word is drawn.
    await search.press("End");
    await search.pressSequentially(" ");

    const layer = page.locator("[data-query-highlight]");
    await expect(layer).toHaveCount(1);
    // Lined up: the drawn text is as wide as the input's own text in the input's own font - a layer whose
    // glyphs drift would leave the caret beside the letters instead of on them.
    const widths = await search.evaluate((input: HTMLInputElement) => {
      const drawn = input.parentElement!.querySelector("[data-query-highlight] > div")!;
      const range = document.createRange();
      range.selectNodeContents(drawn);
      const ctx = document.createElement("canvas").getContext("2d")!;
      // From its parts: Chrome serialises the `font` shorthand as "" when it cannot express every part.
      const cs = getComputedStyle(input);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      // And one pill in the middle starts where its word does.
      const word = "in:leave-requests";
      const pill = Array.from(drawn.children).find((s) => s.textContent === word)!;
      return {
        drawn: range.getBoundingClientRect().width,
        typed: ctx.measureText(input.value).width,
        pillAt: pill.getBoundingClientRect().left - drawn.getBoundingClientRect().left,
        wordAt: ctx.measureText(input.value.slice(0, input.value.indexOf(word))).width,
      };
    });
    expect(Math.abs(widths.drawn - widths.typed)).toBeLessThanOrEqual(1);
    expect(Math.abs(widths.pillAt - widths.wordAt)).toBeLessThanOrEqual(1);

    // `in:leeve` names no kind of record: its pill says so; the good words' pills do not.
    const bad = searchPanel(page).getByRole("button", { name: "Remove filter: Leeve" }).locator("..");
    await expect(bad).toHaveAttribute("title", /No kind of record/);
    await expect(searchPanel(page).getByRole("button", { name: "Remove filter: Leave requests" }).locator("..")).not.toHaveAttribute("title", /./);
  });

  test("the kinds after in: come ranked: somebody's records before catalogs, then what this person picks, then the page", async ({ as }) => {
    // A throwaway person: picking a kind is remembered in their own preferences row, which must not be a
    // seeded login's that another worker is ranking with at the same moment.
    const admin = await as("super");
    const person = await makeThrowawayPerson(admin, "Kinds");
    try {
      const page = await as({ email: person.email });
      await gotoRoute(page, "dashboard");
      const search = searchBox(page);
      const kinds = page.getByRole("listbox", { name: "Kind suggestions" }).getByRole("option");
      // A chip's name is its label, then its count when it has one ("Tickets 3").
      const names = async () => (await kinds.allTextContents()).map((t) => t.trim().replace(/\s+[\d,]+\+?$/, ""));
      const openIn = async () => {
        await page.keyboard.press("ControlOrMeta+k");
        await search.fill("in:");
        await expect(kinds.first()).toBeVisible();
      };

      // A bare `in:` on a page that shows no kind: the person's records (their tickets and leave, the
      // directory) before the org's catalogs (holidays) and their own inbox (notifications), however many
      // rows those hold.
      const totals = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/search:counts");
      await openIn();
      expect((await totals).status()).toBe(200);
      const bare = await names();
      const at = (label: string) => {
        expect(bare, label).toContain(label);
        return bare.indexOf(label);
      };
      for (const record of ["Tickets", "Leave requests", "Employees"]) {
        for (const reference of ["Holidays", "Notifications"]) expect(at(record), `${record} before ${reference}`).toBeLessThan(at(reference));
      }

      // Picking a kind is remembered: next time it comes first, catalog or not.
      await kinds.filter({ hasText: /^Holidays(\s|$)/ }).click();
      await expect(search).toHaveValue("in:holidays ");
      await page.keyboard.press("Escape");
      await openIn();
      await expect(kinds.first()).toHaveText(/^Holidays(\s+[\d,]+)?$/);

      // The page the search is opened from comes before even that.
      await page.keyboard.press("Escape");
      await gotoRoute(page, "tickets");
      await openIn();
      await expect(kinds.first()).toHaveText(/^Tickets(\s+[\d,]+)?$/);
    } finally {
      await retireThrowawayPerson(admin, person.path);
    }
  });

  test("with words, the kinds after in: lead with where those words' results are, each with its count", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);
    const kinds = page.getByRole("listbox", { name: "Kind suggestions" }).getByRole("option");
    const countsOf = async () =>
      (await kinds.allTextContents()).map((t) => /([\d,]+)\+?$/.exec(t.trim())?.[1]).filter((n): n is string => !!n).map((n) => Number(n.replace(/,/g, "")));

    // How many of THEIR results are of each kind - "letter" finds letter templates above all. Every kind with a
    // result comes before every kind without one.
    await search.fill("letter in:");
    await expect(kinds.first()).toHaveText(/^Letter templates [\d,]+\+?$/, { timeout: 30_000 });
    const worded = await countsOf();
    const found = worded.filter((n) => n > 0);
    expect(worded.slice(0, found.length)).toEqual(found);
    expect(found).toEqual([...found].sort((a, b) => b - a));
  });

  test("a kind goes in the box under the name the app shows for it", async ({ as }) => {
    // Super, who can search board tasks (the employee fixture's first "tas" kind is transition tasks).
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);
    // Board tasks are `tasks` in the box - never the wire name `cards`, a word the app shows nowhere else -
    // whether picked from the suggestions or typed out in full.
    await search.fill("in:tas");
    await page.getByRole("listbox", { name: "Kind suggestions" }).getByRole("option", { name: "Tasks", exact: true }).click();
    await expect(search).toHaveValue("in:tasks ");
    // Typed out in full it is left as typed, and read as the kind it names.
    await search.fill("in:tasks ");
    await expect(page.getByRole("button", { name: "Remove filter: Tasks" })).toBeVisible();
    await expect(search).toHaveValue("in:tasks ");
  });

  test("a lone filter word offers its values and still shows the catalogue under them", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    // `in:` names nothing yet, so it is not searched: the empty-box catalogue stays, and the chip row offers
    // the kinds of record that can come after it.
    await searchBox(page).fill("in:");
    await expect(page.getByRole("listbox", { name: "Kind suggestions" }).getByRole("option").first()).toBeVisible();
    await expect(searchPanel(page).getByRole("group", { name: "Pages" })).toBeVisible();
  });

  test("filters that leave nothing offer to search everything instead, keeping the words", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);
    // Vendors are not holidays: narrowed to holidays, "vendors" finds nothing.
    await search.fill("in:holidays vendors");
    const widen = page.getByRole("option").filter({ hasText: 'Search everything for "vendors"' });
    await expect(widen).toBeVisible({ timeout: 30_000 });
    await expect(widen).toContainText("Without Holidays");
    await widen.click();
    await expect(search).toHaveValue("vendors");
    await expect(page.getByRole("option").filter({ hasText: "Vendors" }).first()).toBeVisible();
  });

  test("↑ in the empty box brings back the last search, and ⌘-click opens a result in a new tab", async ({ as }) => {
    const page = await as("super");
    await gotoRoute(page, "dashboard");
    await page.keyboard.press("ControlOrMeta+k");
    const search = searchBox(page);
    // A search that led somewhere is remembered.
    await search.fill("vendors");
    await page.getByRole("option").filter({ hasText: "Vendors" }).first().click();
    await expect(page).toHaveURL(/\/vendors/);

    await page.keyboard.press("ControlOrMeta+k");
    await expect(search).toHaveValue("");
    await search.press("ArrowUp");
    await expect(search).toHaveValue("vendors");

    // ⌘/Ctrl-click: a new tab on the result's own address, and the search stays open behind it.
    const opened = page.context().waitForEvent("page");
    await page.getByRole("option").filter({ hasText: "Vendors" }).first().click({ modifiers: ["ControlOrMeta"] });
    const tab = await opened;
    await expect(tab).toHaveURL(/\/vendors/);
    await tab.close();
    await expect(searchPanel(page)).toBeVisible();
  });

  test("? lists every filter, and taking one hands over to its own completions", async ({ as }) => {
    const employee = await as("employee");
    await gotoRoute(employee, "dashboard");
    await employee.keyboard.press("ControlOrMeta+k");
    const search = searchBox(employee);
    const filters = employee.getByRole("group", { name: "Filters" });

    // The hint bar's "all filters" opens the same guide typing `?` does.
    await employee.getByRole("button", { name: "? all filters" }).click();
    await expect(search).toHaveValue("?");
    await expect(search).toBeFocused();
    // Leaving out is one rule, first in the list, and each filter that has a - form shows it.
    await expect(filters.getByRole("option").first()).toContainText("put - in front of it");
    await expect(filters.getByRole("option").filter({ hasText: "leave out with -status:rejected" })).toBeVisible();

    // Taking the rule leaves a lone -, which offers the filters it turns round.
    await filters.getByRole("option").first().click();
    await expect(search).toHaveValue("-");
    await expect(filters.getByRole("option").filter({ hasText: "-is:mine" })).toBeVisible();
    await search.fill("?");

    // Picking a key leaves it open, with the caret after it, so its values are offered next - as chips.
    // By its example: hasText is a substring, and "Records in one status" is inside "Leave out records in one status".
    await filters.getByRole("option").filter({ hasText: "status:pending" }).click();
    await expect(search).toHaveValue("status:");
    await expect(employee.getByRole("listbox", { name: "Status suggestions" }).getByRole("option", { name: "Pending" })).toBeVisible();
  });
});
