import { allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// Every catalog an admin has to be able to add a row to.
//
// A dozen settings panels are the same shape - a table of the org's own vocabulary (departments, leave
// types, pay components, categories, grades, structures, plans, projects) behind a create dialog. They are
// unglamorous, and that is exactly why they rot: nobody opens "Reimbursement categories" for months, and a
// panel whose dialog no longer submits is discovered by the person trying to configure the product.
//
// `everySetting` proves each panel OPENS. This proves each one still WORKS: the create button, a dialog that
// takes a name, a submit that lands a row on the table behind it - and the row gone again afterwards, so the
// spec leaves the org's vocabulary as it found it.
//
// It is one spec rather than a dozen because the failure it protects against is a whole class, not a page:
// a change to Field, WriteDialog or the collection lane breaks all of them at once, and a list here is the
// cheapest way to keep every one of them walked.
type Catalog = {
  /** `settings/<key>` - the panel's own route. */
  key: string;
  /** The panel's own <h1> (registry.ts `title`) - what `gotoRoute` waits on. Without it, a same-document hash
   *  navigation between two settings panels can resolve against the PREVIOUS panel's still-mounted <main>
   *  before the new one has actually rendered, so the very next click can land nowhere. */
  heading: string;
  /** A sub-tab to open first, where the panel holds the catalog beside other settings. */
  tab?: string;
  /** The button that opens the create dialog. */
  create: string;
  /** The field the row is named in. */
  nameField: string;
  /** Wire collection, for taking the row back out. */
  collection: string;
  /** `projects` and `benefit-plans` render their catalog as a list of Cards, not a <table> - every other
   *  panel here does. Only the delete test needs to know: it scopes to "the row" to find its own action
   *  button, and a <table>-shaped locator matches nothing on a Card-shaped page. */
  cardBased?: boolean;
};

const CATALOGS: Catalog[] = [
  { key: "departments", heading: "Departments", create: "New department", nameField: "Department name", collection: "departments" },
  { key: "leave-types", heading: "Leave types", create: "New leave type", nameField: "Name", collection: "leave-types" },
  { key: "pay-components", heading: "Pay components", create: "New component", nameField: "Name", collection: "pay-components" },
  { key: "pay-grades", heading: "Pay grades", create: "New grade", nameField: "Grade name", collection: "pay-grades" },
  { key: "salary-structures", heading: "Salary structures", create: "New structure", nameField: "Name", collection: "salary-structures" },
  { key: "projects", heading: "Projects", create: "New project", nameField: "Name", collection: "projects", cardBased: true },
  { key: "benefit-plans", heading: "Benefit plans", create: "New plan", nameField: "Name", collection: "benefit-plans", cardBased: true },
  // These three panels hold their catalog beside other settings, behind a sub-tab.
  { key: "expenses", heading: "Expenses", tab: "Categories", create: "New category", nameField: "Name", collection: "expense-categories" },
  { key: "reimbursements", heading: "Reimbursements", tab: "Categories", create: "New category", nameField: "Name", collection: "reimbursement-categories" },
  { key: "asset-tags", heading: "Asset tags", tab: "Categories", create: "New category", nameField: "Name", collection: "asset-categories" },
];

test("every catalog editor takes a new row", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  // Every catalog page in one run, back to back - on a busy lane, a dev Worker restart mid-request on any one
  // of that many navigations reads as a plain 503, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.); a genuine editor failure still fails via `failures` below.
  allowConsoleErrors(page, /status of 503/i);
  const stamp = Date.now();
  const failures: string[] = [];

  for (const cat of CATALOGS) {
    const name = `E2E ${cat.collection} ${stamp}`;
    try {
      await gotoRoute(page, `settings/${cat.key}`, cat.heading);
      if (cat.tab) await page.getByRole("tab", { name: cat.tab }).click();
      await page.getByRole("button", { name: cat.create }).first().click();
      const form = page.getByRole("dialog");
      await form.getByLabel(cat.nameField, { exact: true }).fill(name);
      await form.getByRole("button", { name: "Create", exact: true }).click();

      // Two catalogs decide how everybody's pay is BUILT (components, structures), so saving one asks
      // whether to re-solve every current employee's basic / special-allowance split. Declining leaves the
      // catalog changed and the people alone, which is the answer this spec wants.
      // Waited for rather than counted: the prompt is raised by the write's ANSWER, so it is not on screen at
      // the moment Create is pressed - and a count taken then reads zero and leaves it sitting there.
      const reapply = page.getByRole("dialog").filter({ hasText: "Re-apply the split to existing employees?" });
      const prompted = await reapply.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
      if (prompted) {
        await reapply.getByRole("button", { name: /Later|Cancel|No/ }).first().click();
      }

      // The dialog closes on a successful write and pins the reason on a failed one, so a dialog still open
      // here IS the failure - and the row lands on the table behind it.
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
      // Found by text alone, on whichever page is loaded - and these catalogs page at 100 rows client-side.
      // Under this suite's own concurrency a catalog being churned by another spec's own create/purge retry
      // loop (expenseBudgetRollForward's category, for one) can grow past that cap before this read happens,
      // pushing the row this iteration just made off the first page. "Load more" until it turns up.
      const found = page.getByText(name).first();
      await expect(async () => {
        if (await found.count()) return;
        const more = page.getByRole("button", { name: "Load more" });
        if (!(await more.count())) throw new Error(`${cat.key}: row not on any loaded page`);
        await more.click();
        await expect(found.or(more)).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 30_000 });
      await expect(found).toBeVisible({ timeout: 15_000 });
    } catch (e) {
      failures.push(`${cat.key}: ${(e as Error).message.split("\n")[0]}`);
      await page.keyboard.press("Escape");
      const discard = page.getByRole("dialog");
      if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
        await discard.getByRole("button", { name: /Discard|Leave/ }).click();
      }
    }
    // Every dialog pushes its own history entry on open and, closed normally, drops it with a REAL
    // `history.back()` (dialogHistory.ts) so the phone back-gesture still dismisses it - deferred a tick,
    // by design (the comment there: "history.back() does not pop synchronously"). Moving straight to the next
    // catalog's own `page.goto()` can race that still-pending back(): it can land after the new hash push and
    // pop THAT instead, leaving the browser wherever the stack landed (once, the settings hub) rather than
    // where this iteration finished. A brief settle covers the worst case the same file documents (its own
    // 500ms safety net in `selfBack`).
    await page.waitForTimeout(500);
    await purgeNamed(page, cat.collection, name);
  }

  expect(failures, `catalogs that would not take a row:\n${failures.join("\n")}`).toEqual([]);
});

