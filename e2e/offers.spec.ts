import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// An offer, walked along its state machine.
//
// draft → approved → extended is a chain of one-press verbs, each of which asks first because each is
// visible to the candidate or commits the company to a number. The page draws the chain as a step trail, so
// where an offer stands is legible - and that trail, the verbs appearing one at a time, and the money field
// that turns an annual figure into "about X a month" before anybody signs, only exist in the browser.
test("an offer is created, approved and extended, one step at a time", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("hr");
  const stamp = Date.now();
  const candidate = `E2E Offeree ${stamp}`;
  const role = `E2E Offer Role ${stamp}`;

  const req = await create(page, "job-requisitions", { title: role, openings: 1 });
  const cand = await create(page, "candidates", { name: candidate, email: `e2e.offer.${stamp}@example.com` });
  const app = await create(page, "applications", { candidate: cand, requisition: req, stage: "offer" });

  await gotoRoute(page, "offers", "Offers");
  await page.getByRole("button", { name: "New offer" }).first().click();
  const form = page.getByRole("dialog");

  await form.getByLabel("Application").click();
  await page.getByPlaceholder(/Search/).last().fill(candidate);
  await expect(page.getByRole("button", { name: new RegExp(candidate) })).toBeVisible();
  await page.keyboard.press("Enter");

  // The money: an annual figure, read back as a monthly one, because that is the number the candidate hears.
  await form.getByLabel("Compensation (annual)").fill("1800000");
  await expect(form.getByText(/a month/)).toBeVisible();
  await form.getByRole("button", { name: "Create offer" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // A draft offer offers approval and nothing further: extending an unapproved offer is the mistake the
  // state machine exists to prevent.
  const row = page.locator("tbody tr").filter({ hasText: candidate });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("button", { name: "Extend" })).toHaveCount(0);

  // Approving an internal draft asks nobody anything - it is the step BEFORE the candidate is involved.
  await row.getByRole("button", { name: "Approve" }).click();
  await expect(toast(page, "Offer approved")).toBeVisible();

  // Extending is the press the candidate sees, so that one asks first.
  await row.getByRole("button", { name: "Extend" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm.getByText("Extend this offer to the candidate?")).toBeVisible();
  await confirm.getByRole("button", { name: "Extend offer" }).click();
  await expect(toast(page, "Offer extended")).toBeVisible();

  await purgeMatching(page, "offers", (r) => (r.application ?? "") === app);
  await purgeMatching(page, "applications", (r) => (r.candidate ?? "") === cand);
  await purge(page, cand);
  await purge(page, req);
});

/** Create a row through the API and hand back its path. */
async function create(
  page: import("@playwright/test").Page,
  collection: string,
  data: Record<string, unknown>,
): Promise<string> {
  const res = await page.request.post(`/v1/${collection}`, { headers: SPA_HEADERS, data });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { path: string }).path;
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
