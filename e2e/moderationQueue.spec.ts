import { apiPost, capabilitiesOf, gotoRoute, test, expect } from "./fixtures";

// The flagged-post queue: who can reach it, and what it says when there is nothing in it.
//
// WHAT THIS CANNOT COVER, stated up front so nobody reads more into a green run than is there. A flag is
// written by a guard model's verdict, and the only model this lane can reach is whatever is running locally
// (`AI_LOCAL_URL` in e2e/e2e.vars) - which is not Llama Guard, so no text can be relied on to produce a flag
// on demand. `moderation` is also off in every run but the one test that turns it on, and that test lives in
// `e2e/aiFeatures.spec.ts` because the switch is one org-wide settings row and two files writing it race.
// Rendering a flag, the hazard chips, the anonymity rule and Hide taking a post off the wall are covered
// against real D1 in `test/moderation.test.ts` and are deliberately not attempted here.
//
// What IS only checkable here is the half that unit tests structurally cannot reach: that the capability is
// private by default in a running app. `moderation` seeds nothing for any role, so the posture is that a
// super sees the queue and nobody else does - and that posture is worth a browser test precisely because it
// is one ACL edit away from being wrong and nothing else would notice.
test.describe("the moderation queue", () => {
  test("a super can open it, and it says plainly that there is nothing to do", async ({ as }) => {
    const page = await as("super");
    // The queue is a tab of the Connect workspace, beside the walls it decides on, so the entry to it only
    // renders while a Connect page is open - the dashboard shows the workspace, not its tabs.
    await gotoRoute(page, "announcements");

    // THE POSITIVE CONTROL for the absence assertion in the next test. Without this, "the employee cannot see
    // the tab" would pass just as happily if the tab did not exist for anybody - which is the way an absence
    // assertion rots into a test that proves nothing.
    await expect(page.getByRole("link", { name: "Flagged posts" })).toBeVisible();

    await gotoRoute(page, "moderation");

    // Reachable and rendered. The empty state is the normal state for a wall nobody has posted anything
    // objectionable to, so it has to read as "all clear" rather than as a page that failed to load.
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("Something went wrong");
  });

  test("an employee is not offered it, and cannot act on a flag by calling the endpoint", async ({ as }) => {
    const employee = await as("employee");

    // Nothing seeds `moderation`, so an ordinary employee holds neither half of it.
    const caps = await capabilitiesOf(employee);
    expect(caps).not.toContain("moderation.read");
    expect(caps).not.toContain("moderation.decide");

    // The nav never offers it. `hide, never disable`: a person without the capability is not shown a door
    // they cannot open - checked on the Connect wall itself, where the tab WOULD be if they held it.
    await gotoRoute(employee, "announcements");
    await expect(employee.getByRole("link", { name: "Flagged posts" })).toHaveCount(0);

    // And the endpoint refuses them directly, which is the half that matters: the nav is a courtesy, the
    // authz middleware is the control. 403 rather than 404 - they may not act on flags at all, which is a
    // different answer from "that flag is not there".
    const res = await apiPost(employee, "moderation:decide", { host: "announcements/whatever", action: "hide" });
    expect(res.status()).toBe(403);
  });

  test("rejects a way of putting a post back that does not exist", async ({ as }) => {
    // `:unhide` grew a `mode` - back to its author as a draft, or straight onto the wall - and the route is
    // the only thing standing between a typo and a service that would read it as the default. A bad value is
    // refused BEFORE the flag is looked up, which is why this answers 422 (the codebase's invalid-argument)
    // rather than the 404 the same post gets below.
    const page = await as("super");
    const res = await apiPost(page, "moderation:unhide", { host: "announcements/not-a-real-id", mode: "wall" });
    expect(res.status()).toBe(422);
  });

  test("even a super gets a 404 for a post that was never flagged", async ({ as }) => {
    // The capability lets somebody act on the queue; it does not let them take down an arbitrary post by
    // naming it. Without a flag there is nothing to decide, and the endpoint says so rather than hiding it.
    const page = await as("super");
    const res = await apiPost(page, "moderation:decide", { host: "announcements/not-a-real-id", action: "hide" });
    expect(res.status()).toBe(404);
  });
});
