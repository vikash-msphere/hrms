import { inflateSync } from "node:zlib";
import type { Page, Route } from "@playwright/test";
import { gotoRoute, test, expect } from "./fixtures";

// What session replay actually records - read out of the recording bytes, not inferred from the config.
//
// This is the only way to test masking. `REPLAY_PRIVACY` (web/src/instrument.ts) is unmask-by-default: text,
// inputs and media are recorded, and only the deny-list is hidden. That inverts the failure mode - forgetting
// to cover something now LEAKS it - and nothing else in the suite can see the difference, because the config
// reads the same either way and the leak is silent. So this inflates the rrweb payload the browser actually
// uploads and looks for the words.
//
// The two halves matter equally: text has to be readable where it is supposed to be (or the recording is
// useless and someone will widen the policy further), and unreadable on the routes that carry pay, identity
// documents and bank details (or this is a payroll leak into a third-party console).

/**
 * EVERY replay recording the page uploads, inflated and concatenated.
 *
 * All of them, not the first: the flush happens when the report dialog OPENS, so the first segment predates
 * anything typed into that dialog. A test asserting "the typed value is absent" against only that segment
 * passes whatever the masking config says, which is the worst kind of green.
 *
 * Handed back as an accessor rather than a promise because `await` flattens nested promises at runtime - a
 * helper returning `Promise<Promise<string>>` makes the caller's `await` block on the recording before it has
 * navigated anywhere, which never resolves.
 */
async function captureRecording(page: Page): Promise<{ all: () => string }> {
  const chunks: string[] = [];
  await page.route("**/diag", (route: Route) => {
    const raw = route.request().postDataBuffer();
    if (raw?.includes("replay_recording")) {
      // Envelope: header \n item-header \n item-payload. The recording item's PAYLOAD is itself
      // `{"segment_id":N}\n<zlib events>`, so there are two newlines to step over, not one.
      const outer = raw.subarray(raw.indexOf(0x0a, raw.indexOf("replay_recording")) + 1);
      const events = outer.subarray(outer.indexOf(0x0a) + 1);
      try {
        chunks.push(inflateSync(events).toString("utf8"));
      } catch {
        /* not the compressed segment - the next envelope carries it */
      }
    }
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: "e2e" }) });
  });
  return { all: () => chunks.join("\n") };
}

/** Report a problem from wherever the page is, which is what flushes the buffer. */
async function reportAProblem(page: Page) {
  // The flush happens when the dialog opens, and the SDK drops a replay shorter than its 5s floor, so the
  // window has to exist BEFORE the menu is touched.
  await page.waitForTimeout(6000);
  await page.getByRole("button", { name: "Support" }).click();
  await page.getByRole("menuitem", { name: "Report a problem" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("The page went blank when I clicked Save").fill(`E2E masking check ${Date.now()}`);
  await dialog.getByRole("button", { name: "Send report", exact: true }).click();
}

test.describe("session replay masking", () => {
  // The SDK's own 5s minimum replay duration has to elapse before a flush produces anything, and every action
  // here runs under the config's slowMo. That does not fit the default 30s budget.
  test.describe.configure({ timeout: 90_000 });

  test("records the page text on an ordinary route", async ({ as }) => {
    const page = await as("employee");
    const recording = await captureRecording(page);
    await gotoRoute(page, "leave-requests");
    const heading = (await page.getByRole("heading", { level: 1 }).first().textContent())?.trim() ?? "";
    expect(heading.length).toBeGreaterThan(3); // a blank heading would make the assertion below vacuous

    await reportAProblem(page);
    await page.waitForTimeout(4000); // let the post-submit segment land
    const events = recording.all();
    // The heading the user was looking at is in the recording, in plain text.
    expect(events).toContain(heading);
  });

  test("masks what carries the sentry-mask class, and only that", async ({ as }) => {
    const page = await as("employee");
    const recording = await captureRecording(page);
    await gotoRoute(page, "profile");

    // Two markers, planted rather than harvested from the page. Route-level masking is gone from the profile -
    // it hid headings, hints, statuses and dates for the sake of a few panels - and protection now rides on
    // `sentry-mask`, applied to the seven sensitive panels and their dialogs. Which panels carry it is checked
    // in test/replayMaskCoverage.test.ts; what this proves is the other half, that the class masks at all, and
    // that its neighbours are left alone. Planted because the seeded employee has no bank or tax record, so
    // there is no natural sensitive value on the page to sample - and a test that quietly finds nothing to
    // assert on is a test that passes for the wrong reason.
    const marks = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const stamp = Date.now();
      const inside = `masked-marker-${stamp}`;
      const outside = `plain-marker-${stamp}`;
      const copy = `authored-copy-${stamp}`;
      const placeholder = `authored-placeholder-${stamp}`;

      const panel = document.createElement("div");
      panel.className = "sentry-mask";
      panel.textContent = inside;

      // Inside the masked panel, but authored copy rather than anybody's data: a field hint, a card title, a
      // placeholder. These were all masked, which is what made a masked panel unreadable rather than merely
      // discreet - a form of `***` labels around `***` boxes.
      const hint = document.createElement("p");
      hint.setAttribute("data-sentry-unmask", "");
      hint.textContent = copy;
      const input = document.createElement("input");
      input.placeholder = placeholder;
      panel.append(hint, input);

      const plain = document.createElement("div");
      plain.textContent = outside;
      main.append(panel, plain);
      return { inside, outside, copy, placeholder };
    });

    await reportAProblem(page);
    await page.waitForTimeout(4000);
    const events = recording.all();
    expect(events).not.toContain(marks.inside); // the panel's values
    expect(events).toContain(marks.outside); // its neighbour on the same page
    expect(events).toContain(marks.copy); // an unmasked hint INSIDE the masked panel
    expect(events).toContain(marks.placeholder); // and the placeholder attribute of a field in it
  });
});
