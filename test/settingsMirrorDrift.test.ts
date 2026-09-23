/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// A SETTINGS MIRROR THAT NEVER RE-READS IS A SETTING THAT NEEDS A RELOAD TO TAKE EFFECT.
//
// Two modules in web/src/lib hold a settings key in a module variable so it can be read SYNCHRONOUSLY from
// render and from handlers that cannot await (lib/orgDay.ts explains the trade at length). Each memoizes the
// read with `x ??= readSetting(...)`, which by construction runs once per page life. (lib/clock.tsx holds the
// same kind of value but re-reads it from a React effect, so it is not a module-scope memo and not matched.)
//
// That memo is correct for the boot path and wrong for everything after it: the key is editable in Settings
// and the server adopts a saved value on the very next request, so a tab that memoized at boot goes on
// enforcing the old one until somebody reloads. lib/orgDay.ts:52-64 states the rule in as many words - "Read
// it AGAIN, because the memo above is settled for the life of the page ... Without this the SPA kept the
// timezone it booted with for the rest of the session - so straight after the save the two disagreed" - and
// pairs its memo with a `subscribeInvalidations` that clears it. lib/clock.tsx does the same.
//
// lib/ticketWorkflow.ts does not, and the symptom is precisely the one its own header says reading the org's
// table was meant to remove: the board renders the default's columns and offers moves the server will refuse.
//
// Asserted from source rather than by driving the modules, because what is being checked is that the WIRING
// exists - a rendered case can only show the boot read, which is the half that already works.
const libs = import.meta.glob("../web/src/lib/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Modules that memoize a settings read into module scope - `<var> ??= readSetting(...)` or `getSetting(...)`. */
const MEMOIZED_READ = /\?\?=\s*(?:await\s+)?(?:readSetting|getSetting)\b/;

const mirrors = Object.entries(libs)
  .filter(([, src]) => MEMOIZED_READ.test(src))
  .map(([path, src]) => [path.split("/").pop()!, src] as const);

describe("settings mirrors re-read when the setting is saved", () => {
  it("finds the mirrors (so a rename cannot empty this suite)", () => {
    // If this drops to zero the regex above has gone stale and every assertion below passes vacuously.
    expect(mirrors.length).toBeGreaterThan(0);
    expect(mirrors.map(([name]) => name)).toContain("orgDay.ts");
  });

  it.each(mirrors.map(([name]) => name))("%s subscribes to settings invalidation", (name) => {
    const src = mirrors.find(([n]) => n === name)![1];
    // The store publishes one signal for "this collection was written", locally and over the cross-tab bus
    // (lib/resourceStore.ts#subscribeInvalidations). A mirror that memoizes has to listen for `settings` on it.
    expect(src).toMatch(/subscribeInvalidations/);
    expect(src).toMatch(/collections\.includes\("settings"\)|includes\("settings"\)/);
  });

  it.each(mirrors.map(([name]) => name))("%s can actually clear its memo", (name) => {
    const src = mirrors.find(([n]) => n === name)![1];
    // Subscribing is not enough: the handler has to null the memo, or the re-read returns the settled promise.
    // orgDay.ts does this in `rehydrateOrgTimezone` (`hydrating = null`).
    expect(src).toMatch(/=\s*null\s*;|=\s*undefined\s*;/);
  });
});
