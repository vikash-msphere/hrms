import { SPA_HEADERS, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// A shared review, exported as a PDF - `reviewStages.spec.ts` walks the whole state machine through
// ACKNOWLEDGED but never once presses "Review PDF" (only offered once a review is SHARED or ACKNOWLEDGED),
// so `PdfPreviewDialog`'s real render-then-download chain has never run for this document. Reaching SHARED
// is driven over the wire - `test/reviewFlow.test.ts` owns that machine - so this spec is only about the
// export itself.
test("a shared review is previewed and saved as a real PDF", async ({ as }) => {
  test.setTimeout(120_000);
  const hr = await as("hr");
  const employee = await as("employee");
  const manager = await as("manager");
  const admin = await as("super");
  const name = `E2E review pdf ${Date.now()}`;

  const created = await hr.request.post("/v1/review-cycles", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const cycle = (await created.json()) as { path: string; etag: string };
  const launched = await hr.request.post(`/v1/${cycle.path}:launch`, {
    headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
    data: { employees: [await personPath(hr, "employee")] },
  });
  expect(launched.status(), await launched.text()).toBe(200);

  const listed = await hr.request.get(`/v1/reviews?cycle=${encodeURIComponent(cycle.path)}&page_size=10`);
  expect(listed.status(), await listed.text()).toBe(200);
  const { results = [] } = (await listed.json()) as { results?: { path: string; etag: string }[] };
  expect(results.length, "the launch minted no review").toBe(1);
  let review = results[0]!;

  // To SHARED over the wire: the state machine itself belongs to `test/reviewFlow.test.ts`.
  const selfSubmitted = await employee.request.post(`/v1/${review.path}:submitSelf`, {
    headers: { ...SPA_HEADERS, "If-Match": review.etag },
    data: { self_comment: "Shipped the importer." },
  });
  expect(selfSubmitted.status(), await selfSubmitted.text()).toBe(200);
  review = (await selfSubmitted.json()) as { path: string; etag: string };

  const managerSubmitted = await manager.request.post(`/v1/${review.path}:submitManager`, {
    headers: { ...SPA_HEADERS, "If-Match": review.etag },
    data: { overall_rating: 4, manager_comment: "Strong year." },
  });
  expect(managerSubmitted.status(), await managerSubmitted.text()).toBe(200);

  try {
    await gotoRoute(employee, "reviews", "Reviews");
    const card = employee.locator('[id^="review-"]').filter({ hasText: name }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      const header = card.getByRole("button").first();
      await expect(header).toBeVisible();
      if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "true");
    }).toPass({ timeout: 30_000 });

    // `exact`, because the card's own accordion header is a button too and its accessible name is the review's
    // title - which for this spec's data ("E2E review pdf <stamp>") contains "Review PDF" as a substring.
    await card.getByRole("button", { name: "Review PDF", exact: true }).click();
    const dialog = employee.getByRole("dialog");
    const frame = dialog.getByTitle(/Performance review/);
    await expect(frame).toBeVisible({ timeout: 30_000 });
    await expect(frame).toHaveAttribute("src", /^blob:/);

    const [download] = await Promise.all([
      employee.waitForEvent("download"),
      dialog.getByRole("button", { name: "Save PDF" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^review-.*\.pdf$/);
    const path = await download.path();
    if (!path) throw new Error("the download produced no file");
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  } finally {
    await purge(admin, cycle.path);
  }
});
