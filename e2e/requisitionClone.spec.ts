import { gotoRoute, purge, test, expect } from "./fixtures";

// Opening a second job from a first one - and the two things the form says while it is being done.
//
// `ats.spec.ts` walks the hiring chain: a job, a candidate, an application, a stage. This is the form that
// starts that chain, and everything asserted here is computed in the rendered dialog from rows the page has
// already loaded. There is no endpoint for any of it.
//
// Two guards, and they exist because of the same mistake. A recruiter opening "Senior Backend Engineer" for
// the second headcount naturally reaches for Duplicate - and a duplicate is indistinguishable from an
// accidental second copy of a role that is already taking applications. So the form says which one this is:
// the twin warning names the live job and how many people are already in ITS funnel (two requisitions for
// one role split the pipeline in half and neither looks healthy), and the status picker explains what the
// status it is about to be saved with actually DOES - because "draft" and "open" read as two words for the
// same thing until you know only one of them takes applications.
//
// The copy also comes back as a DRAFT whatever the original was, which is the safe direction: a duplicate
// that silently opened would start collecting applications before anybody had checked the copy.
test("a job is duplicated: the copy comes back as a draft, and the form warns it has a twin", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("hr");
  const role = `E2E Role ${Date.now() % 100000}`;

  await gotoRoute(page, "job-requisitions", "Jobs");
  await sweep(page);

  // The original: open, so it is a job really taking applications rather than a draft nobody can apply to.
  await page.getByRole("button", { name: "New job" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Role title").fill(role);
  await form.getByLabel("Openings").fill("2");

  // The status picker explains itself as it moves. A draft and an open job differ in exactly one thing that
  // matters, and it is not visible anywhere on the picker itself.
  await expect(form.getByText("A draft takes no applications")).toBeVisible({ timeout: 30_000 });
  await form.getByLabel("Status").click();
  await page.getByRole("option", { name: "Open", exact: true }).click();
  await expect(form.getByText("Open accepts applications")).toBeVisible({ timeout: 30_000 });

  await form.getByRole("button", { name: "Open requisition" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  const original = page.locator("tbody tr").filter({ hasText: role });
  await expect(original).toHaveCount(1, { timeout: 30_000 });
  // Seats and hires read together, so "how much of this job is left" needs no arithmetic.
  await expect(original).toContainText("0 / 2");

  // Duplicate it. The dialog says where the copy came from, and what did not come with it.
  await original.getByRole("button", { name: "Duplicate" }).click();
  const copy = page.getByRole("dialog");
  await expect(copy.getByRole("heading", { name: "Open a requisition (copy)" })).toBeVisible({ timeout: 30_000 });
  await expect(copy.getByText(new RegExp(`Copied from .${role}.`))).toBeVisible();

  // Everything but the status: the seats came across, and the status is back to draft - along with the line
  // that says what a draft is, since that is the status the copy is about to be saved with.
  await expect(copy.getByLabel("Role title")).toHaveValue(role);
  await expect(copy.getByLabel("Openings")).toHaveValue("2");
  await expect(copy.getByText("A draft takes no applications")).toBeVisible();

  // And the reason the copy might be a mistake, said before it is saved: the live job of the same name, and
  // the funnel a second one would split.
  await expect(copy.getByText(new RegExp(`.${role}. is already open with \\d+ applicants?`))).toBeVisible({ timeout: 30_000 });

  await copy.getByRole("button", { name: "Open requisition" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  const both = page.locator("tbody tr").filter({ hasText: role });
  await expect(both).toHaveCount(2, { timeout: 30_000 });
  // One of each: the original still taking applications, the copy waiting to be checked.
  await expect(both.filter({ hasText: "Draft" })).toHaveCount(1);
  await expect(both.filter({ hasText: "Open" })).toHaveCount(1);

  await sweep(page);
});

type Page = import("@playwright/test").Page;

/** Take out every job any run of this spec has opened. */
async function sweep(page: Page) {
  const res = await page.request.get("/v1/job-requisitions?page_size=200");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; title?: string }[] };
  for (const r of results.filter((x) => (x.title ?? "").startsWith("E2E Role "))) await purge(page, r.path);
}
