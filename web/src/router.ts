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
