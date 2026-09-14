import { useEffect, useState } from "react";

export type Route = { page: string; id: string | null; sub: string | null; query: Record<string, string> };

function parse(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const [page, id, sub] = path.split("/");
  const query: Record<string, string> = {};
  new URLSearchParams(qs).forEach((v, k) => { query[k] = v; });
  return { page: page || "dashboard", id: id || null, sub: sub || null, query };
}

// ----- Unsaved-changes guard -----
// Draft forms (settings panels) register here while dirty (via useUnsavedTracker). Any hash navigation that
// would unmount a panel - a path change, or the inline settings sheet (`?setting=`) opening/closing - asks for
// confirmation first; beforeunload covers reload/tab-close. The hashchange listener is registered at module
// import, BEFORE React mounts useRoute's listener, so the confirm blocks (and the hash is restored) before any
// re-render can unmount the dirty form and lose its edits.
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
function panelKey(hash: string): string {
  const raw = hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const q = new URLSearchParams(qs);
  return `${path}|${q.get("setting") ?? ""}|${q.get("settingObj") ?? ""}`;
}

let lastHash = window.location.hash;
// Set when the guard turns a navigation back, and read by the OTHER hashchange listeners registered in this
// module. A listener's `return` ends that listener, not the event: the scroll handler below ran for the
// rejected navigation too, so cancelling the prompt threw the dirty form to the top of the page and filed the
// route the reader had just refused to leave as its scroll anchor.
let navRejected = false;
window.addEventListener("hashchange", () => {
  navRejected = false;
  const next = window.location.hash;
  if (dirtyForms.size > 0 && panelKey(next) !== panelKey(lastHash) && !window.confirm(UNSAVED_MSG)) {
    navRejected = true;
    // Restore synchronously: listeners registered after this one (useRoute) re-read location.hash and see the
    // original route, so the dirty panel never unmounts.
    //
    // `replaceState`, not `location.hash = lastHash`: assigning the hash PUSHES a history entry, so cancelling
    // a BACK navigation left a stray forward entry and the next Back landed on the route the reader had just
    // declined to leave. It also fires no hashchange of its own, so there is no second event to swallow.
    history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${lastHash}`);
    return;
  }
  lastHash = next;
});

// Tell the guard about a hash it did NOT hear about. Every `history.replaceState` write below (setRouteRecord,
// and the query-state writers in lib/urlQuery.ts + DataTable) deliberately fires no `hashchange` - that is what
// keeps pure view state from re-rendering the route or consulting the guard. But it also leaves `lastHash`
// stale, and the NEXT real navigation then compares `panelKey(next)` against a path that was never on screen:
// after opening a linkable record (`#/boards/<cardId>`), a query-only change would differ by that id segment and
// prompt "You have unsaved changes" for a navigation that unmounts nothing. So the invariant - `lastHash` is
// what the address bar says - lives here, in one place, and every silent writer restates it.
export function syncLastHash() {
  lastHash = window.location.hash;
}

window.addEventListener("beforeunload", (e) => {
  if (dirtyForms.size > 0) e.preventDefault();
});

// ----- Scroll position -----
// A hash write re-renders the page underneath a window that never moved, so leaving the bottom of a long
// list dropped you into the middle of the next page. Two different behaviours are owed here and the browser
// gives neither for a SPA: a NEW destination starts at the top, and going BACK returns to the row you were
// looking at.
//
// Telling them apart needs no history bookkeeping: assigning `location.hash` fires `hashchange` only, while
// back/forward fires `popstate` FIRST and then `hashchange`. So a popstate flag, set and consumed in that
// order, is exactly "this navigation was the back button".
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

// Keyed by PATH, not the whole hash: a filter or an opened dialog writes the query, and the page it belongs
// to has not changed - re-anchoring the scroll under a filter chip would be its own bug.
const scrollByPath = new Map<string, number>();
const pathOf = (hash: string) => hash.replace(/^#\/?/, "").split("?")[0] ?? "";

let cameFromHistory = false;
window.addEventListener("popstate", () => { cameFromHistory = true; });

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

window.addEventListener("hashchange", (e) => {
  const back = cameFromHistory;
  cameFromHistory = false;
  // The guard above put the address straight back, so nothing was navigated to and nothing was left: the
  // scroll belongs exactly where it is.
  if (navRejected) return;
  // The page being LEFT comes from the event's own `oldURL`, not from a variable this listener maintains:
  // several places (setRouteRecord, the query-state writers) rewrite the path with `replaceState` and
  // deliberately fire no hashchange, so anything tracked here would be describing a path the user left two
  // interactions ago. `oldURL` is always what the address bar actually held a moment ago.
  const prev = pathOf(new URL(e.oldURL).hash);
  const next = pathOf(window.location.hash);
  if (next === prev) return; // query-only change: same page, leave the scroll alone
  scrollByPath.set(prev, window.scrollY);
  if (back) restoreScroll(scrollByPath.get(next) ?? 0);
  else window.scrollTo(0, 0);
});

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const handler = () => setRoute(parse());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}

// Accepts either shape of target: a bare path ("announcements/<id>/view") or one that already carries the hash
// ("#/settings/permissions", which is how a couple of server-built notification links are stored) - otherwise
// the second kind lands on "#/#/…" and routes nowhere.
export function navigate(to: string) {
  window.location.hash = `#/${to.replace(/^#\/?/, "")}`;
}

// Switch a page's routed tab (`#/leave-requests/history`) while KEEPING the current query string. Clicking a
// metric that means "show me those rows" must not silently drop the filters already in the URL, which a plain
// navigate() would. Pass tab = null to land on the page's default tab.
export function navigateTab(page: string, tab: string | null) {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [, qs = ""] = raw.split("?");
  window.location.hash = `#/${page}${tab ? `/${tab}` : ""}${qs ? `?${qs}` : ""}`;
}

// Set or clear (value === null) a query param on the CURRENT hash path, without navigating away: the page
// path (page/id/sub) and any other params are preserved. Used for inline, deep-linkable overlays like the
// settings sheet, so the open panel is shareable and the back button closes it.
export function setQueryParam(name: string, value: string | null) {
  setQueryParams({ [name]: value });
}

// Set/clear several query params in one hash write (one hashchange). Object-scoped settings need `setting` and
// `settingObj` to move together, else two writes race and one clobbers the other.
export function setQueryParams(patch: Record<string, string | null>) {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const params = new URLSearchParams(qs);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  const q = params.toString();
  window.location.hash = `#/${path}${q ? `?${q}` : ""}`;
}

// Reflect the record a page has OPEN in the hash path (`#/boards/<cardId>`), so what is on screen can be
// copied, pasted to a colleague and reloaded straight back into. Pass null when the record closes.
//
// replaceState, not a hash write, and that is the whole design: no `hashchange` fires, so the route does not
// re-render, the unsaved-changes guard is not consulted about pure view state, and no second history entry
// appears to fight the entry a dialog already pushes for its own back-to-close. The inbound half of the
// contract (reading the id and opening that record) is `useDeepOpen` and was always there - this is the
// outbound half that was missing, which is why no task or ticket has ever been linkable.
//
// A `sub` segment describes the open record, so clearing the id clears it too: `#/page//tab` is not a route.
/**
 * The record segment of the LIVE hash (`#/<page>/<id>` -> `<id>`), read straight from the URL.
 *
 * `useRoute` only re-parses on hashchange, and `setRouteRecord` deliberately fires none, so a route object can
 * be a step behind on this one segment. Anything that acts on "which record is the URL pointing at" - opening
 * a deep-linked row - has to ask the URL rather than the last parse.
 */
// Which segment carries the record. `settings` is the one page whose segment 1 is a TAB rather than a record:
// a dozen catalogs are hosted inside it, so their records live one segment further along (`#/settings/
// <tab>/<id>` - which is exactly what App.tsx hands each panel as `openId`). Reading segment 1 there gave
// `useDeepOpen` the tab NAME to compare against a row id; it never matched, and every settings-hosted deep
// link (leave types, shifts, pay components, pay grades, projects, goal templates, benefit plans, …) opened
// the right tab with nothing on it - a link from a search hit or the activity feed that quietly did half its
// job. Read and write go through the same function so the pair cannot drift apart again.
const recordIndex = (page: string) => (page === "settings" ? 2 : 1);

export function routeRecord(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path = ""] = raw.split("?");
  const segments = path.split("/");
  return segments[recordIndex(segments[0] ?? "")] || null;
}

export function setRouteRecord(id: string | null) {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const parts = path.split("/");
  const page = parts[0] || "dashboard";
  const at = recordIndex(page);
  // Everything before the record stays (the settings tab); everything after it describes the record, so
  // clearing the id clears that too - `#/page//tab` is not a route.
  // A record cannot be written into a slot the segments before it have not filled. On `#/settings` with no tab
  // chosen, `parts.slice(0, 2)` is just `["settings"]`, so the id landed in segment 1 - which that page reads
  // as the TAB NAME. Nothing to anchor the record to means nothing to write.
  if (id && parts.slice(0, at).filter(Boolean).length < at) return;
  const head = parts.slice(0, at).map((s, i) => (i === 0 ? page : s)).filter(Boolean);
  const tail = parts[at + 1];
  const segments = id ? [...head, id, ...(tail ? [tail] : [])] : head;
  window.history.replaceState(window.history.state, "", `#/${segments.join("/")}${qs ? `?${qs}` : ""}`);
  syncLastHash();
}

/** An absolute, pasteable link to one record's page route (`…/#/boards/<cardId>`). */
export function recordUrl(page: string, id: string): string {
  return `${location.origin}${location.pathname}${location.search}#/${page}/${id}`;
}

// The standalone route of one record - `announcements/<id>/view` - where the page renders that record
// ALONE, with no list behind it. A separate route from `recordUrl` on purpose: `#/<page>/<id>` is the deep
// link the activity feed, search and every copied link already hand out, and it means "show me this one on
// the board". This is the pop-out: same record, its own page, nothing else on it. A path, not a URL,
// because it is navigated to in this tab (`navigate(pagePath(…))`) - the pop-out is a route, not a window.
export function pagePath(page: string, id: string): string {
  return `${page}/${id}/view`;
}
