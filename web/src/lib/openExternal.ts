// Opening a URL this app did not author.
//
// `noopener` was already set at every call site, which handles reverse-tabnabbing and nothing else. The SCHEME
// is the other half: a window opened with a `javascript:` URL from a same-origin document runs that script in
// THIS origin, so an unchecked value is an XSS sink rather than a navigation. The values these calls carry are
// third-party JSON fields (an e-sign vendor's `signing_link`, stored verbatim and served back on the document
// row), and this codebase already holds a link an employee typed into a post to exactly this standard -
// lib/richText.tsx#safeHref - and outbound webhook targets to it in src/lib/urlGuard.ts.
//
// `https` only, not `https?`: every external link this app opens carries a session or a signed token, and
// those have no business on plain HTTP. `noreferrer` alongside `noopener`, because the alternative is sending
// the vendor this app's own document URL as a `Referer`.
//
// Validated here as well as at the boundary that stores the value: one of the two is defence in depth, and the
// one at the sink is the one that survives a new adapter being added.

/** True when `url` is something this app may hand to `window.open`. */
export const isExternalUrl = (url?: string | null): url is string => typeof url === "string" && /^https:\/\//i.test(url);

/** Open an external URL in a new tab, or do nothing at all if it is not one. */
export function openExternal(url?: string | null): void {
  if (!isExternalUrl(url)) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
