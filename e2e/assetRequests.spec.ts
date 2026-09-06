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

  await gotoRoute(employee, "profile", "My Profile");
  await employee.getByRole("tab", { name: "Assets" }).click();

  const panel = employee.getByRole("tabpanel");
  await panel.getByRole("button", { name: "Request an asset" }).click();
  const form = employee.getByRole("dialog");
  await form.getByLabel("What do you need").click();
  await employee.getByRole("option").first().click();
  await form.getByLabel("Why you need it").fill(why);
  await form.getByRole("button", { name: "Send request" }).click();
  await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // Their own profile carries the open ask - kit they have asked for sits beside kit they hold.
  await expect(panel.getByText(/Pending|Requested|Awaiting/i).first()).toBeVisible({ timeout: 30_000 });

  // And it is a decision somebody owes, so it is in the approvals queue rather than in an inbox nobody reads.
  await gotoRoute(approver, "approvals", "Approvals");
  await expect(approver.getByText(why).first()).toBeVisible({ timeout: 30_000 });

  await purgeRequests(approver, why);
  if (category.created) await purge(approver, category.path);
});

/** The category an ask is made within - the org's own if it has one, otherwise a fresh one. */
async function assetCategory(page: import("@playwright/test").Page): Promise<{ path: string; created: boolean }> {
  // A page of them, and the first that does not demand a serial: `assetSerialRequired.spec.ts` keeps a
  // `requires_serial` category in the table for the length of its own run, and picking that one refuses the
  // asset ("a serial number is required for …") for a reason nothing here is about.
  const existing = await page.request.get("/v1/asset-categories?page_size=100");
  const rows = ((await existing.json()) as { results?: { path: string; requires_serial?: boolean }[] }).results ?? [];
  const found = rows.find((r) => !r.requires_serial)?.path;
  if (found) return { path: found, created: false };
  const made = await page.request.post("/v1/asset-categories", {
    headers: SPA_HEADERS,
    data: { display_name: `E2E asset category ${Date.now()}`, requires_serial: false },
  });
  expect(made.status(), await made.text()).toBe(200);
  return { path: ((await made.json()) as { path: string }).path, created: true };
}

/** Drop the request this spec filed. */
async function purgeRequests(page: import("@playwright/test").Page, why: string) {
  const res = await page.request.get("/v1/asset-requests?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; justification?: string }[] };
  for (const r of results.filter((x) => x.justification === why)) await purge(page, r.path);
}
