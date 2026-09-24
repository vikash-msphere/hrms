import { useEffect, useState } from "react";

export type Route = { page: string; id: string | null; sub: string | null; query: Record<string, string> };

// The address the router owns: path + query string, no origin. Routes are real paths (`/employees/<id>/documents`)
// and the Worker serves the shell for any path it does not own itself, so the URL a reader copies is the URL a
// crawler, a monitor and a fresh tab all resolve the same way.
function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function parse(): Route {
  const path = window.location.pathname.replace(/^\/+/, "");
  const [page, id, sub] = path.split("/");
  const query: Record<string, string> = {};
  new URLSearchParams(window.location.search).forEach((v, k) => { query[k] = v; });
  return { page: page || "dashboard", id: id || null, sub: sub || null, query };
}

// ----- The one route-change signal -----
// A history router gets no event of its own: `pushState` fires nothing, and `popstate` fires for entries that are
// not navigations at all (a dialog owns an entry at the SAME address - lib/dialogHistory.ts). So every real route
// change, however it was caused, is announced once here, and the three things that care - the unsaved-changes
// guard, the scroll manager, `useRoute` - listen to this and to nothing else. They run in registration order, and
// this module is imported before React mounts, so the guard has always had its say before a component re-renders.
const ROUTE_EVENT = "hrms:route";
type RouteChange = { prev: string; back: boolean };

function emit(detail: RouteChange) {
  window.dispatchEvent(new CustomEvent<RouteChange>(ROUTE_EVENT, { detail }));
}

function onRouteChange(handler: (change: RouteChange) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<RouteChange>).detail);
  window.addEventListener(ROUTE_EVENT, listener);
  return () => window.removeEventListener(ROUTE_EVENT, listener);
}

// ----- Unsaved-changes guard -----
// Draft forms (settings panels) register here while dirty (via useUnsavedTracker). Any navigation that would
// unmount a panel - a path change, or the inline settings sheet (`?setting=`) opening/closing - asks for
// confirmation first; beforeunload covers reload/tab-close.
const dirtyForms = new Set<string>();
export function reportUnsaved(id: string, dirty: boolean) {
  if (dirty) dirtyForms.add(id);
  else dirtyForms.delete(id);
}
export function hasUnsavedChanges() {
  return dirtyForms.size > 0;
}

const UNSAVED_MSG = "You have unsaved changes. Leave without saving?";

// What a navigation must change to threaten a mounted form: the page path, or which settings sheet is open.
// Query-only changes (filters, open dialogs) never unmount a panel, so they pass without a prompt.
function panelKey(url: string): string {
  const [path, qs = ""] = url.split("?");
  const q = new URLSearchParams(qs);
  return `${path}|${q.get("setting") ?? ""}|${q.get("settingObj") ?? ""}`;
}

let lastUrl = currentUrl();

function guardRefuses(next: string): boolean {
  return dirtyForms.size > 0 && panelKey(next) !== panelKey(lastUrl) && !window.confirm(UNSAVED_MSG);
}

// Tell the guard about an address it did NOT hear about. Every `history.replaceState` write below
// (setRouteRecord, and the query-state writers in lib/urlQuery.ts + DataTable) deliberately announces no route
// change - that is what keeps pure view state from re-rendering the route or consulting the guard. But it also
// leaves `lastUrl` stale, and the NEXT real navigation then compares `panelKey(next)` against a path that was
// never on screen: after opening a linkable record (`/boards/<cardId>`), a query-only change would differ by that
// id segment and prompt "You have unsaved changes" for a navigation that unmounts nothing. So the invariant -
// `lastUrl` is what the address bar says - lives here, in one place, and every silent writer restates it.
export function syncLastUrl() {
  lastUrl = currentUrl();
}

window.addEventListener("beforeunload", (e) => {
  if (dirtyForms.size > 0) e.preventDefault();
});

