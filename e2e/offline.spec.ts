import { allowConsoleErrors, gotoRoute, test, expect } from "./fixtures";

// Losing the network, and getting it back.
//
// Before the bar existed this was silent: every read failed, each panel drew its own "couldn't load this"
// message, and nothing said the reason was the connection or that it had returned (OfflineBar.tsx). The
// behaviour is built out of `navigator.onLine` and the window `online`/`offline` events, and the recovery
// re-reads whatever is mounted - none of which exists anywhere but a live browser with its network pulled.
test("the app says when the network goes, and re-reads when it comes back", async ({ as }) => {
  const page = await as("super");
  await gotoRoute(page, "dashboard");
  // Reads fired while the network is down fail loudly in the console. That is the scenario.
  allowConsoleErrors(page, /Failed to (load resource|fetch)|net::|ERR_INTERNET_DISCONNECTED/i);

  await page.context().setOffline(true);
  await expect(page.getByText("You're offline - showing what was already loaded")).toBeVisible();

  // Coming back re-reads what is on screen (refetchMounted), so the page is not left as a wall of failed
  // panels over a working connection. The bar clears itself once that is done.
  const refetched = page.waitForRequest((r) => new URL(r.url()).pathname.startsWith("/v1"));
  await page.context().setOffline(false);
  await refetched;
  await expect(page.getByText("You're offline - showing what was already loaded")).toBeHidden();
  await expect(page.getByRole("main")).not.toBeEmpty();
});
