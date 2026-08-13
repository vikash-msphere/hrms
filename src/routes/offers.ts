import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import {
  listOffers, createOffer, updateOffer,
  approveOffer, extendOffer, acceptOffer, declineOffer, rescindOffer,
  type OfferInput,
} from "../services/ats";
import { toOfferResource } from "../http/serialize";

const writeSchema = z
  .object({
    application: z.string().nullable().optional(),
    base_comp: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    offer_date: z.string().nullable().optional(),
    join_date: z.string().nullable().optional(),
    expiry_date: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

// Offers. The five verbs are the offer's whole life after it is drafted: approved internally, extended to the
// candidate, then accepted (which converts them to an employee), declined or rescinded.
export const offers = collectionRoutes<OfferInput, typeof schema.offers>({
  table: schema.offers,
  collection: "offers",
  auditName: "offer",
  notFound: "offer not found",
  param: "offer_id",
  writeSchema,
  serialize: toOfferResource,
  overrides: {
    create: (deps, actor, input, id) => createOffer(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateOffer(deps, actor, id, patch, ifMatch),
  },
  list: (c, page) => {
    return listOffers(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      application: c.req.query("application"),
      status: c.req.query("status"),
      showDeleted: page.showDeleted,
    });
  },
  verbs: {
    approve: { run: (deps, user, id) => approveOffer(deps, user, id) },
    extend: { run: (deps, user, id) => extendOffer(deps, user, id) },
    accept: { run: (deps, user, id) => acceptOffer(deps, user, id) },
    decline: { run: (deps, user, id) => declineOffer(deps, user, id) },
    rescind: { run: (deps, user, id) => rescindOffer(deps, user, id) },
  },
});
