import { allocFlatCode, allocFlatCodes, withFreshCode } from "./codeAlloc";
import { and, eq, gte, inArray, lt, ne, or, type SQL } from "drizzle-orm";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditMany, createdMeta, diffMeta, removedMeta } from "../lib/audit";
import { chunk, insertBatches, runBatch } from "../lib/dbBatch";
import { invalidArgument, notFound, aborted, forbidden, failedPrecondition, isCodeCollision, isAssetTagCollision } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { genId } from "../lib/idCodec";
import { notify } from "./notifications";
import { emitEvent, emitEvents } from "./eventBus";
import { getSettingValue } from "./settings";
import {
  custodyPolicy,
  daysBetween,
  isPending,
  mintTagSecret,
  scanProof,
  statusForAssignment,
  type AssetCondition,
  type AssetStatus,
  type CustodyPolicy,
} from "../domain/assetCustody";
import { allocTagRun, FALLBACK_TAG_CODE, formatAssetTag, nextSeq, normalizeTagConfig, type AssetTagConfig } from "../domain/assetTag";
import { requireOpenStocktake } from "./stocktakes";

export type AssetInput = {
  asset_tag?: string | null;
  name?: string;
  category?: string | null; // asset-categories/<id> or null (the inbound edge already decoded the ref)
  serial_number?: string | null;
  status?: AssetStatus;
  assigned_to?: string | null; // employees/<id> or null (the inbound edge already decoded the ref)
  assigned_on?: string | null; // YYYY-MM-DD
  purchase_date?: string | null;
  notes?: string | null;
};

/**
 * The one place a status coming off the wire is turned into a status this row may actually hold.
 *
 * `in_stock` and `assigned` are EARNED - they are what a scan produces (:verify, :acknowledge) - so a caller
 * asking for one gets the pending state that precedes it instead. Without this, "where is it" would be a
 * free-text claim on both POST and PATCH, which is the whole thing this feature exists to stop. `repair` and
 * `retired` are ordinary bookkeeping and pass through untouched.
 *
 * `acknowledged` is the CURRENT holder's confirmation (null on create, cleared by a hand-over): an asset that
 * was already confirmed by the person still holding it does not re-enter the queue because somebody re-saved
 * the form.
 */
function provableStatus(policy: CustodyPolicy, wanted: AssetStatus, acknowledged: Date | null): AssetStatus {
  if (wanted === "in_stock" && policy.requireStockScan) return "pending_verification";
  if (wanted === "assigned" && policy.requireAck && !acknowledged) return "pending_ack";
  return wanted;
}

/** Body shared by the two scan verbs: the raw scanned string, plus what the scanner saw. */
export type CustodyScanInput = {
  scan?: string | null;
  condition?: AssetCondition | null;
  note?: string | null;
  override?: boolean; // sticker destroyed/unreadable - allowed on :verify, and on :acknowledge only by policy
  /** `stocktakes/<id>`: file this sighting against an open count (:verify only). */
  stocktake?: string | null;
};

async function policyOf(deps: Deps): Promise<CustodyPolicy> {
  return custodyPolicy(await getSettingValue<unknown>(deps, "asset-tags", {}));
}

// The tag pattern, with the prefix falling back to the org's initials (see domain/assetTag.ts).
async function tagConfigOf(deps: Deps): Promise<AssetTagConfig> {
  const blob = await getSettingValue<unknown>(deps, "asset-tags", {});
  const org = await getSettingValue<{ name?: string }>(deps, "organization", {});
  return normalizeTagConfig(blob, org.name);
}

