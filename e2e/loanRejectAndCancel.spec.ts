import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The two endings `loans.spec.ts` and `loanLifecycle.spec.ts` never reach: payroll saying no, and the
// borrower taking back a request nobody has decided on yet. Both are one-click, and both are gone the moment
// the request stops being pending - reject is payroll's decision either way, but Delete is `mine(l) &&
// l.status === "PENDING"` together, so it is offered to the borrower only, and only until somebody answers.
test.describe("loan requests: rejected and cancelled", () => {
  test("payroll rejects a pending request outright", async ({ as }) => {
    test.setTimeout(90_000);
    const employee = await as("employee");
    const payroll = await as("payroll");
    const reason = `E2E loan reject ${Date.now()}`;

    const made = await employee.request.post("/v1/loans", {
      headers: SPA_HEADERS,
      data: { principal: 30000, installments: 3, reason },
    });
    expect(made.status(), await made.text()).toBe(200);
    const loan = (await made.json()) as { path: string };

    try {
      await gotoRoute(payroll, "loans", "Loans & Advances");
      const card = payroll.locator("div.shadow-card").filter({ hasText: reason }).first();
      await expect(card).toBeVisible({ timeout: 30_000 });
      // Pressed against the RECORD, not the toast: `:reject` is one write, and the runtime under this suite
      // refuses one outright now and again (a 503 in tens of milliseconds, tmp/e2e-worker.log - the local D1
      // Durable Object's queue, see fixtures.ts) - which is a decision that did not happen, not a decision
      // the app got wrong. A toast lives ~5s and is missed under load anyway.
      // Rejecting asks why, and the reason is what the borrower then reads on the card.
      await expect(async () => {
        if (await rejected(payroll, loan.path)) return;
        await card.getByRole("button", { name: "Reject", exact: true }).click({ timeout: 10_000 });
        const ask = payroll.getByRole("dialog").filter({ hasText: "Reject this request?" });
        await ask.getByRole("textbox", { name: "Reason", exact: true }).fill(WHY, { timeout: 10_000 });
        await ask.getByRole("button", { name: "Reject", exact: true }).click({ timeout: 10_000 });
        await expect.poll(() => rejected(payroll, loan.path), { timeout: 10_000 }).toBe(true);
      }).toPass({ timeout: 45_000 });
      await expect(card).toContainText(/Rejected/i, { timeout: 30_000 });
      await expect(card).toContainText(WHY);

      // Rejected is terminal: neither of the two decisions, nor disbursal, is offered any more.
      await expect(card.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
      await expect(card.getByRole("button", { name: "Mark disbursed" })).toHaveCount(0);

      const after = await payroll.request.get(`/v1/${loan.path}`);
      expect((await after.json() as { status?: string }).status).toBe("REJECTED");
    } finally {
      await purge(payroll, loan.path);
    }
  });

  test("the borrower withdraws their own request before anyone decides", async ({ as }) => {
    test.setTimeout(90_000);
    const employee = await as("employee");
    const reason = `E2E loan cancel ${Date.now()}`;

    await gotoRoute(employee, "loans", "Loans & Advances");
    await employee.getByRole("button", { name: "Request loan" }).first().click();
    const form = employee.getByRole("dialog");
    await form.getByLabel("Amount").fill("15000");
    await form.getByRole("button", { name: "3 months" }).click();
    await form.getByLabel(/Reason/).fill(reason);
    await form.getByRole("button", { name: "Request", exact: true }).click();
    await expect(employee.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    try {
      const card = employee.locator("div.shadow-card").filter({ hasText: reason }).first();
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.getByRole("button", { name: "Delete" }).click();
      const confirm = employee.getByRole("dialog");
      await expect(confirm.getByText("Delete this loan request?")).toBeVisible({ timeout: 15_000 });
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(toast(employee, "Request deleted")).toBeVisible({ timeout: 30_000 });
      await expect(employee.locator("div.shadow-card").filter({ hasText: reason })).toHaveCount(0, { timeout: 30_000 });
    } finally {
      // Belt-and-braces: a no-op if Delete already removed it outright, a real purge if it only soft-deleted.
      const res = await employee.request.get("/v1/loans?page_size=100&show_deleted=true");
      if (res.ok()) {
        const { results = [] } = (await res.json()) as { results?: { path: string; reason?: string }[] };
        for (const r of results.filter((x) => x.reason === reason)) await purge(employee, r.path).catch(() => undefined);
      }
    }
  });
});

const WHY = "Over the advance limit for your grade";

/** Whether the loan really is rejected - asked of the record, not of the toast that announced it. */
async function rejected(page: import("@playwright/test").Page, path: string): Promise<boolean> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return false;
  return ((await res.json()) as { status?: string }).status === "REJECTED";
}
