import { describe, it, expect, beforeEach } from "vitest";
import { cached, clearCache } from "../src/lib/cache";

// P3: the isolate cache must be CORRECTNESS-INDEPENDENT - a cold isolate (miss) and a warm one (hit) yield
// the identical value, the cache only saves the read. It must also never serve past its TTL and must drop a
// key on demand (the recompile/edit invalidation path that keeps a grant edit from being masked in-isolate).
describe("isolate cache - correctness-independent + invalidation", () => {
  beforeEach(() => clearCache());

  it("loads once on a miss, serves the SAME value warm (cold == warm)", async () => {
    let calls = 0;
    const load = async () => ({ n: ++calls });
    const cold = await cached("k", 10_000, load);
    const warm = await cached("k", 10_000, load);
    expect(calls).toBe(1); // warm hit did not reload
    expect(warm).toBe(cold); // identical value -> the verdict input is the same cold or warm
  });

  it("never serves past its TTL (ttl 0 always reloads -> no stale authority)", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached("k", 0, load);
    await cached("k", 0, load);
    expect(calls).toBe(2);
  });

  it("clearCache(key) forces a reload (the grant-recompile invalidation path)", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached("role", 10_000, load);
    clearCache("role");
    const after = await cached("role", 10_000, load);
    expect(calls).toBe(2);
    expect(after).toBe(2);
  });

  it("clearCache() drops everything; distinct keys never collide", async () => {
    const x = await cached("x", 10_000, async () => "X");
    const y = await cached("y", 10_000, async () => "Y");
    expect([x, y]).toEqual(["X", "Y"]);
    clearCache();
    expect(await cached("x", 10_000, async () => "X2")).toBe("X2"); // reloaded after a full clear
  });
});

// The `stale` question is how a long-held value is checked against the cache counters (lib/cacheGenerations.ts).
describe("isolate cache - the stale check", () => {
  beforeEach(() => clearCache());

  it("keeps a hit the check calls fresh, and reloads one it calls stale", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached("k", 10_000, load);
    expect(await cached("k", 10_000, load, () => false)).toBe(1);
    expect(await cached("k", 10_000, load, () => true)).toBe(2);
    expect(calls).toBe(2);
  });

  it("reloads ONCE per call even when the fresh value is stale too (a replica behind the check), never looping", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached("k", 10_000, load);
    // Always stale: the reloaded value is returned without being asked about again.
    expect(await cached("k", 10_000, load, () => true)).toBe(2);
    expect(calls).toBe(2);
  });

  it("callers who find the same stale entry share one reload", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached("k", 10_000, load);
    const stale = (v: number) => v === 1;
    const [a, b, c] = await Promise.all([cached("k", 10_000, load, stale), cached("k", 10_000, load, stale), cached("k", 10_000, load, stale)]);
    expect([a, b, c]).toEqual([2, 2, 2]);
    expect(calls).toBe(2);
  });
});
