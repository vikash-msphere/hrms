import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Asking for kit, and the queue that answers.
//
// `assets.spec.ts` covers the register and `assetCustody` the scan that proves who holds what. The step
// before either is somebody asking: an asset request is filed on the person's OWN profile, next to what they
// already hold, because "what do I have and what do I still need" is one question. That placement is the
// design decision worth pinning - the request is not a ticket and not a page of its own - along with the
// two-sided flow it starts: the asker sees their pending ask on their profile, and the approver sees it in
// the approvals queue as a decision they owe.
test("an employee asks for kit from their own profile, and it lands in the approvals queue", async ({ as }) => {
  test.setTimeout(180_000);
  const employee = await as("employee");
  const approver = await as("super");
  const why = `E2E asset request ${Date.now() % 100000}`;

  // A category to ask within: what a person requests is a KIND of thing ("a laptop"), not a specific serial,
  // which is the whole difference between a request and an assignment.
  const category = await assetCategory(approver);

  await gotoRoute(employee, "profile"); // one record page, two addresses: its `h1` is the person's name
  // Assets is a card on Employment now, not a tab of its own: the kit somebody holds is part of the terms of
  // the job, and the one record page carries it there for every viewer (pages/EmployeeProfile.tsx).
  await employee.getByRole("tab", { name: "Employment" }).click();

  const panel = employee.getByRole("tabpanel");
  // Retried as one whole unit so a submit that loses a race reopens the dialog and goes again, rather than
  // failing the spec on the first slow round trip. What it no longer covers for is the picked category being
  // deleted underneath: this spec owns its category now (see `assetCategory` below), so it is picked BY NAME
  // rather than taking whatever sits first in an org-wide list full of other specs' fixtures.
  await expect(async () => {
    if (!(await employee.getByRole("dialog").count())) await panel.getByRole("button", { name: "Request an asset" }).click();
    const form = employee.getByRole("dialog");
    await form.getByLabel("What do you need").click();
    await employee.getByRole("option", { name: category.name, exact: true }).click();
    await form.getByLabel("Why you need it").fill(why);
    await form.getByRole("button", { name: "Send request" }).click();
    await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });
  }).toPass({ timeout: 60_000 });

  // Their own profile carries the open ask - kit they have asked for sits beside kit they hold.
  await expect(panel.getByText(/Pending|Requested|Awaiting/i).first()).toBeVisible({ timeout: 30_000 });

  // And it is a decision somebody owes, so it is in the approvals queue rather than in an inbox nobody reads.
  await gotoRoute(approver, "approvals", "Approvals");
  await expect(approver.getByText(why).first()).toBeVisible({ timeout: 30_000 });

  await purgeRequests(approver, why);
  await purge(approver, category.path);
});

/**
 * The category this ask is made within - ALWAYS a fresh one this spec owns.
 *
 * It used to reuse the first listed category that did not demand a serial, and only create one if the org had
 * none. But "the org's categories" in this lane are mostly other specs' fixtures: `assets`, `assetTagPdf`,
 * `assetTagPrinterQueue` and `cancelOwnRequest` each create an `E2E …` category and purge it when they
 * finish. Reusing whichever was listed first meant asking within a row another spec was about to delete, and
 * the create then 400s "asset category not found" - repeatedly, since the next spec's fixture takes the same
 * place in the list. Owning the row removes the whole class: nothing else knows this name.
 */
async function assetCategory(page: import("@playwright/test").Page): Promise<{ path: string; name: string }> {
  // `requires_serial: false` deliberately - a category that demands a serial refuses the asset later
  // ("a serial number is required for …") for a reason nothing here is about.
  const name = `E2E asset request category ${Date.now()}`;
  const made = await page.request.post("/v1/asset-categories", {
    headers: SPA_HEADERS,
    data: { display_name: name, requires_serial: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  return { path: ((await made.json()) as { path: string }).path, name };
}

/** Drop the request this spec filed. */
async function purgeRequests(page: import("@playwright/test").Page, why: string) {
  const res = await page.request.get("/v1/asset-requests?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; justification?: string }[] };
  for (const r of results.filter((x) => x.justification === why)) await purge(page, r.path);
}
