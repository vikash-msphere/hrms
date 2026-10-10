import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The dashboard's OWN inline decision widget - a third surface for the same approve/reject verbs, distinct
// from both the full Approvals inbox (`rejection.spec.ts`, `approval.spec.ts`) and any collection's own page.
// "Awaiting your approval" lets the decider act right there among the widgets (`decideInline` in
// Dashboard.tsx), asking for the reason the same way the inbox row does - built to answer exactly like it,
// and proven here to actually work rather than just render.
//
// Payroll, not the employee's manager: loans/advances are payroll's workflow by design (grants.ts - manager
// holds `loans.**` at `read` only, "decisions are payroll's verbs"), so a manager never gets an `approve` on
// this collection at any scope and the widget correctly never shows it to one.
test("a request is rejected right from the dashboard's own approval widget", async ({ as }) => {
  // Longer than the 90s the reload-until-in-view retry below budgets itself, plus the decision that follows.
  test.setTimeout(220_000);
  const employee = await as("employee");
  const payroll = await as("payroll");
  const reason = `E2E dashboard reject ${Date.now() % 100000}`;
  // A principal nobody else's advance would land on: the dashboard widget's own row renders the AMOUNT
  // (Dashboard.tsx's approvalItems - money(r.principal)), never the reason, so that is what has to be unique
  // for this test's own row to be tellable apart from another spec's advance for the same seeded person.
  const principal = 400000 + (Date.now() % 90000);

  const made = await employee.request.post("/v1/loans", {
    headers: SPA_HEADERS,
    data: { kind: "advance", principal, installments: 1, reason },
  });
  expect(made.status(), await made.text()).toBe(200);
  const path = ((await made.json()) as { path: string }).path;

  try {
    await gotoRoute(payroll, "dashboard");
    await payroll.getByText("Awaiting your approval").first().scrollIntoViewIfNeeded();
    // Scoped by the principal's own digits, not just "Eve Employee" + "Advance" - the widget only shows the
    // top 5 pending items, rendering the AMOUNT rather than the reason, and another spec filing its OWN
    // advance for the same seeded person at the same time would otherwise leave that broader match still
    // resolving to something after this one is rejected. A digit-by-digit pattern rather than the plain
    // formatted string, since a thousands separator can land between any two digits depending on locale.
    const amountPattern = new RegExp(String(principal).split("").join("[,.]?"));
    const row = payroll.locator("div").filter({ hasText: "Eve Employee" }).filter({ hasText: amountPattern }).last();
    // Reloaded until it is in view, not waited out on one paint. The widget holds FIVE pending items, and the
    // rest of this suite files requests into the same queue for the length of a run: five arriving after this
    // advance push it off the bottom, and no amount of waiting on an already-rendered widget brings it back.
    // Those specs also decide their own items within seconds, so the queue drains and this one comes back into
    // the five - which a fresh read of the dashboard picks up, and a stale one never does.
    await expect(async () => {
      await payroll.reload();
      await expect(payroll.getByRole("main")).toBeVisible({ timeout: 15_000 });
      await payroll.getByText("Awaiting your approval").first().scrollIntoViewIfNeeded();
      await expect(row, "the filed advance isn't in the dashboard's top-5 pending view").toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });

    await row.getByRole("button", { name: /^Reject/ }).click();
    const dialog = payroll.getByRole("dialog");
    await expect(dialog.getByText("Reject this request?")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(/advance request/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
    await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill("Already advanced this month");
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(toast(payroll, "Rejected")).toBeVisible({ timeout: 30_000 });

    // Settled without leaving the dashboard: the row is gone from the widget, and the record agrees.
    await expect(row).toHaveCount(0, { timeout: 30_000 });
    await expect
      .poll(async () => {
        const r = await payroll.request.get(`/v1/${path}`);
        if (!r.ok()) return "unreadable";
        const body = (await r.json()) as { status?: string; decision_note?: string };
        return `${body.status}: ${body.decision_note}`;
      }, { timeout: 30_000 })
      .toBe("REJECTED: Already advanced this month");
  } finally {
    await purge(payroll, path);
  }
});
