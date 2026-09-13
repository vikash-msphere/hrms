import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listAssets,
  getAsset,
  createAsset,
  createAssetsBatch,
  updateAsset,
  deleteAsset,
  verifyAsset,
  acknowledgeAsset,
  markTagPrinted,
  reissueTag,
  ASSET_BATCH_MAX,
  type AssetInput,
  type CustodyScanInput,
} from "../services/assets";
import { ASSET_CONDITIONS, ASSET_STATUSES, type AssetStatus } from "../domain/assetCustody";
import { toAssetResource } from "../http/serialize";
import { accessHint, withAccess } from "../http/accessHint";

const writeSchema = z
  .object({
    asset_tag: z.string().nullable().optional(),
    name: z.string().min(1).optional(),
    category: z.string().nullable().optional(), // asset-categories/{id}
    serial_number: z.string().nullable().optional(),
    status: z.enum(["pending_verification", "in_stock", "pending_ack", "assigned", "repair", "retired"]).optional(),
    assigned_to: z.string().nullable().optional(),
    assigned_on: z.string().nullable().optional(),
    purchase_date: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

// The body both scan verbs take. `scan` is the raw string the camera/wedge produced - it is matched against
// the asset server-side, so the client cannot decide what counts as proof.
const scanSchema = z
  .object({
    scan: z.string().max(500).nullable().optional(),
    condition: z.enum(ASSET_CONDITIONS as [string, ...string[]]).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
    override: z.boolean().optional(),
    // Which walk-through claimed this sighting (`:verify` only, and only an OPEN count - the service checks).
    // Declared here as well as in the manifest: the body is strict, so an undeclared field is a 400, and the
    // stocktake scanner sends this on every scan.
    stocktake: z.string().nullable().optional(),
  })
  .strict();

// A delivery: lines that each describe one asset, or - with `quantity` - a run of identical ones. No status,
// no assignment and no tag override, because none of the three is something you can honestly say about a
// hundred things at once (see createAssetsBatch).
const batchSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            name: z.string().min(1),
            category: z.string().nullable().optional(),
            serial_number: z.string().nullable().optional(),
            purchase_date: z.string().nullable().optional(),
            notes: z.string().nullable().optional(),
            quantity: z.number().int().min(1).max(ASSET_BATCH_MAX).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(ASSET_BATCH_MAX),
  })
  .strict();

// Collection-level custom method `assets:batchCreate` (mounted at the full path in index.ts, before the assets
// mount, like bonuses:award). Authz resolves it to the `assets.batchCreate` verb, grantable via the ACL like
// any other custom method. It answers with a page of rows rather than one resource, which is why it sits
// outside the item-verb lane the factory owns.
export const assetBatchCreate = new Hono<AppEnv>().post("/", zValidator("json", batchSchema), async (c) => {
  const user = c.get("user");
  const rows = await createAssetsBatch(c.get("deps"), user, c.req.valid("json").items);
  // Same hint-then-serialize order the factory uses, so a caller who may print tags gets the tag secret of
  // every asset they just created and can send the run straight to the sticker printer.
  return c.json({
    results: rows.map((r) => {
      const hint = accessHint(user, "assets", r.code);
      return withAccess(toAssetResource(r, user, hint.can), user, "assets", r.code, undefined, undefined, hint);
    }),
  });
});

// Company assets (laptops, phones, access cards) and who holds them. Retiring an asset is a status, so the
// DELETE here is a real removal of the record - permanent, with no restore.
//
// Custody moves through the two scan verbs, never through PATCH: `:verify` counts one into stock, and
// `:acknowledge` is the holder confirming receipt. `tag_printed_time` is likewise owned by `:printTag`.
export const assets = collectionRoutes<AssetInput, typeof schema.assets>({
  table: schema.assets,
  collection: "assets",
  auditName: "asset",
  notFound: "asset not found",
  param: "asset_id",
  writeSchema,
  serialize: toAssetResource,
  softDelete: false,
  overrides: {
    get: (deps, _actor, id) => getAsset(deps, id),
    create: (deps, actor, input) => createAsset(deps, actor, input),
    update: (deps, actor, id, patch, ifMatch) => updateAsset(deps, actor, id, patch, ifMatch),
    remove: deleteAsset,
  },
  list: (c, page) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    // `status` is the picker's filter ("what can I hand over?"), taken only when it names a real status so a
    // typo narrows to nothing rather than being ignored and answering a wider question than was asked.
    const status = c.req.query("status");
    return listAssets(c.get("deps"), c.get("scope"), {
      employeeId: emp ? emp.split("/").pop()! : undefined,
      status: status && (ASSET_STATUSES as readonly string[]).includes(status) ? (status as AssetStatus) : undefined,
      maxPageSize: page.maxPageSize,
      pageToken: page.pageToken,
    });
  },
  verbs: {
    verify: { schema: scanSchema, run: (deps, user, id, body: CustodyScanInput) => verifyAsset(deps, user, id, body ?? {}) },
    acknowledge: { schema: scanSchema, run: (deps, user, id, body: CustodyScanInput) => acknowledgeAsset(deps, user, id, body ?? {}) },
    printTag: { run: (deps, user, id) => markTagPrinted(deps, user, id) },
    reissueTag: { run: (deps, user, id) => reissueTag(deps, user, id) },
  },
});