// ----- Back / forward -----
// Deferred to a microtask rather than read inside the popstate handler, and that is load-bearing. Several
// listeners correct the address DURING a popstate - dialogHistory rewrites the entry underneath a dialog whose
// record id the app has since cleared - and they are registered after this module, so reading synchronously here
// would route to an address that is about to be replaced. All popstate listeners are synchronous, so a microtask
// is exactly "after every one of them has run".
window.addEventListener("popstate", () => {
  queueMicrotask(() => {
    const next = currentUrl();
    // A dialog's history entry sits at the SAME address as the page underneath it, so popping one is not a
    // navigation and must not re-render the route or wake the guard.
    if (next === lastUrl) return;
    const prev = lastUrl;
    if (guardRefuses(next)) {
      // Put the address straight back. `replaceState`, not `history.back()`: stepping again would fire another
      // popstate and, on a cancelled BACK, leave a stray forward entry so the next Back landed on the route the
      // reader had just declined to leave.
      window.history.replaceState(window.history.state, "", prev);
      return;
    }
    lastUrl = next;
    emit({ prev: pathOf(prev), back: true });
  });
});

// ----- Programmatic navigation -----
// The guard is consulted BEFORE the write, unlike the back/forward path above which can only undo one: nothing is
// pushed for a navigation the reader refuses, so a cancelled link click leaves the history stack untouched.
//
// `pushState(null, …)`: a fresh entry must not inherit the current entry's state object. A dialog marks its own
// entry `hrmsDialog: true` (lib/dialogHistory.ts) and drops it by checking that marker on the top entry; copying
// it onto a page navigation would make the next dialog close pop the wrong entry.
//
// `replace` is for a bounce: an address that decided, on arrival, that the reader belongs somewhere else. It
// must not leave its own entry behind, because that entry would bounce again the moment Back landed on it -
// the reader presses Back, the app throws them forward, and the button looks broken.
function go(to: string, replace = false) {
  const url = to.startsWith("/") ? to : `/${to}`;
  if (url === currentUrl()) return;
  if (guardRefuses(url)) return;
  const prev = lastUrl;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  lastUrl = url;
  emit({ prev: pathOf(prev), back: false });
}

// ----- In-app links -----
// Every in-app destination is written as a plain `<a href="/leaves">`, so it is a real link: middle-click opens a
// tab, the status bar shows where it goes, and a crawler or a copy-link gesture gets a working URL. One delegated
// listener turns the ordinary left click into a route change instead of a document load. Anything that is not a
// same-origin app route - another origin, a Worker-owned path, a file, a download, a new tab, a modified click -
// is left to the browser.
const WORKER_OWNED_PREFIXES = ["/v1", "/esign", "/auth", "/found", "/calendar", "/diag", "/healthz", "/readyz"];
// A path whose last segment carries a file extension is asking for a FILE, not an app route (the same test the
// Worker's static site applies in src/http/staticSite.ts).
const LOOKS_LIKE_A_FILE = /\/[^/]+\.[a-z0-9]+$/i;

function servedByWorker(path: string): boolean {
  return WORKER_OWNED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) || LOOKS_LIKE_A_FILE.test(path);
}

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  if (anchor.target && anchor.target !== "_self") return;
  if (anchor.hasAttribute("download")) return;
  // A bare fragment is an in-page anchor (a skip link), not a route.
  if ((anchor.getAttribute("href") ?? "").startsWith("#")) return;
  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return; // mailto:, tel:, a malformed href - the browser's problem, not the router's
  }
  if (url.origin !== window.location.origin) return;
  if (servedByWorker(url.pathname)) return;
  e.preventDefault();
  go(`${url.pathname}${url.search}`);
});

// ----- Scroll position -----
// A route change re-renders the page underneath a window that never moved, so leaving the bottom of a long list
// dropped you into the middle of the next page. Two different behaviours are owed here and the browser gives
// neither for a SPA: a NEW destination starts at the top, and going BACK returns to the row you were looking at.
// The route event says which of the two this was.
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

