import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { listPreferences, getPreference, upsertPreference } from "../services/preferences";
import { toPreferenceResource } from "../http/serialize";
import { clampPageSize } from "../http/pagination";

const writeSchema = z.object({ value: z.unknown().optional(), key: z.string().optional() }).strict();

// All routes are caller-scoped: a user only ever reads or writes their own preferences.
export const preferences = new Hono<AppEnv>()
  .get("/", async (c) => {
    const { items, nextPageToken } = await listPreferences(c.get("deps"), c.get("user"), clampPageSize(Number(c.req.query("max_page_size")) || undefined), c.req.query("page_token"));
    return c.json({ results: items.map(toPreferenceResource), next_page_token: nextPageToken });
  })
  .get("/:preference_id", async (c) => {
    const row = await getPreference(c.get("deps"), c.get("user"), c.req.param("preference_id"));
    return c.json(toPreferenceResource(row));
  })
  .patch("/:preference_id", zValidator("json", writeSchema), async (c) => {
    // Both validators optional, as on settings: `If-Match` for a value built on a read, `If-None-Match: *` for a
    // caller that read no row (services/preferences.ts#upsertPreference).
    const row = await upsertPreference(c.get("deps"), c.get("user"), c.req.param("preference_id"), c.req.valid("json").value, c.req.header("If-Match"), c.req.header("If-None-Match"));
    return c.json(toPreferenceResource(row));
  });
