/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { createAsset, createAssetsBatch, ASSET_BATCH_MAX } from "../src/services/assets";
import { crudService } from "../src/services/crud";
import { assetCategorySpec, type AssetCategoryInput } from "../src/services/assetCategories";
import { upsertSetting } from "../src/services/settings";
import { allocTagRun, DEFAULT_ASSET_TAG_CONFIG } from "../src/domain/assetTag";

// Adding a DELIVERY rather than a thing: a quantity of identical items (a box of adapters, none of which has a
// serial) or a list of serials. The invariants worth pinning are the ones a loop of single creates would break:
// the tags come out as one contiguous run per category code, every row is a real asset with its own code and
// secret, and nothing arrives claiming to be in stock or in somebody's hands.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;
const categories = crudService<AssetCategoryInput, typeof schema.assetCategories>(assetCategorySpec);

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.assets, schema.assetCategories, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(role = "hr_admin"): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role, employeeId });
  const actor = { uuid, email: `${uuid}@test.example`, role, status: "active", employeeId, employeeCode: null } as unknown as AppUser;
  await upsertSetting(deps, actor, "organization", { name: "Meridian Systems" });
  return actor;
}

const category = async (actor: AppUser, input: AssetCategoryInput) => categories.create(deps, actor, input);

describe("a quantity of identical things", () => {
  it("becomes one record each, on a contiguous tag run", async () => {
    const admin = await seedActor();
    const adapters = await category(admin, { display_name: "Adapter", tag_code: "ADP" });
    const rows = await createAssetsBatch(deps, admin, [{ name: "USB-C to HDMI adapter", category: `asset-categories/${adapters.uuid}`, quantity: 5 }]);

    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.assetTag)).toEqual(["MS-ADP-001", "MS-ADP-002", "MS-ADP-003", "MS-ADP-004", "MS-ADP-005"]);
    expect(new Set(rows.map((r) => r.code)).size).toBe(5); // each is its own record, not five views of one
    expect(rows.every((r) => r.name === "USB-C to HDMI adapter" && r.serialNumber === null)).toBe(true);
    expect(rows.every((r) => !!r.tagSecret)).toBe(true); // a sticker can be printed for each from day one
    expect(await deps.db.select().from(schema.assets)).toHaveLength(5);
  });

  it("continues the run an earlier single create started, and never assigns", async () => {
    const admin = await seedActor();
    const adapters = await category(admin, { display_name: "Adapter", tag_code: "ADP" });
    const first = await createAsset(deps, admin, { name: "Spare adapter", category: `asset-categories/${adapters.uuid}` });
    expect(first.assetTag).toBe("MS-ADP-001");

    const rows = await createAssetsBatch(deps, admin, [{ name: "USB-C to HDMI adapter", category: `asset-categories/${adapters.uuid}`, quantity: 3 }]);
    expect(rows.map((r) => r.assetTag)).toEqual(["MS-ADP-002", "MS-ADP-003", "MS-ADP-004"]);
    // Handing something over is a custody act, one scan at a time - a bulk add cannot manufacture one.
    expect(rows.every((r) => r.assignedTo === null && r.status === "pending_verification" && r.custodySince !== null)).toBe(true);
  });

  it("counts each category's run separately in a mixed delivery", async () => {
    const admin = await seedActor();
    const laptops = await category(admin, { display_name: "Laptop", tag_code: "LAP" });
    const mice = await category(admin, { display_name: "Mouse", tag_code: "MSE" });
    const rows = await createAssetsBatch(deps, admin, [
      { name: "MacBook Pro 14", category: `asset-categories/${laptops.uuid}`, serial_number: "C02X-1" },
      { name: "Wireless mouse", category: `asset-categories/${mice.uuid}`, quantity: 2 },
      { name: "MacBook Pro 14", category: `asset-categories/${laptops.uuid}`, serial_number: "C02X-2" },
      { name: "Mystery box" }, // uncategorised falls onto the fallback run, exactly as a single create does
    ]);
    expect(rows.map((r) => r.assetTag)).toEqual(["MS-LAP-001", "MS-MSE-001", "MS-MSE-002", "MS-LAP-002", "MS-AST-001"]);
  });
});

