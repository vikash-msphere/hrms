/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The GET coalescer's WINDOW shape. A page load fires its reads in waves - shell providers, then the lazy page
// chunk, then a workspace's tabs - milliseconds apart. A fixed window from the first read cut wherever it landed,
// so a wave arriving a moment late became its own `batch:run` (the "several small batches per page" complaint).
// A trailing window merges adjacent waves; a hard cap stops a steady drip from holding reads indefinitely; and a
// read fired only AFTER an earlier one resolved is a genuinely later phase that must NOT be waited for.

const batchGet = vi.fn(async (paths: string[]) => paths.map(() => ({ status: 200, body: { results: [] } })));
vi.mock("@/api", () => ({
  batchGet: (paths: string[]) => batchGet(paths),
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public problem: unknown) {
      super(message);
    }
  },
}));

const { coalescedGet } = await import("@/lib/getCoalescer");

beforeEach(() => {
  vi.useFakeTimers();
  batchGet.mockClear();
});
afterEach(async () => {
  // Drain anything still queued (the drip case flushes more than once) so it can't land in the next test's
  // window - the coalescer is module state, like it is in the browser.
  await vi.advanceTimersByTimeAsync(500);
  vi.useRealTimers();
});

// The coalescer hands `batchGet` full sub-request paths, so assertions compare on those.
const paths = () => batchGet.mock.calls.map((c) => c[0]);

describe("GET coalescer window", () => {
  it("merges waves that arrive a few milliseconds apart into ONE request", async () => {
    void coalescedGet("a?1"); // shell providers
    await vi.advanceTimersByTimeAsync(20);
    void coalescedGet("b?1"); // the page chunk mounts
    await vi.advanceTimersByTimeAsync(20);
    void coalescedGet("c?1"); // a workspace's sibling tabs
    await vi.advanceTimersByTimeAsync(40);
    expect(batchGet).toHaveBeenCalledTimes(1);
    expect(paths()[0]).toEqual(["/v1/a?1", "/v1/b?1", "/v1/c?1"]);
  });

  it("never holds a read past the cap, however long the drip continues", async () => {
    void coalescedGet("a?2");
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(20);
      void coalescedGet(`drip${i}?2`);
    }
    // The first batch went out at the cap rather than waiting for the drip to stop.
    expect(batchGet.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(paths()[0]![0]).toBe("/v1/a?2");
    expect(paths()[0]!.length).toBeLessThan(11);
  });

  it("shares one in-flight promise per path, so duplicate readers never double-fetch", async () => {
    const a = coalescedGet("dup?3");
    const b = coalescedGet("dup?3");
    expect(a).toBe(b);
    await vi.advanceTimersByTimeAsync(40);
    expect(paths()[0]).toEqual(["/v1/dup?3"]);
  });

  it("does not wait for a read that only starts after an earlier one resolved", async () => {
    const first = coalescedGet("first?4");
    await vi.advanceTimersByTimeAsync(40);
    await first;
    void coalescedGet("dependent?4"); // a widget that needed the answer before it could ask
    await vi.advanceTimersByTimeAsync(40);
    expect(batchGet).toHaveBeenCalledTimes(2);
    expect(paths()[1]).toEqual(["/v1/dependent?4"]);
  });
});
