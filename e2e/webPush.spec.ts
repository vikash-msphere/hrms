import { SPA_HEADERS, gotoRoute, test, expect } from "./fixtures";

// Browser push, enrolled and withdrawn from the one place that must never render nothing.
//
// `enablePush`/`disablePush` (lib/webPush.ts) ask the BROWSER for a real subscription, which is exactly the
// part no test runner can do for real: subscribing means a round trip to a push service over the open
// internet, which is neither available nor deterministic in CI. So this fakes the three browser APIs the
// module calls - `Notification`, `navigator.serviceWorker` and `PushManager` - with an object that behaves
// like a real one (a subscribe that mints an endpoint, a getSubscription that remembers it, an unsubscribe
// that forgets it) and drives the real `enablePush`/`disablePush`/`getPushState` against that double. What
// this proves is everything downstream of the browser handing back a subscription: the row toggles, the
// state survives a reload (nothing here is kept in React state), and the subscription is written to and
// removed from the caller's OWN preferences row on the server - `test/webPush.test.ts` owns what the server
// does with that row once delivery actually happens.
//
// The fake lives in `localStorage` under a key nothing else touches, so a subscription "created" by enabling
// survives the reload the persistence check needs, the same way a real one would.
async function mockPush(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const KEY = "__e2e_fake_push_subscription__";
    const read = (): { endpoint: string; keys: { p256dh: string; auth: string } } | null => {
      try {
        const raw = localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    };
    const write = (sub: { endpoint: string; keys: { p256dh: string; auth: string } } | null) => {
      try {
        if (sub) localStorage.setItem(KEY, JSON.stringify(sub));
        else localStorage.removeItem(KEY);
      } catch {
        /* private mode: the fake just won't persist across the reload this run happens not to need */
      }
    };
    const wrap = (data: { endpoint: string; keys: { p256dh: string; auth: string } }) => ({
      endpoint: data.endpoint,
      toJSON: () => ({ endpoint: data.endpoint, keys: data.keys }),
      unsubscribe: async () => { write(null); return true; },
    });
    class FakePushManager {
      async getSubscription() {
        const s = read();
        return s ? wrap(s) : null;
      }
      async subscribe() {
        const sub = { endpoint: `https://push.e2e.test/${Math.random().toString(36).slice(2)}`, keys: { p256dh: "e2e-p256dh", auth: "e2e-auth" } };
        write(sub);
        return wrap(sub);
      }
    }
    const registration = { pushManager: new FakePushManager() };
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: { register: async () => registration, getRegistration: async () => registration },
    });
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission() {
        FakeNotification.permission = "granted";
        return Promise.resolve("granted" as NotificationPermission);
      }
    }
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: FakeNotification });
    (window as unknown as { PushManager: unknown }).PushManager = FakePushManager;
  });
}

test("browser push is enrolled, withdrawn, and both survive a reload", async ({ as }) => {
  test.setTimeout(120_000);
  const page = await as("employee");
  await mockPush(page);

  const before = await page.request.get("/v1/preferences/push_subscriptions");
  const kept = before.ok() ? ((await before.json()) as { value?: unknown }).value : undefined;

  try {
    await gotoRoute(page, "notifications", "Notifications");
    await page.getByRole("button", { name: "Your notification preferences" }).click();
    const panel = page.getByRole("dialog", { name: "Your notification preferences" });
    await expect(panel).toBeVisible();

    // The row that must never be empty: with the fake in place it is always the actionable one, off to start.
    await expect(panel.getByText("Browser notifications on this device")).toBeVisible({ timeout: 30_000 });
    const toggle = panel.getByRole("button", { name: /^Turn (on|off)$/ });
    await expect(toggle).toHaveText("Turn on");

    await toggle.click();
    await expect(toggle).toHaveText("Turn off", { timeout: 30_000 });

    // Persisted on the server, in the caller's own preferences row - not only in whatever local state the
    // panel holds. Read straight off the wire rather than through another render.
    const enrolled = await page.request.get("/v1/preferences/push_subscriptions");
    expect(enrolled.status(), await enrolled.text()).toBe(200);
    const enrolledSubs = ((await enrolled.json()) as { value?: { subs?: { endpoint: string }[] } }).value?.subs ?? [];
    expect(enrolledSubs.length, "the fake subscription reached the server").toBeGreaterThan(0);

    // A reload proves the "on" state is read back from the subscription itself, not kept in memory - the
    // panel has to ask the (fake) browser again from cold and draw the same answer.
    // The reload comes back INTO the panel rather than onto the page behind it: opening it wrote
    // `?setting=notification-prefs`, which is how every inline settings panel is addressed. So there is
    // nothing to press here - pressing the gear again would only wait on a trigger the open sheet covers.
    await page.reload();
    const reopened = page.getByRole("dialog", { name: "Your notification preferences" });
    await expect(reopened.getByRole("button", { name: "Turn off" })).toBeVisible({ timeout: 30_000 });

    await reopened.getByRole("button", { name: "Turn off" }).click();
    await expect(reopened.getByRole("button", { name: "Turn on" })).toBeVisible({ timeout: 30_000 });

    const withdrawn = await page.request.get("/v1/preferences/push_subscriptions");
    const withdrawnSubs = ((await withdrawn.json()) as { value?: { subs?: { endpoint: string }[] } }).value?.subs ?? [];
    expect(withdrawnSubs.length, "the withdrawn subscription left the server's copy too").toBe(0);
  } finally {
    // However this ended, leave the caller with exactly the row it had - a stray fake endpoint left behind
    // would report this device as enrolled to every spec that runs after it. Preferences have no delete
    // route (a caller only ever replaces its own row), so an org with no prior row is left with an empty
    // one rather than none at all - indistinguishable from "no subscription" to every reader of it.
    await page.request.patch("/v1/preferences/push_subscriptions", { headers: SPA_HEADERS, data: { value: kept ?? {} } }).catch(() => undefined);
  }
});
