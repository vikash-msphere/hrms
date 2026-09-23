import type { Page } from "@playwright/test";
import { SPA_HEADERS, gotoRoute, test, expect } from "./fixtures";

// Copying one role's permissions onto another, from the compare view.
//
// The server suite owns what the copy WRITES (`accessLifecycle`: active rules only, one correlation id over
// every entry, one summary entry, one notification, skip on repeat). What only a browser can show is the
// path a person actually takes to it, and it is a long one: open Compare, pick the two roles, read the gap
// between them, copy in the direction you meant, and then find the copy again in the audit trail as the
// SINGLE change it was. Two things here are worth a browser on their own - the compare table re-reads after
// the copy (a stale grid would tell an admin the copy did nothing), and the trail's act view groups the
// whole copy, which is the difference between "somebody made three permission changes" and "somebody copied
// this role onto that one".
test("copies one role's rules onto another and shows the whole copy as one act", async ({ as }) => {
  test.setTimeout(180_000);
  const page = await as("super");
  const stamp = `${test.info().parallelIndex}${Date.now() % 100000}`;
  const src = `e2e_copy_from_${stamp}`;
  const dst = `e2e_copy_to_${stamp}`;
  const srcLabel = `E2E Copy From ${stamp}`;
  const dstLabel = `E2E Copy To ${stamp}`;

  // Two throwaway roles, and two rules on the source. Made through the API on purpose: authoring rules by
  // hand through the modal is what `accessAdmin` covers, and it is not what this spec is about.
  for (const [name, label] of [[src, srcLabel], [dst, dstLabel]]) {
    const res = await page.request.post("/v1/roles", { headers: SPA_HEADERS, data: { name, label } });
    expect(res.status(), await res.text()).toBe(200);
  }
  for (const collection of ["leave-requests", "holidays"]) {
    const res = await page.request.post("/v1/access-rules", {
      headers: SPA_HEADERS,
      data: { subject_kind: "role", subject: src, collection, scope: "all", level: "read" },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  try {
    await gotoRoute(page, "settings/permissions", "Permissions");

    // Compare is its own door: "what does this role have that that one doesn't" has no answer short of
    // reading two columns of a sixty-row matrix.
    await page.getByRole("button", { name: "Compare" }).click();
    const compare = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Compare roles" }) });
    await expect(compare).toBeVisible();

    const pickRole = async (which: 0 | 1, label: string) => {
      await compare.getByRole("combobox").nth(which).click();
      await page.getByRole("option", { name: label, exact: true }).click();
      await expect(compare.getByRole("combobox").nth(which)).toContainText(label);
    };
    await pickRole(0, srcLabel);
    await pickRole(1, dstLabel);

    // The gap, before anything is copied: the two rules the source holds and the target does not. This is
    // the number the copy is judged against, and it is also what makes the next assertion mean something.
    const gap = compare.getByText(/of \d+ collections differ/);
    await expect(gap).toHaveText(/^2 of \d+ collections differ/);

    // Copy in the direction shown, confirming first - it is a bulk grant, so it asks.
    await compare.getByRole("button", { name: "Copy A → B" }).click();
    const ask = page.getByRole("dialog").filter({ hasText: /Copy 2 rules\?/ });
    await expect(ask).toContainText(/recorded as one change/);
    await ask.getByRole("button", { name: "Copy", exact: true }).click();

    // What landed, reported back. NOT the `toast()` helper: the compare dialog is still open, and Radix
    // aria-hides the rest of the page behind a modal - so the toast viewport is out of the accessibility
    // tree and no role query can see it while the dialog the copy was started from is up.
    await expect(page.locator("li").filter({ hasText: /Copied 2 rules/ })).toBeVisible();
    // The grid re-reads: the two roles are now identical, which is the copy landing rather than merely
    // being reported. A stale table here would tell an admin the copy did nothing.
    //
    // Re-picked on a miss. That count comes from a PAGED read of `access-rules` across every subject, and
    // this suite writes rules for other subjects the whole time it runs - so one page of that read can be
    // answered before this copy and a later one after it, and the panel then reports a difference that no
    // longer exists. Reproduced by running this spec beside the other permissions specs: "2 of 89 collections
    // differ", for a copy the server had already applied (the rules are checked against the server below).
    // Re-picking the pair is what re-reads it.
    await expect(async () => {
      if (/^0 of/.test(((await gap.textContent()) ?? "").trim())) return;
      await pickRole(0, srcLabel);
      await pickRole(1, dstLabel);
      await expect(gap).toHaveText(/^0 of \d+ collections differ/, { timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await page.keyboard.press("Escape");

    // The target really holds them as its own rules, at the level the source had.
    const copied = (await allRules(page)).filter((r) => r.subject === dst);
    expect(copied.map((r) => r.collection).sort()).toEqual(["holidays", "leave-requests"]);
    expect(copied.every((r) => r.level === "read" && r.status === "active")).toBe(true);

    // And the trail, which is the point of doing this in one request: the copy is ONE act, not three
    // unrelated permission changes.
    await gotoRoute(page, "activity", "Activity");
    await page.getByRole("button", { name: "Permission changes" }).click();
    const search = page.getByPlaceholder(/Search action, person or record/);
    await search.fill(dst);
    await search.press("Enter");

    const summary = page.locator("tbody tr").filter({ hasText: "copied permissions onto" });
    await expect(summary).toHaveCount(1);
    // The row says what happened in words: which subject gained what, and where it came from.
    await expect(summary).toContainText(dst);
    await expect(summary).toContainText(`copied from the ${src} role`);

    // Open the entry, then widen to the whole act - every entry the same request wrote.
    await summary.getByTitle("Show the full entry").click();
    await page.getByRole("button", { name: /Show everything this action changed/ }).click();
    const act = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Everything this action changed" }) });
    await expect(act).toBeVisible();

    // Three entries under one correlation id: the summary, and one per rule the copy authored. A client-side
    // loop of creates could not produce this - each rule would be an act of its own.
    const inAct = act.locator("tbody tr");
    await expect(inAct).toHaveCount(3);
    await expect(inAct.filter({ hasText: "copied permissions onto" })).toHaveCount(1);
    await expect(inAct.filter({ hasText: "created" })).toHaveCount(2);
    await expect(inAct.filter({ hasText: "leave requests" })).toHaveCount(1);
    await expect(inAct.filter({ hasText: "holidays" })).toHaveCount(1);
    await page.keyboard.press("Escape");

    // The grouping the act view read, asserted on the wire too: the three entries carry the SAME
    // correlation id, which is what makes the copy replayable as one operation by anyone auditing later.
    const feed = await page.request.get(`/v1/activity?entity=access-rules&q=${encodeURIComponent(dst)}&max_page_size=50`);
    expect(feed.status(), await feed.text()).toBe(200);
    const entries = ((await feed.json()) as { results?: { action: string; correlation_id?: string }[] }).results ?? [];
    const mine = entries.filter((e) => e.action.startsWith("access-rule."));
    expect(mine).toHaveLength(3);
    expect(mine[0]!.correlation_id).toBeTruthy();
    expect(new Set(mine.map((e) => e.correlation_id)).size).toBe(1);
  } finally {
    // Rules first, then the roles: a rule left behind names a role that no longer exists.
    for (const rule of (await allRules(page)).filter((r) => r.subject === src || r.subject === dst)) {
      await page.request.delete(`/v1/${rule.path}`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
    for (const name of [src, dst]) {
      await page.request.delete(`/v1/roles/${name}`, { headers: SPA_HEADERS }).catch(() => undefined);
    }
  }
});

/**
 * Every access rule, following the cursor.
 *
 * The server caps a page at 100 and an org this size has more than that, so a single-page read would miss
 * the rules this spec is asking about - and, in the cleanup, leave them behind.
 */
async function allRules(page: Page): Promise<{ path: string; subject: string; collection: string; level?: string; status?: string }[]> {
  type Rule = { path: string; subject: string; collection: string; level?: string; status?: string };
  const all: Rule[] = [];
  let token: string | undefined;
  for (let pageNo = 0; pageNo < 20; pageNo++) {
    const url = `/v1/access-rules?max_page_size=100${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
    const res = await page.request.get(url);
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { results?: Rule[]; next_page_token?: string };
    all.push(...(body.results ?? []));
    token = body.next_page_token;
    if (!token) break;
  }
  return all;
}
