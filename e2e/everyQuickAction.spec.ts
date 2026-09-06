import { readFileSync } from "node:fs";
import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Every "+" and ⌘K action, run.
//
// A quick action is two moves in one press: navigate to the page that owns the flow, then fire an intent the
// page picks up on mount and opens its create dialog from. `quickCreate` proves the mechanism on one of them.
// This walks the registry - and the registry is exactly the kind of list that rots, because an action whose
// intent nobody handles any more still renders, still navigates, and simply does nothing when it lands.
//
// The list is checked against `lib/quickActions.ts`, so an action added without a line here fails the spec.
// Two of them are deliberately not RUN, and say why: punching the clock is a real write on a shared seeded
// person (`clock` owns it), and reporting a problem starts a session recording (`reportProblem` owns that).
// Everything else is walked and then abandoned - the dialogs are opened and closed, never submitted.
type Action = {
  id: string;
  /** The route the press must land on. */
  route: string;
  /** Skipped, with the reason - which is what makes an exclusion reviewable rather than a hole. */
  skip?: string;
};

const ACTIONS: Action[] = [
  { id: "request-leave", route: "leave-requests" },
  { id: "new-overtime", route: "overtime" },
  { id: "new-remote", route: "remote-work" },
  { id: "new-asset-request", route: "profile" },
  { id: "new-reimbursement", route: "reimbursements" },
  { id: "new-expense", route: "expenses" },
  { id: "quick-expense", route: "expenses" },
  { id: "new-loan", route: "loans" },
  { id: "new-tax", route: "tax-declarations" },
  { id: "new-referral", route: "referrals" },
  { id: "new-suggestion", route: "suggestions" },
  { id: "new-ticket", route: "tickets" },
  { id: "report-problem", route: "", skip: "starts a session recording - `reportProblem` drives it end to end" },
  { id: "clock-toggle", route: "attendance", skip: "punches the clock for a shared seeded person - `clock` owns it" },
  { id: "new-card", route: "boards" },
  { id: "new-goal", route: "goals" },
  { id: "new-checkin", route: "check-ins" },
  { id: "new-job", route: "job-requisitions" },
  { id: "new-candidate", route: "candidates" },
  { id: "new-post", route: "announcements" },
  { id: "new-document", route: "documents" },
  { id: "new-employee", route: "employees" },
  { id: "give-kudos", route: "announcements" },
];

test.describe("every quick action", () => {
  test("the list covers every action in the registry", () => {
    const src = readFileSync(new URL("../web/src/lib/quickActions.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("QUICK_ACTIONS: QuickAction[] = ["), src.indexOf("];", src.indexOf("QUICK_ACTIONS")));
    const registered = [...body.matchAll(/\{ id: "([a-z-]+)"/g)].map((m) => m[1]!);
    const covered = new Set(ACTIONS.map((a) => a.id));
    expect(registered.filter((id) => !covered.has(id)), "these quick actions are offered but never run here").toEqual([]);
    expect(ACTIONS.map((a) => a.id).filter((id) => !registered.includes(id)), "these are listed here but no longer exist").toEqual([]);
  });

  test("each one lands on its page and opens the flow it promises", async ({ as }) => {
    // Twenty-odd flows in one browser, each landing on a page that fetches before it can open anything.
    test.setTimeout(600_000);
    const page = await as("super");
    const labels = readLabels();
    const failures: string[] = [];

    // "Create a task" needs somewhere to put it: the card composer belongs to a BOARD's view, and a database
    // with no boards draws "No boards yet" instead - so that one action would be judged dead for want of a
    // board rather than for want of a handler. The seed ships none, so the walk brings its own.
    const scratchBoard = await ensureBoard(page);

    for (const action of ACTIONS) {
      if (action.skip) continue;
      const label = labels.get(action.id);
      if (!label) {
        failures.push(`${action.id}: no label in the registry`);
        continue;
      }
      try {
        // Always from the same place, so each press is the same journey a person makes: the dashboard, ⌘K,
        // the action by name.
        await gotoRoute(page, "dashboard");
        await page.keyboard.press("ControlOrMeta+k");
        const palette = page.getByRole("dialog", { name: "Search everything" });
        const search = page.getByPlaceholder("Search people, records, pages and settings…");
        await expect(search).toBeVisible({ timeout: 15_000 });
        await search.fill(label);
        const row = palette.getByRole("button").filter({ hasText: label }).first();
        await expect(row).toBeVisible({ timeout: 15_000 });
        await row.click();

        // It went where it said it would...
        await expect.poll(() => page.url(), { timeout: 30_000 }).toContain(`#/${action.route}`);
        // ...and the page picked the intent up on mount: something to fill in is open. A press that navigates
        // and then does nothing is the failure this walk exists for, and it looks identical to a slow page
        // until the dialog never comes.
        await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 30_000 });

        // Abandoned rather than submitted: this spec is about the entry point, not about what each form
        // writes. Escape can be guarded by the unsaved-changes prompt on a form that autofilled itself, so
        // whichever way out is offered is taken.
        await page.keyboard.press("Escape");
        const discard = page.getByRole("button", { name: /^(Discard|Leave)$/ });
        if (await discard.count()) await discard.first().click();
        if (await page.getByRole("dialog").count()) await page.reload();
      } catch (e) {
        failures.push(`${action.id}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    // Before the verdict, so a failing walk still tidies up after itself. Every press above is caught, so
    // nothing jumps past this line.
    if (scratchBoard) await purge(page, scratchBoard);

    expect(failures, `quick actions that did not open their flow:\n${failures.join("\n")}`).toEqual([]);
  });
});

/**
 * A board to land the "Create a task" action on - this spec's own, and only when the org has none.
 *
 * Returns the path to purge, or null when a board was already there (somebody else's board is not this
 * spec's to take away).
 */
async function ensureBoard(page: import("@playwright/test").Page): Promise<string | null> {
  const res = await page.request.get("/v1/boards?page_size=1");
  expect(res.status(), await res.text()).toBe(200);
  if (((await res.json()) as { results?: unknown[] }).results?.length) return null;
  const made = await page.request.post("/v1/boards", {
    headers: SPA_HEADERS,
    data: { name: `E2E quick actions ${Date.now() % 1_000_000}` },
  });
  expect(made.status(), await made.text()).toBe(200);
  return ((await made.json()) as { path: string }).path;
}

/** The registry's labels, by id - what the palette actually offers. */
function readLabels(): Map<string, string> {
  const src = readFileSync(new URL("../web/src/lib/quickActions.ts", import.meta.url), "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(/\{ id: "([a-z-]+)", label: "([^"]+)"/g)) out.set(m[1]!, m[2]!);
  return out;
}
