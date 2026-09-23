import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// The two ways a requisition stops being open, and neither has ever been pressed.
//
// `requisitionClone.spec.ts` owns the duplicate warning and the draft-vs-open picker on the CREATE form; this
// owns what happens after a job exists: editing its status to Closed (the confirm dialog on Delete explicitly
// points here - "to stop hiring but keep its history, set its status to Closed instead" - so the two are one
// feature, not two), and the outright Delete itself. Worth pinning as its own row: the delete button's own
// accessible name is "Close" (its `aria-label`, not "Delete" - the icon is a trash can, so this is very likely
// a stale label rather than intent, and a test that assumed "Delete" would never have found the button at all).
test("a requisition is closed by editing its status, and a separate one is deleted outright", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const closeMe = `E2E Close Job ${Date.now() % 100000}`;
  const deleteMe = `E2E Delete Job ${Date.now() % 100000}`;

  // Closed by edit: opened, then talked back down to Closed.
  await gotoRoute(page, "job-requisitions", "Jobs");
  await page.getByRole("button", { name: "New job" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Role title").fill(closeMe);
  await form.getByLabel("Openings").fill("1");
  await form.getByRole("button", { name: "Open requisition" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  const closeRow = page.locator("tbody tr").filter({ hasText: closeMe });
  await expect(closeRow).toBeVisible({ timeout: 30_000 });

  await closeRow.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog");
  await expect(edit.getByRole("heading", { name: "Edit requisition" })).toBeVisible({ timeout: 30_000 });
  await edit.getByLabel("Status").click();
  await page.getByRole("option", { name: "Closed", exact: true }).click();
  await expect(edit.getByText("Closing ends the hiring. The applications on it stay readable.")).toBeVisible();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(toast(page, "Job updated")).toBeVisible({ timeout: 30_000 });
  await expect(closeRow).toContainText("Closed", { timeout: 30_000 });

  // Deleted outright: a second job, never meant to survive this spec either way.
  await page.getByRole("button", { name: "New job" }).first().click();
  const form2 = page.getByRole("dialog");
  await form2.getByLabel("Role title").fill(deleteMe);
  await form2.getByLabel("Openings").fill("1");
  await form2.getByRole("button", { name: "Open requisition" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  const deleteRow = page.locator("tbody tr").filter({ hasText: deleteMe });
  await expect(deleteRow).toBeVisible({ timeout: 30_000 });

  await deleteRow.getByRole("button", { name: "Close" }).click(); // the trash-can button's actual accessible name
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Delete this requisition?")).toBeVisible({ timeout: 30_000 });
  await expect(confirm.getByText(/set its status to Closed instead/)).toBeVisible();
  await confirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(deleteRow).toHaveCount(0, { timeout: 30_000 });

  await sweep(page);
});

/** Take out every job any run of this spec has opened. */
async function sweep(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/job-requisitions?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  for (const r of results.filter((x) => (x.title ?? "").startsWith("E2E Close Job ") || (x.title ?? "").startsWith("E2E Delete Job "))) {
    await purge(page, r.path);
  }
}
