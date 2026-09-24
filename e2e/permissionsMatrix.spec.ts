import { SPA_HEADERS, accessRules, gotoRoute, toast, test, expect } from "./fixtures";

// The org-wide grid: every collection down the side, every role across the top.
//
// `accessAdmin` proves a new role gains a COLUMN here and stops at the sight of it. The grid itself - the
// only surface in the app that answers "who can do what, across everything" in one screen - has never had a
// cell changed in a browser, and it is not a read-out: each cell is a live level control that writes the same
// `access-rules` row the modal writes (edit = delete + create), and the key beside it is the way from the
// wide view into the per-collection editor. A grid that displays correctly and saves nothing looks exactly
// like a working grid, and the way anyone would find out is by trusting it.
//
// Everything is done to a throwaway role: a wrong press on a seeded one changes what the rest of the suite is
// being asked to prove. The collection is `letter-templates`, which owns no sidebar entry, so a stray grant
// cannot move another spec's nav or route assertions either.
test("a level is set from the matrix, reads back, and the cell's key opens that collection's editor", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
  const name = `e2e_matrix_${stamp}`;
  const label = `E2E Matrix Role ${stamp}`;

  const made = await page.request.post("/v1/roles", { headers: SPA_HEADERS, data: { name, label } });
  expect(made.status(), await made.text()).toBe(200);

  try {
    await gotoRoute(page, "settings/permissions", "Permissions");
    await page.getByPlaceholder("Filter collections…").fill("Letter templates");

    // The role's own column, found by its header rather than by counting: the column order is the roles
    // collection's order, and a seeded joiner would silently shift a hardcoded index onto somebody else.
    // Polled: the header row renders in a burst as each role's column streams in, and reading it inline
    // (once, right after typing the filter) can catch it before the new role's own column has arrived.
    await expect(page.getByRole("columnheader", { name: label })).toBeVisible({ timeout: 30_000 });
    const headers = (await page.locator("thead th").allInnerTexts()).map((t) => t.trim());
    const column = headers.indexOf(label);
    expect(column, `the new role has no column in the matrix (headers: ${headers.join(", ")})`).toBeGreaterThan(0);

    const row = page.locator("tbody tr").filter({ hasText: "Letter templates" }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    const cell = row.locator("td").nth(column);
    const level = cell.getByRole("combobox");
    await expect(level).toContainText("none");

    await level.click();
    await page.getByRole("option", { name: /^read$/i }).click();
    await expect(toast(page, `Updated ${label} · Letter templates`)).toBeVisible({ timeout: 30_000 });
    await expect(level).toContainText("read");

    const rule = (await accessRules(page)).find((r) => r.subject === name && r.collection === "letter-templates");
    expect(rule?.subject_kind).toBe("role");
    expect(rule?.level, "the matrix cell wrote no rule").toBe("read");
    expect(rule?.scope).toBe("all");

    // The key beside the cell is the way IN to everything the grid cannot show - scopes, fields, methods,
    // single objects. A grid that could only set one number would be a dead end.
    await cell.getByRole("button").click();
    const editor = page.getByRole("dialog");
    await expect(editor.getByRole("heading", { name: /Manage access · Letter templates/ })).toBeVisible({ timeout: 30_000 });
    // And it opens on the same rule the cell just wrote, seen from the other surface.
    await editor.getByRole("tab", { name: /^Roles/ }).click();
    const filter = editor.getByPlaceholder("Filter roles…");
    if (await filter.count()) await filter.fill(label);
    await expect(editor.getByText(label).first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);

    // Back to none, through the same cell: the grid takes access away as well as handing it out.
    await level.click();
    await page.getByRole("option", { name: /^none$/i }).click();
    // No second toast assertion here. Both writes announce themselves in the SAME words, and the first toast
    // lives ~5s - long enough to still be on screen, which made this a strict-mode violation ("resolved to 2
    // elements") whenever the steps between them were quick. Asserting it with `.first()` would be worse than
    // dropping it: the leftover toast satisfies the check on its own, so it would pass whether or not this
    // write announced anything. The cell and the rule below are the claim, and neither can be answered by a
    // toast from the previous step.
    await expect(level).toContainText("none");
    expect((await accessRules(page)).find((r) => r.subject === name && r.collection === "letter-templates")).toBeUndefined();
  } finally {
    for (const rule of await accessRules(page)) {
      if (rule.subject === name) await page.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
    // deleteRole drops the role's own access-rules rows and takes no If-Match: roles are a bespoke router.
    await page.request.delete(`/v1/roles/${name}`, { headers: SPA_HEADERS }).catch(() => undefined);
  }
});

// A section's header row sets one level on every collection listed under it. The filter narrows the section
// to `letter-templates` + `letterheads`, so this also proves the write stops at what is shown: the other
// Onboarding & compliance collections are hidden and must come out of it with no rule.
test("a section header sets a level on every collection shown under it, and reads mixed when they differ", async ({ as }) => {
  test.setTimeout(300_000);
  const page = await as("super");
  const stamp = `${test.info().parallelIndex}${Date.now() % 1_000_000}`;
  const name = `e2e_matrix_group_${stamp}`;
  const label = `E2E Matrix Group ${stamp}`;
  const group = "Onboarding & compliance";
  const shown = ["letter-templates", "letterheads"];

  const made = await page.request.post("/v1/roles", { headers: SPA_HEADERS, data: { name, label } });
  expect(made.status(), await made.text()).toBe(200);

  try {
    await gotoRoute(page, "settings/permissions", "Permissions");
    await page.getByPlaceholder("Filter collections…").fill("letter");
    await expect(page.getByRole("columnheader", { name: label })).toBeVisible({ timeout: 30_000 });
    const headers = (await page.locator("thead th").allInnerTexts()).map((t) => t.trim());
    const column = headers.indexOf(label);
    expect(column, `the new role has no column in the matrix (headers: ${headers.join(", ")})`).toBeGreaterThan(0);

    const header = page.locator("tbody tr").filter({ hasText: group }).first();
    const groupLevel = header.locator("td").nth(column).getByRole("combobox");
    await expect(groupLevel).toContainText("none", { timeout: 30_000 });

    await groupLevel.click();
    await page.getByRole("option", { name: /^read$/i }).click();
    const ask = page.getByRole("dialog").filter({ hasText: `Set ${group} to "read" for ${label}?` });
    await expect(ask).toBeVisible({ timeout: 15_000 });
    await expect(ask).toContainText("hidden by the current filter are not changed");
    await ask.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(toast(page, `Updated ${label} · ${group}`)).toBeVisible({ timeout: 30_000 });
    await expect(groupLevel).toContainText("read");

    const mine = (await accessRules(page)).filter((r) => r.subject === name);
    expect(mine.map((r) => r.collection).sort(), "the header wrote rules outside the rows it showed").toEqual(shown);
    for (const r of mine) {
      expect(r.level).toBe("read");
      expect(r.scope).toBe("all");
    }

    // One row moved on its own: the header stops claiming a single level for the section.
    const row = page.locator("tbody tr").filter({ hasText: "Letterheads" }).first();
    await row.locator("td").nth(column).getByRole("combobox").click();
    await page.getByRole("option", { name: /^write$/i }).click();
    await expect(groupLevel).toContainText("mixed", { timeout: 30_000 });

    // And back to none through the header, which takes access away as well as handing it out.
    await groupLevel.click();
    await page.getByRole("option", { name: /^none$/i }).click();
    const clear = page.getByRole("dialog").filter({ hasText: `Set ${group} to "none" for ${label}?` });
    await clear.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(groupLevel).toContainText("none", { timeout: 30_000 });
    expect((await accessRules(page)).filter((r) => r.subject === name)).toEqual([]);
  } finally {
    for (const rule of await accessRules(page)) {
      if (rule.subject === name) await page.request.delete(`/v1/${rule.path}?force=true`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
    await page.request.delete(`/v1/roles/${name}`, { headers: SPA_HEADERS }).catch(() => undefined);
  }
});
