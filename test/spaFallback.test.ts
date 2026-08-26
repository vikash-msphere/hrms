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
import { WORKER_OWNED_PREFIXES } from "../src/index";

// Inlined at build time rather than read with node:fs: these run inside workerd, which has no filesystem.
// Same approach the migration suite uses to pull in its .sql files.
const wranglerToml = Object.values(
  import.meta.glob("../wrangler.toml", { query: "?raw", import: "default", eager: true }) as Record<string, string>
)[0]!;

describe("SPA fallback", () => {
  // wrangler.toml decides which paths reach the Worker at all; WORKER_OWNED_PREFIXES decides how a miss among
  // them is answered. A prefix in one and not the other is invisible until that route starts serving HTML.
  it("WORKER_OWNED_PREFIXES matches run_worker_first in wrangler.toml", () => {
    const matches = [...wranglerToml.matchAll(/^\s*run_worker_first\s*=\s*\[([^\]]*)\]/gm)];
    expect(matches.length).toBeGreaterThan(0); // the regex silently passing on zero matches would prove nothing
    for (const [, list] of matches) {
      const prefixes = [...list!.matchAll(/"([^"]+)"/g)]
        .map((m) => m[1]!.replace(/\/\*$/, "")) // "/v1/*" -> "/v1"
        .sort();
      expect(prefixes).toEqual([...WORKER_OWNED_PREFIXES].sort());
    }
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
});
