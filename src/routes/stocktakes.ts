import { z } from "zod";
import { collectionRoutes } from "../http/collectionRoute";
import { closeStocktake, listStocktakes, recordFound, stocktakeSpec, type FoundInput } from "../services/stocktakes";
import { COUNTABLE_STATUSES } from "../domain/stocktake";
import { toStocktakeResource } from "../http/serialize";

// Inventory counts (walk-throughs). NO access checks here - the middleware gates the path by grants (private
// by default). Standard CRUD + soft-delete, plus the two verbs a count owns: `:recordFound` (something was
// scanned that the inventory does not know about) and `:close` (freeze the result). The SIGHTINGS a count
// collects are not written here at all - they are stamps `assets:verify` puts on each asset row.
const writeSchema = z
  .object({
    label: z.string().min(1).optional(),
    scope: z
      .object({
        statuses: z.array(z.enum(COUNTABLE_STATUSES as [string, ...string[]])).optional(),
        categories: z.array(z.string()).optional(), // asset-categories/<id>
      })
      .strict()
      .nullable()
      .optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

const foundSchema = z
  .object({
    scan: z.string().max(500).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
  })
  .strict();

const closeSchema = z.object({ notes: z.string().max(2000).nullable().optional() }).strict();

export const stocktakes = collectionRoutes({
  ...stocktakeSpec,
  param: "stocktake_id",
  writeSchema,
  serialize: toStocktakeResource,
  list: (c, page) => listStocktakes(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted),
  verbs: {
    recordFound: { schema: foundSchema, run: (deps, user, id, body: FoundInput) => recordFound(deps, user, id, body ?? {}) },
    close: { schema: closeSchema, run: (deps, user, id, body: { notes?: string | null }) => closeStocktake(deps, user, id, body ?? {}) },
  },
});