describe("a list of serial numbers", () => {
  it("creates one asset per serial, with a per-line name override", async () => {
    const admin = await seedActor();
    const laptops = await category(admin, { display_name: "Laptop", tag_code: "LAP", requires_serial: true });
    const rows = await createAssetsBatch(deps, admin, [
      { name: 'MacBook Pro 14"', category: `asset-categories/${laptops.uuid}`, serial_number: "C02XK1FTQ6LR" },
      { name: "MacBook Air 13", category: `asset-categories/${laptops.uuid}`, serial_number: "DMPQ3LLA" },
    ]);
    expect(rows.map((r) => [r.name, r.serialNumber])).toEqual([
      ['MacBook Pro 14"', "C02XK1FTQ6LR"],
      ["MacBook Air 13", "DMPQ3LLA"],
    ]);
  });

  it("refuses the same serial twice in one delivery", async () => {
    const admin = await seedActor();
    await expect(createAssetsBatch(deps, admin, [
      { name: "Laptop", serial_number: "C02X" },
      { name: "Laptop", serial_number: "c02x" },
    ])).rejects.toThrow(/more than once/i);
    expect(await deps.db.select().from(schema.assets)).toHaveLength(0); // nothing half-written
  });

  it("refuses a quantity for something identified by a serial", async () => {
    const admin = await seedActor();
    const laptops = await category(admin, { display_name: "Laptop", tag_code: "LAP", requires_serial: true });
    await expect(createAssetsBatch(deps, admin, [{ name: "Laptop", serial_number: "C02X", quantity: 4 }])).rejects.toThrow(/identifies one device/i);
    // …and a serial-requiring category cannot be filled by the quantity form either.
    await expect(createAssetsBatch(deps, admin, [{ name: "Laptop", category: `asset-categories/${laptops.uuid}`, quantity: 4 }])).rejects.toThrow(/serial number for each one/i);
    await expect(createAssetsBatch(deps, admin, [{ name: "Laptop", category: `asset-categories/${laptops.uuid}` }])).rejects.toThrow(/serial number is required/i);
  });
});

