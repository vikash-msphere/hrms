import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The SPA's settings snapshot (web/src/lib/settingsStore.ts) as the source of every editor's form and the
// guard on every settings save. A read that does not land must never look like an org that configured
// nothing: an editor hydrated from it shows a configured key as blank, and every settings panel writes its
// whole blob back, so that save overwrites the real row. That is how a quick-create menu save once replaced
// the organization blob (name, logos, address) with `{ quick_actions }`. Pinned here: a failed or timed-out
// read reports `unknown`, and a save holding no version is create-only (`If-None-Match: *`), never blind.

class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}
const list = vi.fn();
const patch = vi.fn();
vi.mock("@/api", () => ({ ApiError, list: (...a: unknown[]) => list(...a), patch: (...a: unknown[]) => patch(...a) }));
vi.mock("@/lib/resourceStore", () => ({
  subscribeInvalidations: () => {},
  subscribePurge: () => {},
  storedCopiesTrusted: () => false,
  reconciled: () => Promise.resolve(),
}));
vi.mock("@/lib/clientStore", () => ({ registerHydrator: () => {}, put: () => {}, del: () => {} }));

const ORG = { key: "organization", value: { name: "Acme", logo: "data:image/png;base64,AAAA" }, etag: 'W/"1"' };

async function store() {
  vi.resetModules();
  return import("../web/src/lib/settingsStore");
}

