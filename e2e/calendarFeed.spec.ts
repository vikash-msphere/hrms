import { SPA_HEADERS, gotoRoute, test, expect } from "./fixtures";

// The calendar somebody subscribes to once and never thinks about again.
//
// The holiday page hands each person a private feed URL - their own token, their own optional picks - meant
// to be pasted into Google Calendar or Outlook. Two things about it are only observable in a browser: the URL
// is composed in the page from this caller's token and the origin it is being served from (a hard-coded host
// would send everybody's calendar to somebody else's deployment), and it is offered as selectable, readable
// text rather than only a copy button, because the people who need it are pasting it into another app.
//
// `holidays` covers the one-off `.ics` download, which is a different thing: a file of today's list, not a
// subscription that keeps up. What is asserted here is the subscription - including that the URL the page
// shows really answers with a calendar.
test("the holiday page offers a personal feed URL that really serves a calendar", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("employee");
  const admin = await as("super"); // the org switch is an admin's to throw

  // The feed is opt-in per org (`settings/holidays.feed_enabled`), and the seed writes no settings rows at
  // all - so with nothing done first, `me` carries no feed URL, the page draws no subscribe affordance, and
  // this spec is testing whether some OTHER spec happened to turn the switch on. Thrown here, put back after.
  const before = await holidaysPolicy(admin);
  await setHolidaysPolicy(admin, { ...before, feed_enabled: true });

  try {
    await gotoRoute(page, "holidays", "Holiday Calendar");

    await page.getByRole("button", { name: "Subscribe in your calendar" }).click();
    // The URL is text somebody can select and copy by hand - the copy button is a convenience, not the
    // feature, which is why it is a readonly input rather than a line of muted prose.
    const feed = await page.locator("input[readonly]").first().inputValue();
    expect(feed, "the page composed no feed URL").toMatch(/\/calendar\/holidays\/[^/]+$/);
    // Composed against the origin the app is actually being served from, so a copied link works from the same
    // place the person is standing.
    expect(feed.startsWith(new URL(page.url()).origin), `the feed URL points somewhere else: ${feed}`).toBe(true);

    // And it answers: the token alone is the credential (this is a URL pasted into a calendar app, which
    // sends no cookie of ours), and what comes back is a calendar rather than a login page.
    const res = await page.request.get(feed);
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR"), `the feed served something else: ${body.slice(0, 80)}`).toBe(true);
    expect(body).toContain("END:VCALENDAR");
  } finally {
    await setHolidaysPolicy(admin, before);
  }
});

type Policy = Record<string, unknown>;
type Page = import("@playwright/test").Page;

/** The org's holiday policy blob, or the empty one the server falls back to when no row has been written. */
async function holidaysPolicy(page: Page): Promise<Policy> {
  const res = await page.request.get("/v1/settings/holidays");
  if (res.status() === 404) return {};
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { value?: Policy }).value ?? {};
}

/** Put the policy back the way it was. Writing `{}` is what "no row" means to every reader of this key. */
async function setHolidaysPolicy(page: Page, value: Policy) {
  const res = await page.request.patch("/v1/settings/holidays", { headers: SPA_HEADERS, data: { value } });
  expect(res.status(), await res.text()).toBe(200);
}
