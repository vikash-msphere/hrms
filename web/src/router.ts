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
let restoringHash = false;
window.addEventListener("hashchange", () => {
  if (restoringHash) {
    restoringHash = false;
    return;
  }
  const next = window.location.hash;
  if (dirtyForms.size > 0 && panelKey(next) !== panelKey(lastHash) && !window.confirm(UNSAVED_MSG)) {
    // Restore synchronously: listeners registered after this one (useRoute) re-read location.hash and see the
    // original route, so the dirty panel never unmounts. The queued hashchange for the restore is swallowed.
    restoringHash = true;
    window.location.hash = lastHash;
    return;
  }
  lastHash = next;
});
window.addEventListener("beforeunload", (e) => {
  if (dirtyForms.size > 0) e.preventDefault();
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

export function navigate(to: string) {
  window.location.hash = `#/${to}`;
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
