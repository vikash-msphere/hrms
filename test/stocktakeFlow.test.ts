/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createAsset, verifyAsset, acknowledgeAsset, updateAsset } from "../src/services/assets";
import { closeStocktake, recordFound, stocktakeSpec } from "../src/services/stocktakes";
import { crudService } from "../src/services/crud";
import { toStocktakeResource } from "../src/http/serialize";
import type { StocktakeResult } from "../src/domain/stocktake";

// Real-D1 (miniflare) flow test for inventory counts. The thing being pinned is that a count OWNS no
// sightings: every sighting is a stamp `:verify` writes on the asset, and the count's value is the frozen
// result it produces when it closes.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const counts = crudService(stocktakeSpec);

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.assets, schema.stocktakes, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(role = "hr_admin"): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role, employeeId });
  return { uuid, email: `${uuid}@test.example`, role, status: "active", employeeId, employeeCode: null } as unknown as AppUser;
}

const scanFor = (asset: { tagSecret: string | null }) => `https://hr.example/#/assets/x?s=${asset.tagSecret}`;
const start = (actor: AppUser, scope?: { statuses?: string[]; categories?: string[] }) =>
  counts.create(deps, actor, { label: "Q3 count", ...(scope ? { scope } : {}) });
const resultOf = (row: { resultJson: string | null }) => JSON.parse(row.resultJson!) as StocktakeResult;

