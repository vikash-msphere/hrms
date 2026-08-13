import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listAssets, getAsset, createAsset, updateAsset, deleteAsset, type AssetInput } from "../services/assets";
import { toAssetResource } from "../http/serialize";

const writeSchema = z
  .object({
    asset_tag: z.string().nullable().optional(),
    name: z.string().min(1).optional(),
    category: z.string().nullable().optional(),
    serial_number: z.string().nullable().optional(),
    status: z.enum(["in_stock", "assigned", "repair", "retired"]).optional(),
    assigned_to: z.string().nullable().optional(),
    assigned_on: z.string().nullable().optional(),
    purchase_date: z.string().nullable().optional(),
    tag_printed_time: z.string().datetime({ offset: true }).nullable().optional(),
    last_verified_time: z.string().datetime({ offset: true }).nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

// Company assets (laptops, phones, access cards) and who holds them. Retiring an asset is a status, so the
// DELETE here is a real removal of the record - permanent, with no restore.
export const assets = collectionRoutes<AssetInput>({
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
  list: (c) => {
    // The inbound edge (decodeWireIds) already decoded the query ref to its internal id; just take the id.
    const emp = c.req.query("employee");
    return listAssets(c.get("deps"), c.get("scope"), emp ? emp.split("/").pop()! : undefined).then((items) => ({ items, nextPageToken: undefined }));
  },
});
