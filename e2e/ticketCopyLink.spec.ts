import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect, toast } from "./fixtures";

// A pasteable link to one ticket - `copyEmail.spec.ts` is the only spec that reads the clipboard back, and
// only for an address; every other "Copy a link to this X" (tickets, applications, goals, tasks,
// suggestions) is its own separate implementation with none of them ever exercised. Tickets stands in for
// the shape they all share: `recordUrl()` into the real Clipboard API, confirmed by a toast that never
// checks what actually landed there.
test("a ticket's copied link opens that exact ticket", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("hr");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). Which ticket the pasted link opens is what this test proves, and
  // that read is asserted below; a console line from a request retried behind it is not its failure.
  allowConsoleErrors(page, /status of 503|status of 500/i);
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
    // "All" is a scope CHIP over the desk's one table, not a tab over four (see `tickets.spec.ts`).
    await page.getByRole("button", { name: /^All/ }).click();
    await page.getByRole("button", { name: subject, exact: true }).click();

    const detail = page.getByRole("dialog").filter({ hasText: subject });
    await expect(detail).toBeVisible({ timeout: 30_000 });
    await detail.getByRole("button", { name: "Copy a link to this ticket" }).click();
    await expect(toast(page, "Link copied")).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 15_000 })
      .toMatch(new RegExp(`/tickets/${ticketId}$`));
  } finally {
    await purge(page, ticket.path);
  }
});
