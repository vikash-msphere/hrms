import { apiPost, gotoRoute, purge, test, expect, SPA_HEADERS } from "./fixtures";
import type { Page } from "@playwright/test";

// The leave-policy editor, which is the only place the THREE STATES of a rule are visible.
//
// A leave type's restrictions blob is merged over the org-wide baseline per leaf: a leaf the type never
// mentions inherits, a leaf it sets overrides, and a leaf set to null EXEMPTS the type from the org's rule.
// `test/leaveRestrictions.test.ts` proves the merge; what it cannot prove is that the form can express all
// three - and a screen that can only say "inherit" and "override" makes an org-wide rule impossible to opt
// out of, which is the case every real policy has (sick leave, and everything else).
//
// The org baseline this writes is deliberately unreachable - a cap of 999 days a year refuses nothing - so it
// cannot disturb the specs filing leave in the same seconds. It is put back at the end either way.

/** Soft-delete, never `?force=true`: a type with requests against it has undeclared children and purges 409. */
async function retireLeaveType(page: Page, path: string) {
  const got = await page.request.get(`/v1/${path}`);
  if (!got.ok()) return;
  const { etag } = (await got.json()) as { etag: string };
  await page.request.delete(`/v1/${path}`, { headers: { ...SPA_HEADERS, "If-Match": etag } }).catch(() => undefined);
}

/** Write the org-wide baseline, carrying the etag the way the app's own forms do. */
async function setOrgRestrictions(page: Page, value: Record<string, unknown>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await page.request.get("/v1/settings/leave_restrictions");
    const body = res.ok() ? ((await res.json()) as { etag?: string }) : {};
    const wrote = await page.request.patch("/v1/settings/leave_restrictions", {
      headers: { ...SPA_HEADERS, ...(body.etag ? { "If-Match": body.etag } : {}) },
      data: { value },
    });
    if (wrote.ok()) return;
    if (wrote.status() !== 409) throw new Error(`e2e: could not write leave_restrictions: ${await wrote.text()}`);
  }
  throw new Error("e2e: kept losing the race writing leave_restrictions");
}

