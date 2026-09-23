import type { Page } from "@playwright/test";
import {
  SPA_HEADERS,
  gotoRoute,
  makeThrowawayPerson,
  purge,
  retireThrowawayPerson,
  test,
  expect,
} from "./fixtures";

// The rows somebody else filed, on a page you are allowed to open.
//
// Half of this app's access model is not "may I open this page" but "which rows does opening it show me".
// `reimbursements` and `expenses` are the sharpest case: EVERY employee holds collection write on both (they
// file their own), so the page always opens, and the only thing standing between one person's claim and
// another person's screen is the service scoping its list to the caller. A regression there is completely
// invisible from the outside - the page renders, the table is full, nothing errors - and what has leaked is
// what a colleague spent money on and why.
//
// The proof is a contrast rather than a count: two claims filed, one by the person under test and one by
// somebody they have nothing to do with, and then the same table read by both an ordinary employee (must see
// exactly their own) and by finance (must see both, which is what makes the absence above scoping rather
// than a filter or an empty page).
test.describe("list scoping", () => {
  test("an employee's claims and expenses are theirs alone, and finance sees both", async ({ as }) => {
    test.setTimeout(300_000);
    const admin = await as("super");
    const stranger = await makeThrowawayPerson(admin, "Scope");
    const theirs = await as({ email: stranger.email });
    const employee = await as("employee");
    const hr = await as("hr");

    const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
    const mine = `E2E scope mine ${stamp}`;
    const other = `E2E scope other ${stamp}`;
    const filed: string[] = [];

    try {
      filed.push(await file(employee, "reimbursements", mine));
      filed.push(await file(theirs, "reimbursements", other));
      filed.push(await file(employee, "expenses", mine));
      filed.push(await file(theirs, "expenses", other));

      // The employee's own two pages: their row is there, the stranger's is not. Description is a
      // `defaultHidden` column on both tables (DataTable's own "Toggle columns" popover) - switched on here so
      // the text this test is actually about is what's being read, not amount/date, which collide between
      // "mine" and "other" (both filed for 175).
      for (const [route, heading] of [["reimbursements", "Reimbursements"], ["expenses", "Expenses"]] as const) {
        await gotoRoute(employee, route, heading);
        await employee.getByRole("button", { name: "Columns" }).click();
        await employee.getByText("Description", { exact: true }).click();
        await employee.keyboard.press("Escape");
        await expect(employee.getByText(mine).first()).toBeVisible({ timeout: 30_000 });
        await expect(employee.getByText(other), `${route} showed an employee a stranger's row`).toHaveCount(0);
      }

      // The contrast, which is what makes the absence above meaningful: the stranger's rows DO exist and ARE
      // readable - by finance, who holds these collections org-wide. Asserted on the wire rather than on the
      // page, because where a freshly filed row surfaces for an approver is a workflow question (the
      // Approvals inbox, the History tab once decided) that `approval` and `rejection` already own; the
      // question here is only whether the row is reachable at all.
      for (const collection of ["reimbursements", "expenses"] as const) {
        const res = await hr.request.get(`/v1/${collection}?page_size=100`);
        expect(res.status(), await res.text()).toBe(200);
        const body = await res.text();
        expect(body, `finance cannot read a ${collection} row filed by somebody else`).toContain(other);
      }

      // And the employee's own list, on the wire, says the same thing the table did - so a passing page test
      // is not just a table that failed to render the row.
      for (const collection of ["reimbursements", "expenses"] as const) {
        const body = await (await employee.request.get(`/v1/${collection}?page_size=100`)).text();
        expect(body).toContain(mine);
        expect(body, `the ${collection} list served an employee a stranger's row`).not.toContain(other);
      }
    } finally {
      for (const path of filed) await purge(admin, path);
      await retireThrowawayPerson(admin, stranger.path);
    }
  });
});

/** File one row of `collection` as whoever this page is signed in as, and return its path. */
async function file(page: Page, collection: string, description: string): Promise<string> {
  const res = await page.request.post(`/v1/${collection}`, {
    headers: SPA_HEADERS,
    data: { amount: 175, description },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
}
