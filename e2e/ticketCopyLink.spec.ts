import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// A pasteable link to one ticket - `copyEmail.spec.ts` is the only spec that reads the clipboard back, and
// only for an address; every other "Copy a link to this X" (tickets, applications, goals, tasks,
// suggestions) is its own separate implementation with none of them ever exercised. Tickets stands in for
// the shape they all share: `recordUrl()` into the real Clipboard API, confirmed by a toast that never
// checks what actually landed there.
test("a ticket's copied link opens that exact ticket", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("hr");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const subject = `E2E copy-link ticket ${Date.now()}`;

  const made = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject, category: "it", description: "Raised by the copy-link spec." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };
  const ticketId = ticket.path.split("/").pop();

  try {
    await gotoRoute(page, "tickets", "Support");
    await page.getByRole("tab", { name: /^All/ }).click();
    await page.getByRole("button", { name: subject, exact: true }).click();

    const detail = page.getByRole("dialog").filter({ hasText: subject });
    await expect(detail).toBeVisible({ timeout: 30_000 });
    await detail.getByRole("button", { name: "Copy a link to this ticket" }).click();
    await expect(toast(page, "Link copied")).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 })
      .toMatch(new RegExp(`#/tickets/${ticketId}$`));
  } finally {
    await purge(page, ticket.path);
  }
});