// The category an asset is being filed under, or null. Existence is the middleware's business (`category` is a
// declared body reference), but a category that requires a serial number is a workflow rule and lives here.
async function categoryOf(deps: Deps, id: string | null): Promise<typeof schema.assetCategories.$inferSelect | null> {
  if (!id) return null;
  const row = (await deps.db.select().from(schema.assetCategories).where(eq(schema.assetCategories.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw invalidArgument("asset category not found");
  return row;
}

// The categories a whole batch names, in ONE read (the single-create path above reads one at a time, which is
// right for one row and wrong for a hundred). Same rule as categoryOf: a missing or deleted category is a bad
// request, not a silently uncategorised asset.
async function categoriesOf(deps: Deps, ids: (string | null)[]): Promise<Map<string, typeof schema.assetCategories.$inferSelect>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (!wanted.length) return new Map();
  const rows = await deps.db.select().from(schema.assetCategories).where(inArray(schema.assetCategories.uuid, wanted));
  const found = new Map(rows.filter((r) => !r.deleteTime).map((r) => [r.uuid, r]));
  if (found.size !== wanted.length) throw invalidArgument("asset category not found");
  return found;
}

/**
 * Every asset tag is stored UPPER CASE, generated or typed.
 *
 * Generated ones always were (formatAssetTag upper-cases the code). Normalising the HR-typed overrides too is
 * what lets everything below compare tags with plain SQL equality and plain ranges: with mixed spellings in the
 * column, "is this tag taken" and "what is the highest number in this run" both have to be decided in the
 * isolate over every row, because SQLite's UNIQUE index and its `<`/`>` are case-SENSITIVE while a human
 * reading a sticker is not. One case in, no such gap - and `ms-lap-014` can no longer become a second sticker
 * numbered the same as `MS-LAP-014`.
 */
const normalizeTag = (tag: string): string => tag.trim().toUpperCase();

/**
 * The half-open key range covering one run's tags (`MS-LAP-` ≤ tag < `MS-LAP.`), for an index scan.
 *
 * Everything a tag carries before its digits is a fixed literal per code, so the run is a contiguous stretch of
 * the index. The upper bound is that literal with its last character stepped on, which is above every digit
 * string that can follow it - and it is built from the same pieces formatAssetTag joins, never by stripping
 * characters off a formatted tag (a category code ending in a zero would lose part of itself that way).
 */
function tagRange(cfg: AssetTagConfig, tagCode: string | null | undefined): { from: string; to: string } {
  const code = tagCode?.trim().toUpperCase() || FALLBACK_TAG_CODE;
  const from = [cfg.prefix, code].filter(Boolean).join(cfg.separator) + cfg.separator;
  return { from, to: from.slice(0, -1) + String.fromCharCode(from.charCodeAt(from.length - 1) + 1) };
}

/**
 * Allocate the next tag for a category: `<prefix><sep><category code><sep><n>`, n one past the highest already
 * in use for that code (MS-LAP-014 and MS-PHN-014 are separate runs).
 *
 * Only THIS run's tags are read, as a half-open range over the UNIQUE index on `asset_tag`. That matters
 * because D1 bills rows read and this sits on the single-create path (the web form, an integration, the
 * "assign a laptop to new hires" rule): reading the whole column instead meant every asset in the inventory
 * was billed for every asset created, growing with the table.
 *
 * Read-then-write, like allocEmployeeNumber: two concurrent creates can compute the same number, and the
 * UNIQUE index on `asset_tag` is what stops the loser. Numbers are never reused - a retired asset's sticker
 * may still be stuck to something in a cupboard, and a scan of it must never resolve to a different machine.
 */
async function allocAssetTag(deps: Deps, tagCode: string | null): Promise<string> {
  const cfg = await tagConfigOf(deps);
  const { from, to } = tagRange(cfg, tagCode);
  const rows = await deps.db
    .select({ t: schema.assets.assetTag })
    .from(schema.assets)
    .where(and(gte(schema.assets.assetTag, from), lt(schema.assets.assetTag, to)));
  return formatAssetTag(cfg, tagCode, nextSeq(cfg, tagCode, rows.map((r) => r.t)));
}

// Reject a duplicate tag so an HR-typed override never collides. One indexed equality read, because every
// stored tag is normalised (see normalizeTag) - this used to compare every row in the isolate. The UNIQUE index
// enforces it in the DB too; this is the friendly, pre-flight version. `exceptId` skips the row being updated.
async function assertTagFree(deps: Deps, tag: string, exceptId?: string): Promise<void> {
  const conds = [eq(schema.assets.assetTag, normalizeTag(tag))];
  if (exceptId) conds.push(ne(schema.assets.uuid, exceptId));
  const [clash] = await deps.db.select({ uuid: schema.assets.uuid }).from(schema.assets).where(and(...conds)).limit(1);
  if (clash) throw invalidArgument(`asset tag ${tag} is already in use`);
}

// A category may insist the physical thing has a serial number recorded (laptops yes, chairs no).
function assertSerial(category: typeof schema.assetCategories.$inferSelect | null, serial: string | null): void {
  if (category?.requiresSerial && !serial) throw invalidArgument(`a serial number is required for ${category.name}`);
}

// What this call may claim about the physical thing. Returns TRUE only for a sighting that is actually proved.
//
// Three lanes, and the distinction between the first two is the whole point of the tag secret:
//   - the QR secret (domain/assetCustody.ts "secret") is evidence: it is served only to callers holding
//     `printTag`, so having it means having the sticker. Proved -> `verified_scanned = true`.
//   - the wire id or the human asset tag ("identifier") is what a Code 128 laser scan or a deep link yields.
//     Accepted, because those stickers are real, but NOT evidence: both values sit on every serialized asset
//     row the caller could already read, so a match only says they named the right asset. It therefore rides
//     the same lane as a manual confirmation - permitted where an override is permitted - and records
//     UNSCANNED. Without this split, `verified_scanned` and every stocktake "scanned" count would be
//     satisfiable from a desk, which is the claim this feature exists to make.
//   - no scan at all: the destroyed-sticker escape hatch, which additionally demands a written reason.
async function requireProof(deps: Deps, row: typeof schema.assets.$inferSelect, input: CustodyScanInput, allowOverride: boolean): Promise<boolean> {
  const scan = input.scan?.trim();
  if (scan) {
    const wireId = await deps.idCodec.encode("assets", row.uuid).catch(() => null);
    const proof = scanProof(scan, { uuid: row.uuid, wireId, assetTag: row.assetTag, tagSecret: row.tagSecret });
    if (!proof) throw invalidArgument("that code belongs to a different asset");
    if (proof === "secret") return true;
    // An identifier-only scan cannot confirm what a scan is for. Where manual confirmation is closed (the
    // holder's own :acknowledge, unless the org opened it), say what the caller has to scan instead.
    if (!allowOverride) throw failedPrecondition("scan the QR code on the asset's tag to confirm this");
    return false;
  }
  if (!allowOverride) throw failedPrecondition("scan the asset's tag to confirm this");
  if (!input.note?.trim()) throw invalidArgument("a note is required when confirming without a scan");
  return false;
}
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? new Date(Date.parse(s + "T00:00:00Z")) : null);

// One employee's assigned assets, or - unfiltered - everything the caller may see (the inventory). The owner
// for scope purposes is `assignedTo` (dynamic), so an employee's "own" list tracks reassignment.
//
// Paged in SQL like every other collection list: this used to read the whole scoped table and sort it in the
// isolate, which both billed every asset row on every inventory view and quietly returned more than the 100-row
// page the rest of the API promises (so nothing downstream could tell it was looking at a window). Newest-first,
// like every other list: on an inventory larger than a page, the assets someone is looking for are the ones just
// bought, not the ones bought first. The presentation sort below puts one page back in tag order.
export async function listAssets(deps: Deps, scope: ListScope, opts: { employeeId?: string; maxPageSize: number; pageToken?: string }) {
  const conds = [applyScope(scope, schema.assets.code, schema.assets.assignedTo)];
  if (opts.employeeId) conds.push(eq(schema.assets.assignedTo, opts.employeeId));
  const { items, nextPageToken } = await keysetPage<typeof schema.assets.$inferSelect>(
    deps,
    schema.assets,
    "assets",
    and(...(conds.filter(Boolean) as SQL[])),
    { max: opts.maxPageSize, pageToken: opts.pageToken },
  );
  return {
    items: items.sort((a, b) => (a.assetTag ?? a.name).localeCompare(b.assetTag ?? b.name) || a.uuid.localeCompare(b.uuid)),
    nextPageToken,
  };
}

export async function getAsset(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, id)).limit(1))[0];
  if (!row) throw notFound("asset not found");
  return row;
}

