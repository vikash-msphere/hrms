import { describe, it, expect, beforeEach } from "vitest";
import { cached, clearCache } from "../src/lib/cache";

// The request a call is made from. Production passes the request's Deps; any object identity will do here.
const req = {};

// P3: the isolate cache must be CORRECTNESS-INDEPENDENT - a cold isolate (miss) and a warm one (hit) yield
// the identical value, the cache only saves the read. It must also never serve past its TTL and must drop a
// key on demand (the recompile/edit invalidation path that keeps a grant edit from being masked in-isolate).
describe("isolate cache - correctness-independent + invalidation", () => {
  beforeEach(() => clearCache());

  it("loads once on a miss, serves the SAME value warm (cold == warm)", async () => {
    let calls = 0;
    const load = async () => ({ n: ++calls });
    const cold = await cached(req, "k", 10_000, load);
    const warm = await cached(req, "k", 10_000, load);
    expect(calls).toBe(1); // warm hit did not reload
    expect(warm).toBe(cold); // identical value -> the verdict input is the same cold or warm
  });

  it("never serves past its TTL (ttl 0 always reloads -> no stale authority)", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached(req, "k", 0, load);
    await cached(req, "k", 0, load);
    expect(calls).toBe(2);
  });

  it("clearCache(key) forces a reload (the grant-recompile invalidation path)", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached(req, "role", 10_000, load);
    clearCache("role");
    const after = await cached(req, "role", 10_000, load);
    expect(calls).toBe(2);
    expect(after).toBe(2);
  });

  it("clearCache() drops everything; distinct keys never collide", async () => {
    const x = await cached(req, "x", 10_000, async () => "X");
    const y = await cached(req, "y", 10_000, async () => "Y");
    expect([x, y]).toEqual(["X", "Y"]);
    clearCache();
    expect(await cached(req, "x", 10_000, async () => "X2")).toBe("X2"); // reloaded after a full clear
  });
});

// The `stale` question is how a long-held value is checked against the cache counters (lib/cacheGenerations.ts).
describe("isolate cache - the stale check", () => {
  beforeEach(() => clearCache());

  it("keeps a hit the check calls fresh, and reloads one it calls stale", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached(req, "k", 10_000, load);
    expect(await cached(req, "k", 10_000, load, () => false)).toBe(1);
    expect(await cached(req, "k", 10_000, load, () => true)).toBe(2);
    expect(calls).toBe(2);
  });

  it("reloads ONCE per call even when the fresh value is stale too (a replica behind the check), never looping", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached(req, "k", 10_000, load);
    // Always stale: the reloaded value is returned without being asked about again.
    expect(await cached(req, "k", 10_000, load, () => true)).toBe(2);
    expect(calls).toBe(2);
  });

  it("callers in one request who find the same stale entry share one reload", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached(req, "k", 10_000, load);
    const stale = (v: number) => v === 1;
    const [a, b, c] = await Promise.all([cached(req, "k", 10_000, load, stale), cached(req, "k", 10_000, load, stale), cached(req, "k", 10_000, load, stale)]);
    expect([a, b, c]).toEqual([2, 2, 2]);
    expect(calls).toBe(2);
  });
});

// The Workers runtime resumes an awaiting request inside the request that resolved the promise, so a request
// joining another's pending D1 read would run its own next query in the wrong request and fail.
describe("isolate cache - requests never await each other's loads", () => {
  beforeEach(() => clearCache());

  it("a load another request has in flight is a miss, not something to wait on", async () => {
    let release!: (v: string) => void;
    const slow = new Promise<string>((resolve) => (release = resolve));
    const first = cached({}, "k", 10_000, () => slow);
    // The first request's load has not settled; a second request reads for itself instead of joining it.
    let calls = 0;
    expect(await cached({}, "k", 10_000, async () => `own ${++calls}`)).toBe("own 1");
    release("first");
    expect(await first).toBe("first");
  });

  it("one request's concurrent callers still share its load", async () => {
    let calls = 0;
    const load = async () => ++calls;
    const [a, b] = await Promise.all([cached(req, "k", 10_000, load), cached(req, "k", 10_000, load)]);
    expect([a, b]).toEqual([1, 1]);
    expect(calls).toBe(1);
  });

  it("a SETTLED value is shared across requests", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cached({}, "k", 10_000, load);
    expect(await cached({}, "k", 10_000, load)).toBe(1);
    expect(calls).toBe(1);
  });
});
