import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

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
  const extra = `E2E extra task ${Date.now() % 100000}`;

  // The process, over the wire: starting one is `onboarding.spec.ts`'s subject.
  const made = await page.request.post("/v1/transitions", {
    headers: SPA_HEADERS,
    data: { employee: await someone(page), kind: "onboarding", name: "E2E onboarding", anchor_date: new Date().toISOString().slice(0, 10) },
  });
  expect(made.status(), await made.text()).toBe(200);
  const transition = (await made.json()) as { path: string };

  await gotoRoute(page, "transitions", "Onboarding & Offboarding");
  const card = page.locator("div").filter({ hasText: "Eve Employee" }).last();
  await expect(card).toBeVisible({ timeout: 30_000 });

  // A task the template never thought of: every onboarding has one, so the list takes additions rather than
  // being fixed at whatever the template said.
  const add = page.getByPlaceholder("Add a task…").first();
  await add.fill(extra);
  await add.press("Enter");
  // `.first()`: the task shows on the checklist and again in the process's own summary line.
  await expect(page.getByText(extra).first()).toBeVisible({ timeout: 30_000 });

  // Ticked, and put back: the reopen is the half that only exists because people tick the wrong line.
  // The tick is a button that swaps between "Mark done" and "Reopen" rather than a checkbox: completing a
  // task is a verb on the record (`transition-tasks:complete`), not a field somebody edits.
  await page.getByRole("button", { name: "Mark done" }).first().click();
  await expect(page.getByRole("button", { name: "Reopen", exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Reopen", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Mark done" }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Mark done" }).first().click();
  await expect(page.getByRole("button", { name: "Reopen", exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // And closing the process, which is a decision about the person rather than about the list.
  await page.getByRole("button", { name: /^Complete/ }).first().click();
  const confirm = page.getByRole("dialog");
  const asked = await confirm.getByRole("button", { name: /Complete|Confirm/ }).first()
    .waitFor({ state: "visible", timeout: 5_000 }).then(() => true).catch(() => false);
  if (asked) await confirm.getByRole("button", { name: /Complete|Confirm/ }).last().click();

  // Closed, and offering the way back: a process completed by mistake has to be reopenable.
  await expect(page.getByRole("button", { name: /^Reopen/ }).first()).toBeVisible({ timeout: 30_000 });

  await purge(page, transition.path);
});

/** Somebody to run a process for. */
async function someone(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.get("/v1/employees?page_size=100");
  const { results = [] } = (await res.json()) as { results?: { path: string; first_name?: string }[] };
  const eve = results.find((e) => e.first_name === "Eve") ?? results[0];
  if (!eve) throw new Error("e2e: the org has nobody to onboard");
  return eve.path;
}
