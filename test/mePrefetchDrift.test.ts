/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Drift gate between the identity prefetch and the API client.
//
// web/public/theme-init.js starts `GET /v1/users/me` from a blocking <head> script so it overlaps with the
// bundle download, and api.ts claims that Response instead of issuing its own request. That only works while
// the two agree on what the request IS: same URL, same headers, same credentials mode. theme-init.js cannot
// import anything (it ships as a plain classic script so the CSP can stay `script-src 'self'`), so nothing
// but this test stops the two drifting apart.
//
// Drift here is not a broken build, which is what makes it worth a gate: the app would keep working and
// simply answer identity from a request that no longer matches - a stale header, a changed base path, or, in
// the case that matters, a request made without the `X-View-As` that a simulation requires. That last one
// would show an admin their own shell while they believed they were looking at somebody else's.
//
// All three files are read as text. api.ts pulls in the app's module graph, and theme-init.js is not a module
// at all. The parsing is shallow by design and each step fails loudly if it finds nothing.
const themeInit = import.meta.glob("../web/public/theme-init.js", { query: "?raw", import: "default", eager: true })[
  "../web/public/theme-init.js"
] as string;
const apiTs = import.meta.glob("../web/src/api.ts", { query: "?raw", import: "default", eager: true })["../web/src/api.ts"] as string;
const viewAsStore = import.meta.glob("../web/src/lib/viewAsStore.ts", { query: "?raw", import: "default", eager: true })[
  "../web/src/lib/viewAsStore.ts"
] as string;

// The headers object api.ts sends on an ordinary call, as literal name/value pairs. Anything spread in
// (`viewAsHeader`, `init.headers`) is absent from a prefetchable request by construction and is not parsed.
function apiConstantHeaders(): Map<string, string> {
  const line = apiTs.match(/headers:\s*\{\s*("Content-Type"[\s\S]*?)\},\s*\n\s*credentials:/)?.[1] ?? "";
  const out = new Map<string, string>();
  for (const [, k, v] of line.matchAll(/"([\w-]+)":\s*"([^"]*)"/g)) out.set(k!, v!);
  return out;
}

// The same, from the fetch() call in theme-init.js.
function prefetchConstantHeaders(): Map<string, string> {
  const line = themeInit.match(/headers:\s*\{([^}]*)\}/)?.[1] ?? "";
  const out = new Map<string, string>();
  for (const [, k, v] of line.matchAll(/"([\w-]+)":\s*"([^"]*)"/g)) out.set(k!, v!);
  return out;
}

describe("the identity prefetch matches the request api.ts would make", () => {
  it("parses both files (a silent parse failure would pass every assertion below)", () => {
    expect(themeInit, "web/public/theme-init.js").toMatch(/__hrmsMePrefetch/);
    expect(apiTs, "web/src/api.ts").toMatch(/claimMePrefetch/);
    expect(apiConstantHeaders().size, "headers parsed out of api.ts").toBeGreaterThan(0);
    expect(prefetchConstantHeaders().size, "headers parsed out of theme-init.js").toBeGreaterThan(0);
  });

  it("sends exactly the constant headers api.ts sends", () => {
    expect(Object.fromEntries(prefetchConstantHeaders())).toEqual(Object.fromEntries(apiConstantHeaders()));
  });

  it("requests the path api.ts would build for /users/me", () => {
    // api.ts fetches `/v1${path}`, and useMe passes "/users/me".
    expect(themeInit).toMatch(/fetch\("\/v1\/users\/me"/);
    expect(apiTs, "api.ts no longer builds request URLs as /v1 + path").toMatch(/fetch\(`\/v1\$\{path\}`/);
  });

  it("uses the same credentials mode", () => {
    const mode = apiTs.match(/credentials:\s*"(\w+)"/)?.[1];
    expect(mode, "credentials mode in api.ts").toBeTruthy();
    expect(themeInit).toMatch(new RegExp(`credentials:\\s*"${mode}"`));
  });

  it("skips the prefetch on the storage key viewAsStore actually uses", () => {
    // The one request that must never be answered for the wrong principal. theme-init.js declines to prefetch
    // when a simulation is stored rather than replicating X-View-As, so it has to read the real key.
    const key = viewAsStore.match(/const KEY = "([^"]+)"/)?.[1];
    expect(key, "KEY in viewAsStore.ts").toBeTruthy();
    expect(themeInit, `theme-init.js must skip the prefetch when "${key}" is set`).toContain(`localStorage.getItem("${key}")`);
  });

  it("is claimed only for a request carrying no view-as and no extra headers", () => {
    const guard = apiTs.match(/function claimMePrefetch[\s\S]*?\n}/)?.[0] ?? "";
    expect(guard, "claimMePrefetch in api.ts").toBeTruthy();
    expect(guard, "must not claim a non-GET").toMatch(/method/);
    expect(guard, "must not claim a request with extra headers").toMatch(/init\.headers/);
    expect(guard, "must not claim the asRealCaller read").toMatch(/asRealCaller/);
    expect(guard, "must not claim while a simulation is running").toMatch(/getViewAs\(\)/);
    // Claimed at most once: a Response body cannot be read twice.
    expect(guard, "must clear the stash when it claims it").toMatch(/__hrmsMePrefetch = undefined/);
  });
});
