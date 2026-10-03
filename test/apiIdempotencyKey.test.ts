/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeEach } from "vitest";

// web/src/api.ts sends an Idempotency-Key only with a write that is not safe to send twice. Each key is a D1
// row the Worker writes, rewrites and sweeps (src/middleware/idempotency.ts), so a write that is already safe to
// repeat - a PATCH or PUT with no `If-Match`, which sets fields - must go without one, and a write the key
// exists for must keep it.
vi.mock("@/lib/crossTabBus", () => ({ publishToAll: () => {}, subscribeTopic: () => () => {} }));
vi.mock("@/lib/viewAsStore", () => ({ getViewAs: () => null, stopViewAs: () => {} }));
vi.mock("@/lib/clientStore", () => ({ purgeCachedData: () => {} }));
vi.mock("@/lib/appLock", () => ({ serverSaysLocked: () => false }));
vi.mock("@/lib/resourceStore", () => ({ invalidateCollections: () => [], affectedCollections: () => [], broadcastInvalidation: () => {} }));
vi.mock("@/lib/getCoalescer", () => ({ coalescedGet: () => Promise.resolve(), coalescedGetDetailed: () => Promise.resolve(), NOT_MODIFIED: Symbol("nm") }));
vi.mock("@/lib/download", () => ({ saveBlob: () => {}, filenameFromDisposition: () => undefined }));

const sent: Headers[] = [];
vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
  sent.push(new Headers(init?.headers));
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
});

const { api, patch } = await import("@/api");

const keyed = () => sent[0]?.has("Idempotency-Key");

beforeEach(() => {
  sent.length = 0;
});

describe("which writes carry an Idempotency-Key", () => {
  it("a PATCH with no If-Match goes without one", async () => {
    await patch("preferences/tab_seen", { value: {} });
    expect(keyed()).toBe(false);
  });

  it("a PUT with no If-Match goes without one", async () => {
    await api("/things/a", { method: "PUT", body: "{}" });
    expect(keyed()).toBe(false);
  });

  it("a PATCH with If-Match carries one: its repeat would be refused 412 for a write that landed", async () => {
    await patch("cards/a", { title: "x" }, '"e1"');
    expect(keyed()).toBe(true);
  });

  it("a POST carries one", async () => {
    await api("/things", { method: "POST", body: "{}" });
    expect(keyed()).toBe(true);
  });

  it("a POST marked safe to repeat, a DELETE and a read go without one", async () => {
    await api("/batch:run", { method: "POST", body: "{}", safeToRepeat: true });
    await api("/things/a", { method: "DELETE" });
    await api("/things");
    expect(sent.map((h) => h.has("Idempotency-Key"))).toEqual([false, false, false]);
  });
});
