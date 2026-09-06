import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Attaching a file to a ticket AFTER it's been raised - distinct from the "Attachments (optional)" field on
// the filing form itself, and never exercised anywhere: a hidden file input behind a dashed "Attach a file"
// row, a download that goes through the ticket's own verb rather than a public URL, and a hover-revealed
// remove icon. `tickets:attach`/`:detach` have no other spec touching them at all.
test("a file is attached to a ticket, downloaded back byte-for-byte, and removed", async ({ as }) => {
  test.setTimeout(120_000);
  const hr = await as("hr");
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

    const [download] = await Promise.all([
      hr.waitForEvent("download"),
      detail.getByText(fileName).click(),
    ]);
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