describe("a stocktake records the walk, not a second copy of the sightings", () => {
  it("a sighting filed against a count stamps the asset, and the count computes the missing list from those stamps", async () => {
    const admin = await seedActor();
    const seen = await createAsset(deps, admin, { name: "Seen laptop" });
    const unseen = await createAsset(deps, admin, { name: "Unseen laptop" });
    const count = await start(admin);

    const verified = await verifyAsset(deps, admin, seen.uuid, { scan: scanFor(seen), stocktake: `stocktakes/${count.uuid}` });
    expect(verified.lastStocktakeId).toBe(count.uuid);
    expect(verified.verifiedBy).toBe(admin.employeeId);
    expect(verified.verifiedScanned).toBe(true);
    // The count row itself is untouched by a sighting: no per-scan write, so a long walk stays one write per item.
    const stillOpen = (await deps.db.select().from(schema.stocktakes).where(eq(schema.stocktakes.uuid, count.uuid)).limit(1))[0]!;
    expect(stillOpen.status).toBe("open");
    expect(stillOpen.resultJson).toBeNull();

    const closed = await closeStocktake(deps, admin, count.uuid);
    const result = resultOf(closed);
    expect(result.counts.scope_total).toBe(2);
    expect(result.counts.sighted).toBe(1);
    expect(result.counts.scanned).toBe(1);
    expect(result.counts.missing).toBe(1);
    expect(result.missing.map((m) => m.name)).toEqual(["Unseen laptop"]);
    expect(result.missing[0]!.asset).toBe(`assets/${unseen.uuid}`);
  });

  it("an unscanned confirmation counts as sighted, and says it was not scanned", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Sticker peeled off" });
    const count = await start(admin);
    const verified = await verifyAsset(deps, admin, asset.uuid, { override: true, note: "sticker destroyed", stocktake: `stocktakes/${count.uuid}` });
    expect(verified.verifiedScanned).toBe(false);
    const result = resultOf(await closeStocktake(deps, admin, count.uuid));
    expect(result.counts.sighted).toBe(1);
    expect(result.counts.scanned).toBe(0);
    expect(result.counts.unscanned).toBe(1);
  });

  // A walk-through is the one moment somebody is standing in front of the shelf with a scanner, so it is also
  // when the check-in queue should empty itself. `:verify` is the same verb either way - counting a sighting and
  // counting something INTO stock are the same act - which matters most right after a bulk add, where a whole
  // delivery is sitting in `pending_verification` waiting for exactly this walk.
  it("a walk-through counts an awaiting-check-in asset into stock, in the same scan", async () => {
    const admin = await seedActor();
    const fresh = await createAsset(deps, admin, { name: "Adapter out of the box" });
    const byHand = await createAsset(deps, admin, { name: "Adapter with no sticker left" });
    expect([fresh.status, byHand.status]).toEqual(["pending_verification", "pending_verification"]);
    // The client's "In the office" preset - awaiting check-in is in scope, so these are counted, not ignored.
    const count = await start(admin, { statuses: ["in_stock", "pending_verification", "repair"] });

    const scanned = await verifyAsset(deps, admin, fresh.uuid, { scan: scanFor(fresh), stocktake: `stocktakes/${count.uuid}` });
    expect(scanned.status).toBe("in_stock");
    expect(scanned.custodySince).toBeNull(); // out of the queue, so the chase-up cron stops asking
    expect(scanned.lastStocktakeId).toBe(count.uuid);
    // The audit row says the scan did two things, which is what makes "who counted this in" answerable later.
    const entry = (await deps.db.select().from(schema.auditLog)).find((a) => a.action === "asset.verify" && a.entityId === fresh.uuid)!;
    expect(JSON.parse(entry.meta ?? "{}")).toMatchObject({ scanned: true, checkedIn: true });

    // A destroyed sticker ticked off by hand checks in too (the UI asks first, precisely because it does).
    const manual = await verifyAsset(deps, admin, byHand.uuid, { override: true, note: "sticker gone", stocktake: `stocktakes/${count.uuid}` });
    expect(manual.status).toBe("in_stock");
    expect(manual.verifiedScanned).toBe(false);

    const result = resultOf(await closeStocktake(deps, admin, count.uuid));
    expect(result.counts.sighted).toBe(2);
    expect(result.counts.missing).toBe(0);
  });

  // The other half of the record. A count that can only say what it failed to find cannot answer "prove you
  // saw these", and the evidence is NOT recoverable later: an asset's last_stocktake names whichever count
  // sighted it most recently, so the next walk would take this one's list away.
  it("freezes WHAT IT SAW, with the proof, weakest evidence first", async () => {
    const admin = await seedActor();
    const scanned = await createAsset(deps, admin, { name: "Scanned laptop" });
    const flagged = await createAsset(deps, admin, { name: "Cracked monitor" });
    const byHand = await createAsset(deps, admin, { name: "Peeled-sticker dock" });
    const unseen = await createAsset(deps, admin, { name: "Nowhere to be found" });
    const count = await start(admin, {});

    await verifyAsset(deps, admin, scanned.uuid, { scan: scanFor(scanned), stocktake: `stocktakes/${count.uuid}` });
    await verifyAsset(deps, admin, flagged.uuid, { scan: scanFor(flagged), condition: "damaged", stocktake: `stocktakes/${count.uuid}` });
    await verifyAsset(deps, admin, byHand.uuid, { override: true, note: "sticker peeled off", stocktake: `stocktakes/${count.uuid}` });

    const result = resultOf(await closeStocktake(deps, admin, count.uuid));
    expect(result.counts).toMatchObject({ scope_total: 4, sighted: 3, scanned: 2, unscanned: 1, flagged: 1, missing: 1 });
    // Weakest proof first: hand-ticked, then the flagged scan, then the clean scan - so a capped snapshot keeps
    // the rows worth re-reading rather than the first N alphabetically.
    expect(result.sighted?.map((r) => r.name)).toEqual(["Peeled-sticker dock", "Cracked monitor", "Scanned laptop"]);
    expect(result.sighted?.find((r) => r.name === "Peeled-sticker dock")).toMatchObject({
      asset: `assets/${byHand.uuid}`,
      asset_tag: byHand.assetTag,
      status: "in_stock", // the sighting counted it in, and the snapshot says where it ended up
      scanned: false,
      sighted_by: `employees/${admin.employeeId}`,
    });
    expect(result.sighted?.find((r) => r.name === "Cracked monitor")).toMatchObject({ scanned: true, condition: "damaged" });
    // The one nobody saw is on the other list, and on neither twice.
    expect(result.missing.map((r) => r.name)).toEqual(["Nowhere to be found"]);
    expect(result.sighted?.some((r) => r.asset === `assets/${unseen.uuid}`)).toBe(false);
    expect(result.sighted_truncated).toBeUndefined();
  });

  it("a later count does not take an earlier one's sighted list away", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Laptop counted twice" });
    const first = await start(admin, {});
    await verifyAsset(deps, admin, asset.uuid, { scan: scanFor(asset), stocktake: `stocktakes/${first.uuid}` });
    const firstResult = resultOf(await closeStocktake(deps, admin, first.uuid));
    expect(firstResult.sighted?.map((r) => r.asset)).toEqual([`assets/${asset.uuid}`]);

    // The second walk claims the stamp on the asset row - which is exactly why the list above had to be frozen.
    const second = await start(admin, {});
    await verifyAsset(deps, admin, asset.uuid, { scan: scanFor(asset), stocktake: `stocktakes/${second.uuid}` });
    expect((await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, asset.uuid)))[0]!.lastStocktakeId).toBe(second.uuid);
    const reread = resultOf((await deps.db.select().from(schema.stocktakes).where(eq(schema.stocktakes.uuid, first.uuid)))[0]!);
    expect(reread.sighted?.map((r) => r.asset)).toEqual([`assets/${asset.uuid}`]);
  });

  it("a walk-through does NOT confirm receipt for an absent holder", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    const asset = await createAsset(deps, admin, { name: "Laptop on a desk", assigned_to: `employees/${holder.employeeId}` });
    expect(asset.status).toBe("pending_ack");
    const count = await start(admin, { statuses: ["pending_ack", "assigned"] });
    // Seeing it on somebody's desk is a sighting, and nothing more: only the holder's own scan can say they
    // have it, so the acknowledgement queue is not something a walk-through may clear on their behalf.
    const seen = await verifyAsset(deps, admin, asset.uuid, { scan: scanFor(asset), stocktake: `stocktakes/${count.uuid}` });
    expect(seen.status).toBe("pending_ack");
    expect(seen.acknowledgedAt).toBeNull();
    expect(resultOf(await closeStocktake(deps, admin, count.uuid)).counts.sighted).toBe(1);
  });

  it("a holder's acknowledgement mid-walk counts as sighted, even though it carries no count", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    const asset = await createAsset(deps, admin, { name: "Laptop with its holder", assigned_to: `employees/${holder.employeeId}` });
    expect(asset.status).toBe("pending_ack");
    const count = await start(admin, { statuses: ["pending_ack", "assigned"] });
    const acked = await acknowledgeAsset(deps, holder, asset.uuid, { scan: scanFor(asset) });
    expect(acked.lastStocktakeId).toBeNull(); // provenance stays honest: this was not a walk-through scan
    const result = resultOf(await closeStocktake(deps, admin, count.uuid));
    expect(result.counts.sighted).toBe(1);
    expect(result.counts.missing).toBe(0);
  });

  it("scope decides what is counted: an out-of-scope asset is neither missing nor sighted", async () => {
    const admin = await seedActor();
    const stock = await createAsset(deps, admin, { name: "In the cupboard" });
    const retiring = await createAsset(deps, admin, { name: "Old monitor" });
    await updateAsset(deps, admin, retiring.uuid, { status: "retired" });
    const count = await start(admin, { statuses: ["pending_verification", "in_stock", "repair"] });
    await verifyAsset(deps, admin, stock.uuid, { scan: scanFor(stock), stocktake: `stocktakes/${count.uuid}` });
    const result = resultOf(await closeStocktake(deps, admin, count.uuid));
    expect(result.counts.scope_total).toBe(1);
    expect(result.counts.missing).toBe(0);
  });

  it("a damaged sighting is counted as flagged", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Cracked screen" });
    const count = await start(admin);
    await verifyAsset(deps, admin, asset.uuid, { scan: scanFor(asset), condition: "damaged", stocktake: `stocktakes/${count.uuid}` });
    const result = resultOf(await closeStocktake(deps, admin, count.uuid));
    expect(result.counts.flagged).toBe(1);
  });

  it("closing is one-way, and a sighting cannot be filed against a closed count", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Late scan" });
    const count = await start(admin);
    await closeStocktake(deps, admin, count.uuid);
    await expect(closeStocktake(deps, admin, count.uuid)).rejects.toMatchObject({ httpStatus: 409 });
    await expect(verifyAsset(deps, admin, asset.uuid, { scan: scanFor(asset), stocktake: `stocktakes/${count.uuid}` })).rejects.toMatchObject({ httpStatus: 409 });
    // The sighting really did not happen: refusing the count must not have stamped the asset anyway.
    const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, asset.uuid)).limit(1))[0]!;
    expect(row.verifiedAt).toBeNull();
  });

  it("a closed count cannot be re-scoped (that would rewrite what its missing list means)", async () => {
    const admin = await seedActor();
    const count = await start(admin, { statuses: ["in_stock"] });
    await closeStocktake(deps, admin, count.uuid);
    await expect(counts.update(deps, admin, count.uuid, { scope: { statuses: ["assigned"] } })).rejects.toMatchObject({ httpStatus: 409 });
    // Notes are still allowed: an after-the-fact explanation does not change the numbers.
    const annotated = await counts.update(deps, admin, count.uuid, { notes: "two rooms were locked" });
    expect(annotated.notes).toBe("two rooms were locked");
  });

  it("a scan that matches no asset is recorded as a find, and rides into the snapshot", async () => {
    const admin = await seedActor();
    const count = await start(admin);
    await recordFound(deps, admin, count.uuid, { scan: "SOME-OTHER-ORG-TAG-42" });
    const closed = await closeStocktake(deps, admin, count.uuid);
    const result = resultOf(closed);
    expect(result.counts.found).toBe(1);
    expect(result.found[0]!.raw).toBe("SOME-OTHER-ORG-TAG-42");
    expect(result.found[0]!.by).toBe(`employees/${admin.employeeId}`);
    await expect(recordFound(deps, admin, count.uuid, { scan: "TOO-LATE" })).rejects.toMatchObject({ httpStatus: 409 });
  });

  // Two people walking one count is the shape this feature is built for (a count is resumable and
  // multi-scanner), so the find log has to survive two appends landing together. Unguarded, the second write
  // overwrote the first one's entry with a list that never contained it - and a find is the ONLY record that
  // something unexpected was seen.
  it("keeps both finds when two scanners log one at the same moment", async () => {
    const admin = await seedActor();
    const count = await start(admin);
    await Promise.all([
      recordFound(deps, admin, count.uuid, { scan: "UNKNOWN-ONE" }),
      recordFound(deps, admin, count.uuid, { scan: "UNKNOWN-TWO" }),
    ]);
    const result = resultOf(await closeStocktake(deps, admin, count.uuid));
    expect(result.counts.found).toBe(2);
    expect(result.found.map((f) => f.raw).sort()).toEqual(["UNKNOWN-ONE", "UNKNOWN-TWO"]);
  });

  it("closing chases the holders of missing kit, and nobody else", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    await createAsset(deps, admin, { name: "Held laptop", assigned_to: `employees/${holder.employeeId}` });
    await createAsset(deps, admin, { name: "Cupboard laptop" });
    const count = await start(admin);
    await closeStocktake(deps, admin, count.uuid);
    const events = await deps.db.select().from(schema.eventLog);
    const missingEvents = events.filter((e) => e.type === "asset.stocktakeMissing");
    expect(missingEvents).toHaveLength(1);
    expect(missingEvents[0]!.employeeId).toBe(holder.employeeId);
    expect(events.some((e) => e.type === "stocktake.closed")).toBe(true);
  });

  it("closing does not touch the asset rows: not finding something proves nothing about the thing", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Nowhere to be found" });
    const count = await start(admin);
    await closeStocktake(deps, admin, count.uuid);
    const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, asset.uuid)).limit(1))[0]!;
    expect(row.status).toBe("pending_verification");
    expect(row.verifiedAt).toBeNull();
  });

  it("serializes the scope as refs and the result as parsed data", async () => {
    const admin = await seedActor();
    const cat = (await deps.db.insert(schema.assetCategories).values({ uuid: genId(), code: "c-1", name: "Laptop", tagCode: "LAP" }).returning())[0]!;
    const count = await start(admin, { statuses: ["in_stock"], categories: [`asset-categories/${cat.uuid}`] });
    const closed = await closeStocktake(deps, admin, count.uuid);
    const wire = toStocktakeResource(closed) as Record<string, any>;
    expect(wire.path).toBe(`stocktakes/${count.uuid}`);
    expect(wire.status).toBe("closed");
    expect(wire.scope).toEqual({ statuses: ["in_stock"], categories: [`asset-categories/${cat.uuid}`] });
    expect(wire.result.counts.scope_total).toBe(0);
    expect(wire.start_time).toBeTruthy();
  });
});