describe("the delivery as a whole", () => {
  it("caps how much one call may create", async () => {
    const admin = await seedActor();
    await expect(createAssetsBatch(deps, admin, [{ name: "Cable", quantity: ASSET_BATCH_MAX }, { name: "Cable", quantity: 1 }]))
      .rejects.toThrow(new RegExp(`more than ${ASSET_BATCH_MAX}`));
    expect(await deps.db.select().from(schema.assets)).toHaveLength(0);
  });

  // The regression this exists for: a multi-row INSERT is bound params, and an asset row binds FIFTEEN of them
  // (thirteen set columns plus the uuid/created/updated defaults drizzle materializes). A hand-guessed chunk of
  // seven therefore blew D1's 100-parameter cap - "D1_ERROR: too many SQL variables" - and took the whole
  // atomic batch with it, so every delivery over six items failed. `insertBatches` measures instead of
  // guessing; a full-cap run through assets AND their audit + event rows is what proves it.
  it("creates a full-cap delivery, with its audit and event rows", async () => {
    const admin = await seedActor();
    const rows = await createAssetsBatch(deps, admin, [{ name: "USB-C cable", quantity: ASSET_BATCH_MAX }]);
    expect(rows).toHaveLength(ASSET_BATCH_MAX);
    expect(new Set(rows.map((r) => r.assetTag)).size).toBe(ASSET_BATCH_MAX); // one run, no repeats
    expect(rows[0]!.assetTag).toBe("MS-AST-001");
    expect(rows[ASSET_BATCH_MAX - 1]!.assetTag).toBe(`MS-AST-${String(ASSET_BATCH_MAX).padStart(3, "0")}`);
    expect(await deps.db.select().from(schema.assets)).toHaveLength(ASSET_BATCH_MAX);
    expect((await deps.db.select().from(schema.auditLog)).filter((a) => a.action === "asset.create")).toHaveLength(ASSET_BATCH_MAX);
    expect((await deps.db.select().from(schema.eventLog)).filter((e) => e.type === "asset.created")).toHaveLength(ASSET_BATCH_MAX);
  });

  it("needs a name, and rejects a nonsense quantity, naming the line", async () => {
    const admin = await seedActor();
    await expect(createAssetsBatch(deps, admin, [{ name: "Cable" }, { name: "  " }])).rejects.toThrow(/name is required \(line 2\)/i);
    await expect(createAssetsBatch(deps, admin, [{ name: "Cable", quantity: 0 }])).rejects.toThrow(/at least 1/i);
    await expect(createAssetsBatch(deps, admin, [])).rejects.toThrow(/nothing to create/i);
  });

  it("refuses a category that is gone, before creating anything", async () => {
    const admin = await seedActor();
    const gone = await category(admin, { display_name: "Tablet", tag_code: "TAB" });
    await categories.remove(deps, admin, gone.uuid);
    await expect(createAssetsBatch(deps, admin, [{ name: "iPad", category: `asset-categories/${gone.uuid}`, quantity: 2 }])).rejects.toThrow(/not found/i);
    expect(await deps.db.select().from(schema.assets)).toHaveLength(0);
  });

  it("gives every asset its own creation entry and event, stamped with the run", async () => {
    const admin = await seedActor();
    const rows = await createAssetsBatch(deps, admin, [{ name: "USB-C cable", quantity: 3 }]);
    const audits = (await deps.db.select().from(schema.auditLog)).filter((a) => a.action === "asset.create");
    expect(audits).toHaveLength(3);
    expect(new Set(audits.map((a) => a.entityId))).toEqual(new Set(rows.map((r) => r.uuid)));
    expect(JSON.parse(audits[0]!.meta ?? "{}")).toMatchObject({ batch: 3 });

    const events = (await deps.db.select().from(schema.eventLog)).filter((e) => e.type === "asset.created");
    expect(events).toHaveLength(3);
    // One act, one trace: the whole delivery shares a correlation id.
    expect(new Set(events.map((e) => e.correlationId)).size).toBe(1);
    expect(new Set(events.map((e) => e.code)).size).toBe(3);
    expect(JSON.parse(events[0]!.payloadJson ?? "{}")).toMatchObject({ batch: 3, assetTag: expect.stringContaining("MS-AST-") });
  });

  it("follows the org's configured tag pattern, like every other create", async () => {
    const admin = await seedActor();
    await upsertSetting(deps, admin, "asset-tags", { prefix: "ACME", separator: ".", digits: 4 });
    const rows = await createAssetsBatch(deps, admin, [{ name: "Dock", quantity: 2 }]);
    expect(rows.map((r) => r.assetTag)).toEqual(["ACME.AST.0001", "ACME.AST.0002"]);
  });
});

describe("allocTagRun", () => {
  it("numbers per code from one view of the tags in use", () => {
    const cfg = { ...DEFAULT_ASSET_TAG_CONFIG, prefix: "MS" };
    expect(allocTagRun(cfg, ["MS-LAP-007", "MS-PHN-002"], ["LAP", "PHN", "LAP", null])).toEqual([
      "MS-LAP-008",
      "MS-PHN-003",
      "MS-LAP-009",
      "MS-AST-001",
    ]);
  });

  it("ignores a hand-typed tag in another shape, so a run skips no numbers", () => {
    const cfg = { ...DEFAULT_ASSET_TAG_CONFIG, prefix: "MS" };
    expect(allocTagRun(cfg, ["LOANER-3"], ["LAP", "LAP"])).toEqual(["MS-LAP-001", "MS-LAP-002"]);
  });
});
