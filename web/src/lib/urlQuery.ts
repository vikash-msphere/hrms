// Read/write a single key in the hash query (`#/leaves?leave_type=…`). A page-level filter belongs in the URL
// for the same reason a table's sort does: reload, back, and a pasted link should all land on the view the
// person was actually looking at. Written with replaceState so a filter toggle doesn't stack history entries -
// and because router.ts's unsaved-changes guard deliberately ignores query-only changes.
import { syncLastHash } from "../router";

export function readHashQuery(key: string): string | null {
  const qs = window.location.hash.split("?")[1] ?? "";
  return new URLSearchParams(qs).get(key);
}

export function writeHashQuery(key: string, value: string | null) {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  const params = new URLSearchParams(qs);
  if (params.get(key) === value || (!params.has(key) && value === null)) return;
  if (value === null) params.delete(key);
  else params.set(key, value);
  const q = params.toString();
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/${path}${q ? `?${q}` : ""}`);
  syncLastHash(); // no hashchange fires, so the guard has to be told what the address bar now says
}
