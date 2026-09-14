import { gotoRoute, personId, test, expect } from "./fixtures";

// The record page's sticky identity bar.
//
// An employee record is long - eleven tabs, and panels inside them that run for screens - so by the time you
// are deciding something about this person their name is several screens up. The bar puts the identity back
// on screen once the header has scrolled away, and must cost nothing before that: it is a zero-height sticky
// container, because a merely-transparent bar still reserves its own height and that put a bar's worth of
// empty space above every profile header.
test("the identity bar appears once the header scrolls away, and takes no space before it", async ({ as }) => {
  const page = await as("hr");
  // A short window, so the page reliably overflows and there is something to scroll. At the default height
  // this record fits the viewport exactly (documentElement.scrollHeight === innerHeight), and a spec that
  // scrolls a page which cannot scroll proves nothing either way.
  await page.setViewportSize({ width: 1280, height: 500 });
  const eve = await personId(page, "employee");
  await gotoRoute(page, `employees/${eve}`);

  // The bar is always mounted (so scrolling past the header does not re-fetch the face), and it is FADED
  // rather than unmounted. So its state is read from `aria-hidden`, not from Playwright's visibility: an
  // `opacity: 0` element still has a box, and `toBeVisible()` counts it as visible.
  const bar = page.getByTestId("profile-sticky-bar");
  await expect(bar).toBeAttached();
  await expect(bar).toHaveAttribute("aria-hidden", "true");
  // The part that regressed once: hidden or not, the slot it lives in must occupy no layout, or every
  // profile header carries a bar's worth of empty space above it.
  const slot = page.getByTestId("profile-sticky-bar-slot");
  expect((await slot.boundingBox())?.height ?? -1).toBe(0);

  // Past the identity row - the name and its actions - which is what the bar replaces. Not past the whole
  // card: the facts band and the tab strip stay useful on screen, and waiting for them cost the bar every
  // record whose page scrolls less than a card's height.
  //
  // `window.scrollTo`, NOT `mouse.wheel`: the wheel fires wherever the pointer happens to be, which starts
  // at (0,0) - over the sidebar, which is its own `overflow-y-auto` scroll container. The wheel then scrolls
  // THAT and the document never moves, which reads exactly like a broken sticky bar.
  await page.evaluate(() => window.scrollTo(0, 400));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(bar).toHaveAttribute("aria-hidden", "false");
  // It carries the identity, which is the whole point of it.
  await expect(bar.getByText(/Eve Employee/)).toBeVisible();
  // And it settles under the app's own top bar rather than over it. Polled, because it arrives on a 200ms
  // transform: measured on the first frame it is still 8px high of where it lands.
  await expect.poll(async () => (await bar.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(56);

  // Back to the top and it stands down again.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar).toHaveAttribute("aria-hidden", "true");
});

// Where the header's actions go is decided by whether they FIT beside the person, not by a breakpoint: the
// name is of unknown length and the button row's width depends on which actions the viewer holds. Beside
// when there is room, below when there is not - and in neither case may they squeeze the identity or push
// the page sideways.
//
// Both directions are asserted, because each failed differently while this was being built: on a wide screen
// the buttons stole the name's width, and on a narrow one they wrapped into the gap beside the face.
for (const [label, width, beside] of [
  ["a phone", 390, false],
  // 700 is chosen to be genuinely too tight rather than arbitrarily narrow: the identity's 440px basis plus
  // this viewer's three buttons exceeds the content width, so the line has to break. At 900 they DO both
  // fit, and sit side by side - which is the rule working, not failing.
  ["a narrow window", 700, false],
  ["a wide screen", 1800, true],
] as const) {
  test(`the header's actions sit ${beside ? "beside" : "below"} the person on ${label}`, async ({ as }) => {
    const page = await as("hr");
    await page.setViewportSize({ width, height: 800 });
    const eve = await personId(page, "employee");
    await gotoRoute(page, `employees/${eve}`);

    const name = page.getByRole("heading", { level: 1, name: /Eve Employee/ });
    const orgChart = page.getByRole("main").getByRole("button", { name: "Org chart" });
    await expect(name).toBeVisible();
    await expect(orgChart).toBeVisible();

    const nameBox = (await name.boundingBox())!;
    const btnBox = (await orgChart.boundingBox())!;
    if (beside) {
      // On the same line as the name, and to the right of it.
      expect(btnBox.y).toBeLessThan(nameBox.y + nameBox.height);
      expect(btnBox.x).toBeGreaterThan(nameBox.x);
    } else {
      // Below: the button's top edge starts under the name's bottom edge.
      expect(btnBox.y).toBeGreaterThan(nameBox.y + nameBox.height);
    }

    // Either way nothing has spilled out of the card - the page must not scroll sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
