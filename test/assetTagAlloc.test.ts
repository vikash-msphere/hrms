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
import { createAsset, updateAsset } from "../src/services/assets";
import { crudService } from "../src/services/crud";
import { assetCategorySpec, type AssetCategoryInput } from "../src/services/assetCategories";
import { upsertSetting } from "../src/services/settings";

// Real-D1 flow test for the two identifiers an asset carries: the category it is filed under, and the tag
// printed on it. The tag is the SERVER's to allocate - the number must not depend on which client created the
// row or on what the browser happened to have loaded - and the category is what decides the code inside it.
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

// The org name matters here: a blank tag prefix falls back to its initials, which is what an org that never
// opens the settings panel gets.
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

describe("asset tags are allocated by the server", () => {
  it("tags every asset on create, numbering per category code", async () => {
    const admin = await seedActor();
    const laptops = await category(admin, { display_name: "Laptop", tag_code: "LAP" });
    const phones = await category(admin, { display_name: "Phone", tag_code: "PHN" });

    const a = await createAsset(deps, admin, { name: "MacBook Pro 14", category: `asset-categories/${laptops.uuid}` });
    const c = await createAsset(deps, admin, { name: "MacBook Air", category: `asset-categories/${laptops.uuid}` });
    const p = await createAsset(deps, admin, { name: "Pixel 9", category: `asset-categories/${phones.uuid}` });

    expect(a.assetTag).toBe("MS-LAP-001"); // prefix falls back to the org's initials
    expect(c.assetTag).toBe("MS-LAP-002");
    expect(p.assetTag).toBe("MS-PHN-001"); // a separate run, not the third laptop's number
  });

  it("an uncategorised asset still gets a tag, on its own run", async () => {
    const admin = await seedActor();
    const first = await createAsset(deps, admin, { name: "Mystery box" });
    const second = await createAsset(deps, admin, { name: "Another mystery" });
    expect(first.assetTag).toBe("MS-AST-001");
    expect(second.assetTag).toBe("MS-AST-002");
  });

  it("follows the org's configured pattern", async () => {
    const admin = await seedActor();
    await upsertSetting(deps, admin, "asset-tags", { prefix: "ACME", separator: ".", digits: 5 });
    const laptops = await category(admin, { display_name: "Laptop" }); // code derived from the name
    expect(laptops.tagCode).toBe("LAP");
    expect((await createAsset(deps, admin, { name: "T14", category: `asset-categories/${laptops.uuid}` })).assetTag).toBe("ACME.LAP.00001");
  });

  it("accepts a typed override, and refuses one already in use", async () => {
    const admin = await seedActor();
    const laptops = await category(admin, { display_name: "Laptop", tag_code: "LAP" });
    const legacy = await createAsset(deps, admin, { name: "Old laptop", asset_tag: "LOANER-3", category: `asset-categories/${laptops.uuid}` });
    expect(legacy.assetTag).toBe("LOANER-3");
    // The override is in another shape, so it does not move the LAP counter.
    expect((await createAsset(deps, admin, { name: "New laptop", category: `asset-categories/${laptops.uuid}` })).assetTag).toBe("MS-LAP-001");
    await expect(createAsset(deps, admin, { name: "Clash", asset_tag: "loaner-3" })).rejects.toThrow(/already in use/i);
  });

  it("a tag can be corrected but never cleared", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "MacBook" });
    const renamed = await updateAsset(deps, admin, asset.uuid, { asset_tag: "MS-LAP-900" });
    expect(renamed.assetTag).toBe("MS-LAP-900");
    await expect(updateAsset(deps, admin, asset.uuid, { asset_tag: "" })).rejects.toThrow(/cannot be empty/i);
    await expect(updateAsset(deps, admin, asset.uuid, { asset_tag: null })).rejects.toThrow(/cannot be empty/i);
  });

  it("re-filing an asset under another category does not renumber its tag", async () => {
    const admin = await seedActor();
    const laptops = await category(admin, { display_name: "Laptop", tag_code: "LAP" });
    const phones = await category(admin, { display_name: "Phone", tag_code: "PHN" });
    const asset = await createAsset(deps, admin, { name: "Mislabelled", category: `asset-categories/${laptops.uuid}` });
    const moved = await updateAsset(deps, admin, asset.uuid, { category: `asset-categories/${phones.uuid}` });
    expect(moved.categoryId).toBe(phones.uuid);
    expect(moved.assetTag).toBe(asset.assetTag); // the sticker is already on the thing
  });

  it("emits the category and the tag with asset.created", async () => {
    const admin = await seedActor();
    const laptops = await category(admin, { display_name: "Laptop", tag_code: "LAP" });
    const asset = await createAsset(deps, admin, { name: "MacBook", category: `asset-categories/${laptops.uuid}` });
    const events = await deps.db.select().from(schema.eventLog);
    const created = events.find((e) => e.type === "asset.created")!;
    expect(JSON.parse(created.payloadJson ?? "{}")).toMatchObject({ categoryId: laptops.uuid, assetTag: asset.assetTag });
  });
});