// A new asset is a claim, not a fact: unless the org has turned custody enforcement off it lands in
// `pending_verification` (someone must scan it into stock) or, when it is created already assigned, in
// `pending_ack` (its holder must scan it). Every row is minted with a tag secret so the sticker printed for
// it can carry proof of possession from day one.
//
// A status sent with the create goes through the SAME gate as one sent with a patch. It has to: an inventory
// that can be typed into existence as "in stock" is exactly the paper record this feature replaces, and the
// callers who send one are the web form (which always posts its default) and automation rules (the seeded
// "assign a laptop to new hires" rule posts `assigned`) - neither of which has seen the physical thing.
export async function createAsset(deps: Deps, actor: AppUser, input: AssetInput) {
  if (!input.name || !input.name.trim()) throw invalidArgument("name is required");
  const name = input.name.trim();
  const assignedTo = idFromPath(input.assigned_to) ?? null;
  const policy = await policyOf(deps);
  const wanted = input.status ? provableStatus(policy, input.status, null) : statusForAssignment(policy, assignedTo);
  // "Assigned" with nobody to assign it to would park the row in a queue no one can ever clear.
  const status = wanted === "pending_ack" && !assignedTo ? statusForAssignment(policy, null) : wanted;
  const now = new Date();
  const category = await categoryOf(deps, idFromPath(input.category) ?? null);
  const serialNumber = input.serial_number?.trim() || null;
  assertSerial(category, serialNumber);
  // Every asset is tagged the moment it exists, whether it was typed into the form, posted by an integration
  // or created by an automation rule - so a sticker can always be printed for it and the number never depends
  // on who happened to open the printer first. A typed override wins, once it is known to be free.
  const override = input.asset_tag ? normalizeTag(input.asset_tag) : "";
  if (override) await assertTagFree(deps, override);
  // BOTH allocated numbers are inside the retry: the row's `code` and the printed asset tag are each
  // read-max-then-write, and each is unique, so two assets booked in at the same moment collide on one or the
  // other. A caller-supplied tag is not re-allocated - it is the number on the sticker in their hand, and a
  // second attempt would not free it - so that collision still surfaces as a conflict.
  const row = (await withFreshCode(
    async () =>
      deps.db
    .insert(schema.assets)
    .values({
      code: await allocFlatCode(deps, schema.assets),
      assetTag: override || (await allocAssetTag(deps, category?.tagCode ?? null)),
      name,
      categoryId: category?.uuid ?? null,
      serialNumber,
      status,
      assignedTo,
      assignedOn: assignedTo ? (dayMs(input.assigned_on) ?? now) : null,
      purchaseDate: dayMs(input.purchase_date),
      tagSecret: mintTagSecret(),
      custodySince: isPending(status) ? now : null,
      notes: input.notes?.trim() || null,
    })
        .returning(),
    (e) => isCodeCollision(e) || (!override && isAssetTagCollision(e)),
  ))[0]!;
  await audit(deps, actor, "asset.create", "assets", row.uuid, createdMeta(row, "assets"), row);
  await emitEvent(deps, actor, "asset.created", { subject: `assets/${row.uuid}`, employeeId: assignedTo, payload: { categoryId: row.categoryId, assetTag: row.assetTag } });
  if (assignedTo && assignedTo !== actor.employeeId) await notifyAssignee(deps, actor, row);
  return row;
}