// Keyed by PATH, not the whole URL: a filter or an opened dialog writes the query, and the page it belongs to has
// not changed - re-anchoring the scroll under a filter chip would be its own bug.
const scrollByPath = new Map<string, number>();
const pathOf = (url: string) => url.split("?")[0] ?? "";

// The page a navigation lands on is not its final height: its chunk may still be downloading and its rows
// are certainly still being fetched, so a scroll set on the spot is clamped to whatever short document
// exists at that instant. Re-assert the target each frame until the document is tall enough to hold it, and
// give up after a second - by then the position is stale anyway. Any real scroll input abandons it at once:
// fighting the user for the scroll position is worse than losing the position.
function restoreScroll(target: number) {
  if (target <= 0) return;
  const deadline = performance.now() + 1000;
  let cancelled = false;
  const opts = { passive: true } as const;
  // Detached explicitly rather than left to `once`: a listener that never fires would otherwise sit there
  // until the user's next scroll, and every navigation in between would add three more.
  const stop = () => {
    cancelled = true;
    window.removeEventListener("wheel", stop);
    window.removeEventListener("touchstart", stop);
    window.removeEventListener("keydown", stop);
  };
  window.addEventListener("wheel", stop, opts);
  window.addEventListener("touchstart", stop, opts);
  window.addEventListener("keydown", stop, opts);
  const step = () => {
    if (cancelled) return;
    window.scrollTo(0, target);
    const reached = Math.abs(window.scrollY - target) < 2;
    if (reached || performance.now() > deadline) { stop(); return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

onRouteChange(({ prev, back }) => {
  const next = pathOf(currentUrl());
  if (next === prev) return; // query-only change: same page, leave the scroll alone
  scrollByPath.set(prev, window.scrollY);
  if (back) restoreScroll(scrollByPath.get(next) ?? 0);
  else window.scrollTo(0, 0);
});

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => onRouteChange(() => setRoute(parse())), []);
  return route;
}

// Accepts either shape of target: a bare path ("announcements/<id>/view"), one that already leads with a slash,
// or a legacy hash form ("#/settings/permissions", which is how a couple of server-built notification links are
// stored) - otherwise the last kind lands on "/#/…" and routes nowhere.
export function navigate(to: string) {
  go(`/${to.replace(/^#?\/?/, "")}`);
}

// Same destination, without keeping the address being left. For a page that redirects on arrival (a settings
// key whose real home is its host page): the address bounced off is consumed rather than stacked, so Back from
// the destination reaches wherever the reader actually came from instead of the redirect that would fire again.
export function redirect(to: string) {
  go(`/${to.replace(/^#?\/?/, "")}`, true);
}

// Switch a page's routed tab (`/leave-requests/history`) while KEEPING the current query string. Clicking a
// metric that means "show me those rows" must not silently drop the filters already in the URL, which a plain
// navigate() would. Pass tab = null to land on the page's default tab.
export function navigateTab(page: string, tab: string | null) {
  go(`/${page}${tab ? `/${tab}` : ""}${window.location.search}`);
}

// Set or clear (value === null) a query param on the CURRENT path, without navigating away: the page path
// (page/id/sub) and any other params are preserved. Used for inline, deep-linkable overlays like the settings
// sheet, so the open panel is shareable and the back button closes it.
//
// `replace` is for the other kind of caller: state that is shareable but is not a step the reader took - which
// board of theirs is on screen. Pushed, each of those costs one back press, and a reader who tried three
// boards is three presses from the page they arrived from.
export function setQueryParam(name: string, value: string | null, opts?: { replace?: boolean }) {
  setQueryParams({ [name]: value }, opts);
}

// Set/clear several query params in one write (one route change). Object-scoped settings need `setting` and
// `settingObj` to move together, else two writes race and one clobbers the other.
export function setQueryParams(patch: Record<string, string | null>, opts?: { replace?: boolean }) {
  const params = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  const q = params.toString();
  go(`${window.location.pathname}${q ? `?${q}` : ""}`, opts?.replace);
}

// Reflect the record a page has OPEN in the path (`/boards/<cardId>`), so what is on screen can be copied, pasted
// to a colleague and reloaded straight back into. Pass null when the record closes.
//
// replaceState, and that is the whole design: no route change is announced, so the route does not re-render, the
// unsaved-changes guard is not consulted about pure view state, and no second history entry appears to fight the
// entry a dialog already pushes for its own back-to-close. The inbound half of the contract (reading the id and
// opening that record) is `useDeepOpen`.
//
// A `sub` segment describes the open record, so clearing the id clears it too: `/page//tab` is not a route.
/**
 * The record segment of the LIVE path (`/<page>/<id>` -> `<id>`), read straight from the URL.
 *
 * `useRoute` only re-parses on a route change, and `setRouteRecord` deliberately announces none, so a route
 * object can be a step behind on this one segment. Anything that acts on "which record is the URL pointing at" -
 * opening a deep-linked row - has to ask the URL rather than the last parse.
 */
// Which segment carries the record. `settings` is the one page whose segment 1 is a TAB rather than a record:
// a dozen catalogs are hosted inside it, so their records live one segment further along (`/settings/<tab>/<id>`
// - which is exactly what App.tsx hands each panel as `openId`). Reading segment 1 there gave `useDeepOpen` the
// tab NAME to compare against a row id; it never matched, and every settings-hosted deep link (leave types,
// shifts, pay components, pay grades, projects, goal templates, benefit plans, …) opened the right tab with
// nothing on it - a link from a search hit or the activity feed that quietly did half its job. Read and write go
// through the same function so the pair cannot drift apart again.
const recordIndex = (page: string) => (page === "settings" ? 2 : 1);

export function routeRecord(): string | null {
  const segments = window.location.pathname.replace(/^\/+/, "").split("/");
  return segments[recordIndex(segments[0] ?? "")] || null;
}

export function setRouteRecord(id: string | null) {
  const parts = window.location.pathname.replace(/^\/+/, "").split("/");
  const page = parts[0] || "dashboard";
  const at = recordIndex(page);
  // Everything before the record stays (the settings tab); everything after it describes the record, so
  // clearing the id clears that too - `/page//tab` is not a route.
  // A record cannot be written into a slot the segments before it have not filled. On `/settings` with no tab
  // chosen, `parts.slice(0, 2)` is just `["settings"]`, so the id landed in segment 1 - which that page reads
  // as the TAB NAME. Nothing to anchor the record to means nothing to write.
  if (id && parts.slice(0, at).filter(Boolean).length < at) return;
  const head = parts.slice(0, at).map((s, i) => (i === 0 ? page : s)).filter(Boolean);
  const tail = parts[at + 1];
  const segments = id ? [...head, id, ...(tail ? [tail] : [])] : head;
  // The CURRENT state object is carried through rather than replaced: a dialog marks its own entry
  // `hrmsDialog: true` and `dropDialogEntry` refuses to pop one whose marker has gone.
  window.history.replaceState(window.history.state, "", `/${segments.join("/")}${window.location.search}`);
  syncLastUrl();
}

/** An absolute, pasteable link to one record's page route (`…/boards/<cardId>`). */
export function recordUrl(page: string, id: string): string {
  return `${window.location.origin}/${page}/${id}`;
}

// The standalone route of one record - `announcements/<id>/view` - where the page renders that record
// ALONE, with no list behind it. A separate route from `recordUrl` on purpose: `/<page>/<id>` is the deep
// link the activity feed, search and every copied link already hand out, and it means "show me this one on
// the board". This is the pop-out: same record, its own page, nothing else on it. A path, not a URL,
// because it is navigated to in this tab (`navigate(pagePath(…))`) - the pop-out is a route, not a window.
export function pagePath(page: string, id: string): string {
  return `${page}/${id}/view`;
}
