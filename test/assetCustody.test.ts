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
import { createAsset, updateAsset, verifyAsset, acknowledgeAsset, markTagPrinted, reissueTag } from "../src/services/assets";
import { remindAssetCustody } from "../src/cron";
import { upsertSetting } from "../src/services/settings";
import { toAssetResource } from "../src/http/serialize";

// Real-D1 (miniflare) flow test for asset custody: nothing about where an asset IS may be recorded except by
// scanning its printed tag. The transitions, the proof check, and the two ways a scan can be faked (wrong
// asset, or somebody who is not the holder) all live here.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  deps = makeDeps(b);
});

const TABLES = [schema.assets, schema.notifications, schema.auditLog, schema.eventLog, schema.settings, schema.users, schema.employees, schema.roles];
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

const secretOf = async (id: string) => (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, id)).limit(1))[0]!.tagSecret!;

describe("asset custody is claimed by scanning the tag", () => {
  it("a new asset is unproven until somebody scans it into stock", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "MacBook Pro 14", asset_tag: "LAP-014" });
    expect(asset.status).toBe("pending_verification");
    expect(asset.custodySince).not.toBeNull();
    expect(asset.tagSecret).toBeTruthy();

    const verified = await verifyAsset(deps, admin, asset.uuid, { scan: `https://hr.example/assets/x?s=${asset.tagSecret}` });
    expect(verified.status).toBe("in_stock");
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.custodySince).toBeNull();
  });

  it("cannot be typed into existence as in stock - create takes the same gate as patch", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    // What the web form used to post on every add, and what an automation rule posts for a new hire.
    expect((await createAsset(deps, admin, { name: "Typed-in laptop", status: "in_stock" })).status).toBe("pending_verification");
    expect((await createAsset(deps, admin, { name: "Auto-assigned laptop", status: "assigned", assigned_to: `employees/${holder.employeeId}` })).status).toBe("pending_ack");
    // "Assigned" with nobody to assign it to would queue for a confirmation that can never come.
    expect((await createAsset(deps, admin, { name: "Nobody's laptop", status: "assigned" })).status).toBe("pending_verification");
    // Bookkeeping states are nobody's claim about custody, so they pass through.
    expect((await createAsset(deps, admin, { name: "Dead monitor", status: "retired" })).status).toBe("retired");
    expect((await createAsset(deps, admin, { name: "Cracked screen", status: "repair" })).status).toBe("repair");
  });

  it("refuses a scan that belongs to a different asset", async () => {
    const admin = await seedActor();
    const a = await createAsset(deps, admin, { name: "Laptop A", asset_tag: "LAP-001" });
    const other = await createAsset(deps, admin, { name: "Laptop B", asset_tag: "LAP-002" });
    await expect(verifyAsset(deps, admin, a.uuid, { scan: await secretOf(other.uuid) })).rejects.toMatchObject({ httpStatus: 400 });
    expect((await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, a.uuid)))[0]!.status).toBe("pending_verification");
  });

  it("a hand-over waits for the holder's own scan, and only the holder may give it", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    const asset = await createAsset(deps, admin, { name: "Dell 27\"", asset_tag: "MON-003" });
    await verifyAsset(deps, admin, asset.uuid, { scan: asset.tagSecret! });

    const assigned = await updateAsset(deps, admin, asset.uuid, { assigned_to: `employees/${holder.employeeId}`, status: "assigned" });
    expect(assigned.status).toBe("pending_ack");
    expect(assigned.assignedTo).toBe(holder.employeeId);

    // The admin who handed it over cannot confirm receipt on the holder's behalf.
    await expect(acknowledgeAsset(deps, admin, asset.uuid, { scan: asset.tagSecret! })).rejects.toMatchObject({ httpStatus: 403 });
    // Nor can the holder confirm without producing the tag - the default policy demands a scan.
    await expect(acknowledgeAsset(deps, holder, asset.uuid, {})).rejects.toMatchObject({ httpStatus: 409 });

    const acked = await acknowledgeAsset(deps, holder, asset.uuid, { scan: asset.tagSecret!, condition: "damaged", note: "dead pixel" });
    expect(acked.status).toBe("assigned");
    expect(acked.acknowledgedAt).not.toBeNull();
    expect(acked.custodyState).toBe("damaged");
    expect(acked.verifiedAt).not.toBeNull(); // the holder's scan is a sighting too
  });

  it("a return has to be scanned back in, and the old acknowledgement is void", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    const asset = await createAsset(deps, admin, { name: "iPhone 15", assigned_to: `employees/${holder.employeeId}` });
    await acknowledgeAsset(deps, holder, asset.uuid, { scan: asset.tagSecret! });

    const returned = await updateAsset(deps, admin, asset.uuid, { assigned_to: null, status: "in_stock" });
    expect(returned.status).toBe("pending_verification");
    expect(returned.acknowledgedAt).toBeNull();

    const back = await verifyAsset(deps, admin, asset.uuid, { scan: asset.tagSecret! });
    expect(back.status).toBe("in_stock");
  });

  it("editing an acknowledged asset does not knock it back to pending", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    const asset = await createAsset(deps, admin, { name: "ThinkPad", assigned_to: `employees/${holder.employeeId}` });
    await acknowledgeAsset(deps, holder, asset.uuid, { scan: asset.tagSecret! });

    // The edit form re-sends every field, including the status the row already has.
    const edited = await updateAsset(deps, admin, asset.uuid, { notes: "kept at the Bangalore desk", status: "assigned", assigned_to: `employees/${holder.employeeId}` });
    expect(edited.status).toBe("assigned");
  });

  it("nobody can declare an asset in stock by PATCH - only a scan does that", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Keyboard" });
    await verifyAsset(deps, admin, asset.uuid, { scan: asset.tagSecret! });
    const repaired = await updateAsset(deps, admin, asset.uuid, { status: "repair" });
    expect(repaired.status).toBe("repair");
    // Coming back from repair goes round the check-in loop again rather than straight into stock.
    const back = await updateAsset(deps, admin, asset.uuid, { status: "in_stock" });
    expect(back.status).toBe("pending_verification");
  });

  it("has no second way to claim a sighting: the verified stamp is not writable", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Label printer" });
    // The field is off the write schema, so this cannot arrive over the wire at all; belt and braces, the
    // service ignores it too rather than trusting a caller-supplied timestamp.
    await updateAsset(deps, admin, asset.uuid, { last_verified_time: new Date().toISOString() } as never);
    const after = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, asset.uuid)))[0]!;
    expect(after.verifiedAt).toBeNull();
    expect(after.status).toBe("pending_verification");
  });

  it("confirming without a scan is possible for a verifier, demands a reason, and is audited as unscanned", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Desk lamp" });
    await expect(verifyAsset(deps, admin, asset.uuid, { override: true })).rejects.toMatchObject({ httpStatus: 400 });
    const done = await verifyAsset(deps, admin, asset.uuid, { override: true, note: "sticker peeled off" });
    expect(done.status).toBe("in_stock");
    const audit = (await deps.db.select().from(schema.auditLog)).filter((r) => r.action === "asset.verify");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.meta ?? "{}").scanned).toBe(false);
  });

  it("the policy can be turned off entirely, and then assignment is recorded on trust", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    await upsertSetting(deps, admin, "asset-tags", { custody: { stock_scan_required: false, ack_required: false } });
    const asset = await createAsset(deps, admin, { name: "Monitor arm" });
    expect(asset.status).toBe("in_stock");
    const assigned = await updateAsset(deps, admin, asset.uuid, { assigned_to: `employees/${holder.employeeId}` });
    expect(assigned.status).toBe("assigned");
  });

  it("reissuing a tag kills the sticker that is out in the world", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Projector" });
    const printed = await markTagPrinted(deps, admin, asset.uuid);
    expect(printed.tagPrintedAt).not.toBeNull();

    const reissued = await reissueTag(deps, admin, asset.uuid);
    expect(reissued.tagSecret).not.toBe(asset.tagSecret);
    expect(reissued.tagPrintedAt).toBeNull();
    await expect(verifyAsset(deps, admin, asset.uuid, { scan: asset.tagSecret! })).rejects.toMatchObject({ httpStatus: 400 });
    const ok = await verifyAsset(deps, admin, asset.uuid, { scan: reissued.tagSecret! });
    expect(ok.status).toBe("in_stock");
  });

  it("the nightly tick chases a hand-over nobody confirmed, and lets a fresh one alone", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    const waiting = await createAsset(deps, admin, { name: "Unconfirmed laptop", assigned_to: `employees/${holder.employeeId}` });
    const fresh = await createAsset(deps, admin, { name: "Just handed over", assigned_to: `employees/${holder.employeeId}` });
    // Back-date one wait past the default 3-day window; the other stays today's.
    await deps.db.update(schema.assets).set({ custodySince: new Date(Date.now() - 5 * 86_400_000) }).where(eq(schema.assets.uuid, waiting.uuid));
    await deps.db.delete(schema.notifications);

    const acted = await remindAssetCustody(deps);
    expect(acted).toBeGreaterThan(0);
    const notes = await deps.db.select().from(schema.notifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.recipientId).toBe(holder.employeeId);
    expect(notes[0]!.subject).toBe(`assets/${waiting.uuid}`);
    expect(notes[0]!.subject).not.toBe(`assets/${fresh.uuid}`);

    const events = (await deps.db.select().from(schema.eventLog)).filter((e) => e.type === "asset.custodyOverdue");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payloadJson ?? "{}").kind).toBe("ack");
  });

  // The distinction the whole feature rests on: a sighting is PROVED only by the one value on the sticker that
  // a reader of the row does not already have. The wire id and the human asset tag are on every serialized
  // asset, so accepting either as evidence would make `verified_scanned` - and every stocktake's scanned count -
  // something a caller can assert from their desk without going anywhere near the hardware.
  it("only the QR secret proves a sighting; the id and the printed tag do not", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Laptop" });
    const wireId = await deps.idCodec.encode("assets", asset.uuid);

    // Both weaker forms come off real stickers, so they still check the asset in...
    const byTag = await verifyAsset(deps, admin, asset.uuid, { scan: asset.assetTag! });
    expect(byTag.status).toBe("in_stock");
    expect(byTag.verifiedScanned).toBe(false); // ...but neither is evidence
    const byDeepLink = await verifyAsset(deps, admin, asset.uuid, { scan: `https://hr.example/assets/${wireId}` });
    expect(byDeepLink.verifiedScanned).toBe(false);

    const bySecret = await verifyAsset(deps, admin, asset.uuid, { scan: await secretOf(asset.uuid) });
    expect(bySecret.verifiedScanned).toBe(true);
  });

  it("a holder's acknowledgement takes the QR secret and nothing weaker", async () => {
    const admin = await seedActor();
    const holder = await seedActor("employee");
    const asset = await createAsset(deps, admin, { name: "Laptop", assigned_to: `employees/${holder.employeeId}` });
    expect(asset.status).toBe("pending_ack");

    // Manual confirmation is closed by default, so the identifier tier is closed with it: confirming receipt is
    // the one place the app is asserting somebody physically has the thing.
    await expect(acknowledgeAsset(deps, holder, asset.uuid, { scan: asset.assetTag! })).rejects.toMatchObject({ httpStatus: 409 });
    const acked = await acknowledgeAsset(deps, holder, asset.uuid, { scan: await secretOf(asset.uuid) });
    expect(acked.status).toBe("assigned");
    expect(acked.verifiedScanned).toBe(true);
  });

  it("the tag secret reaches only a caller who may print the tag", async () => {
    const admin = await seedActor();
    const asset = await createAsset(deps, admin, { name: "Router" });
    expect((toAssetResource(asset, admin, ["update", "verify"]) as Record<string, unknown>).tag_secret).toBeUndefined();
    expect((toAssetResource(asset, admin, ["printTag"]) as Record<string, unknown>).tag_secret).toBe(asset.tagSecret);
    expect((toAssetResource(asset) as Record<string, unknown>).tag_secret).toBeUndefined();
  });
});
