import { gotoRoute, purge, test, expect } from "./fixtures";

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
  /** A sub-tab to open first, where the panel holds the catalog beside other settings. */
  tab?: string;
  /** The button that opens the create dialog. */
  create: string;
  /** The field the row is named in. */
  nameField: string;
  /** Wire collection, for taking the row back out. */
  collection: string;
};

const CATALOGS: Catalog[] = [
  { key: "departments", create: "New department", nameField: "Department name", collection: "departments" },
  { key: "leave-types", create: "New leave type", nameField: "Name", collection: "leave-types" },
  { key: "pay-components", create: "New component", nameField: "Name", collection: "pay-components" },
  { key: "pay-grades", create: "New grade", nameField: "Grade name", collection: "pay-grades" },
  { key: "salary-structures", create: "New structure", nameField: "Name", collection: "salary-structures" },
  { key: "projects", create: "New project", nameField: "Name", collection: "projects" },
  { key: "benefit-plans", create: "New plan", nameField: "Name", collection: "benefit-plans" },
  // These three panels hold their catalog beside other settings, behind a sub-tab.
  { key: "expenses", tab: "Categories", create: "New category", nameField: "Name", collection: "expense-categories" },
  { key: "reimbursements", tab: "Categories", create: "New category", nameField: "Name", collection: "reimbursement-categories" },
  { key: "asset-tags", tab: "Categories", create: "New category", nameField: "Name", collection: "asset-categories" },
];

test("every catalog editor takes a new row", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = Date.now();
  const failures: string[] = [];

  for (const cat of CATALOGS) {
    const name = `E2E ${cat.collection} ${stamp}`;
    try {
      await gotoRoute(page, `settings/${cat.key}`);
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
      await expect(page.getByText(name).first()).toBeVisible({ timeout: 15_000 });
    } catch (e) {
      failures.push(`${cat.key}: ${(e as Error).message.split("\n")[0]}`);
      await page.keyboard.press("Escape");
      const discard = page.getByRole("dialog");
      if (await discard.getByRole("button", { name: /Discard|Leave/ }).count()) {
        await discard.getByRole("button", { name: /Discard|Leave/ }).click();
      }
    }
    await purgeNamed(page, cat.collection, name);
  }

  expect(failures, `catalogs that would not take a row:\n${failures.join("\n")}`).toEqual([]);
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
