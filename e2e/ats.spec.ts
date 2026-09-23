import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// Hiring, end to end, through the pages it actually happens on.
//
// `test/ats.test.ts` owns the state machine (stages, rejection reasons, the conversion to an employee).
// What only a browser shows is that the pipeline is REACHABLE: a job is opened on one page, a candidate
// added on another, the two are joined into an application on a third, and the board then moves that
// application a stage at a time - with the next stage NAMED on the button, because "advance" without saying
// where is how people advance the wrong person. Four surfaces, one story; a break anywhere in the chain
// leaves a recruiter with a candidate they cannot put on a job.
test("a job is opened, a candidate added, applied to it, and advanced a stage", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  const stamp = Date.now();
  const role = `E2E Role ${stamp}`;
  const candidate = `E2E Candidate ${stamp}`;

  // The job.
  await gotoRoute(page, "job-requisitions", "Jobs");
  await page.getByRole("button", { name: "New job" }).first().click();
  const req = page.getByRole("dialog");
  await req.getByLabel("Role title").fill(role);
  await req.getByRole("button", { name: "Open requisition" }).click();
  await expect(toast(page, "Requisition opened")).toBeVisible();
  await expect(page.getByText(role).first()).toBeVisible();

  // The candidate.
  await gotoRoute(page, "candidates", "Candidates");
  await page.getByRole("button", { name: "Add candidate" }).first().click();
  const cand = page.getByRole("dialog");
  await cand.getByLabel("Name").fill(candidate);
  await cand.getByLabel(/Email/).fill(`e2e.candidate.${stamp}@example.com`);
  await cand.getByRole("button", { name: "Add candidate", exact: true }).click();
  await expect(page.getByText(candidate).first()).toBeVisible();

  // The application: the join that puts a person on a job.
  await gotoRoute(page, "pipeline", "Pipeline");
  await page.getByRole("button", { name: "New application" }).first().click();
  const app = page.getByRole("dialog");
  await expect(app.getByRole("heading", { name: "New application" })).toBeVisible();
  await pick(app, page, "Candidate", candidate);
  await pick(app, page, "Job", role);
  await app.getByRole("button", { name: "Add application" }).click();
  await expect(toast(page, "Application added")).toBeVisible();

  // The board has them, and the advance button says where it is about to send them.
  // The card is the draggable tile, which is also the only container that holds both the name and the
  // stage buttons.
  const card = page.locator("div[draggable='true']").filter({ hasText: candidate });
  await expect(card).toHaveCount(1);
  const advance = card.getByRole("button", { name: /^Advance to / });
  await expect(advance).toBeVisible();
  const goingTo = ((await advance.innerText()) || "").replace("Advance to ", "").trim();
  await advance.click();

  // A stage change tells the people on the next stage, so it asks first.
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Move to the next stage?")).toBeVisible();
  await expect(confirm).toContainText(candidate);
  await confirm.getByRole("button", { name: "Advance" }).click();

  // The candidate is now under the column the button named.
  await expect(page.getByRole("group", { name: new RegExp(goingTo, "i") }).getByText(candidate)).toBeVisible();

  // Clean up the chain: the application first, then the two records it joined.
  await purgeMatching(page, "applications", (r) => (r.candidate ?? "").length > 0 && (r.candidate_name ?? "") === candidate);
  await purgeMatching(page, "candidates", (r) => r.name === candidate || r.display_name === candidate);
  await purgeMatching(page, "job-requisitions", (r) => r.title === role || r.display_name === role);
});

/** Choose a value in one of WriteDialog's comboboxes, by the label of its field. */
async function pick(
  dialog: import("@playwright/test").Locator,
  page: import("@playwright/test").Page,
  label: string,
  value: string,
) {
  await dialog.getByLabel(label, { exact: true }).click();
  await page.getByPlaceholder(/Search/).last().fill(value);
  await expect(page.getByRole("option", { name: new RegExp(value) })).toBeVisible();
  await page.keyboard.press("Enter");
}

/** Purge every row of `collection` the predicate picks out. */
async function purgeMatching(
  page: import("@playwright/test").Page,
  collection: string,
  match: (row: Record<string, string>) => boolean,
) {
  const res = await page.request.get(`/v1/${collection}?page_size=100`);
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: Record<string, string>[] };
  for (const r of results) if (match(r)) await purge(page, r.path!);
}
