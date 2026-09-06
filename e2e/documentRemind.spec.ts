import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Chasing the people who have not signed the policy.
//
// A policy that requires acknowledgement is only useful once everybody has actually signed it, so HR needs a
// page that answers "who hasn't?" and a way to chase them. Both are browser work: the progress dialog
// computes pending against every active employee (the server stores only the acknowledgements that exist),
// groups the stragglers by department, and offers the chase twice - everyone at once, or one person from
// their own chip.
//
// `documentAck` owns the signing chain (the PDF, the signature box, the stamped copy) and
// `test/documentAck.test.ts` the records. What only a browser shows is the chase-up: the dialog reachable
// from the row, the pending list, and the reminder actually reaching the person it names.
test("HR sees who has not acknowledged a policy, and reminds one of them", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const employee = await as("employee");
  const title = `E2E policy ${Date.now() % 1_000_000}`;

  // An ack-required policy of this spec's own. Written over the wire because placing the signature box on a
  // rendering of the PDF is `documentAck`'s subject - the server takes the same anchor either way.
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

    // The progress view is a row action, not a page: it belongs to the document it counts.
    // The row's menu: an icon button whose only name is its `sr-only` "Actions", drawn on hover.
    await row.hover();
    await row.getByRole("button", { name: "Actions" }).click();
    await page.getByRole("menuitem", { name: "View acknowledgements" }).click();

    const dialog = page.getByRole("dialog").filter({ hasText: `Acknowledgements · ${title}` });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // Nobody has signed it, so everybody is pending - and the dialog says whose problem that is by name.
    const reminder = dialog.getByRole("button", { name: "Remind Eve Employee" });
    await expect(reminder).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: "Remind everyone" })).toBeVisible();

    // Counted before: this seeded person is chased by every earlier run of this spec too.
    const before = await pendingNudges(employee);
    await reminder.click();

    // The chase reaches the person, in the only place it can be observed: their own notifications.
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
