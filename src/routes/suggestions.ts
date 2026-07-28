import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { customMethod } from "../http/customMethod";
import {
  listSuggestions, getSuggestion, createSuggestion, updateSuggestion,
  respondSuggestion, voteSuggestion, deleteSuggestion, restoreSuggestion, purgeSuggestion,
} from "../services/suggestions";
import { toSuggestionResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { clampPageSize } from "../http/pagination";
import { invalidArgument } from "../lib/errors";

const COL = "suggestions";

const writeSchema = z
  .object({
    category: z.string().nullable().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    anonymous: z.boolean().optional(),
  })
  .strict();
const respondSchema = z.object({ status: z.string().max(64).optional(), response: z.string().max(10_000).nullable().optional() }).strict();

export const suggestions = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const user = c.get("user");
    const { items, nextPageToken } = await listSuggestions(c.get("deps"), c.get("scope"), maxPageSize, {
      pageToken: c.req.query("page_token"),
      status: c.req.query("status"),
      category: c.req.query("category"),
      showDeleted: c.req.query("show_deleted") === "true",
      actor: user,
    });
    return c.json({ results: items.map((r) => withAccess(toSuggestionResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:suggestion_id", async (c) => {
    const row = await getSuggestion(c.get("deps"), c.get("user"), c.req.param("suggestion_id"));
    return c.json(withAccess(toSuggestionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .post("/", zValidator("json", writeSchema), async (c) => {
    const row = await createSuggestion(c.get("deps"), c.get("user"), c.req.valid("json"));
    return c.json(withAccess(toSuggestionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .patch("/:suggestion_id", zValidator("json", writeSchema), async (c) => {
    const row = await updateSuggestion(c.get("deps"), c.get("user"), c.req.param("suggestion_id"), c.req.valid("json"), c.req.header("If-Match"));
    return c.json(withAccess(toSuggestionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  .delete("/:suggestion_id", async (c) => {
    const id = c.req.param("suggestion_id");
    const ifMatch = c.req.header("If-Match");
    if (c.req.query("force") === "true") await purgeSuggestion(c.get("deps"), c.get("user"), id, ifMatch);
    else await deleteSuggestion(c.get("deps"), c.get("user"), id, ifMatch);
    return c.body(null, 204);
  })
  .post("/:suggestion_id", async (c) => {
    const { id, verb } = customMethod(c);
    const user = c.get("user");
    const hint = (row: { code: string | null } | undefined) => withAccess(toSuggestionResource(row), user, COL, row?.code, c.get("objectGrant"));
    if (verb === "respond") {
      const parsed = respondSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) throw invalidArgument("body must be { status?, response? }");
      return c.json(hint(await respondSuggestion(c.get("deps"), user, id, parsed.data)));
    }
    if (verb === "upvote") return c.json(hint(await voteSuggestion(c.get("deps"), user, id, 1)));
    if (verb === "downvote") return c.json(hint(await voteSuggestion(c.get("deps"), user, id, -1)));
    if (verb === "restore") return c.json(toSuggestionResource(await restoreSuggestion(c.get("deps"), user, id)));
    return c.notFound();
  });
