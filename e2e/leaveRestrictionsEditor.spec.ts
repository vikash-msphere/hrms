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

/**
 * Show one policy section.
 *
 * The nine sections are CHIPS inside the "Policy sections" group, not folds: one section is painted at a
 * time, so this selects rather than expands. Scoped to that group because the chips sit inside a dialog that
 * carries its own tabs, and short names like "Counting" are exactly the kind that answer to a loose query
 * somewhere else on the page.
 */
async function openSection(scope: { getByRole: Page["getByRole"] }, name: string) {
  const chip = scope.getByRole("group", { name: "Policy sections" }).getByRole("button", { name });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
}

/** The leave-type dialog's own tabs (Basics / Balance / Restrictions), which sit above the section chips. */
async function openDialogTab(form: { getByRole: Page["getByRole"] }, name: string) {
  await form.getByRole("tablist", { name: "Leave type sections" }).getByRole("tab", { name }).click();
}

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

    // The policy is its own tab now: this form was one scroll of about fifty controls before.
    await openDialogTab(form, "Restrictions");

    // INHERIT. The quota field is empty and says whose rule is in force instead - the state a rule is in
    // until somebody touches it, and the one that has no control of its own to show.
    await openSection(form, "Quota");
    // The section says what it is set to without anything having to be opened to read it.
    // `exact`, because getByText matches substrings too: the editor's own header says "Follows the org policy
    // in full", which contains this string. Same rule as getByLabel and getByRole({name}).
    await expect(form.getByText("Follows the org policy", { exact: true })).toBeVisible();
    // `exact`, because getByLabel matches a SUBSTRING of the accessible name by default - and every rule's
    // source toggle is named after the rule ("Days a year source"), so a loose query answers to both.
    const perYear = form.getByLabel("Days a year", { exact: true });
    // "<rule> source", not the rule's name: the name belongs to the input, and a group sharing it would take
    // the input's accessible name away.
    const source = form.getByRole("group", { name: "Days a year source", exact: true });
    await expect(perYear).toHaveValue("");
    // The three states are ONE control, the same shape on every rule. Which one is active is readable without
    // opening anything, which is what the four different idioms this replaced could not manage between them.
    await expect(source.getByRole("button", { name: "Org policy" })).toHaveAttribute("aria-pressed", "true");
    // Given room: the baseline was written from outside the app, so the tab may still be reconciling its
    // settings snapshot against the server when the dialog first paints.
    await expect(form.getByText("Inherits the org rule: 999")).toBeVisible({ timeout: 30_000 });

    // OVERRIDE. Typing a number makes it this type's own, and the sentence at the foot of the editor - the
    // same `describeRestrictions` the server's policy is written from - follows it immediately.
    await perYear.fill("12");
    await expect(form.getByText(/at most 12 days a calendar year/)).toBeVisible();
    await expect(source.getByRole("button", { name: "Custom" })).toHaveAttribute("aria-pressed", "true");
    // And the clause says WHOSE rule it is, which is the question the summary could not answer before: every
    // clause read the same whether the type had set it or was being handed it.
    await expect(form.getByText(/at most 12 days a calendar year/).locator("xpath=..")).toContainText("This type");
    await expect(form.getByText("Overrides 1 of the org's rules")).toBeVisible();

    // EXEMPT. "No limit" is the third state: the leaf is present and null, so the org's rule does not apply
    // to this type at all. Clearing the box would only put it back to inheriting.
    await source.getByRole("button", { name: "No limit" }).click();
    await expect(perYear).toBeDisabled();
    await expect(form.getByText("No limit - overrides the org rule")).toBeVisible();
    await expect(form.getByText(/at most \d+ days a calendar year/)).toHaveCount(0);
    // An exemption produces no clause at all, so it is stated in its own right - otherwise the one thing an
    // override is most often FOR is invisible in the summary of what the policy does.
    await expect(form.getByText(/Exempt from:.*Days a year/)).toBeVisible();

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
    await openDialogTab(form, "Restrictions");
    await openSection(form, "Notice & timing");
    // Where there is no org rule above it, the same control offers the two states that exist rather than
    // pretending at a third: "No rule" and "Set a rule".
    await form.getByRole("group", { name: "Advance notice required source", exact: true }).getByRole("button", { name: "Set a rule" }).click();

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
    // Selected, not clicked: the editor opens on the first section this type actually has rules in, so the
    // policy it carries is what you land on rather than an empty Eligibility panel.
    await openDialogTab(edit, "Restrictions");
    await expect(
      edit.getByRole("group", { name: "Policy sections" }).getByRole("button", { name: "Notice & timing" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(edit.getByLabel("Band 2 needs notice (days)")).toHaveValue("7");
    await expect(edit.getByLabel("Anything longer needs notice (days)")).toHaveValue("14");
    await edit.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });

    // The org-wide baseline is the same editor in Settings, over the same blob - the one screen that decides
    // what every type inherits. Asserted on the SHAPE rather than on a value: this key is org-wide, so a
    // spec that expects a particular figure in it is asserting about a row it does not own.
    // Straight to the Restrictions tab: it is deep-linked through `?tab=`, which is what makes "the org
    // baseline" a place a link can point at rather than a tab the reader has to know to pick.
    await gotoRoute(page, "settings/leave-policy?tab=restrictions");
    await expect(page.getByRole("group", { name: "Policy sections" })).toBeVisible({ timeout: 30_000 });
    await openSection(page, "Quota");
    await expect(page.getByLabel("Days a year", { exact: true })).toBeVisible();
    // In the org's own editor there is nothing above it to inherit from, so a scalar rule carries no source
    // control at all - an empty box IS "no rule", and a two-state toggle saying so beside forty of them would
    // be noise on the one screen where nothing is ever inherited.
    await expect(page.getByRole("group", { name: "Days a year source", exact: true })).toHaveCount(0);
    // And exactly one control is NAMED "Days a year" - the input. This is the guard against the collision
    // coming back: a toggle that took the rule's own name as its aria-label (rather than "<rule> source")
    // would make this two, and would have taken the input's accessible name away with it.
    await expect(page.getByLabel("Days a year", { exact: true })).toHaveCount(1);
  } finally {
    if (typePath) await retireLeaveType(page, typePath);
  }
});

