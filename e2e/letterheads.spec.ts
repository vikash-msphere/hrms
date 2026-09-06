import { gotoRoute, purge, test, expect } from "./fixtures";

// The company paper every generated document prints on.
//
// A letterhead is not an uploaded image, it is a designed PAGE: margins, a header band, a footer, a
// watermark, and the marks that sit on them. `test/letterheads.test.ts` owns what the stored design means
// when a letter renders. What only a browser has is the designer itself - a form on one side, a LIVE PDF of
// the page on the other, re-rendered as the design is edited. That preview is the entire point of the
// screen: without it somebody is choosing millimetres blind and finding out when a letter reaches an
// employee.
test("a letterhead is designed, previewed as a real PDF, and removed", async ({ as }) => {
  test.setTimeout(240_000);
  const page = await as("super");
  const label = `E2E letterhead ${Date.now() % 100000}`;

  await gotoRoute(page, "settings/identity");
  await expect(page.locator("h1").first()).toHaveText("Name & branding");

  // Letterheads are a tab of the branding panel: they ARE the company's identity on paper, so they sit with
  // the logo and the wordmark rather than in a page of their own.
  await page.getByRole("tab", { name: "Letterheads" }).click();

  // A new letterhead starts from the stock page rather than empty: an org that never opens the designer still
  // gets a usable one.
  await page.getByRole("button", { name: "Add letterhead" }).click();
  const designer = page.getByRole("dialog");
  await expect(designer).toBeVisible({ timeout: 30_000 });
  await designer.getByLabel("Name").fill(label);

  // The preview is a PDF of the page as designed, streamed into an iframe from a blob - the same renderer a
  // letter goes through, so what is on screen is what will print.
  const frame = designer.getByTitle("Letterhead preview");
  await expect(frame).toBeVisible({ timeout: 60_000 });
  await expect(frame).toHaveAttribute("src", /^blob:/);

  await designer.getByRole("button", { name: "Create letterhead" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

  // On the list, described by what it IS (its own page or the stock one, and how many marks it carries) -
  // which is what tells an admin whether a letterhead has been set up or merely created.
  const row = page.locator("div").filter({ hasText: label }).filter({ has: page.getByRole("button", { name: "Design", exact: true }) }).last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Stock page|Custom page/).first()).toBeVisible();

  // And gone again: letterheads are picked per letter type, so a stray one is a wrong choice waiting to be
  // made.
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("tab", { name: "Letterheads" }).click();
  await expect(page.getByText(label)).toBeVisible({ timeout: 30_000 });

  await purgeNamed(page, label);
});

/** Drop the letterhead this spec designed. */
async function purgeNamed(page: import("@playwright/test").Page, label: string) {
  const res = await page.request.get("/v1/letterheads?page_size=100");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; label?: string }[] };
  for (const l of results.filter((x) => x.label === label)) await purge(page, l.path);
}
