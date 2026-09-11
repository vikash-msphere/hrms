import { SPA_HEADERS, gotoRoute, purge, test, expect } from "./fixtures";

// A native tooltip for whatever CSS is actually clipping, sitewide - not a per-page decision.
//
// `truncate`/`line-clamp` are everywhere in this UI, and every one of them costs the end of the sentence: an
// ellipsis says "there is more" and offers no way to read it. `lib/clippedTitle.ts` fixes that once, for every
// clipped box on the page, by measuring the RUNNING LAYOUT rather than trusting a class list - the same string
// clips on a narrow drawer and fits on a wide one, so whether a `title` belongs on a given element is a fact
// about pixels, not markup. Nothing about that is reachable without an actual browser laying an actual box
// out; a source scan can find every `truncate` in the app and learn nothing about which of them are lying.
//
// Two tickets, not one: the mechanism is proven by BOTH halves at once - a long subject earns a title with the
// full text, and a short one that fits earns no title at all. Either half alone would pass a version that
// always writes one (or never does).
test("a subject too long for its box gets a native title; one that fits gets none", async ({ as }) => {
  // Longer than the 90s the second retry below budgets itself, plus the first dialog's own work ahead of it.
  test.setTimeout(240_000);
  const hr = await as("hr");
  const stamp = Date.now();
  const long = `E2E ${stamp} ` + "a very long subject line that no drawer heading is ever going to have room for in one line ".repeat(2).trim();
  const short = `E2E short ${stamp}`;

  const longTicket = await makeTicket(hr, long);
  const shortTicket = await makeTicket(hr, short);

  try {
    await gotoRoute(hr, "tickets", "Support");

    await hr.locator("tbody tr").filter({ hasText: `E2E ${stamp} ` }).first().click();
    let detail = hr.getByRole("dialog");
    const longSpan = detail.locator("span.truncate", { hasText: /a very long subject/ }).first();
    await expect(longSpan).toBeVisible({ timeout: 30_000 });
    await expect(longSpan).toHaveAttribute("title", long, { timeout: 15_000 });
    // Escape has proven unreliable at actually closing a dialog under load elsewhere in this suite - retried
    // rather than trusted to one press, since a dialog left open here stacks a second one under the next row
    // click below instead of replacing it.
    await expect(async () => {
      if (!(await hr.getByRole("dialog").count())) return;
      await hr.keyboard.press("Escape");
      await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    }).toPass({ timeout: 20_000 });

    detail = hr.getByRole("dialog");
    // Opened, measured and checked as one retried unit. The claim needs a PAUSE in the middle - the title has
    // to have been measured and deliberately not written - and this dialog can go away inside that pause: the
    // Escape retried just above lands late often enough to close this one instead, and the list re-renders on
    // any ticket write, org-wide. Re-opening is the recovery; a dialog that closed under the wait is not the
    // absence of a title.
    // Recovered on "is THIS ticket's heading on screen", not on "is any dialog open". The Escape retried
    // above can land late and leave the LONG ticket's dialog up - a dialog, so a check for one being open is
    // satisfied by it, and every pass then hunts the short subject inside the wrong ticket until the budget
    // runs out. So: whatever is open gets closed first, then this ticket is opened.
    const shortSpan = detail!.locator("span.truncate", { hasText: short }).first();
    await expect(async () => {
      if (!(await shortSpan.count())) {
        await expect(async () => {
          if (!(await hr.getByRole("dialog").count())) return;
          await hr.keyboard.press("Escape");
          await expect(hr.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
        }).toPass({ timeout: 20_000 });
        await hr.locator("tbody tr").filter({ hasText: short }).first().click({ timeout: 8_000 });
      }
      await expect(shortSpan).toBeVisible({ timeout: 10_000 });
      await hr.waitForTimeout(300);
      await expect(shortSpan).toBeVisible({ timeout: 5_000 });
      await expect(shortSpan).not.toHaveAttribute("title");
    }).toPass({ timeout: 90_000 });
    await hr.keyboard.press("Escape");
  } finally {
    await purge(hr, longTicket);
    await purge(hr, shortTicket);
  }
});

async function makeTicket(page: import("@playwright/test").Page, subject: string): Promise<string> {
  const made = await page.request.post("/v1/tickets", {
    headers: SPA_HEADERS,
    data: { subject, category: "it", description: "Raised by the e2e suite to prove the clipped-title behaviour." },
  });
  expect(made.status(), await made.text()).toBe(200);
  return ((await made.json()) as { path: string }).path;
}
