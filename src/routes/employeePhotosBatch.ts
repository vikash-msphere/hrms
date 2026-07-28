import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { AppEnv } from "../env";
import { batchGetPhotos } from "../services/employeePhoto";

// Collection-level custom method `employees:batchGetPhotos` (mounted at the full path in index.ts, before the
// employees mount). One request returns the photos for many employees, replacing the per-avatar `:getPhoto`
// N+1. The envelope is callable by any authenticated user (allow `employees.batchGetPhotos`); the SERVICE
// re-applies the employees list scope per id, so a caller only gets photos of employees they may see. Inbound
// `employees/<token>` refs are already decoded to internal ids by the wire-id edge; the response maps ids back
// to `employees/<id>` refs so the outbound edge re-tokenizes them.
const bodySchema = z.object({ employees: z.array(z.string()).default([]) }).strict();
const idOf = (p: string) => p.split("/").pop()!;

export const employeePhotosBatch = new Hono<AppEnv>().post("/", zValidator("json", bodySchema), async (c) => {
  const ids = c.req.valid("json").employees.map(idOf);
  const photos = await batchGetPhotos(c.get("deps"), c.get("user"), ids);
  return c.json({ photos: photos.map((p) => ({ employee: `employees/${p.employeeId}`, data_uri: p.dataUri })) });
});
