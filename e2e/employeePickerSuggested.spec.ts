import { SPA_HEADERS, allowConsoleErrors, gotoRoute, personPath, purge, test, expect } from "./fixtures";

// `EmployeePicker`'s "Suggested" chips - `feedback360.spec.ts` proves the SAME picker will not offer the
// reviewee; what it never reaches is the OTHER half, floated above the search box: likely picks (same board,
// same department - `suggestFor` in Reviews.tsx), offered as one-click chips rather than making the manager
// type a name they already have in mind. The ranking itself is arithmetic `test/` could own if it ever grew
// its own coverage; what only a browser shows is that a chip is a REAL shortcut for the checkbox below it -
// pressing it picks the same person, pressing it again lets them go.
test("a suggested chip toggles the same pick as its own checkbox", async ({ as }) => {
  test.setTimeout(180_000);
  const hr = await as("hr");
  const manager = await as("manager");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). What the chip and its checkbox agree on is what this test reads;
  // a console line from a request retried behind that is not its failure.
  allowConsoleErrors(manager, /status of 503|status of 500/i);
  const name = `E2E suggested ${Date.now()}`;

  await purgeLeftovers(hr);

  const created = await hr.request.post("/v1/review-cycles", { headers: SPA_HEADERS, data: { name } });
  expect(created.status(), await created.text()).toBe(200);
  const cycle = (await created.json()) as { path: string; etag: string };
  const launched = await hr.request.post(`/v1/${cycle.path}:launch`, {
    headers: { ...SPA_HEADERS, "If-Match": cycle.etag },
    data: { employees: [await personPath(hr, "employee")] },
  });
  expect(launched.status(), await launched.text()).toBe(200);

  await gotoRoute(manager, "reviews", "Reviews");
  const card = manager.locator('[id^="review-"]').filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    const header = card.getByRole("button").first();
    await expect(header).toBeVisible();
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
  }).toPass({ timeout: 30_000 });

  try {
    await card.getByRole("button", { name: "Request feedback" }).click();
    const picker = manager.getByRole("dialog");
    await expect(picker.getByPlaceholder("Search name…")).toBeVisible({ timeout: 30_000 });

    // The reviewee is a seeded person in a seeded department of several - some colleague of theirs is always
    // a candidate, which is what makes this provable without staging fresh collaboration data of its own.
    await expect(picker.getByText("Suggested:")).toBeVisible({ timeout: 15_000 });
    const firstChip = picker.locator("button", { hasText: "+ " }).first();
    await expect(firstChip).toBeVisible();
    const chipName = ((await firstChip.textContent()) ?? "").replace(/^\+\s*/, "").trim();
    // Held by NAME from here on. The ✓/+ glyph is decoration the chip does not answer to, so the locator
    // keeps pointing at the same person once it is picked - "the first unpicked chip" would slide onto the
    // next one the moment this one is on.
    const anyChip = picker.getByRole("button", { name: chipName, exact: true });

    await anyChip.click();
    await expect(anyChip).toHaveAttribute("aria-pressed", "true");
    await expect(anyChip).toHaveText(`✓ ${chipName}`);
    // The same pick, on the same person's row in the list below - a chip that only painted itself would pass
    // this test and still leave the request unsent.
    await expect(picker.getByRole("checkbox", { name: chipName })).toBeChecked();

    // And back off again - the chip is a toggle, not a one-way "add".
    await anyChip.click();
    await expect(anyChip).toHaveAttribute("aria-pressed", "false");
    await expect(anyChip).toHaveText(`+ ${chipName}`);
    await expect(picker.getByRole("checkbox", { name: chipName })).not.toBeChecked();

    await manager.keyboard.press("Escape");
  } finally {
    await purge(hr, cycle.path);
  }
});

async function purgeLeftovers(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/review-cycles?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const c of results.filter((x) => (x.name ?? "").startsWith("E2E suggested"))) await purge(page, c.path);
}
