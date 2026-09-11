/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The GET coalescer's WINDOW shape. A page load fires its reads in waves - shell providers, then the lazy page
// chunk, then a workspace's tabs - milliseconds apart. A fixed window from the first read cut wherever it landed,
// so a wave arriving a moment late became its own `batch:run` (the "several small batches per page" complaint).
// A trailing window merges adjacent waves; a hard cap stops a steady drip from holding reads indefinitely; and a
// read fired only AFTER an earlier one resolved is a genuinely later phase that must NOT be waited for.

// Reads reach `batchGet` as a bare path string, or as `{ path, etag }` when the caller sent a validator. The
// fake answers 304 for any read that carried one, which is what a server does when the copy is still current.
type Read = string | { path: string; etag?: string };
type Sub = { status: number; body: unknown; etag?: string };
const batchGet = vi.fn(async (reads: Read[]): Promise<Sub[]> =>
  reads.map((r) => (typeof r === "string" ? { status: 200, body: { results: [] } } : { status: 304, body: "", etag: r.etag })),
);
vi.mock("@/api", () => ({
  batchGet: (paths: Read[]) => batchGet(paths),
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public problem: unknown) {
      super(message);
    }
  },
}));

const { coalescedGet, coalescedGetDetailed, NOT_MODIFIED } = await import("@/lib/getCoalescer");

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

  it("never hands a 304 to a reader that sent no validator", async () => {
    // The bug this pins: dedup keyed on the path alone shared a conditional revalidation with an
    // unconditional `list()`, and a 304 then resolved BOTH with NOT_MODIFIED. The plain caller has no rows to
    // keep, so `r.results ?? []` read a property off a Symbol and rendered an empty list with no error - which
    // is what the access screens did, mounting RolesManagePanel (store, with an etag) beside
    // PermissionsPanel's `list<Role>("roles")` on the identical path.
    const revalidation = coalescedGet("roles?5", 'W/"held"'); // the store, revalidating what it holds
    const plain = coalescedGet("roles?5"); // a panel reading the same path with nothing cached
    expect(plain).not.toBe(revalidation); // different reads: one of them cannot use the other's answer
    await vi.advanceTimersByTimeAsync(40);
    expect(await revalidation).toBe(NOT_MODIFIED);
    expect(await plain).toEqual({ results: [] });
    // Both rode the SAME batch - the fix costs one extra sub-request in the overlap, not an extra request.
    expect(batchGet).toHaveBeenCalledTimes(1);
    expect(paths()[0]).toEqual([{ path: "/v1/roles?5", etag: 'W/"held"' }, "/v1/roles?5"]);
  });

  it("still shares one request between two readers holding the SAME validator", async () => {
    const a = coalescedGet("roles?6", 'W/"same"');
    const b = coalescedGet("roles?6", 'W/"same"');
    expect(a).toBe(b);
    await vi.advanceTimersByTimeAsync(40);
    expect(paths()[0]).toEqual([{ path: "/v1/roles?6", etag: 'W/"same"' }]);
  });

  // The validator has to travel WITH its own answer. It used to be looked up from a `path -> etag` map after
  // the promise resolved, so two concurrent reads of one path handed each other's etag over - and rows then
  // stored against a validator describing a DIFFERENT set of rows are pinned there by the next 304.
  it("gives each read back the validator its own response carried", async () => {
    batchGet.mockImplementationOnce(async (reads: Read[]): Promise<Sub[]> =>
      reads.map((_r, i) => ({ status: 200, body: { results: [{ i }] }, etag: `W/"answer-${i}"` })),
    );
    const first = coalescedGetDetailed<{ results: unknown[] }>("same-path?7");
    const second = coalescedGetDetailed<{ results: unknown[] }>("same-path?7", 'W/"held"');
    await vi.advanceTimersByTimeAsync(40);
    // Two reads of one path, answered in the one batch, each keeping the etag from its own sub-response.
    expect((await first).etag).toBe('W/"answer-0"');
    expect((await second).etag).toBe('W/"answer-1"');
  });

  it("carries the validator a 304 came back with, so the held rows keep a usable one", async () => {
    const answer = coalescedGetDetailed("roles?8", 'W/"held"');
    await vi.advanceTimersByTimeAsync(40);
    const a = await answer;
    expect(a.body).toBe(NOT_MODIFIED);
    expect(a.etag).toBe('W/"held"');
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
