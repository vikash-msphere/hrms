// Apply the saved theme before first paint so there is no light/dark flash on load. Mirrors the storage key
// + resolution logic in src/lib/theme.ts. Kept as an external file (not inline) so the SPA can ship a strict
// Content-Security-Policy with `script-src 'self'` and no `'unsafe-inline'`.
(function () {
  try {
    var t = localStorage.getItem("theme") || "system";
    var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
})();

// Start the identity request HERE, not from React.
//
// This is a blocking classic script in <head>, so it runs while the module bundle is still being fetched;
// `useMe` runs after all of it has downloaded, parsed and mounted. Boot was therefore two serial round trips:
// the bundle, then /users/me, then the first page reads. Firing it now overlaps identity with the bundle
// download and takes one round trip off every cold load. Nothing is done with the answer here - it is parked
// on `window` and picked up by api.ts, which applies the same 401/403/error handling it always has.
//
// The request must be byte-identical to the one api.ts would send, or it would be answered for a different
// principal. Two things make that safe rather than a duplicated-logic trap:
//   - the headers, URL and credentials mode are constants, held to api.ts's by test/mePrefetchDrift.test.ts;
//   - a "view as" simulation, the ONE case where /users/me answers as somebody else, is detected and skipped
//     outright. Replicating X-View-As here would mean mirroring viewAsStore's parsing and api.ts's carve-outs
//     in a file that cannot import either. Skipping costs a rare admin mode one round trip and cannot ever
//     answer as the wrong person; a malformed or stale key skips too, which is the safe direction.
(function () {
  try {
    if (localStorage.getItem("hrms:viewAs")) return;
  } catch (e) {
    return; // no storage access = can't rule out a simulation
  }
  try {
    window.__hrmsMePrefetch = fetch("/v1/users/me", {
      headers: { "Content-Type": "application/json", "X-Requested-By": "hrms-spa" },
      credentials: "include",
    }).catch(function () {
      return null; // offline, or the server is down: api.ts retries for real and reports it properly
    });
  } catch (e) {}
})();