/** One line of a batch create: an asset, or - with `quantity` - a run of identical ones. */
export type AssetBatchItem = {
  name?: string;
  category?: string | null; // asset-categories/<id> (the inbound edge already decoded the ref)
  serial_number?: string | null;
  purchase_date?: string | null;
  notes?: string | null;
  quantity?: number; // >1 only for things that carry no serial (a box of adapters)
};

/**
 * How many assets one call may create.
 *
 * Not a policy about how much stock an org may own - it is the shape of a single request. Everything here
 * happens in one batch of statements against the subrequest budget (lib/dbBatch.ts), and a run this size is
 * already a hundred stickers to print. Bigger deliveries are several calls, which is also how the client keeps
 * a progress bar honest.
 */
export const ASSET_BATCH_MAX = 100;

/**
 * Create MANY assets in one act: a quantity of identical untagged things (twenty USB-C adapters out of one
 * box), a pasted list of serial numbers, or a mix of both.
 *
 * Why this is a verb and not a loop of POSTs on the client: the tags. Each single create reads every tag in
 * use to work out the next number (allocAssetTag), so twenty creates would be twenty full scans - and, worse,
 * twenty racing allocations whose losers fail on the UNIQUE index. Here the run is allocated ONCE, from one
 * view of the tags, so the numbers come out contiguous (MS-USB-021…040) and the writes land in one batch.
 *
 * What it deliberately does NOT do is assign. Handing over is a custody act, per thing, and an assignment made
 * twenty at a time would be the paper record this feature exists to replace. Bulk-created assets therefore land
 * in the same pending state a single create produces, waiting for the scan that puts them in stock.
 */
