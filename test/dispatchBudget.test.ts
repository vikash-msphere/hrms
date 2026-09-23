/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { describe, it, expect } from "vitest";
import { MAX_TOTAL_DISPATCHES } from "../src/services/automationEngine";
import { ASSET_BATCH_MAX } from "../src/services/assets";

// The automation dispatch ceiling exists to stop a RUNAWAY - a rule whose `apiCall` re-triggers its own
// trigger. It must never refuse a fan-out the app itself authored with a known, bounded size.
//
// It did. `assets:batchCreate` accepts up to ASSET_BATCH_MAX assets in one act and emits one `asset.created`
// per asset; the ceiling was 50. With any rule on that trigger, a 100-asset delivery fired the rule for the
// first fifty and dropped the rest - HTTP 200, the whole inventory written, half the automations missing, and
// the only trace a console.warn plus one `automation_runs` row nobody was looking for.
//
// This is a pure arithmetic check on purpose. The failure it guards is not a behaviour that a scenario test
// would exercise; it is someone adding a bulk verb (or raising an existing cap) whose ceiling crosses the
// budget, months from now, in a file that has nothing to do with automations. Adding a bulk verb with a bigger
// batch than this list knows about is exactly the case that has to fail here.
describe("dispatch budget clears every bounded bulk act", () => {
  // Every verb that emits one event per row in a single originating action, with the cap it accepts.
  const BOUNDED_BULK: { verb: string; cap: number }[] = [
    { verb: "assets:batchCreate", cap: ASSET_BATCH_MAX },
  ];

  for (const { verb, cap } of BOUNDED_BULK) {
    it(`${verb} (${cap} rows) fits inside the ${MAX_TOTAL_DISPATCHES}-dispatch budget`, () => {
      expect(cap).toBeLessThan(MAX_TOTAL_DISPATCHES);
    });
  }

  it("leaves headroom above the largest bulk act, so a rule may also emit its own events", () => {
    // A rule reacting to a bulk event can itself `emitEvent`, and those count too. Requiring the budget to be
    // at least double the largest batch means a one-hop reaction across a full batch still fits.
    const largest = Math.max(...BOUNDED_BULK.map((b) => b.cap));
    expect(MAX_TOTAL_DISPATCHES).toBeGreaterThanOrEqual(largest * 2);
  });
});
