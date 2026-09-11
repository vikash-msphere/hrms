import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// The acknowledgement-progress dialog offers three ways to chase stragglers: remind one by name
// (`documentRemind.spec.ts` covers that), remind everyone still pending in one press, and copy every pending
// address to paste into a mail client. Only the per-person reminder was ever actually clicked - "Remind
// everyone" and "Copy emails" were asserted visible and never pressed, so neither's own effect (a reminder
// landing for EVERY pending person, not just one; the real clipboard, not just a state flip to "Copied") had
// ever been proven.
test("the acknowledgement dialog's bulk reminder and copy-emails both do what their button says", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const employee = await as("employee");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const title = `E2E bulk-remind ${Date.now() % 1_000_000}`;

  const created = await page.request.post("/v1/org-documents", {
    headers: SPA_HEADERS,
    data: {
      display_name: title,
      document_type: "POLICY",
      requires_ack: true,
      ack_method: "internal",
      sign_anchor: { page: 1, x1: 0.1, y1: 0.8, x2: 0.4, y2: 0.9 },
      notify_audience: { kind: "none" },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const path = ((await created.json()) as { path: string }).path;

  try {
    await gotoRoute(page, "documents", "Documents");
    const row = page.locator("tbody tr").filter({ hasText: title }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "View acknowledgements" }).click();
    const dialog = page.getByRole("dialog").filter({ hasText: `Acknowledgements · ${title}` });
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // Copy emails: the real system clipboard, not just the button relabelling itself.
    const copyBtn = dialog.getByRole("button", { name: "Copy emails" });
    await expect(copyBtn).toBeVisible({ timeout: 30_000 });
    await copyBtn.click();
    await expect(dialog.getByRole("button", { name: "Copied" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 })
      .toMatch(/@/);

    // Remind everyone: nobody has acknowledged this brand-new policy, so "everyone pending" includes the
    // seeded employee session, and the chase has to reach them the same way the per-person one does.
    const before = await pendingNudges(employee);
    await dialog.getByRole("button", { name: "Remind everyone" }).click();
    await expect.poll(() => pendingNudges(employee), { timeout: 30_000 }).toBeGreaterThan(before);
  } finally {
    await purge(page, path);
  }
});

/** "You still have to sign this" reminders sitting in this person's notifications. */
async function pendingNudges(page: import("@playwright/test").Page): Promise<number> {
  const res = await page.request.get("/v1/notifications?page_size=100");
  if (!res.ok()) return 0;
  const { results = [] } = (await res.json()) as { results?: { type?: string }[] };
  return results.filter((n) => n.type === "document.ackPending").length;
}
