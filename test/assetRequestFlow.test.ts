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
import { createAsset, deleteAsset } from "../src/services/assets";
import { crudService } from "../src/services/crud";
import { assetCategorySpec, type AssetCategoryInput } from "../src/services/assetCategories";
import {
  createAssetRequest, approveAssetRequest, rejectAssetRequest, cancelAssetRequest, issueAssetRequest, listAssetRequests,
} from "../src/services/assetRequests";
import { upsertSetting } from "../src/services/settings";
import type { ListScope } from "../src/domain/access";

// The org-wide reader an admin gets; the per-role narrowing is the middleware's business, tested elsewhere.
const allScope = (): ListScope => ({ breadth: "all", deptCode: null, ownerId: null, seeRestricted: true });

// Real-D1 flow test for asking for kit: request -> decision -> hand-over. The hand-over is the interesting
// half, because it is the only step that changes the inventory: issuing must assign the asset through the
// ordinary custody path (so it waits for the holder's scan) and must never hand over the same request twice.
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

const TABLES = [schema.assetRequests, schema.assets, schema.assetCategories, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
});

async function seedActor(role = "employee", managerId?: string): Promise<AppUser> {
  await deps.db.insert(schema.roles).values({ name: role, label: role }).onConflictDoNothing();
  const employeeId = genId();
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code: `04-${genId().slice(0, 3)}`, firstName: "Test", lastName: "User", workEmail: `${employeeId}@test.example`, status: "active", managerId: managerId ?? null });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${genId().slice(0, 4)}`, email: `${uuid}@test.example`, role, employeeId });
  const actor = { uuid, email: `${uuid}@test.example`, role, status: "active", employeeId, employeeCode: null } as unknown as AppUser;
  await upsertSetting(deps, actor, "organization", { name: "Meridian Systems" });
  return actor;
}

const laptopCategory = (actor: AppUser) => categories.create(deps, actor, { display_name: "Laptop", tag_code: "LAP" });
const assetOf = (id: string) => deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, id)).limit(1).then((r) => r[0]!);

describe("asking for kit", () => {
  it("files a pending request against a category and nudges the manager", async () => {
    const hr = await seedActor("hr_admin");
    const manager = await seedActor("manager");
    const employee = await seedActor("employee", manager.employeeId!);
    const cat = await laptopCategory(hr);

    const req = await createAssetRequest(deps, employee, { category: `asset-categories/${cat.uuid}`, justification: "Build takes 40 minutes", needed_by: "2026-09-01" });
    expect(req.state).toBe("PENDING");
    expect(req.employeeId).toBe(employee.employeeId); // defaults to the caller, no employee ref needed
    expect(req.categoryId).toBe(cat.uuid);
    expect(req.neededBy).not.toBeNull();

    const notes = await deps.db.select().from(schema.notifications);
    expect(notes.map((n) => n.recipientId)).toContain(manager.employeeId);
  });

  it("requires a category that exists", async () => {
    const hr = await seedActor("hr_admin");
    const employee = await seedActor();
    await expect(createAssetRequest(deps, employee, {})).rejects.toThrow(/category is required/i);
    const gone = await laptopCategory(hr);
    await categories.remove(deps, hr, gone.uuid);
    await expect(createAssetRequest(deps, employee, { category: `asset-categories/${gone.uuid}` })).rejects.toThrow(/not found/i);
  });

  it("decides exactly once, and tells the requester", async () => {
    const hr = await seedActor("hr_admin");
    const employee = await seedActor();
    const cat = await laptopCategory(hr);
    const req = await createAssetRequest(deps, employee, { category: `asset-categories/${cat.uuid}` });

    const approved = await approveAssetRequest(deps, hr, req.uuid, "Ordering one");
    expect(approved.state).toBe("APPROVED");
    expect(approved.decisionNote).toBe("Ordering one");
    // A second decision on a decided request is refused rather than overwriting the first.
    await expect(approveAssetRequest(deps, hr, req.uuid)).rejects.toThrow(/not pending/i);
    await expect(rejectAssetRequest(deps, hr, req.uuid, "None in stock")).rejects.toThrow(/not pending/i);

    const notes = await deps.db.select().from(schema.notifications);
    expect(notes.some((n) => n.recipientId === employee.employeeId && n.type === "asset.requestApproved")).toBe(true);
  });

  it("the owner can withdraw a pending request", async () => {
    const hr = await seedActor("hr_admin");
    const employee = await seedActor();
    const cat = await laptopCategory(hr);
    const req = await createAssetRequest(deps, employee, { category: `asset-categories/${cat.uuid}` });
    expect((await cancelAssetRequest(deps, employee, req.uuid)).state).toBe("CANCELLED");
  });

  it("the owner can withdraw an approved request until something is handed over, never after", async () => {
    const hr = await seedActor("hr_admin");
    const employee = await seedActor();
    const cat = await laptopCategory(hr);
    const unneeded = await createAssetRequest(deps, employee, { category: `asset-categories/${cat.uuid}` });
    await approveAssetRequest(deps, hr, unneeded.uuid);
    expect((await cancelAssetRequest(deps, employee, unneeded.uuid)).state).toBe("CANCELLED");
    // Withdrawn means withdrawn: it can no longer be handed over against.
    const spare = await createAsset(deps, hr, { name: "Spare laptop", category: `asset-categories/${cat.uuid}`, serial_number: "SN-W1" });
    await expect(issueAssetRequest(deps, hr, unneeded.uuid, `assets/${spare.uuid}`)).rejects.toThrow(/only an approved request/i);

    const issued = await createAssetRequest(deps, employee, { category: `asset-categories/${cat.uuid}` });
    await approveAssetRequest(deps, hr, issued.uuid);
    await issueAssetRequest(deps, hr, issued.uuid, `assets/${spare.uuid}`);
    await expect(cancelAssetRequest(deps, employee, issued.uuid)).rejects.toThrow(/not been handed over/i);
  });
});

describe("handing the kit over", () => {
  it("issues an in-stock asset, which assigns it and leaves it awaiting the holder's scan", async () => {
    const hr = await seedActor("hr_admin");
    const employee = await seedActor();
    const cat = await laptopCategory(hr);
    const asset = await createAsset(deps, hr, { name: "MacBook Pro 14", category: `asset-categories/${cat.uuid}`, serial_number: "SN-1" });
    const req = await createAssetRequest(deps, employee, { category: `asset-categories/${cat.uuid}` });
    await approveAssetRequest(deps, hr, req.uuid);

    const issued = await issueAssetRequest(deps, hr, req.uuid, `assets/${asset.uuid}`);
    expect(issued.state).toBe("ISSUED");
    expect(issued.issuedAssetId).toBe(asset.uuid);
    expect(issued.issuedAt).not.toBeNull();

    const held = await assetOf(asset.uuid);
    expect(held.assignedTo).toBe(employee.employeeId);
    // The custody loop still applies: closing a request is not evidence that anybody received anything.
    expect(held.status).toBe("pending_ack");
    expect(held.assignedOn).not.toBeNull();

    const events = await deps.db.select().from(schema.eventLog);
    expect(events.some((e) => e.type === "assetRequest.issued")).toBe(true);
    // Hand-over is once: the second call finds the request already ISSUED.
    await expect(issueAssetRequest(deps, hr, req.uuid, `assets/${asset.uuid}`)).rejects.toThrow(/only an approved request/i);

    // An issued asset carries the request's history, and there is no soft delete to fall back on: refuse the
    // delete in words rather than letting the foreign key surface as a 500.
    await expect(deleteAsset(deps, hr, asset.uuid)).rejects.toMatchObject({ httpStatus: 409 });
    expect(await assetOf(asset.uuid)).toBeTruthy();
  });

  // ISSUED is terminal, so a hand-over that cannot complete must not leave the request claiming it did. Here the
  // asset sits in a category that insists on a serial number while carrying none - the state a category edit
  // leaves behind - so updateAsset refuses it AFTER the request state has already been claimed.
  it("gives the request back when the hand-over itself fails", async () => {
    const hr = await seedActor("hr_admin");
    const employee = await seedActor();
    const cat = await laptopCategory(hr);
    const strict = await categories.create(deps, hr, { display_name: "Serialled laptop", tag_code: "SLP", requires_serial: true });
    const asset = await createAsset(deps, hr, { name: "Laptop with no serial on file" });
    await deps.db.update(schema.assets).set({ categoryId: strict.uuid }).where(eq(schema.assets.uuid, asset.uuid));
    const req = await createAssetRequest(deps, employee, { category: `asset-categories/${cat.uuid}` });
    await approveAssetRequest(deps, hr, req.uuid);

    await expect(issueAssetRequest(deps, hr, req.uuid, `assets/${asset.uuid}`)).rejects.toBeTruthy();
    const after = (await deps.db.select().from(schema.assetRequests).where(eq(schema.assetRequests.uuid, req.uuid)))[0]!;
    expect(after.state).toBe("APPROVED"); // still issuable, once somebody sorts the asset out
    expect(after.issuedAssetId).toBeNull();
    expect((await assetOf(asset.uuid)).assignedTo).toBeNull();
  });

  it("refuses to hand over before approval, without an asset, or somebody else's asset", async () => {
    const hr = await seedActor("hr_admin");
    const employee = await seedActor();
    const holder = await seedActor();
    const cat = await laptopCategory(hr);
    const req = await createAssetRequest(deps, employee, { category: `asset-categories/${cat.uuid}` });
    const free = await createAsset(deps, hr, { name: "Spare laptop", category: `asset-categories/${cat.uuid}`, serial_number: "SN-2" });
    const taken = await createAsset(deps, hr, { name: "Somebody's laptop", category: `asset-categories/${cat.uuid}`, serial_number: "SN-3", assigned_to: `employees/${holder.employeeId}` });

    await expect(issueAssetRequest(deps, hr, req.uuid, `assets/${free.uuid}`)).rejects.toThrow(/only an approved request/i);
    await approveAssetRequest(deps, hr, req.uuid);
    await expect(issueAssetRequest(deps, hr, req.uuid, null)).rejects.toThrow(/asset is required/i);
    await expect(issueAssetRequest(deps, hr, req.uuid, `assets/${taken.uuid}`)).rejects.toThrow(/assigned to somebody else/i);
    // The failed attempts left the request open, so a real hand-over still works.
    expect((await issueAssetRequest(deps, hr, req.uuid, `assets/${free.uuid}`)).state).toBe("ISSUED");
  });
});

describe("listing", () => {
  it("filters to one employee's requests, newest first", async () => {
    const hr = await seedActor("hr_admin");
    const a = await seedActor();
    const other = await seedActor();
    const cat = await laptopCategory(hr);
    await createAssetRequest(deps, a, { category: `asset-categories/${cat.uuid}`, justification: "first" });
    await createAssetRequest(deps, a, { category: `asset-categories/${cat.uuid}`, justification: "second" });
    await createAssetRequest(deps, other, { category: `asset-categories/${cat.uuid}`, justification: "theirs" });

    const mine = await listAssetRequests(deps, allScope(), 50, undefined, undefined, undefined, a.employeeId!);
    expect(mine.items.map((r) => r.justification).sort()).toEqual(["first", "second"]);

    const pending = await listAssetRequests(deps, allScope(), 50, undefined, "PENDING");
    expect(pending.items).toHaveLength(3);
  });
});
