import { allowConsoleErrors, enableTelemetry, gotoRoute, test, expect, toast } from "./fixtures";

// Reporting a problem, from the top bar's support menu.
//
// Everything this asserts needs a browser. The entry point is a routeless quick action, which means the menu
// click fires an intent with no navigation and a dialog mounted in the top bar answers it - there is no page
// to land on, so nothing but a real click proves the handoff happened. The submit then depends on a chain
// that only exists at runtime: the Sentry SDK has to be recording, `captureSessionReplay()` has to flush and
// come back with a sampled id, that id has to survive the server's 32-hex validation, and the ticket drawer
// has to render it back as a link. Any link of that breaking leaves a report that looks sent and carries
// nothing.
//
// It also pins the bug this spec was written for: with no `ticket-categories` settings row - which is exactly
// what the e2e database has, since scripts/seed.sql seeds no settings at all - the dialog used to read "this
// org has no categories", leave the category unset and disable Send forever. The client falls back to the
// same defaults the Worker does now, so the form is submittable on a database with no settings in it.

// The telemetry relay, answered in the page. Intercepted at `/diag` - our own origin - because that is where
// the SDK now posts (`tunnel` in web/src/instrument.ts); an interception aimed at the vendor's ingest host
// would match nothing and the envelope would travel for real. Which is the point of the stub: without it,
// every run of this spec files a live session replay into the project you look at when production breaks.
//
// Same-origin, so there is no CORS dance to reproduce here. Fulfilled with a 202 rather than aborted: the SDK
// treats a failed send as a failed send, `getReplayId(true)` then returns undefined, and the spec would be
// asserting the empty path while looking like it passed.
//
// Returns the envelope header lines seen, so a spec can assert WHAT was sent and not merely that something
// was. `postDataBuffer()` on purpose: a replay envelope's recording item is compressed binary, and reading it
// as a string is the exact mistake that silently dropped every replay once - the relay UTF-8-decoded the body
// and forwarded mangled bytes while the client held a perfectly valid replay id.
async function stubTelemetryRelay(page: Parameters<typeof gotoRoute>[0]) {
  const envelopes: { header: string; itemType: string }[] = [];
  // The lane leaves the SDK inert unless a page asks for it; the stub below is what keeps this one's
  // envelopes on the machine. Both have to be in place before the first navigation.
  await enableTelemetry(page);
  await page.route("**/diag", (route) => {
    const raw = route.request().postDataBuffer();
    if (raw) {
      // Header line, then the item header - the second is what says whether this envelope is a replay, an
      // error or a transaction, and a test that cannot tell them apart counts the wrong things.
      const [header = "", itemType = ""] = raw.toString("latin1").split("\n", 2);
      envelopes.push({ header, itemType });
    }
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "e2e" }) });
  });
  return envelopes;
}

/** The distinct replay ids seen. A replay envelope's header `event_id` IS the replay id. */
const replayIds = (envelopes: { header: string; itemType: string }[]): string[] => [
  ...new Set(
    envelopes
      .filter((e) => e.itemType.includes("replay_event"))
      .map((e) => JSON.parse(e.header).event_id as string),
  ),
];

