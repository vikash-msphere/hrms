import { gotoRoute, inDays, purge, expect, test } from "./fixtures";

// Editing a delegation, not just adding or removing one.
//
// `overlapping` (the "already covered" warning) is computed by scanning every OTHER delegation against the
// form's current dates - `rows.filter((r) => r.path !== editing?.path && ...)`. That exclusion is the one line
// standing between "edit my own delegation" and "the form accuses me of colliding with myself" the moment its
// dates are touched at all. `delegations.spec.ts` only ever adds; this is the edit path, and the warning
// reappearing correctly once a SECOND person's delegation genuinely does overlap - proving the exclusion is
// keyed on identity, not a blanket suppression of the warning during an edit.
test("editing a delegation does not warn about itself, but still warns about someone else's", async ({ as }) => {
  test.setTimeout(90_000);
  const page = await as("super");
  const made: string[] = [];
  // Stamped: a bare "E2E delegation edit" is what an earlier failed run (one that died before its own
  // `finally` purge ran) would have left behind too, and every lookup below - the row filter, the reason
  // query, the row count - matches on this text alone. Unstamped, a stale orphan with that exact reason
  // outranks or shadows the row this run just made, and the "To" field read back at line ~42 belongs to
  // whichever delegation the orphan happens to be, not the one this run edited.
  const reason = `E2E delegation edit ${Date.now() % 1_000_000}`;

  try {
    await gotoRoute(page, "delegations", "Approval delegation");

    // The one under edit: Hank covers days 40-44.
    await pickDelegation(page, "Add delegation", "Hank", inDays(40), inDays(44), reason);
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
    made.push(await delegationByReason(page, reason));

    const row = page.locator("tbody tr").filter({ hasText: reason }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = page.getByRole("dialog");
    await expect(edit.getByRole("heading", { name: "Edit delegation" })).toBeVisible({ timeout: 15_000 });

    // Widening ITS OWN window (still 40-44, now 40-46) touches `form.to_date` - exactly what would trip the
    // overlap scan if the row being edited were not excluded from it.
    await edit.getByLabel("To", { exact: true }).fill(inDays(46));
    await expect(edit.getByText(/receives your approvals for 7 days/)).toBeVisible();
    await expect(edit.getByText("These days are already covered")).toHaveCount(0);
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

    // The edit actually landed (re-opened, the raw ISO date input reads the new value - not the display
    // text, whose exact format `formatDate` owns and this spec has no business predicting), and it updated
    // the one row rather than creating a second. Retried with a hard RELOAD each attempt: this list renders
    // from the shared client snapshot, and a pass can be handed one taken before the edit - a reload is what
    // re-establishes it from the server.
    await expect(async () => {
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Approval delegation" })).toBeVisible({ timeout: 15_000 });
      await row.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(edit.getByLabel("To", { exact: true })).toHaveValue(inDays(46), { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    // Re-pressed on a miss - Escape has proven unreliable at actually closing a dialog under load elsewhere
    // in this suite - and safe to repeat here because the pass above only re-opened the form to read it, so
    // there is no draft a second press could lose.
    await expect(async () => {
      if (!(await page.getByRole("dialog").count())) return;
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    }).toPass({ timeout: 20_000 });
    expect(await countDelegations(page, reason), "editing created a second row instead of updating the one").toBe(1);

    // A second person's delegation, genuinely inside that widened window, IS a real collision - the exclusion
    // above is for the row's own identity, not a suppression of the warning altogether.
    await page.getByRole("button", { name: "Add delegation" }).first().click();
    const second = page.getByRole("dialog");
    await pickDelegation(page, undefined, "Eve", inDays(42), inDays(43), `${reason} collide`, second);
    const overlapWarning = second.getByText("These days are already covered").locator("..");
    await expect(overlapWarning).toBeVisible({ timeout: 15_000 });
    // Scoped to the warning box, not the whole dialog: the "Covered by" combobox above it can leave its own
    // closed-but-still-mounted option list in the DOM (Hank being a pickable colleague too, unrelated to this
    // overlap), and a bare dialog-wide text match catches that name a second time.
    await expect(overlapWarning.getByText(/Hank Hr/)).toBeVisible();
    await page.keyboard.press("Escape");
    const discard = page.getByRole("dialog");
    const discardBtn = discard.getByRole("button", { name: /Discard|Leave/ });
    if (await discardBtn.count()) await discardBtn.first().click();
  } finally {
    for (const path of made) await purge(page, path).catch(() => undefined);
  }
});

/** Open (unless already open), fill and submit the Add-delegation form; returns the dialog used. */
async function pickDelegation(
  page: import("@playwright/test").Page,
  openWith: string | undefined,
  colleagueNeedle: string,
  from: string,
  to: string,
  reason: string,
  dialog?: import("@playwright/test").Locator,
): Promise<import("@playwright/test").Locator> {
  if (openWith) await page.getByRole("button", { name: openWith }).first().click();
  const form = dialog ?? page.getByRole("dialog");
  await form.getByLabel("Covered by").click();
  await page.getByPlaceholder(/Search|Pick/).last().fill(colleagueNeedle);
  const option = page.getByRole("option", { name: new RegExp(colleagueNeedle) });
  await expect(option).toBeVisible();
  await page.keyboard.press("Enter");
  await form.getByLabel("From").fill(from);
  await form.getByLabel("To", { exact: true }).fill(to);
  await form.getByLabel(/Reason/).fill(reason);
  if (!openWith) return form; // second delegation: caller reads the warning before deciding whether to submit
  await form.getByRole("button", { name: "Add", exact: true }).click();
  return form;
}

/** The delegation this spec created, by its reason text. */
async function delegationByReason(page: import("@playwright/test").Page, reason: string): Promise<string> {
  const res = await page.request.get("/v1/approval-delegations?page_size=100");
  expect(res.status(), await res.text()).toBe(200);
  const { results = [] } = (await res.json()) as { results?: { path: string; reason?: string }[] };
  const row = results.find((d) => d.reason === reason);
  if (!row) throw new Error(`e2e: no delegation with reason "${reason}"`);
  return row.path;
}

async function countDelegations(page: import("@playwright/test").Page, reason: string): Promise<number> {
  const res = await page.request.get("/v1/approval-delegations?page_size=100");
  const { results = [] } = (await res.json()) as { results?: { reason?: string }[] };
  return results.filter((d) => d.reason === reason).length;
}