export async function createAssetsBatch(deps: Deps, actor: AppUser, items: AssetBatchItem[]) {
  if (!items.length) throw invalidArgument("nothing to create");
  // Expand quantities into the individual things they stand for: an asset row is one physical object, because
  // one sticker, one scan and one holder are all per object. A count column would have no answer to "who has
  // adapter number seven".
  type Draft = { name: string; categoryId: string | null; tagCode: string | null; serialNumber: string | null; purchaseDate: Date | null; notes: string | null };
  const drafts: Draft[] = [];
  const categories = await categoriesOf(deps, items.map((i) => idFromPath(i.category) ?? null));
  for (const [n, item] of items.entries()) {
    const where = items.length > 1 ? ` (line ${n + 1})` : "";
    const name = item.name?.trim();
    if (!name) throw invalidArgument(`name is required${where}`);
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) throw invalidArgument(`quantity must be a whole number of at least 1${where}`);
    const serialNumber = item.serial_number?.trim() || null;
    if (quantity > 1 && serialNumber) throw invalidArgument(`a serial number identifies one device, so it cannot be given for a quantity of ${quantity}${where}`);
    const categoryId = idFromPath(item.category) ?? null;
    const category = categoryId ? categories.get(categoryId)! : null;
    // A category that insists on serials cannot be filled by the quantity form at all: twenty laptops are
    // twenty serials, and saying so here beats creating twenty rows that each fail the same rule.
    if (category?.requiresSerial && quantity > 1) throw invalidArgument(`${category.name} needs a serial number for each one, so add them as a list rather than a quantity${where}`);
    assertSerial(category, serialNumber);
    if (drafts.length + quantity > ASSET_BATCH_MAX) throw invalidArgument(`that is more than ${ASSET_BATCH_MAX} assets - add them in smaller batches`);
    for (let i = 0; i < quantity; i++) {
      drafts.push({ name, categoryId, tagCode: category?.tagCode ?? null, serialNumber, purchaseDate: dayMs(item.purchase_date), notes: item.notes?.trim() || null });
    }
  }
  // The same serial twice in one paste is the same machine entered twice - the mistake this form makes easiest,
  // and the one worth refusing rather than recording.
  const seen = new Set<string>();
  for (const d of drafts) {
    const key = d.serialNumber?.toLowerCase();
    if (!key) continue;
    if (seen.has(key)) throw invalidArgument(`serial number ${d.serialNumber} appears more than once`);
    seen.add(key);
  }
  const policy = await policyOf(deps);
  const cfg = await tagConfigOf(deps);
  const status = statusForAssignment(policy, null);
  const now = new Date();
  // One read of the tags in use, one run of numbers off it - the reason this verb exists. Narrowed to the runs
  // this delivery actually touches (a mixed box is a handful of categories), as index ranges rather than the
  // whole column: same single read, a fraction of the rows billed.
  const runs = [...new Set(drafts.map((d) => d.tagCode?.trim().toUpperCase() || FALLBACK_TAG_CODE))].map((code) => tagRange(cfg, code));
  const inUse = (
    await deps.db
      .select({ t: schema.assets.assetTag })
      .from(schema.assets)
      .where(or(...runs.map((r) => and(gte(schema.assets.assetTag, r.from), lt(schema.assets.assetTag, r.to)))))
  ).map((r) => r.t);
  const tags = allocTagRun(cfg, inUse, drafts.map((d) => d.tagCode));
  const codes = await allocFlatCodes(deps, schema.assets, drafts.length);
  const rows = drafts.map((d, i) => ({
    uuid: genId(), // minted here so the audit + event rows can name each asset without reading the inserts back
    code: codes[i]!,
    assetTag: tags[i]!,
    name: d.name,
    categoryId: d.categoryId,
    serialNumber: d.serialNumber,
    status,
    assignedTo: null,
    assignedOn: null,
    purchaseDate: d.purchaseDate,
    tagSecret: mintTagSecret(),
    custodySince: isPending(status) ? now : null,
    notes: d.notes,
  }));
  // One atomic batch: either the whole delivery is in the inventory or none of it is. A half-written run would
  // leave numbered stickers with nothing to stick them to, and no way to tell which.
  await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.assets).values(group)));
  // Read the rows back for their server-side stamps (create/update time, which the caller's ETag rides on).
  // Chunked at 90 ids: a batched insert returns nothing to take them from, and an IN list is bound params too.
  const created = (await Promise.all(
    chunk(rows.map((r) => r.uuid), 90).map((ids) => deps.db.select().from(schema.assets).where(inArray(schema.assets.uuid, ids))),
  )).flat();
  const byId = new Map(created.map((r) => [r.uuid, r]));
  const ordered = rows.map((r) => byId.get(r.uuid)!).filter(Boolean);
  // Each asset keeps its own creation entry (its activity feed is per record), stamped with the run it came in.
  await auditMany(deps, actor, ordered.map((row) => ({ action: "asset.create", entity: "assets", entityId: row.uuid, meta: { batch: ordered.length, ...createdMeta(row, "assets") }, snapshot: row })));
  await emitEvents(deps, actor, "asset.created", ordered.map((row) => ({ subject: `assets/${row.uuid}`, payload: { categoryId: row.categoryId, assetTag: row.assetTag, batch: ordered.length } })));
  return ordered;
}

