import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// Two people for a permission change.
//
// An org can turn on four-eyes for access (`access-approval`): while it is on, every rule write lands as a
// PENDING row that a SECOND access admin has to approve, and the requester may not decide their own. The
// server enforces all of that. What the browser owes is the other half - a pending rule has to READ as
// pending wherever rules are read (a badge saying it is awaiting approval, beside an approve and a reject),
// or an admin sees a permission they believe is live and it is not.
//
// `accessAdmin` covers writing rules with the ceremony off, and `test/` owns the decision rules. This spec is
// the only one that turns the setting on, and it is written to hold it on for two API calls and no longer:
// the flag is org-wide, so a lane running under it would quietly turn every other spec's access write into a
// request. Everything it touches is its own - a throwaway role nobody holds, and a temporary grant to HR that
// exists only so there IS a second admin - and all of it is taken away again in `finally`.
test("a pending permission change is approved by a second admin, from the rules UI", async ({ as }) => {
  test.setTimeout(240_000);
  const admin = await as("super");
  const hr = await as("hr");
  const stamp = Date.now() % 1_000_000;
  const role = `e2e_4eyes_${stamp}`;
  const temporary: string[] = []; // rules this spec made and must take back

  // A role nobody holds: every rule below is inert, so the ceremony can be driven without changing what any
  // person in the org can actually do.
  const madeRole = await admin.request.post("/v1/roles", {
    headers: SPA_HEADERS,
    data: { name: role, label: `E2E four eyes ${stamp}` },
  });
  expect(madeRole.status(), await madeRole.text()).toBe(200);

  try {
    // Leftovers first: the two grants below are exact, and the server refuses a duplicate rule outright
    // (409). A run that died before its `finally` therefore blocks every run after it - and since the seed
    // grants HR nothing on access-rules, anything matching can only be this spec's.
    await sweepTemporary(admin);

    // A second admin to approve with. HR holds no access-rules rights in the seed, which is exactly why the
    // ceremony cannot otherwise be driven: with one admin there is nobody to be the other pair of eyes.
    for (const rule of [
      { collection: "access-rules", scope: "all", level: "write" },
      { collection: "access-rules", scope: "all", verb: "approve" },
    ]) {
      const res = await admin.request.post("/v1/access-rules", {
        headers: SPA_HEADERS,
        data: { subject_kind: "role", subject: "hr_admin", effect: "allow", ...rule },
      });
      expect(res.status(), await res.text()).toBe(200);
      temporary.push(((await res.json()) as { path: string }).path);
    }

    // On, requested, off - three calls back to back, because this flag is the org's and every other spec in
    // the lane is writing access rules while this runs.
    await setFourEyes(admin, true);
    let pending: string;
    try {
      const requested = await hr.request.post("/v1/access-rules", {
        headers: SPA_HEADERS,
        data: { subject_kind: "role", subject: role, collection: "holidays", scope: "all", level: "read", effect: "allow" },
      });
      expect(requested.status(), await requested.text()).toBe(200);
      pending = ((await requested.json()) as { path: string }).path;
      temporary.push(pending);
    } finally {
      await setFourEyes(admin, false);
    }

    // It really is a request rather than a grant: the server says so before the browser is asked to.
    expect(await status(admin, pending), "the request landed as an active rule").toBe("pending");

    // And the rules UI says so too. The badge is the whole point: an admin reading this list has to be able
    // to tell a live permission from one that is still waiting.
    await gotoRoute(admin, "settings/permissions", "Permissions");
    // The key beside HOLIDAYS, which is the collection the pending rule is about - `.first()` opens whatever
    // sits at the top of the matrix and its modal has nothing to say about this request.
    await admin.getByRole("button", { name: /^Manage access for Holidays/ }).first().click();
    const modal = admin.getByRole("dialog");
    await expect(modal).toBeVisible({ timeout: 30_000 });
    // The request was made FOR A ROLE, and the modal opens on its Users tab - so the row carrying this
    // change, its badge and its two decisions are all one tab across.
    await modal.getByRole("tab", { name: /^Roles/ }).click();
    await expect(modal.getByText("awaiting approval").first()).toBeVisible({ timeout: 30_000 });

    // The second pair of eyes, pressed by somebody who is not the requester.
    await modal.getByRole("button", { name: "approve", exact: true }).first().click();
    await expect.poll(() => status(admin, pending), { timeout: 30_000 }).toBe("active");
  } finally {
    for (const rule of temporary) await purge(admin, rule);
    await purgeNamedRole(admin, role);
    // However this ended, the org is left as it was found: the ceremony off.
    await setFourEyes(admin, false);
  }
});

/** Turn the org's four-eyes ceremony on or off. */
async function setFourEyes(page: import("@playwright/test").Page, enabled: boolean) {
  const res = await page.request.patch("/v1/settings/access-approval", {
    headers: SPA_HEADERS,
    data: { value: { enabled } },
  });
  expect(res.ok(), `access-approval ${enabled}: ${await res.text()}`).toBe(true);
}

/** The rule's status - "pending" while it is a request, "active" once somebody else has approved it. */
async function status(page: import("@playwright/test").Page, path: string): Promise<string | undefined> {
  const res = await page.request.get(`/v1/${path}`);
  if (!res.ok()) return undefined;
  return ((await res.json()) as { status?: string }).status;
}

/** Take the throwaway role away again. */
async function purgeNamedRole(page: import("@playwright/test").Page, name: string) {
  const res = await page.request.get("/v1/roles?page_size=200");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as { results?: { path: string; name?: string }[] };
  for (const r of results.filter((x) => x.name === name)) await purge(page, r.path);
}

/**
 * Take back the temporary grants an earlier run of this spec left on HR.
 *
 * Scoped as tightly as the rules it writes: role `hr_admin`, on `access-rules` itself. The seed gives HR
 * nothing there, so a match is this spec's litter and never somebody's real policy.
 */
async function sweepTemporary(page: import("@playwright/test").Page) {
  const res = await page.request.get("/v1/access-rules?page_size=500");
  if (!res.ok()) return;
  const { results = [] } = (await res.json()) as {
    results?: { path: string; subject_kind?: string; subject?: string; collection?: string }[];
  };
  for (const r of results.filter((x) => x.subject_kind === "role" && x.subject === "hr_admin" && x.collection === "access-rules")) {
    await purge(page, r.path);
  }
}