test.describe("report a problem", () => {
  test("the support menu opens the report dialog in place and files a ticket with the recording", async ({ as }) => {
    // Longer than the 45s the Send-report wait below can now take on a busy lane.
    test.setTimeout(120_000);
    const page = await as("employee");
    // Two expected console lines, neither of them this test's failure. A dev Worker restart mid-request on a
    // busy lane reads as a 503/500 (the same rare hiccup documented elsewhere in this suite,
    // complianceRuleDelete.spec.ts et al.); and a recording attaching itself to a ticket while another
    // browser is attaching one of its own gets a 409 the app is built to retry ("this ticket's attachments
    // are being changed by somebody else - try again", services/tickets.ts). The ticket this files, and the
    // recording on it, are what the assertions below actually read.
    allowConsoleErrors(page, /status of 503|status of 500|status of 409/i);
    const envelopes = await stubTelemetryRelay(page);
    await gotoRoute(page, "leave-requests");
    const before = page.url();

    // The replay is flushed when the dialog OPENS, and the SDK discards one shorter than its 5s floor - so the
    // wait belongs here, before the menu, not before Send. Reporting is meant to keep the minute BEFORE this.
    await page.waitForTimeout(6000);

    await page.getByRole("button", { name: "Support" }).click();
    await page.getByRole("menuitem", { name: "Report a problem" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Report a problem")).toBeVisible();
    // In place. The whole reason the action carries no route: a bug report must not take away the screen the
    // bug is on. If this ever navigates, the reporter loses the evidence and the replay's last frames are of
    // the Tickets page instead of the thing that broke.
    expect(page.url()).toBe(before);

    // The recording is stated, not asked. There is no opt-in checkbox to tick - but the person being recorded
    // is told, in the dialog, before they send. A silent version of this feature is the thing being prevented.
    // Nothing to opt into and nothing to read: the dialog is a form, and what was captured is said on the
    // toast after sending (asserted below) rather than as standing text above a button.
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Record the problem" })).toBeVisible();

    // No category picker: "app" ships as a default category and the dialog preselects it, so the reporter is
    // never asked which desk fixes the software.
    await expect(dialog.getByText("Who should see this?")).toHaveCount(0);

    const subject = `E2E report a problem ${Date.now()}`;
    await dialog.getByPlaceholder("The page went blank when I clicked Save").fill(subject);
    await dialog.getByPlaceholder("The page went blank when I clicked Save").blur();

    // Send is enabled on a database with NO ticket-categories row. This is the regression: the category was
    // unsettable, so `canSubmit` was false forever and the button never came alive. The button also stays
    // disabled until the org's ticket categories have loaded and picked one (`getSetting("ticket-categories")`,
    // a settings fetch shared by every consumer's first read this session), which on a lane heavy with other
    // browsers hitting the same settings endpoint at once can take a while longer than the ordinary case.
    const send = dialog.getByRole("button", { name: "Send report", exact: true });
    await expect(send).toBeEnabled({ timeout: 45_000 });

    await send.click();

    // Reported, and the toast does not claim a recording it failed to attach.
    const sent = toast(page, /Problem reported/i);
    await expect(sent).toBeVisible();
    // The person is told what went with their report, at the moment it went. This is the ONLY place that says
    // so now, which is exactly why it is asserted: a recording nobody was told about is monitoring.
    await expect(sent.getByText(/Screen recording attached/i)).toBeVisible();
    await expect(sent.getByText(/recording was too short/i)).toHaveCount(0);

    // The toast's own way back to the ticket, since the report was filed from another page entirely.
    await sent.getByRole("button", { name: "View ticket" }).click();
    await expect.poll(() => page.url()).toMatch(/\/tickets\//);

    // What support actually sees: the ticket, and a link to the recording that came with it. The link proves
    // the id round-tripped - flushed in the browser, accepted by the server's 32-hex check (a rejected id is
    // a 400, not a silently empty field), stored, serialized and rendered.
    await expect(page.getByText(subject).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Session recordings/ })).toBeVisible();
    const watch = page.getByRole("link", { name: /Recorded by/i }).first();
    await expect(watch).toBeVisible();
    await expect(watch).toHaveAttribute("href", /^https:\/\/[\w-]+\.sentry\.io\/replays\/[0-9a-f]{32}\/$/);

    // Everything reached the relay on OUR origin, addressed to the configured project. Nothing was posted to
    // a vendor host, which is the point of the tunnel: an ad blocker has nothing in this traffic to match.
    expect(envelopes.length).toBeGreaterThan(0);
    for (const { header } of envelopes) expect(JSON.parse(header).dsn).toMatch(/^https:\/\/\w+@[\w.-]+\/\d+$/);
  });

  test('"Record the problem" hides the form, counts down in the top bar, and comes back with the draft', async ({ as }) => {
    const page = await as("employee");
    const envelopes = await stubTelemetryRelay(page);
    await gotoRoute(page, "leave-requests");
    await page.waitForTimeout(6000);

    await page.getByRole("button", { name: "Support" }).click();
    await page.getByRole("menuitem", { name: "Report a problem" }).click();
    const dialog = page.getByRole("dialog");
    const subject = `E2E show-me ${Date.now()}`;
    await dialog.getByPlaceholder("The page went blank when I clicked Save").fill(subject);

    await dialog.getByRole("button", { name: "Record the problem" }).click();

    // The form gets out of the way, and the countdown is the only thing left saying a recording is running.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const chip = page.getByRole("status").filter({ hasText: /Recording/ });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/[0-2]:\d\d/); // m:ss, and it starts at 2:00

    // The user can go and do the thing that broke - the whole point of the mode. Long enough to clear the
    // SDK's 5s `minReplayDuration`, below which the recorder discards the window entirely and there would be
    // no second replay to assert on (and, in the app, nothing for the ticket to link to).
    await gotoRoute(page, "tickets");
    await expect(chip).toBeVisible();
    await page.waitForTimeout(7000);

    await chip.getByRole("button", { name: "Stop" }).click();

    // Back, with what they had already typed. A mode that loses the draft would be worse than no mode.
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByPlaceholder("The page went blank when I clicked Save")).toHaveValue(subject);
    await expect(page.getByRole("status").filter({ hasText: /Recording/ })).toHaveCount(0);

    // And it still files, carrying the recording that now includes the demonstration. Given room, because
    // filing uploads that recording through the relay: on a wide run the default five seconds is the report
    // being slow, not the report failing.
    await page.getByRole("dialog").getByRole("button", { name: "Send report", exact: true }).click();
    await expect(toast(page, /Problem reported/i)).toBeVisible({ timeout: 30_000 });

    // The demonstration is its OWN replay. Two distinct replay ids reached the relay: the run-up flushed when
    // the dialog opened, and the window that began when Record was pressed. Before this, Record continued the
    // existing session - one long replay with no boundary saying where the person started demonstrating, and
    // a recorder that had been running since the page loaded.
    await page.waitForTimeout(3000);
    expect(replayIds(envelopes).length).toBeGreaterThanOrEqual(2);
  });

  test("the countdown survives a reload, so a recording can always be stopped", async ({ as }) => {
    const page = await as("employee");
    await stubTelemetryRelay(page);
    await gotoRoute(page, "leave-requests");
    await page.waitForTimeout(6000);

    await page.getByRole("button", { name: "Support" }).click();
    await page.getByRole("menuitem", { name: "Report a problem" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Record the problem" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Recording/ })).toBeVisible();

    // The SDK's replay session is sticky, so a refresh does NOT stop the recorder - and the chip used to be
    // React state that a reload threw away. That left a recording running with nothing on screen saying so and
    // no way to end it, which is the one state this feature must never reach.
    await page.reload();
    const chip = page.getByRole("status").filter({ hasText: /Recording/ });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(/[0-2]:\d\d/);

    // And it is still a working control, not just a label.
    await chip.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Recording/ })).toHaveCount(0);
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("a second recording can be added to a ticket that already exists", async ({ as }) => {
    // Longer than the 45s the Send-report wait below budgets itself - a default 30s test timeout shorter than
    // that wait (plus the 6s settle before it) kills the test mid-wait and reports it as the whole TEST timing
    // out rather than ever letting the wait actually use the time it was given.
    test.setTimeout(120_000);
    const page = await as("employee");
    await stubTelemetryRelay(page);
    await gotoRoute(page, "leave-requests");
    await page.waitForTimeout(6000);

    // File one the usual way, then open it.
    await page.getByRole("button", { name: "Support" }).click();
    await page.getByRole("menuitem", { name: "Report a problem" }).click();
    const subject = `E2E second recording ${Date.now()}`;
    await page.getByRole("dialog").getByPlaceholder("The page went blank when I clicked Save").fill(subject);
    // The button stays disabled until the org's ticket categories have loaded and picked one
    // (`getSetting("ticket-categories")`), which on a lane heavy with other browsers hitting the same
    // settings endpoint at once can take a while longer than the ordinary case.
    const send = page.getByRole("dialog").getByRole("button", { name: "Send report", exact: true });
    await expect(send).toBeEnabled({ timeout: 45_000 });
    await send.click();
    await toast(page, /Problem reported/i).getByRole("button", { name: "View ticket" }).click();
    await expect(page.getByRole("heading", { name: /Session recordings/ })).toBeVisible();
    const before = await page.getByRole("link", { name: /Recorded by/i }).count();

    // "Can you show me that again?" - the whole point. The window runs from the ticket, the drawer does not
    // have to stay open, and the recording attaches itself when it ends.
    await page.getByRole("button", { name: "Record the problem again" }).click();
    // The drawer closes with the click: it is a modal over the whole app, and the next two minutes are for
    // going and making the fault happen. Asserted for the report form too (further up) - no modal may sit over
    // the app while a recording runs, whichever of them started it.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const chip = page.getByRole("status").filter({ hasText: /Recording/ });
    await expect(chip).toBeVisible();
    await gotoRoute(page, "leave-requests"); // go and reproduce it somewhere else
    await page.waitForTimeout(7000); // clear the SDK's 5s floor, or there is nothing to attach
    await chip.getByRole("button", { name: "Stop" }).click();

    await expect(toast(page, /Recording added to the ticket/i)).toBeVisible();
    await toast(page, /Recording added to the ticket/i).getByRole("button", { name: "View ticket" }).click();
    await expect.poll(() => page.getByRole("link", { name: /Recorded by/i }).count()).toBe(before + 1);
  });

  test("an ordinary support ticket carries no recording", async ({ as }) => {
    const page = await as("employee");
    await stubTelemetryRelay(page);
    await gotoRoute(page, "tickets");

    // The other half of the consent story: only the report-a-problem flow captures. Raising a ticket the
    // normal way must stay a form, or the disclosure in the other dialog is describing behaviour that also
    // happens where nothing is disclosed.
    await page.getByRole("button", { name: "New ticket" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("New support ticket")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Record the problem" })).toHaveCount(0);
  });
});