// Forty rules across nine sections, and which section owns which rule is knowledge the reader does not have
// the first time. Search is the answer to "where is the blackout setting" that does not require them to have
// learned the layout first - and it has to reach rules in sections other than the one on screen, or it is just
// a filter over what was already visible.
test("a rule can be found by name, from whichever section is showing", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");

  await gotoRoute(page, "settings/leave-types");
  await page.getByRole("button", { name: "New leave type" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name", { exact: true }).fill(`E2E search ${Date.now()}`);
  await openDialogTab(form, "Restrictions");

  // Standing in Eligibility, which owns neither blackout rule.
  await openSection(form, "Eligibility");
  await form.getByLabel("Find a rule").fill("blackout");

  // Both of them, each saying which section it came from - the point of searching is not to avoid the
  // sections, it is to find out which one you needed.
  await expect(form.getByText("Closed periods")).toBeVisible();
  await expect(form.getByText("Block days of the month")).toBeVisible();
  await expect(form.getByText("2 rules match")).toBeVisible();

  // Clearing puts the sections back rather than leaving the reader in a filtered view they have to escape.
  await form.getByRole("button", { name: "Clear" }).click();
  await expect(form.getByRole("group", { name: "Policy sections" })).toBeVisible();

  await form.getByRole("button", { name: "Cancel" }).click();
  const discard = page.getByRole("button", { name: /Discard/ });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
});

// A rule the server would refuse is refused while the control that broke it is still on screen.
//
// The server's validation is strict and its answer is one sentence delivered after Save - which very often
// names a field inside a section the reader had folded, on a form that has just been submitted. The same
// refusals are made here against the blob as it is edited, so the answer arrives beside the two boxes that
// disagree rather than after a round trip.
test("an impossible rule is refused in the form, not after the round trip", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("super");

  await gotoRoute(page, "settings/leave-types");
  await page.getByRole("button", { name: "New leave type" }).first().click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Name", { exact: true }).fill(`E2E invalid ${Date.now()}`);

  await openDialogTab(form, "Restrictions");
  await openSection(form, "Request shape");
  // `exact` throughout: these are rule labels, so if the ORG baseline happens to set either of them - shared
  // state this spec does not own - each grows a "<rule> source" toggle beside it and a loose query matches
  // both. Exact keeps the spec independent of what the org's policy happens to hold while it runs.
  await form.getByLabel("Minimum per request", { exact: true }).fill("5");
  await form.getByLabel("Maximum per request", { exact: true }).fill("2");

  // Said once by the field and once by the banner at the head of the editor - the banner is what a reader
  // sees when the offending section is folded, which is the state nine of them are in by default.
  await expect(form.getByText("The minimum cannot exceed the maximum - no request could satisfy both.").first()).toBeVisible();
  await expect(form.getByRole("button", { name: "Create" })).toBeDisabled();

  // And it clears: a form that latches on the first bad keystroke is its own trap.
  await form.getByLabel("Maximum per request", { exact: true }).fill("10");
  await expect(form.getByRole("button", { name: "Create" })).toBeEnabled();

  await form.getByRole("button", { name: "Cancel" }).click();
  // Nothing was created - the dialog was never submitted. The discard guard may ask first, since the form
  // carries edits.
  const discard = page.getByRole("button", { name: /Discard/ });
  if (await discard.isVisible().catch(() => false)) await discard.click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
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