beforeEach(() => {
  list.mockReset();
  patch.mockReset().mockResolvedValue({ etag: 'W/"2"' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a settings read that does not land", () => {
  it("reports unknown when the fetch fails, not an empty value", async () => {
    list.mockRejectedValue(new Error("offline"));
    const s = await store();
    expect(await s.getSetting("organization")).toEqual({ unknown: true });
  });

  it("reports unknown when the fetch outlasts the bounded wait", async () => {
    vi.useFakeTimers();
    list.mockReturnValue(new Promise(() => {}));
    const s = await store();
    const read = s.getSetting("organization");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await read).toEqual({ unknown: true });
  });

  it("is not kept: the next read fetches again and sees the row", async () => {
    list.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ results: [ORG] });
    const s = await store();
    expect((await s.getSetting("organization")).unknown).toBe(true);
    expect(await s.getSetting("organization")).toEqual({ value: ORG.value, version: ORG.etag });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("a read superseded by an invalidation still hands out its value WITH the version it was read at", async () => {
    let answer!: (v: unknown) => void;
    list.mockReturnValueOnce(new Promise((r) => (answer = r))).mockResolvedValue({ results: [ORG] });
    const s = await store();
    const read = s.getSetting("organization");
    s.invalidateSettings(); // a write elsewhere lands while the read is in flight
    answer({ results: [ORG] });
    expect(await read).toEqual({ value: ORG.value, version: ORG.etag });
    await s.saveSetting("organization", { value: ORG.value });
    expect(patch.mock.calls[0]![2]).toBe(ORG.etag);
  });

  it("still reads a render consumer's key as unset, so its defaults stand", async () => {
    list.mockRejectedValue(new Error("offline"));
    const s = await store();
    expect(await s.readSetting("organization")).toBeUndefined();
  });
});

describe("a settings save", () => {
  const sent = () => {
    const [path, , etag, init] = patch.mock.calls[0] as [string, unknown, string | undefined, { headers?: Record<string, string> } | undefined];
    return { path, ifMatch: etag, ifNoneMatch: init?.headers?.["If-None-Match"] };
  };

  it("is create-only after a read that did not land, so it cannot overwrite the real row", async () => {
    list.mockRejectedValue(new Error("offline"));
    const s = await store();
    await s.getSetting("organization");
    await s.saveSetting("organization", { value: { quick_actions: { groups: [] } } });
    expect(sent()).toEqual({ path: "settings/organization", ifMatch: undefined, ifNoneMatch: "*" });
  });

  it("is create-only for a key the read found no row for", async () => {
    list.mockResolvedValue({ results: [] });
    const s = await store();
    expect(await s.getSetting("kudos")).toEqual({ value: undefined, version: undefined });
    await s.saveSetting("kudos", { value: { levels: [] } });
    expect(sent()).toEqual({ path: "settings/kudos", ifMatch: undefined, ifNoneMatch: "*" });
  });

  it("is guarded on the version the reader was handed", async () => {
    list.mockResolvedValue({ results: [ORG] });
    const s = await store();
    await s.getSetting("organization");
    await s.saveSetting("organization", { value: { ...ORG.value, address: "1 Main St" } });
    expect(sent()).toEqual({ path: "settings/organization", ifMatch: ORG.etag, ifNoneMatch: undefined });
  });

  it("does not fall back to the snapshot's live version for a caller that saw no row", async () => {
    list.mockResolvedValue({ results: [ORG] });
    const s = await store();
    await s.getSetting("organization");
    await s.saveSetting("organization", { value: {} }, null);
    expect(sent()).toEqual({ path: "settings/organization", ifMatch: undefined, ifNoneMatch: "*" });
  });

  it("is never blind for a key this session never read", async () => {
    list.mockResolvedValue({ results: [ORG] });
    const s = await store();
    await s.saveSetting("organization", { value: {} });
    expect(sent()).toEqual({ path: "settings/organization", ifMatch: undefined, ifNoneMatch: "*" });
  });

  it("keeps its version through a refusal that is not a conflict, so a confirmed re-send still lands", async () => {
    list.mockResolvedValue({ results: [{ key: "employee_fields", value: { fields: [] }, etag: 'W/"7"' }] });
    patch.mockRejectedValueOnce(new ApiError("these identity fields still hold values", 400)).mockResolvedValue({ etag: 'W/"8"' });
    const s = await store();
    await s.getSetting("employee_fields");
    await expect(s.saveSetting("employee_fields", { value: { fields: [] } })).rejects.toThrow();
    await s.saveSetting("employee_fields", { value: { fields: [], delete_removed_values: true } });
    expect(patch.mock.calls[1]![2]).toBe('W/"7"');
  });

  it("re-arms on the winner's version after a conflict: never the one that lost, never create-only", async () => {
    // Create-only would be refused by the existing row on every press, so "press Save again" could never land.
    const WON = { ...ORG, etag: 'W/"5"' };
    list.mockResolvedValueOnce({ results: [ORG] }).mockResolvedValue({ results: [WON] });
    patch.mockRejectedValueOnce(new ApiError("etag mismatch", 409)).mockResolvedValue({ etag: 'W/"9"' });
    const s = await store();
    await s.getSetting("organization");
    await expect(s.saveSetting("organization", { value: ORG.value })).rejects.toThrow();
    await s.saveSetting("organization", { value: ORG.value });
    expect(patch.mock.calls[1]![2]).toBe(WON.etag);
    expect(patch.mock.calls[1]![3]).toBeUndefined();
  });

  it("an editor's read re-asks an unknown answer and rejects one that stays unknown", async () => {
    vi.useFakeTimers();
    list.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ results: [ORG] });
    const s = await store();
    const read = s.getSettingForEdit("organization");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await read).toEqual({ value: ORG.value, version: ORG.etag });

    list.mockReset().mockRejectedValue(new Error("offline"));
    const s2 = await store();
    const failed = s2.getSettingForEdit("organization");
    const settled = expect(failed).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
  });

  it("returns the version it created, which the next save carries", async () => {
    list.mockResolvedValue({ results: [ORG] });
    const s = await store();
    await s.getSetting("organization");
    expect(await s.saveSetting("organization", { value: ORG.value })).toBe('W/"2"');
    patch.mockClear();
    await s.saveSetting("organization", { value: ORG.value });
    expect(sent().ifMatch).toBe('W/"2"');
  });
});
