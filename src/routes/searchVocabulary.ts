import { Hono } from "hono";
import type { AppEnv } from "../env";
import { searchVocabulary } from "../domain/searchIndex";

// `GET /v1/search:vocabulary` - what the palette suggests after `in:` and `status:`: the searchable collections
// this caller may list, each with its status values. The middleware decides which collections those are and
// leaves them on `listableCollections`, as it does for `/v1/changes`; this route makes no access decision.
export const searchVocabularyRoute = new Hono<AppEnv>().get("/", (c) =>
  c.json({ collections: searchVocabulary(c.get("listableCollections") ?? new Set<string>()) }),
);
