import { SPA_HEADERS, gotoRoute, test, expect } from "./fixtures";

// Who sees which KPI card, and who decides.
//
// There are two separate answers, and both are only observable in a browser. The ORG's answer lives in the
// `settings/dashboard` blob: every card carries an audience (everyone / named roles / named people, or
// nothing at all, which means nobody), plus a coarse switch that turns a whole band off. The PERSON's answer
// is their own preferences row: a card they never want to look at is hidden from their dashboard, with a way
// back. Neither is access control - the numbers behind every card stay gated by their own collection - so
// there is no server behaviour to assert here at all: the fact IS the rendered dashboard.
//
// `dashboardLayout.spec.ts` owns the section order. This is the cards.
test.describe("KPI card visibility", () => {
  test("an admin takes a card off everyone's dashboard, and gives it back", async ({ as }) => {
    test.setTimeout(240_000);
    const admin = await as("super");
    const employee = await as("employee");
    // The blob is shared by the whole org and read on every dashboard load, so this spec leaves it as it
    // found it - a card left switched off would quietly change what `everyPage` renders and what
    // `requestBudget` counts. It also STARTS from that state: a run that died between the switch-off and the
    // switch-back leaves the card hidden, and the next run would then be asserting against its own leftover.
    const clean = withoutThisSpecsMarks(await dashboardConfig(admin));
    await writeDashboardConfig(admin, clean);

    // The card as an ordinary employee sees it. "Open support tickets" is one of the cards that ships
    // visible to everyone, and its number is drawn whether or not there is anything in it. Their PERSONAL
    // choices are cleared first: the org's answer and the reader's own are independent, and a card this
    // person had put away would look exactly like a card the org had withdrawn.
    await clearPersonalKpiPrefs(employee);
    await gotoRoute(employee, "dashboard");
    const card = employee.getByText("Open tickets", { exact: true });
    await expect(card).toBeVisible({ timeout: 30_000 });

    // The org's answer is edited per card, inside the band it belongs to - the bands start collapsed so the
    // editor stays short.
    await gotoRoute(admin, "settings/dashboard");
    await admin.getByRole("button", { name: /Needs attention/ }).click();
    const row = admin.locator("div").filter({ hasText: "Open support tickets" }).last();
    const audience = row.getByRole("button", { name: /^Visible to:/ });
    await expect(audience).toBeVisible({ timeout: 30_000 });

    // Everyone is a toggle, and switching it off leaves an audience that names nobody - which the summary
    // says in as many words rather than looking like "unset". Pressed until it does: a card that has never
    // been configured reads "Everyone (default)" and the first press CONFIGURES it as everyone, so how many
    // presses it takes depends on what the org has already done to this card.
    //
    // Found by its own description, NOT by the name "Everyone": the role chips below it include the
    // `everyone` pseudo-role (src/domain/grants.ts), whose label is also "Everyone" - and picking THAT names
    // a role nobody holds, which hides the card for a completely different reason.
    await audience.click();
    const everyone = admin.getByRole("button", { name: /All employees see this card/ });
    await expect(everyone).toBeVisible();
    await expect
      .poll(
        async () => {
          if (/No one/.test((await audience.innerText()) || "")) return true;
          await everyone.click();
          return /No one/.test((await audience.innerText()) || "");
        },
        { intervals: [200, 400, 800], timeout: 15_000 },
      )
      .toBe(true);
    await admin.keyboard.press("Escape");
    // Row-scoped: several cards ship visible to nobody, so the same words are elsewhere on this page.
    await expect(row.getByText("No one · hidden")).toBeVisible({ timeout: 30_000 });

    await admin.getByRole("button", { name: "Save KPIs" }).click();
    // What was stored is an audience that names nobody - not a role nobody holds, and not "unset".
    await expect.poll(() => cardAudience(admin), { timeout: 30_000 }).toEqual({});

    // And it is gone from the dashboard of somebody who was seeing it a moment ago.
    await employee.reload();
    await expect(employee.getByRole("main")).toBeVisible();
    await expect(employee.getByText("Open tickets", { exact: true })).toHaveCount(0, { timeout: 30_000 });

    // Shared again - the same control, the other way.
    await audience.click();
    await admin.getByRole("button", { name: /All employees see this card/ }).click();
    await admin.keyboard.press("Escape");
    await expect(row.getByText("Everyone", { exact: true })).toBeVisible({ timeout: 30_000 });
    await admin.getByRole("button", { name: "Save KPIs" }).click();
    await expect.poll(() => cardAudience(admin), { timeout: 30_000 }).toEqual({ everyone: true });

    await employee.reload();
    await expect(employee.getByRole("main")).toBeVisible();
    await expect(employee.getByText("Open tickets", { exact: true })).toBeVisible({ timeout: 30_000 });

    await writeDashboardConfig(admin, clean);
  });

  test("a whole band is switched off org-wide", async ({ as }) => {
    // Two 90s re-save retries (the config row is contested - see below), plus the reader's own reloads.
    test.setTimeout(420_000);
    const admin = await as("super");
    const employee = await as("employee");
    const clean = withoutThisSpecsMarks(await dashboardConfig(admin));
    await writeDashboardConfig(admin, clean);

    // A band is a set of cards, so the coarse switch has to take all of them - that is the whole reason it
    // exists next to the per-card rules.
    await clearPersonalKpiPrefs(employee);
    await gotoRoute(employee, "dashboard");
    await expect(employee.getByText("Needs attention")).toBeVisible({ timeout: 30_000 });

    await gotoRoute(admin, "settings/dashboard");
    const band = admin.getByRole("checkbox", { name: "Show Needs attention band" });
    await expect(band).toBeVisible({ timeout: 30_000 });
    // Pressed against the CHECKBOX's own state, not once and hoped for: this editor re-renders as the
    // dashboard config it is bound to settles, and a press that landed on the control mid-render toggles
    // nothing - after which the "Hidden" marks below can never appear.
    await expect(async () => {
      if (await band.isChecked()) await band.click({ timeout: 5_000 });
      await expect(band).not.toBeChecked({ timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    // The band reads as off in the editor before anything is saved, and its per-card rules stop mattering.
    await expect(admin.getByText("Hidden").first()).toBeVisible({ timeout: 15_000 });
    // Saved, and CONFIRMED on the org's own config row before the reader's dashboard is asked about it. The
    // band's state is one entry in `hiddenKpiCategories` there, so it says which way the switch really went -
    // a Save pressed while this editor was still settling writes the config unchanged, and then every read
    // below is asking the wrong question.
    //
    // RE-SAVED on a miss, because this row is contested: the whole `settings/dashboard` blob is read at
    // page-mount and written back entire (the deliberate single-admin last-write-wins - see
    // docs/settings-lost-update.md), so another dashboard spec saving its own edit in between drops this one.
    // A reload re-reads the blob as it now stands before the switch is thrown again, so the retry cannot
    // re-send a stale copy of somebody else's row.
    await expect(async () => {
      if (await bandHidden(admin)) return;
      await admin.reload();
      await expect(band).toBeVisible({ timeout: 15_000 });
      // Waited on until it AGREES WITH THE RECORD before it is touched. The panel paints its defaults and
      // fills them in from the stored blob a moment later, so a state read taken straight after a reload is
      // the default rather than the org's - and acting on it saves the config the panel is still holding.
      await expect.poll(() => band.isChecked().catch(() => null), { timeout: 20_000 }).toBe(true);
      await band.click({ timeout: 10_000 });
      await expect(band).not.toBeChecked({ timeout: 10_000 });
      await admin.getByRole("button", { name: "Save KPIs" }).click({ timeout: 10_000 });
      await expect.poll(() => bandHidden(admin), { timeout: 20_000 }).toBe(true);
    }).toPass({ timeout: 120_000 });

    await employee.reload();
    await expect(employee.getByRole("main")).toBeVisible();
    await expect(employee.getByText("Needs attention")).toHaveCount(0, { timeout: 30_000 });
    await expect(employee.getByText("Open tickets", { exact: true })).toHaveCount(0);

    // And back on, against the record for the same reason the switch-off is: a click that lands mid-render
    // toggles nothing, Save then writes the config unchanged, and the band the reader is waiting for never
    // comes back however long the wait.
    await expect(async () => {
      if (!(await bandHidden(admin))) return;
      await admin.reload();
      await expect(band).toBeVisible({ timeout: 15_000 });
      // The same wait as the switch-off, and the reason this restore could not make progress: the band ships
      // VISIBLE, so the freshly painted control reads "checked" for a band the record has hidden. Read
      // immediately, that says there is nothing to turn on - the switch is left alone, Save writes the hidden
      // blob straight back, and every retry repeats it until the budget is gone.
      await expect.poll(() => band.isChecked().catch(() => null), { timeout: 20_000 }).toBe(false);
      await band.click({ timeout: 10_000 });
      await expect(band).toBeChecked({ timeout: 10_000 });
      await admin.getByRole("button", { name: "Save KPIs" }).click({ timeout: 10_000 });
      await expect.poll(() => bandHidden(admin), { timeout: 20_000 }).toBe(false);
    }).toPass({ timeout: 120_000 });
    await employee.reload();
    await expect(employee.getByRole("main")).toBeVisible();
    await expect(employee.getByText("Needs attention")).toBeVisible({ timeout: 30_000 });

    await writeDashboardConfig(admin, clean);
  });

  test("a reader hides a card from their own dashboard, and restores it", async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as("employee");
    // A run that died with a card put away leaves it away, and a pinned card is drawn twice - so start from
    // a dashboard this reader has not customised.
    await clearPersonalKpiPrefs(page);
    await gotoRoute(page, "dashboard");

    // Their own choice, made on the card itself: the affordance appears on the card it hides, so nobody has
    // to find a settings page to stop looking at a number.
    const card = page.getByText("Open tickets", { exact: true });
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Exact, and it matters: the CARD is itself a button (it drills through to the page behind the number)
    // and its accessible name is everything written on it - including "Hide Open tickets". A substring match
    // therefore finds the card first, and pressing it navigates instead of hiding.
    await page.getByRole("button", { name: "Hide Open tickets", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText("Open tickets", { exact: true })).toHaveCount(0, { timeout: 30_000 });

    // Hidden, not lost: the count of what this reader has put away is offered back as one press.
    const restore = page.getByRole("button", { name: /^Show \d+ hidden$/ });
    await expect(restore).toBeVisible();

    // It is a preference, so it survives a reload rather than being a trick of this render.
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByText("Open tickets", { exact: true })).toHaveCount(0, { timeout: 30_000 });

    // And nobody else's dashboard moved - the org still shares the card, this reader just stopped reading it.
    const colleague = await as("hr");
    await gotoRoute(colleague, "dashboard");
    await expect(colleague.getByText("Open tickets", { exact: true })).toBeVisible({ timeout: 30_000 });

    // Put it back, so the next spec measures the dashboard this one found.
    await page.getByRole("button", { name: /^Show \d+ hidden$/ }).click();
    await expect(page.getByText("Open tickets", { exact: true })).toBeVisible({ timeout: 30_000 });
  });
});

/** The stored audience for the card this spec moves, so "what the org saved" is checked, not just the label. */
async function cardAudience(page: import("@playwright/test").Page): Promise<unknown> {
  const cfg = await dashboardConfig(page);
  return ((cfg.kpis as Record<string, unknown>) ?? {}).open_tickets;
}

/**
 * Clear this reader's own KPI pins and hides, leaving the rest of their dashboard preferences alone.
 *
 * The personal choice and the org's are separate mechanisms that produce the SAME absence on screen, so a
 * spec about one has to start from a clean slate on the other. Written over the wire rather than through the
 * restore chip because the chip only exists when something is hidden.
 */
async function clearPersonalKpiPrefs(page: import("@playwright/test").Page): Promise<void> {
  const res = await page.request.get("/v1/preferences/dashboard");
  const value = res.ok() ? (((await res.json()) as { value?: Record<string, unknown> }).value ?? {}) : {};
  const wrote = await page.request.patch("/v1/preferences/dashboard", {
    headers: SPA_HEADERS,
    data: { value: { ...value, hiddenKpis: [], pinnedKpis: [] } },
  });
  expect(wrote.status(), await wrote.text()).toBe(200);
}

/**
 * The org's config with this spec's fingerprints removed: the one card it switches off, and the one band.
 *
 * Restoring the blob VERBATIM would carry a dead run's leftovers forward forever, so the state this spec
 * starts and ends on is "whatever the org has configured, minus the two things this spec touches" - which is
 * the shipped default for both.
 */
function withoutThisSpecsMarks(cfg: Record<string, unknown>): Record<string, unknown> {
  const kpis = { ...((cfg.kpis as Record<string, unknown>) ?? {}) };
  delete kpis.open_tickets;
  const bands = ((cfg.hiddenKpiCategories as string[]) ?? []).filter((c) => c !== "attention");
  return { ...cfg, kpis, hiddenKpiCategories: bands };
}

/** Whether the "Needs attention" band is switched off ORG-WIDE - one entry in the config's own hidden list,
 *  which is the only place that says what a Save actually wrote. */
async function bandHidden(page: import("@playwright/test").Page): Promise<boolean> {
  const hidden = (await dashboardConfig(page)).hiddenKpiCategories as string[] | undefined;
  return (hidden ?? []).includes("attention");
}

/** The org's dashboard config as it stands, so a spec can put back exactly what it found. */
async function dashboardConfig(page: import("@playwright/test").Page): Promise<Record<string, unknown>> {
  const res = await page.request.get("/v1/settings/dashboard");
  if (!res.ok()) return {};
  return ((await res.json()) as { value?: Record<string, unknown> }).value ?? {};
}

/** Write the config. The blob is one shared row, and this spec is its only writer while it runs. */
async function writeDashboardConfig(
  page: import("@playwright/test").Page,
  value: Record<string, unknown>,
): Promise<void> {
  const res = await page.request.patch("/v1/settings/dashboard", { headers: SPA_HEADERS, data: { value } });
  expect(res.status(), await res.text()).toBe(200);
}
