import { SPA_HEADERS, allowConsoleErrors, gotoRoute, purge, test, expect, toast } from "./fixtures";

// Running somebody's first week - the checklist, not the record.
//
// `onboarding.spec.ts` starts a process from a template. What it leaves untested is the work: a task ticked
// off, a task put back (people tick the wrong line), a task added that the template never thought of, and
// the process itself closed once nothing is left. Those are four verbs (`transition-tasks:complete` /
// `:reopen`, `transitions:appendTask` / `:complete`) and every one of them is a press on this page.
// `test/transitions.test.ts` owns what completing does to the record; this owns the checklist somebody
// actually works from.
test("an onboarding checklist is ticked, corrected, added to, and closed", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("hr");
  // A dev Worker restart mid-request on a busy lane, the same rare hiccup documented elsewhere in this suite
  // (complianceRuleDelete.spec.ts et al.). Every step below is proved by what the checklist reads back, which
  // a console line from a request retried behind it says nothing about.
  allowConsoleErrors(page, /status of 503|status of 500/i);
  const extra = `E2E extra task ${Date.now() % 100000}`;

  // Self-healing: a prior run interrupted after this same "E2E onboarding" process was created (a failed
  // assertion partway through, before the cleanup at the end ever ran) leaves it behind, and the next run
  // then finds two "Eve Employee" cards instead of one.
  const priorRuns = await page.request.get("/v1/transitions?page_size=50");
  const { results: priorResults = [] } = (await priorRuns.json()) as { results?: { path: string; name?: string }[] };
  for (const t of priorResults.filter((t) => t.name === "E2E onboarding")) await purge(page, t.path);

  // The process, over the wire: starting one is `onboarding.spec.ts`'s subject. `template` is optional on
  // create (an automation naming a template HR has since renamed still opens the process, empty rather than
  // not at all) - omitted, this spec's own checklist would open empty too, since nothing seeds a custom
  // template to fall back to implicitly. Named explicitly to get the shipped default's tasks, the ID-upload
  // one included.
  const made = await page.request.post("/v1/transitions", {
    headers: SPA_HEADERS,
    data: { employee: await someone(page), kind: "onboarding", name: "E2E onboarding", template: "default-onboarding", anchor_date: new Date().toISOString().slice(0, 10) },
  });
  expect(made.status(), await made.text()).toBe(200);
  const transition = (await made.json()) as { path: string };

  await gotoRoute(page, "transitions", "Onboarding & Offboarding");
  // By its own id (Onboarding.tsx: `id="transition-<id>"` on the Card, the same convention Reviews' own cards
  // use), not by "Eve Employee" - `onboarding.spec.ts` runs its own onboarding for the same seeded person, and
  // the two specs' transitions can both be live on the page at once under concurrency, matching text either
  // spec's card carries in more than one place at once (a name-only or text-only locator kept resolving to
  // more than one element here, never reliably the same "more than one" twice).
  const card = page.locator(`#transition-${transition.path.split("/").pop()}`);
  await expect(card).toBeVisible({ timeout: 30_000 });

  // A task the template never thought of: every onboarding has one, so the list takes additions rather than
  // being fixed at whatever the template said.
  const add = page.getByPlaceholder("Add a task…").first();
  await add.fill(extra);
  await add.press("Enter");
  // `.first()`: the task shows on the checklist and again in the process's own summary line.
  await expect(page.getByText(extra).first()).toBeVisible({ timeout: 30_000 });

  // A document-collection task: the default onboarding template (src/domain/transitions.ts) seeds one for a
  // government ID, and its whole point is that ticking it off is not a checkbox - it takes an actual upload,
  // which nothing has ever pressed. HR can attach it directly from the checklist (the assignee's own "Your
  // tasks" widget is the other route to the same upload, `canManage` here reaches it just as well).
  const idTaskRow = card.locator("div").filter({ hasText: "Upload a government ID proof" }).last();
  await expect(idTaskRow).toBeVisible({ timeout: 30_000 });
  await expect(idTaskRow.getByText("ID", { exact: true })).toBeVisible();
  await idTaskRow.getByRole("button", { name: "Upload" }).click();
  await idTaskRow.locator('input[type="file"]').setInputFiles({
    name: "e2e-id-proof.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n%E2E id proof\n"),
  });
  // Through `toast()`, not a bare text match: the toaster also renders a screen-reader announcement with the
  // same words in a `role="status"` live region beside the toast itself - a plain `getByText` catches both.
  await expect(toast(page, "Document uploaded")).toBeVisible({ timeout: 30_000 });
  // The upload button is gone, replaced by the way to read back what was attached.
  await expect(idTaskRow.getByRole("button", { name: "Upload" })).toHaveCount(0, { timeout: 30_000 });
  // Its accessible name is the doc type ("ID"), not the tooltip - the button is titled "View uploaded
  // document" for a mouse, but its visible (and accessible) text is the badge it replaced.
  const viewDoc = idTaskRow.locator('button[title="View uploaded document"]');
  await expect(viewDoc).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), viewDoc.click()]);
  expect(download.suggestedFilename()).toBeTruthy();

  // Ticked, and put back: the reopen is the half that only exists because people tick the wrong line.
  // The tick is a button that swaps between "Mark done" and "Reopen" rather than a checkbox: completing a
  // task is a verb on the record (`transition-tasks:complete`), not a field somebody edits.
  // Scoped to THIS card throughout: `onboarding.spec.ts` runs its own process (with its own tasks, its own
  // Complete/Cancel/Delete) for the same person concurrently, and a page-wide `.first()` on any of these can
  // silently act on that other process instead of this one.
  await card.getByRole("button", { name: "Mark done" }).first().click();
  await expect(card.getByRole("button", { name: "Reopen", exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Reopen", exact: true }).first().click();
  await expect(card.getByRole("button", { name: "Mark done" }).first()).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Mark done" }).first().click();
  await expect(card.getByRole("button", { name: "Reopen", exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // And closing the process, which is a decision about the person rather than about the list. Scoped to the
  // card's own footer (identified by the Delete button beside it, always offered): a bare page-wide
  // `getByRole("button", { name: /^Reopen/ })` is ambiguous with the ID-proof task's own per-task toggle,
  // which reads "Reopen" too once THAT task is marked done (as it is here, from the tick/untick above) -
  // `.first()` on the unscoped locator would silently un-complete that task instead of reopening the process.
  const footer = card.locator("div").filter({ has: page.getByRole("button", { name: "Delete", exact: true }) }).last();
  const reopenProcess = footer.getByRole("button", { name: "Reopen", exact: true });
  // A fixed "did a confirm dialog show up" window used to decide whether to answer one, and a dialog slow to
  // render under load (not absent) read as "none coming" and was left unanswered - stuck ACTIVE forever, which
  // is exactly the state this then waited 30s for Reopen from. Polled instead, the press itself included: the
  // card re-renders on any task/process write broadcast org-wide (a broad, collection-level invalidation, not
  // scoped to this one transition), and a Complete press that lands on a button about to be replaced by a
  // re-render is a press that never reached the server at all - re-pressing (once Reopen still is not there
  // and no dialog is open to answer) is what recovers from that, not just waiting longer on the first one.
  await expect(async () => {
    const confirm = page.getByRole("dialog");
    const ask = confirm.getByRole("button", { name: /Complete|Confirm/ }).last();
    if (await ask.count()) {
      await ask.click();
    } else if (!(await reopenProcess.count())) {
      await card.getByRole("button", { name: /^Complete/ }).first().click({ timeout: 5_000 });
    }
    await expect(reopenProcess).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
  await reopenProcess.click();
  // Reopened for real, not just re-offered: it goes back ACTIVE on the wire, and the card offers Complete
  // again rather than staying stuck on a Reopen button nothing behind it ever answers.
  await expect
    .poll(async () => {
      const r = await page.request.get(`/v1/${transition.path}`);
      return r.ok() ? ((await r.json()) as { state?: string }).state : "unreadable";
    }, { timeout: 30_000 })
    .toBe("ACTIVE");
  await expect(card.getByRole("button", { name: /^Complete/ }).first()).toBeVisible({ timeout: 30_000 });

  // Cancel: the other way an active process ends, offered right beside Complete and never pressed anywhere -
  // no confirmation gates it (only completing an OFFBOARDING does, since that terminates someone).
  await card.getByRole("button", { name: /^Cancel/ }).first().click();
  await expect
    .poll(async () => {
      const r = await page.request.get(`/v1/${transition.path}`);
      return r.ok() ? ((await r.json()) as { state?: string }).state : "unreadable";
    }, { timeout: 30_000 })
    .toBe("CANCELLED");

  // Delete: offered on the card regardless of state (unlike Complete/Cancel/Reopen, it needs no ACTIVE or
  // terminal state) and never pressed by anything before this - cleanup here always went straight through the
  // API instead, never through the button itself. Asks first, naming the process by name.
  await card.getByRole("button", { name: "Delete", exact: true }).first().click();
  const deleteConfirm = page.getByRole("dialog").filter({ hasText: "Delete the" });
  await expect(deleteConfirm).toBeVisible({ timeout: 30_000 });
  await deleteConfirm.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(card).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(async () => {
      const r = await page.request.get(`/v1/${transition.path}`);
      if (!r.ok()) return "unreadable";
      return !!((await r.json()) as { delete_time?: string }).delete_time;
    }, { timeout: 30_000 })
    .toBe(true);

  await purge(page, transition.path); // hard purge - a plain delete above is only ever soft
});

/** Somebody to run a process for. */
async function someone(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get("/v1/employees?page_size=100");
  const { results = [] } = (await res.json()) as { results?: { path: string; first_name?: string }[] };
  const eve = results.find((e) => e.first_name === "Eve") ?? results[0];
  if (!eve) throw new Error("e2e: the org has nobody to onboard");
  return eve.path;
}