// One notification for "this is yours now", whose wording depends on whether the holder still owes a scan.
async function notifyAssignee(deps: Deps, actor: AppUser, row: typeof schema.assets.$inferSelect) {
  const label = `${row.name}${row.assetTag ? ` (${row.assetTag})` : ""}`;
  await notify(deps, {
    recipient: row.assignedTo!,
    type: "asset.assigned",
    title: row.status === "pending_ack" ? "Confirm an asset assigned to you" : "Asset assigned to you",
    body: row.status === "pending_ack" ? `${label} - scan its tag to confirm you have it.` : label,
    link: "assets",
    subject: `assets/${row.uuid}`,
    actorId: actor.employeeId,
  });
}

export async function updateAsset(deps: Deps, actor: AppUser, id: string, patch: AssetInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, id)).limit(1))[0];
  if (!row) throw notFound("asset not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const has = (k: keyof AssetInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: SetOf<typeof schema.assets> = { updatedAt: new Date() };
  // A tag can be corrected but not removed: it is what the sticker on the thing says, and an untagged row
  // would be a machine nobody can scan. A lost or defaced sticker is `:reissueTag`, which keeps the number.
  if (has("asset_tag")) {
    const tag = patch.asset_tag ? normalizeTag(patch.asset_tag) : "";
    if (!tag) throw invalidArgument("asset_tag cannot be empty");
    if (tag !== row.assetTag) await assertTagFree(deps, tag, id);
    set.assetTag = tag;
  }
  if (has("name")) {
    if (!patch.name?.trim()) throw invalidArgument("name cannot be empty");
    set.name = patch.name.trim();
  }
  // Re-filing an asset under another category does NOT renumber its tag - the sticker is already on the thing.
  if (has("category")) set.categoryId = idFromPath(patch.category) ?? null;
  if (has("serial_number")) set.serialNumber = patch.serial_number?.trim() || null;
  const category = await categoryOf(deps, (has("category") ? (set.categoryId ?? null) : row.categoryId) as string | null);
  assertSerial(category, (has("serial_number") ? (set.serialNumber ?? null) : row.serialNumber) as string | null);
  if (has("purchase_date")) set.purchaseDate = dayMs(patch.purchase_date);
  // `last_verified_time` is deliberately NOT writable here: a sighting is something someone did in a room,
  // recorded by :verify. A PATCHable timestamp would be a second way to claim custody, without the scan.
  if (has("notes")) set.notes = patch.notes?.trim() || null;
  // Assignment: set assigned_to (employees/<id> or null) -> owner + assigned-on date, and (unless an explicit
  // status is also given) the derived status. Keep the prior assigned-on if the same person is re-saved.
  const policy = await policyOf(deps);
  let derivedAssigned = row.assignedTo;
  const handedOver = has("assigned_to") && (idFromPath(patch.assigned_to) ?? null) !== row.assignedTo;
  if (has("assigned_to")) {
    const to = idFromPath(patch.assigned_to) ?? null;
    set.assignedTo = to;
    set.assignedOn = to ? (dayMs(patch.assigned_on) ?? (row.assignedTo === to ? row.assignedOn : new Date())) : null;
    derivedAssigned = to;
  }
  // A hand-over (to somebody, or back to the company) re-opens the custody question: the new state is
  // whatever the policy says an unproven asset is, and the previous holder's acknowledgement is void.
  if (handedOver) {
    set.status = statusForAssignment(policy, derivedAssigned);
    set.acknowledgedAt = null;
    set.custodyState = null;
  }
  // Same gate as create: an explicit status write may not MANUFACTURE a proven state - only a scan does that.
  // Asking for "in stock" or "assigned" therefore lands on the pending state that precedes it, which is also
  // what sends an asset coming back from repair round the check-in loop again. Re-saving the status a row
  // already has is a no-op, so editing an acknowledged asset's notes cannot knock it back to pending.
  if (has("status") && patch.status !== row.status) {
    set.status = provableStatus(policy, patch.status!, handedOver ? null : row.acknowledgedAt);
  }
  if (set.status !== undefined && set.status !== row.status) set.custodySince = isPending(set.status as string) ? new Date() : null;
  const [updated] = await deps.db.update(schema.assets).set(set).where(eq(schema.assets.uuid, id)).returning();
  await audit(deps, actor, "asset.update", "assets", id, diffMeta(row, updated, set, "assets"), updated);
  // Newly assigned to someone (a reassignment) notifies the new owner - with the "scan it" ask when the
  // org requires acknowledgement.
  if (derivedAssigned && derivedAssigned !== row.assignedTo && derivedAssigned !== actor.employeeId) await notifyAssignee(deps, actor, updated!);
  return updated!;
}