describe("asset categories", () => {
  it("derives a tag code from the name and keeps codes unique", async () => {
    const admin = await seedActor();
    expect((await category(admin, { display_name: "Monitor" })).tagCode).toBe("MON");
    await expect(category(admin, { display_name: "Monitor stand", tag_code: "mon" })).rejects.toThrow(/already used/i);
    // Re-coding is allowed as long as nothing else answers to the new code.
    const furniture = await category(admin, { display_name: "Furniture" });
    const recoded = await categories.update(deps, admin, furniture.uuid, { tag_code: "FRN" });
    expect(recoded.tagCode).toBe("FRN");
  });

  it("moves a derived code out of the way rather than refusing the name", async () => {
    const admin = await seedActor();
    // Nobody typed a code here, so a clash between two names that derive the same three letters is the
    // product's problem to solve, not the author's: refusing "Monitor arm" over a code they never saw leaves
    // them with no way to add the category at all.
    expect((await category(admin, { display_name: "Monitor" })).tagCode).toBe("MON");
    expect((await category(admin, { display_name: "Monitor arm" })).tagCode).toBe("MON2");
    expect((await category(admin, { display_name: "Monitors, spare" })).tagCode).toBe("MON3");
    // Clearing a code asks for the default again, and gets a free one.
    const arm = await category(admin, { display_name: "Monitor mount", tag_code: "MNT" });
    expect((await categories.update(deps, admin, arm.uuid, { tag_code: null })).tagCode).toBe("MON4");
  });

  it("a category can insist on a serial number", async () => {
    const admin = await seedActor();
    const laptops = await category(admin, { display_name: "Laptop", tag_code: "LAP", requires_serial: true });
    const chairs = await category(admin, { display_name: "Furniture", tag_code: "FUR" });
    await expect(createAsset(deps, admin, { name: "Serial-less laptop", category: `asset-categories/${laptops.uuid}` })).rejects.toThrow(/serial number is required/i);
    await createAsset(deps, admin, { name: "Chair", category: `asset-categories/${chairs.uuid}` }); // no serial needed
    const ok = await createAsset(deps, admin, { name: "T14", serial_number: "SN-9", category: `asset-categories/${laptops.uuid}` });
    // The rule holds on the way in as well as on create: clearing the serial of a laptop is refused.
    await expect(updateAsset(deps, admin, ok.uuid, { serial_number: null })).rejects.toThrow(/serial number is required/i);
    // Moving it to a category that does not care is fine.
    await updateAsset(deps, admin, ok.uuid, { category: `asset-categories/${chairs.uuid}`, serial_number: null });
  });

  it("refuses an asset filed under a category that is gone", async () => {
    const admin = await seedActor();
    const gone = await category(admin, { display_name: "Tablet", tag_code: "TAB" });
    await categories.remove(deps, admin, gone.uuid);
    await expect(createAsset(deps, admin, { name: "iPad", category: `asset-categories/${gone.uuid}` })).rejects.toThrow(/not found/i);
  });
});
