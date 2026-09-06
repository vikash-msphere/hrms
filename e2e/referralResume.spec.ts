import { gotoRoute, purge, test, expect, toast } from "./fixtures";

// A referral's resume - `referrals.spec.ts` covers the status/bonus form and the hand-off to the pipeline,
// but never attaches a file. The row's own button does double duty (its label is "Attach" or "Replace"
// depending on whether one is already on file) and a "View" button appears only once there is one to view -
// neither of which shows up until a real file has actually been uploaded and read back.
test("a referral's resume is attached, downloaded back, and replaced", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");
  const name = `E2E Referral Resume ${Date.now() % 100000}`;

  await gotoRoute(page, "referrals", "Referrals");
  await page.getByRole("button", { name: "Refer someone" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Candidate name").fill(name);
  await form.getByRole("button", { name: "Submit referral" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const row = page.locator("tbody tr").filter({ hasText: name });
  await expect(row).toHaveCount(1);

  try {
    // Nothing on file yet: no way to view one, and the attach button says so.
    await expect(row.getByRole("button", { name: "View" })).toHaveCount(0);
    const attach = row.getByRole("button", { name: "Attach", exact: true });
    await expect(attach).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: "resume-v1.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%v1%%EOF", "latin1"),
    });
    await expect(toast(page, "Resume uploaded")).toBeVisible({ timeout: 30_000 });

    // On file now: the same button reads "Replace", and there is something to View.
    await expect(row.getByRole("button", { name: "Attach", exact: true })).toHaveCount(0);
    const replace = row.getByRole("button", { name: "Replace", exact: true });
    await expect(replace).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      row.getByRole("button", { name: "View" }).click(),
    ]);
    const path = await download.path();
    if (!path) throw new Error("the download produced no file");
    const { readFile } = await import("node:fs/promises");
    const first = await readFile(path);
    expect(first.toString("latin1")).toContain("v1");

    // Replaced: the SAME resource now reads back the second file, not the first one still on file.
    await replace.click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "resume-v2.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%v2%%EOF", "latin1"),
    });
    await expect(toast(page, "Resume uploaded")).toBeVisible({ timeout: 30_000 });

    const [download2] = await Promise.all([
      page.waitForEvent("download"),
      row.getByRole("button", { name: "View" }).click(),
    ]);
    const path2 = await download2.path();
    if (!path2) throw new Error("the second download produced no file");
    const second = await readFile(path2);
    expect(second.toString("latin1")).toContain("v2");
  } finally {
    const res = await page.request.get("/v1/referrals?page_size=100");
    if (res.ok()) {
      const { results = [] } = (await res.json()) as { results?: { path: string; candidate_name?: string }[] };
      const created = results.find((r) => r.candidate_name === name);
      if (created) await purge(page, created.path);
    }
  }
});