/**
 * `:verify` - somebody scanned this asset's tag and is looking at the physical thing.
 *
 * Always stamps the sighting (this is what a stocktake walk-through records); when the asset was waiting to
 * be counted into stock, the scan is also what puts it there. A returned or repaired asset therefore cannot
 * re-enter the inventory as "in stock" without a human standing next to it.
 *
 * A sighting also records WHO saw it and whether a scan proved it, and - when the caller names an open count -
 * which walk-through claimed it. Those three stamps are why a stocktake needs no per-scan row of its own: this
 * update was already happening, so a hundred-item walk stays a hundred writes (domain/stocktake.ts). Scanning
 * something the count did not declare in its scope is fine and lands as a bonus sighting; refusing to record a
 * thing the person is holding in their hand would be the wrong answer.
 */
export async function verifyAsset(deps: Deps, actor: AppUser, id: string, input: CustodyScanInput = {}) {
  const row = await getAsset(deps, id);
  const scanned = await requireProof(deps, row, input, true);
  // Resolved before the write: filing a sighting against a closed (or deleted) count must fail loudly rather
  // than stamp a session that can no longer answer for it.
  const stocktakeId = idFromPath(input.stocktake) ?? null;
  if (stocktakeId) await requireOpenStocktake(deps, stocktakeId);
  const now = new Date();
  const checkedIn = row.status === "pending_verification";
  const set: SetOf<typeof schema.assets> = {
    verifiedAt: now,
    verifiedBy: actor.employeeId ?? null,
    verifiedScanned: scanned,
    lastStocktakeId: stocktakeId,
    updatedAt: now,
  };
  if (checkedIn) {
    set.status = "in_stock";
    set.custodySince = null;
  }
  if (input.condition) set.custodyState = input.condition;
  const [updated] = await deps.db.update(schema.assets).set(set).where(eq(schema.assets.uuid, id)).returning();
  await audit(deps, actor, "asset.verify", "assets", id, { scanned, checkedIn, condition: input.condition ?? null, note: input.note?.trim() || null, stocktake: stocktakeId }, updated);
  await emitEvent(deps, actor, "asset.verified", {
    subject: `assets/${id}`,
    employeeId: updated!.assignedTo,
    payload: { categoryId: updated!.categoryId, assetTag: updated!.assetTag, scanned, checkedIn, condition: input.condition ?? "good" },
  });
  return updated!;
}

/**
 * `:acknowledge` - the holder scanned the tag on the thing they were handed.
 *
 * Only the person the asset is assigned to may do this: an acknowledgement by anyone else would record a
 * custody chain that never happened. The scan doubles as a sighting, so an acknowledged asset is a verified
 * one. Confirming without a scan is possible only if the org allows it (destroyed sticker), and the audit
 * row says so.
 */
