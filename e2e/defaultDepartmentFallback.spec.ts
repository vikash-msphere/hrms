import { SPA_HEADERS, gotoRoute, purge, test, expect, toast } from "./fixtures";

// The org-wide default department (web/src/pages/Settings.tsx's "Company details" tab) - never touched
// through the UI before this, even though the fallback it drives (src/services/settings.ts's
// getDefaultDepartmentId, read by both cards and tickets when none is otherwise supplied) is real and
// already load-bearing. Set through the Select, it has to survive a reload, and a board card created with no
// department of its own has to actually pick it up - a setting saved but never applied would look identical
// from the form alone.
test("the org default department is saved from the settings form and a card with no department of its own picks it up", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = Date.now() % 100000;
  const deptLabel = `E2E Default Dept ${stamp}`;

  const madeDept = await page.request.post("/v1/departments", {
    headers: SPA_HEADERS,
    data: { display_name: deptLabel },
  });
  expect(madeDept.status(), await madeDept.text()).toBe(200);
  const dept = (await madeDept.json()) as { path: string };

  // What was there before, so it can be put back exactly - this is a singleton every other org-wide feature
  // reads, not a fixture of this spec's own.
  const before = await page.request.get("/v1/settings/organization");
  const previous = before.ok() ? ((await before.json()) as { value?: { default_department?: string | null } }).value?.default_department ?? null : null;

  let boardId: string | undefined;
  try {
    await gotoRoute(page, "settings/identity");
    await page.getByRole("tab", { name: "Company details" }).click();

    // The field is the innermost div carrying BOTH the label and the combobox it labels. On `hasText` alone,
    // `.last()` resolves to whichever nested div is deepest - the bare label, or the hint under it - and the
    // click then waits out its timeout for a combobox that was never inside what was picked.
    const field = page.locator("div").filter({ hasText: "Default department" }).filter({ has: page.getByRole("combobox") }).last();
    await field.getByRole("combobox").click();
    await page.getByRole("option", { name: deptLabel, exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page, "Organization saved")).toBeVisible({ timeout: 30_000 });

    // Survives a reload - not just the form's own local state.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Company details" }).click();
    const field2 = page.locator("div").filter({ hasText: "Default department" }).filter({ has: page.getByRole("combobox") }).last();
    await expect(field2.getByRole("combobox")).toContainText(deptLabel, { timeout: 30_000 });

    // The downstream half: a card made with no department of its own picks up what the form just saved.
    const boardRes = await page.request.post("/v1/boards", { headers: SPA_HEADERS, data: { name: `E2E default dept board ${stamp}` } });
    expect(boardRes.status(), await boardRes.text()).toBe(200);
    const board = (await boardRes.json()) as { path: string };
    boardId = board.path.split("/")[1]!;
    const cardRes = await page.request.post("/v1/cards", {
      headers: SPA_HEADERS,
      data: { board: board.path, title: `E2E default dept card ${stamp}`, column_key: "backlog" },
    });
    expect(cardRes.status(), await cardRes.text()).toBe(200);
    const card = (await cardRes.json()) as { department?: string };
    expect(card.department).toBe(dept.path);
  } finally {
    await restoreDefaultDepartment(page, previous);
    if (boardId) {
      const cards = await page.request.get(`/v1/cards?page_size=200&board=boards/${boardId}`);
      if (cards.ok()) {
        const { results = [] } = (await cards.json()) as { results?: { path: string }[] };
        for (const c of results) await purge(page, c.path);
      }
      await purge(page, `boards/${boardId}`);
    }
    await purge(page, dept.path);
  }
});

async function restoreDefaultDepartment(page: import("@playwright/test").Page, value: string | null) {
  const current = await page.request.get("/v1/settings/organization");
  const blob = current.ok() ? ((await current.json()) as { value?: Record<string, unknown> }).value ?? {} : {};
  await page.request.patch("/v1/settings/organization", {
    headers: SPA_HEADERS,
    data: { value: { ...blob, default_department: value } },
  });
}