// The other half nothing has ever pressed: every catalog's own Delete. Cleanup in the test above (and in
// every other spec that seeds a throwaway row in these catalogs) goes straight through `purge()` - so the
// UI's own Delete has never actually been clicked, in either shape it comes in here. Most panels share
// `SoftDeleteRowActions` behind an "Actions" menu, with no confirm at all (`useSoftDelete`'s own comment:
// soft delete "skips the confirm dialog" - the row vanishes immediately, reversible via the toast's Undo).
// `projects` and `benefit-plans` are the outliers on BOTH axes: Delete is their own plain icon button, never
// behind a menu, and it asks a plain confirm first. One loop, whichever shape answers.
test("every catalog editor's row can also be deleted", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  // Every catalog page in one run, back to back - on a busy lane, a dev Worker restart mid-request on any one
  // of that many navigations reads as a plain 503, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.); a genuine editor failure still fails via `failures` below.
  allowConsoleErrors(page, /status of 503/i);
  const stamp = Date.now();
  const failures: string[] = [];

  for (const cat of CATALOGS) {
    const name = `E2E del ${cat.collection} ${stamp}`;
    try {
      await gotoRoute(page, `settings/${cat.key}`, cat.heading);
      if (cat.tab) await page.getByRole("tab", { name: cat.tab }).click();
      await page.getByRole("button", { name: cat.create }).first().click();
      const form = page.getByRole("dialog");
      await form.getByLabel(cat.nameField, { exact: true }).fill(name);
      await form.getByRole("button", { name: "Create", exact: true }).click();
      const reapply = page.getByRole("dialog").filter({ hasText: "Re-apply the split to existing employees?" });
      if (await reapply.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
        await reapply.getByRole("button", { name: /Later|Cancel|No/ }).first().click();
      }
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
      // Closing this dialog just fired its own deferred `history.back()` (dialogHistory.ts) - give it the
      // same settle margin as the loop's own end-of-iteration wait below before reading the table off it,
      // rather than risk sampling the page mid-navigation.
      await page.waitForTimeout(500);
      // `projects` and `benefit-plans` list their catalog as Cards (no <table> at all) - the row is found by
      // its nearest ancestor that also carries the row's own Delete button, not by `tbody tr`.
      const row = cat.cardBased
        ? page.locator("div").filter({ hasText: name }).filter({ has: page.getByRole("button", { name: "Delete" }) }).last()
        : page.locator("tbody tr").filter({ hasText: name }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Two shapes of row action, not one: most of these catalogs share `SoftDeleteRowActions` (an "Actions"
      // menu), but `projects` and `benefit-plans` render Delete as their own plain icon button beside the row
      // - never behind a menu at all.
      const actionsMenu = row.getByRole("button", { name: "Actions" });
      if (await actionsMenu.count()) {
        await actionsMenu.click();
        await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      } else {
        await row.getByRole("button", { name: "Delete" }).click();
      }

      // Either a confirm dialog names the row and asks first (projects, benefit-plans), or nothing does and
      // the row is already gone (every `useSoftDelete` catalog) - both are a correct answer here.
      const confirm = page.getByRole("dialog").filter({ hasText: `"${name}"` });
      if (await confirm.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
        await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      }
      // Pay components and salary structures feed the org's basic/special-allowance split - deleting a row
      // there re-solves it too (afterMutation -> promptReapply), which can raise the very same "Re-apply the
      // split?" prompt the create step above already knows to dismiss. Left open, it would block every
      // catalog navigated to next, not just this one.
      if (await reapply.waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false)) {
        await reapply.getByRole("button", { name: /Later|Cancel|No/ }).first().click();
      }
      if (cat.cardBased) {
        // No dimming here - neither page tracks `delete_time` at all, so Delete drops the row outright.
        await expect(page.getByText(name)).toHaveCount(0, { timeout: 15_000 });
      } else {
        // Every OTHER catalog here dims a soft-deleted row (rowClassName -> opacity-60) rather than dropping
        // it from the table - the same "soft delete stays visible, Restore offered" shape
        // `complianceRuleDelete.spec.ts` already proves on its own collection. Whichever a given catalog does,
        // it settles quickly; poll for either rather than assuming the row vanishes. Pay components and
        // salary structures can raise the SAME re-apply prompt here that the create step above dismisses -
        // its own re-solve, over every employee the split touches, is not always inside the 5s window already
        // checked, so a later poll pass dismisses one too if it shows up mid-poll.
        const stillThere = page.locator("tbody tr").filter({ hasText: name });
        await expect
          .poll(async () => {
            if (await reapply.count()) {
              await reapply.getByRole("button", { name: /Later|Cancel|No/ }).first().click();
              return "live";
            }
            const n = await stillThere.count();
            if (n === 0) return "gone";
            const cls = (await stillThere.first().getAttribute("class")) ?? "";
            return cls.includes("opacity-60") ? "dimmed" : "live";
          }, { timeout: 30_000 })
          .not.toBe("live");
      }
    } catch (e) {
      failures.push(`${cat.key}: ${(e as Error).message.split("\n")[0]}`);
      await page.keyboard.press("Escape");
    }
    // Same reasoning as the create test's own end-of-iteration wait: whichever dialog closed last here (the
    // confirm, or the row menu) fired its own deferred self-back, and the next catalog's `gotoRoute` races it.
    await page.waitForTimeout(500);
    await purgeNamed(page, cat.collection, name); // belt-and-braces: a no-op wherever Delete already worked
  }

  expect(failures, `catalogs whose row could not be deleted:\n${failures.join("\n")}`).toEqual([]);
});

/** Take the row back out, whatever the collection calls its name column. */
async function purgeNamed(page: import("@playwright/test").Page, collection: string, name: string) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  for (const r of results) {
    if ([r.name, r.display_name, r.title].includes(name)) await purge(page, r.path!);
  }
}