export async function acknowledgeAsset(deps: Deps, actor: AppUser, id: string, input: CustodyScanInput = {}) {
  const row = await getAsset(deps, id);
  if (!row.assignedTo) throw failedPrecondition("this asset is not assigned to anyone");
  if (row.assignedTo !== actor.employeeId) throw forbidden("only the person holding an asset can confirm it");
  const policy = await policyOf(deps);
  const scanned = await requireProof(deps, row, input, policy.allowManualAck);
  const now = new Date();
  const waitedDays = row.custodySince ? daysBetween(row.custodySince, now) : 0;
  const [updated] = await deps.db
    .update(schema.assets)
    // An acknowledgement IS a sighting, by the holder: it stamps the same three provenance columns :verify
    // does, minus a count (a holder confirming their own kit is not walking the inventory).
    .set({ status: "assigned", acknowledgedAt: now, verifiedAt: now, verifiedBy: actor.employeeId ?? null, verifiedScanned: scanned, custodySince: null, custodyState: input.condition ?? "good", updatedAt: now })
    .where(eq(schema.assets.uuid, id))
    .returning();
  await audit(deps, actor, "asset.acknowledge", "assets", id, { scanned, condition: input.condition ?? "good", note: input.note?.trim() || null, waitedDays }, updated);
  await emitEvent(deps, actor, "asset.acknowledged", {
    subject: `assets/${id}`,
    employeeId: actor.employeeId,
    payload: { categoryId: updated!.categoryId, assetTag: updated!.assetTag, condition: input.condition ?? "good", scanned, waitedDays },
  });
  return updated!;
}

/**
 * `:printTag` - the sticker for this asset has just been printed.
 *
 * Holding this verb is also what exposes `tag_secret` on the serialized resource (see toAssetResource): the
 * people who print tags are the only ones who ever see the number that makes a scan provable.
 */
export async function markTagPrinted(deps: Deps, actor: AppUser, id: string) {
  const row = await getAsset(deps, id);
  const now = new Date();
  const [updated] = await deps.db
    .update(schema.assets)
    .set({ tagPrintedAt: now, tagSecret: row.tagSecret ?? mintTagSecret(), updatedAt: now })
    .where(eq(schema.assets.uuid, id))
    .returning();
  await audit(deps, actor, "asset.printTag", "assets", id, { diff: { tagPrintedAt: { from: row.tagPrintedAt, to: updated!.tagPrintedAt } } }, updated);
  return updated!;
}

/**
 * `:reissueTag` - mint a new secret, so the sticker that is out in the world stops working.
 *
 * Used when a tag is lost, defaced or peeled off onto the wrong laptop. Clearing the printed stamp puts the
 * asset back in the printer's "needs a tag" queue.
 */
export async function reissueTag(deps: Deps, actor: AppUser, id: string) {
  await getAsset(deps, id);
  const now = new Date();
  const [updated] = await deps.db
    .update(schema.assets)
    .set({ tagSecret: mintTagSecret(), tagPrintedAt: null, updatedAt: now })
    .where(eq(schema.assets.uuid, id))
    .returning();
  // The old sticker stops working here, so the trail records the invalidation - never the secret itself,
  // which lib/audit strips from any meta regardless.
  await audit(deps, actor, "asset.reissueTag", "assets", id, { note: "the printed tag was invalidated and the asset returned to the print queue" }, updated);
  return updated!;
}

export async function deleteAsset(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.assets).where(eq(schema.assets.uuid, id)).limit(1))[0];
  if (!row) throw notFound("asset not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  // An asset row has no `delete_time` - a delete here is permanent - and `asset_requests.issued_asset_id`
  // points at it with ON DELETE no action, so a thing that was ever handed over against a request cannot go.
  // Say so: without this check D1 raises FOREIGN KEY constraint failed and the caller gets a 500 for what is
  // an ordinary precondition. Retiring is the answer for hardware that has left the building but has history.
  const [issued] = await deps.db
    .select({ uuid: schema.assetRequests.uuid })
    .from(schema.assetRequests)
    .where(eq(schema.assetRequests.issuedAssetId, id))
    .limit(1);
  if (issued) throw failedPrecondition("this asset was handed over against an asset request, so its history cannot be deleted - retire it instead");
  await deps.db.delete(schema.assets).where(eq(schema.assets.uuid, id));
  // Assets have no delete_time - this is permanent, so the row survives only as this entry.
  await audit(deps, actor, "asset.delete", "assets", id, removedMeta(row, "assets"), row);
}
