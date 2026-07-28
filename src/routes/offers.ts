import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import {
  listOffers, getOffer, createOffer, updateOffer, deleteOffer, restoreOffer, purgeOffer,
  approveOffer, extendOffer, acceptOffer, declineOffer, rescindOffer,
} from "../services/ats";
import { toOfferResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { customMethod } from "../http/customMethod";

const COL = "offers";

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

export const offers = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const { items, nextPageToken } = await listOffers(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), {
      application: c.req.query("application"),
      status: c.req.query("status"),
      showDeleted: c.req.query("show_deleted") === "true",
    });
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toOfferResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:offer_id", async (c) => {
    const row = await getOffer(c.get("deps"), c.req.param("offer_id"));
    return c.json(withAccess(toOfferResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createOffer(c.get("deps"), c.get("user"), c.req.valid("json"), c.req.query("id"));
    return c.json(withAccess(toOfferResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:offer_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateOffer(c.get("deps"), c.get("user"), c.req.param("offer_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toOfferResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:offer_id", async (c) => {
    const id = c.req.param("offer_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeOffer(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteOffer(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:offer_id", async (c) => {
    const { id, verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    const hint = (row: any) => withAccess(toOfferResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "approve") return c.json(hint(await approveOffer(deps, user, id)));
    if (verb === "extend") return c.json(hint(await extendOffer(deps, user, id)));
    if (verb === "accept") return c.json(hint(await acceptOffer(deps, user, id)));
    if (verb === "decline") return c.json(hint(await declineOffer(deps, user, id)));
    if (verb === "rescind") return c.json(hint(await rescindOffer(deps, user, id)));
    if (verb === "restore") return c.json(hint(await restoreOffer(deps, user, id)));
    return c.notFound();
  });
