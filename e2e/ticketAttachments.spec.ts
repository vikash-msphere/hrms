import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect } from "./fixtures";

// Attaching a file to a ticket AFTER it's been raised - distinct from the "Attachments (optional)" field on
// the filing form itself, and never exercised anywhere: a hidden file input behind a dashed "Attach a file"
// row, a download that goes through the ticket's own verb rather than a public URL, and a hover-revealed
// remove icon. `tickets:attach`/`:detach` have no other spec touching them at all.
test("a file is attached to a ticket, downloaded back byte-for-byte, and removed", async ({ as }) => {
  // Longer than the download retry below budgets itself, plus the upload ahead of it.
  test.setTimeout(180_000);
  const hr = await as("hr");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). The bytes read back are what this test proves; a console line from
  // the fetch the retry below repeats is not its failure.
  allowConsoleErrors(hr, /status of 503|status of 500/i);
  const stamp = Date.now();
  const subject = `E2E attach ${stamp}`;
  const fileName = `note-${stamp % 100000}.txt`;
  const fileContent = `E2E attachment body ${stamp}`;

  const made = await hr.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject, category: "it", description: "Raised by the e2e suite to attach a file to." },
  });
  expect(made.status(), await made.text()).toBe(200);
  const ticket = (await made.json()) as { path: string };

  try {
    await gotoRoute(hr, "tickets", "Support");
    await hr.locator("tbody tr").filter({ hasText: subject }).first().click();
    const detail = hr.getByRole("dialog");
    await expect(detail.getByText(subject).first()).toBeVisible();

    await detail.locator('input[type="file"]').setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: Buffer.from(fileContent),
    });
    await expect(detail.getByText(fileName)).toBeVisible({ timeout: 30_000 });

    // Re-clicked on a miss rather than trusted to one press: the download goes through the ticket's own
    // `attachment` verb, and a dev Worker restarting mid-request answers that fetch with a 503 - which the
    // page reports honestly ("Couldn't download …", Tickets.tsx) and which produces no download event at all.
    // A press that fetched nothing is not the verb failing to serve the bytes.
    let download!: import("@playwright/test").Download;
    await expect(async () => {
      const [dl] = await Promise.all([
        hr.waitForEvent("download", { timeout: 20_000 }),
        detail.getByText(fileName).click(),
      ]);
      download = dl;
    }).toPass({ timeout: 90_000 });
    expect(download.suggestedFilename()).toBe(fileName);
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error("the attachment download produced no file");
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(downloadPath)).toString("utf8")).toBe(fileContent);

    await detail.getByRole("button", { name: `Remove ${fileName}` }).click();
    await expect(detail.getByText(fileName)).toHaveCount(0, { timeout: 30_000 });

    // Gone on the server too, not just off the row.
    const reread = await hr.request.get(`/v1/${ticket.path}`);
    expect(reread.status(), await reread.text()).toBe(200);
    const attachments = ((await reread.json()) as { attachments?: { name?: string }[] }).attachments ?? [];
    expect(attachments.some((a) => a.name === fileName)).toBe(false);
  } finally {
    await purge(hr, ticket.path);
  }
});