test("a leave type inherits an org rule, overrides it, or opts out of it", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const name = `E2E policy ${Date.now()}`;
  let typePath = "";

  // A cap no request could ever reach, so the whole org keeping it for the length of this spec changes
  // nothing for anybody filing leave beside it.
  await setOrgRestrictions(page, { quota: { max_days_per_year: 999 } });
  try {
    // A full document load, not just a hash change: the org's settings are held as ONE shared snapshot in the
    // tab (web/src/lib/settingsStore.ts), and this spec wrote the baseline from outside the app, so nothing
    // in the running page knows to drop it. Navigating between hash routes would keep serving the old copy.
    await page.reload();
    await gotoRoute(page, "settings/leave-types");
    await page.getByRole("button", { name: "New leave type" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name", { exact: true }).fill(name);

    // INHERIT. The quota field is empty and says whose rule is in force instead - the state a rule is in
    // until somebody touches it, and the one that has no control of its own to show.
    await form.getByRole("button", { name: "Quota" }).click();
    const perYear = form.getByLabel("Days a year");
    await expect(perYear).toHaveValue("");
    // Given room: the baseline was written from outside the app, so the tab may still be reconciling its
    // settings snapshot against the server when the dialog first paints.
    await expect(form.getByText("Inherits the org rule: 999")).toBeVisible({ timeout: 30_000 });

    // OVERRIDE. Typing a number makes it this type's own, and the sentence at the foot of the editor - the
    // same `describeRestrictions` the server's policy is written from - follows it immediately.
    await perYear.fill("12");
    await expect(form.getByText(/at most 12 days a calendar year/)).toBeVisible();

    // EXEMPT. "No limit" is the third state: the leaf is present and null, so the org's rule does not apply
    // to this type at all. Clearing the box would only put it back to inheriting.
    await form.getByRole("checkbox", { name: "No limit" }).first().check();
    await expect(perYear).toBeDisabled();
    await expect(form.getByText("No limit - overrides the org rule")).toBeVisible();
    await expect(form.getByText(/at most \d+ days a calendar year/)).toHaveCount(0);

    // Saved, and read back from the server rather than from the form that wrote it: the exemption is an
    // explicit null on the wire, and a serializer that dropped it would look identical in this dialog while
    // meaning the opposite thing.
    await form.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    const list = await page.request.get("/v1/leave-types?page_size=200");
    const { results = [] } = (await list.json()) as { results?: { path: string; display_name: string; restrictions?: Record<string, unknown> }[] };
    const saved = results.find((t) => t.display_name === name);
    expect(saved, "the new leave type should come back from the API").toBeTruthy();
    typePath = saved!.path;
    expect(saved!.restrictions).toEqual({ quota: { max_days_per_year: null } });
  } finally {
    if (typePath) await retireLeaveType(page, typePath);
    await setOrgRestrictions(page, {});
  }
});

test("the notice tiers survive a save, and the org tab shows the same editor", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const name = `E2E notice ${Date.now()}`;
  let typePath = "";

  try {
    // Built through the form, because the tiers are the one rule with a repeatable row: "two days for a day
    // off, a week for two" is two rows plus a figure for everything longer, and a form that loses the second
    // row on save is a policy that silently stops applying past the first tier.
    await gotoRoute(page, "settings/leave-types");
    await page.getByRole("button", { name: "New leave type" }).first().click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByRole("button", { name: "Notice & timing" }).click();
    await form.getByRole("checkbox", { name: "Advance notice required" }).check();

    // Every row states the band it covers - the top is typed, the bottom is wherever the row above stopped -
    // so there is no "between two tiers" left for a reader to guess at.
    await form.getByLabel("Band 1 covers leave up to (days)").fill("1");
    await form.getByLabel("Band 1 needs notice (days)").fill("2");
    await form.getByRole("button", { name: "Add a band" }).click();
    await form.getByLabel("Band 2 covers leave up to (days)").fill("5");
    await form.getByLabel("Band 2 needs notice (days)").fill("7");
    // The second row says where it starts - which is where the first one stopped, so nothing falls between.
    await expect(form.getByText("Over 1 day, up to", { exact: true })).toBeVisible();

    // The open-ended last band is a row of the ladder, not a field underneath it: until it is filled in, the
    // editor says out loud that long requests need no notice at all.
    await expect(form.getByText("no notice required")).toBeVisible();
    await form.getByLabel("Anything longer needs notice (days)").fill("14");
    await expect(form.getByText("no notice required")).toHaveCount(0);

    // The sentence says the whole ladder back before it is saved, in the same band language.
    await expect(form.getByText(/notice: up to 1 day needs 2 days; over 1 day, up to 5 days needs 7 days; over 5 days needs 14 days/)).toBeVisible();

    await form.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    const list = await page.request.get("/v1/leave-types?page_size=200");
    const { results = [] } = (await list.json()) as { results?: { path: string; display_name: string; restrictions?: { timing?: { advance_notice?: { tiers?: unknown[]; beyond_notice_days?: number } } } }[] };
    const saved = results.find((t) => t.display_name === name);
    expect(saved).toBeTruthy();
    typePath = saved!.path;
    expect(saved!.restrictions?.timing?.advance_notice).toEqual({
      tiers: [{ up_to_days: 1, notice_days: 2 }, { up_to_days: 5, notice_days: 7 }],
      beyond_notice_days: 14,
    });

    // Reopened from the server's copy - the record's own deep link, which is what a link to a leave type in
    // an email or a search result opens - so what the form shows is what was stored rather than the state it
    // happened to be left in.
    await gotoRoute(page, `settings/leave-types/${typePath.split("/")[1]}`);
    const edit = page.getByRole("dialog");
    await expect(edit.getByRole("heading", { name: "Edit leave type" })).toBeVisible({ timeout: 30_000 });
    await edit.getByRole("button", { name: "Notice & timing" }).click();
    await expect(edit.getByLabel("Band 2 needs notice (days)")).toHaveValue("7");
    await expect(edit.getByLabel("Anything longer needs notice (days)")).toHaveValue("14");
    await edit.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // The org-wide baseline is the same editor in Settings, over the same blob - the one screen that decides
    // what every type inherits. Asserted on the SHAPE rather than on a value: this key is org-wide, so a
    // spec that expects a particular figure in it is asserting about a row it does not own.
    await gotoRoute(page, "settings/leave-policy");
    await page.getByRole("tab", { name: "Restrictions" }).click();
    await page.getByRole("button", { name: "Quota" }).click();
    await expect(page.getByLabel("Days a year")).toBeVisible({ timeout: 30_000 });
    // In the org's own editor there is nothing above it to inherit from, so the third state is not offered.
    await expect(page.getByRole("checkbox", { name: "No limit" })).toHaveCount(0);
  } finally {
    if (typePath) await retireLeaveType(page, typePath);
  }
});

// A rule the server would refuse has to be refused in the FORM too: `.strict()` on the write schema turns a
// mistyped rule into a 400, and a policy screen that saves cleanly and enforces nothing is the failure this
// whole feature exists to avoid. Driven through the API because no form can produce the bad shape.
test("a nonsense rule is refused rather than stored", async ({ as }) => {
  const page = await as("super");
  const bad = await apiPost(page, "leave-types", {
    display_name: `E2E bad ${Date.now()}`,
    restrictions: { quota: { max_days_per_fortnight: 2 } },
  });
  expect(bad.status(), await bad.text()).toBe(400);

  // Nor one that could never be satisfied.
  const impossible = await apiPost(page, "leave-types", {
    display_name: `E2E impossible ${Date.now()}`,
    restrictions: { request: { min_days: 5, max_days: 2 } },
  });
  expect(impossible.status(), await impossible.text()).toBe(400);

  // A waiver naming a rule that does not exist waives nothing, so it is refused rather than stored.
  const typo = await apiPost(page, "leave-types", {
    display_name: `E2E typo ${Date.now()}`,
    restrictions: { soft_rules: ["advance_notiec"] },
  });
  expect(typo.status(), await typo.text()).toBe(400);

  // Nothing was created by any of the three.
  const list = await page.request.get("/v1/leave-types?page_size=200");
  const { results = [] } = (await list.json()) as { results?: { path: string; display_name: string }[] };
  for (const t of results.filter((r) => /^E2E (bad|impossible|typo) /.test(r.display_name))) await purge(page, t.path);
  expect(results.filter((r) => /^E2E (bad|impossible|typo) /.test(r.display_name))).toHaveLength(0);
});
