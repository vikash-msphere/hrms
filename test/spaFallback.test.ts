// The Worker owns the SPA fallback (wrangler.toml sets `not_found_handling = "none"`), so these rules are
// code, not platform behaviour, and they are the kind that break quietly:
//
//   - a missing FILE must 404. The platform's own SPA fallback answers every miss with index.html at 200,
//     which a browser fetching a script reads as "wrong content type" and then CACHES - a service worker
//     poisoned that way stays broken until the user clears their cache by hand.
//   - a miss under a worker-owned prefix must 404. Those are the API and the unauthenticated public pages;
//     answering with the shell turns "feed disabled" or "forged token" into a 200 page.
//   - anything else is a client-side route and must get the shell, or deep links and refreshes 404.
import { describe, expect, it } from "vitest";
import { app, WORKER_OWNED_PREFIXES } from "../src/index";
import type { Bindings } from "../src/env";

// Inlined at build time rather than read with node:fs: these run inside workerd, which has no filesystem.
// Same approach the migration suite uses to pull in its .sql files.
// Both deploy targets, because they are separate files now: production in wrangler.toml, staging in
// wrangler.staging.toml. A prefix added to one and not the other means that route reaches the Worker in one
// environment and is answered by the SPA shell in the other - exactly the difference staging exists to not
// have, and invisible until somebody rehearses a release and the route 404s there alone.
const wranglerConfigs = Object.entries(
  import.meta.glob("../wrangler*.toml", { query: "?raw", import: "default", eager: true }) as Record<string, string>
);

const viteConfig = Object.values(
  import.meta.glob("../web/vite.config.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>
)[0]!;

describe("SPA fallback", () => {
  // wrangler.toml decides which paths reach the Worker at all; WORKER_OWNED_PREFIXES decides how a miss among
  // them is answered. A prefix in one and not the other is invisible until that route starts serving HTML.
  it("WORKER_OWNED_PREFIXES matches run_worker_first in every wrangler config", () => {
    // Two files are expected. One means the staging config was deleted or renamed and this gate quietly
    // stopped covering it, which is the failure mode a `for` loop over whatever matched cannot report.
    expect(wranglerConfigs.map(([path]) => path).sort()).toEqual(
      ["../wrangler.staging.toml", "../wrangler.toml"],
    );
    for (const [path, toml] of wranglerConfigs) {
      const matches = [...toml.matchAll(/^\s*run_worker_first\s*=\s*\[([^\]]*)\]/gm)];
      expect(matches.length, path).toBeGreaterThan(0); // the regex silently passing on zero matches would prove nothing
      for (const [, list] of matches) {
        const prefixes = [...list!.matchAll(/"([^"]+)"/g)]
          .map((m) => m[1]!.replace(/\/\*$/, "")) // "/v1/*" -> "/v1"
          .sort();
        expect(prefixes, path).toEqual([...WORKER_OWNED_PREFIXES].sort());
      }
    }
  });

  // The THIRD list. A worker-owned path has to be named in three places that cannot see each other:
  // run_worker_first (so Cloudflare's asset layer does not answer it), WORKER_OWNED_PREFIXES (so a miss under
  // it 404s instead of serving the shell), and the Vite dev proxy (so it reaches the Worker at all in local
  // development). The first two already had this guard; the third did not, and adding /diag without it meant
  // the route worked in production and 404'd on every developer's machine - the SPA's own index.html
  // answering a POST, which looks exactly like the route not existing.
  it("the Vite dev proxy forwards every worker-owned prefix", () => {
    // Underscores are part of the character class because a worker-owned prefix can carry one: wrangler's
    // own `/__scheduled` is the case in point. Without them this regex simply stopped matching, and the
    // failure was "expected null not to be null" - the gate going blind rather than reporting a mismatch,
    // which is the worse of the two ways for a drift test to break.
    const alternation = viteConfig.match(/\^\/\(([a-z_|]+)\)\(\/\|\$\)/);
    expect(alternation).not.toBeNull();
    const proxied = alternation![1]!.split("|").map((p) => `/${p}`);
    // /v1 is excluded here on purpose: it has its own two proxy entries above (Prism, plus the binary custom
    // methods that must bypass it), so it is never part of this alternation.
    expect(proxied.sort()).toEqual(WORKER_OWNED_PREFIXES.filter((p) => p !== "/v1").sort());
  });

  // Guards the classification itself. The regex has to catch a hashed asset without catching an app route
  // that merely contains a dot-free word, so both directions are pinned.
  it("tells a file request apart from a client-side route", () => {
    const looksLikeAFile = (p: string) => /\/[^/]+\.[a-z0-9]+$/i.test(p);

    for (const p of ["/push-sw.js", "/assets/index-DRYsST8K.js", "/assets/a.css", "/favicon.svg", "/manifest.webmanifest", "/assets/pdfjs/wasm/jbig2.wasm"]) {
      expect(looksLikeAFile(p), p).toBe(true);
    }
    for (const p of ["/", "/notifications", "/employees/123", "/payroll/runs/abc", "/settings/notification-prefs"]) {
      expect(looksLikeAFile(p), p).toBe(false);
    }
  });

  it("treats worker-owned prefixes as owned, and app routes as not", () => {
    const owned = (path: string) => WORKER_OWNED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

    expect(owned("/v1/employees")).toBe(true);
    expect(owned("/calendar/holidays/tok")).toBe(true); // the case that regressed: a disabled feed must 404
    expect(owned("/found/abc")).toBe(true);
    expect(owned("/auth/login")).toBe(true);
    expect(owned("/esign/callback")).toBe(true);

    // A prefix must match on a segment boundary, never as a bare string prefix, or an app route that merely
    // starts with the same letters would be misrouted into a 404.
    expect(owned("/v1beta/x")).toBe(false);
    expect(owned("/calendars")).toBe(false);
    expect(owned("/notifications")).toBe(false);
  });

  // The shell's OWN status, not a hardcoded 200. A client-side route is answered by fetching index.html
  // through the ASSETS binding, and that fetch can fail - the file missing after a bad build, the asset layer
  // unwell. Returning 200 around whatever came back is how an error page becomes a "healthy" app route to
  // every monitor, crawler and browser cache that sees it.
  const dispatch = (path: string, shell: Response) =>
    app.fetch(new Request(`https://hrms.example.com${path}`), { ASSETS: { fetch: async () => shell } } as unknown as Bindings);

  it("serves a client-side route with the shell, at the shell's status", async () => {
    const ok = await dispatch("/notifications", new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("<!doctype html>");
  });

  it("passes a failed shell fetch through instead of dressing it as a 200", async () => {
    const missing = await dispatch("/notifications", new Response("not found", { status: 404 }));
    expect(missing.status).toBe(404);
    const broken = await dispatch("/notifications", new Response("bad gateway", { status: 502 }));
    expect(broken.status).toBe(502);
  });
});
