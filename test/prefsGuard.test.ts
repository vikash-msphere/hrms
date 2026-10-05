import { describe, it, expect, beforeEach, vi } from "vitest";

// The SPA's preferences cache (web/src/lib/prefs.ts) as the basis of every preference write. Each write
// replaces the whole value, so a value built on a read that did not land is the write that loses data: a
// person's saved searches, their layouts, another device's push subscription. Pinned here: a failed read makes
// every write create-only, and a read-modify-write refuses outright when it cannot read, guards on the version
// it read, and re-applies its edit when another device wrote in between.

class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
const get = vi.fn();
const listAll = vi.fn();
const patch = vi.fn();
vi.mock("@/api", () => ({
  ApiError,
  get: (...a: unknown[]) => get(...a),
  listAll: (...a: unknown[]) => listAll(...a),
  patch: (...a: unknown[]) => patch(...a),
}));
vi.mock("@/lib/clientStore", () => ({ storedIdentity: () => "u1" }));
vi.mock("@/lib/crossTabBus", () => ({ publish: () => {}, subscribeTopic: () => {} }));

async function prefs() {
  vi.resetModules();
  return import("../web/src/lib/prefs");
}
const headersOf = (call: unknown[]) => (call[3] as { headers?: Record<string, string> } | undefined)?.headers ?? {};

beforeEach(() => {
  get.mockReset();
  listAll.mockReset();
  patch.mockReset().mockResolvedValue({});
});

describe("a preference write after the read failed", () => {
  it("is create-only, so it cannot replace what the person has stored", async () => {
    listAll.mockRejectedValue(new Error("offline"));
    const p = await prefs();
    expect(await p.readPref("nav")).toBeUndefined(); // rendering still gets the defaults
    await p.writePref("nav", { folds: [] });
    expect(headersOf(patch.mock.calls[0]!)["If-None-Match"]).toBe("*");
  });

  it("says so, so a consumer acting on absence (the theme seed) can tell unknown from no row", async () => {
    listAll.mockRejectedValue(new Error("signed out"));
    expect(await (await prefs()).prefsKnown()).toBe(false);
    listAll.mockReset().mockResolvedValue([]);
    expect(await (await prefs()).prefsKnown()).toBe(true);
  });

  it("is unguarded after a read that landed, as before", async () => {
    listAll.mockResolvedValue([{ key: "theme", value: { theme: "dark" } }]);
    const p = await prefs();
    await p.readPref("theme");
    await p.writePref("theme", { theme: "light" });
    expect(headersOf(patch.mock.calls[0]!)["If-None-Match"]).toBeUndefined();
    expect(patch.mock.calls[0]![2]).toBeUndefined();
  });
});

describe("a read-modify-write of a shared list", () => {
  it("writes nothing when the row cannot be read", async () => {
    get.mockRejectedValue(new ApiError("unavailable", 503));
    const p = await prefs();
    await expect(p.updatePref("saved_searches", () => ({ searches: [] }))).rejects.toThrow();
    expect(patch).not.toHaveBeenCalled();
  });

  it("guards the write on the version it read", async () => {
    get.mockResolvedValue({ value: { subs: ["a"] }, etag: 'W/"1"' });
    const p = await prefs();
    const next = await p.updatePref<{ subs: string[] }>("push_subscriptions", (v) => ({ subs: [...(v?.subs ?? []), "b"] }));
    expect(next).toEqual({ subs: ["a", "b"] });
    expect(patch.mock.calls[0]![1]).toEqual({ value: { subs: ["a", "b"] } });
    expect(patch.mock.calls[0]![2]).toBe('W/"1"');
  });

  it("may only create when the read found no row", async () => {
    get.mockRejectedValue(new ApiError("not found", 404));
    const p = await prefs();
    await p.updatePref("saved_searches", () => ({ searches: ["x"] }));
    expect(patch.mock.calls[0]![2]).toBeUndefined();
    expect(headersOf(patch.mock.calls[0]!)["If-None-Match"]).toBe("*");
  });

  it("re-applies the edit to what another device saved in between", async () => {
    get.mockResolvedValueOnce({ value: { subs: ["a"] }, etag: 'W/"1"' }).mockResolvedValueOnce({ value: { subs: ["a", "other"] }, etag: 'W/"2"' });
    patch.mockRejectedValueOnce(new ApiError("etag mismatch", 409)).mockResolvedValue({});
    const p = await prefs();
    const next = await p.updatePref<{ subs: string[] }>("push_subscriptions", (v) => ({ subs: [...(v?.subs ?? []), "mine"] }));
    expect(next).toEqual({ subs: ["a", "other", "mine"] });
    expect(patch.mock.calls[1]![2]).toBe('W/"2"');
  });
});
