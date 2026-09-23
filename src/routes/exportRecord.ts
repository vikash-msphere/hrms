import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { COLLECTIONS } from "../domain/collections";

/**
 * `POST /v1/export:record` - the audit entry for a bulk export.
 *
 * Exports are generated ENTIRELY IN THE BROWSER (web/src/lib/exportTable.ts): the rows are already on screen,
 * so a CSV is a local transform with no request behind it. That made the single highest-risk action in an HR
 * system the one thing the trail said nothing about - open the compensation list, click Export, and three
 * hundred salaries leave on a laptop with no entry anywhere. A list GET is deliberately not a "sensitive read"
 * either (domain/auditAccess audits a specific record, not a listing), so there was no indirect coverage.
 *
 * This is the client telling the server what it just did. That is worth being precise about:
 *
 * - It records WHAT WAS CLAIMED. A modified client could lie about the count, and nothing here can tell. That
 *   is acceptable because it is not a control: anyone who can export can already read every one of those rows
 *   through the API, so a liar gains nothing they did not have. The entry exists for accountability among
 *   people using the app as built, which is what an audit trail is for.
 * - It records no VALUES, only shape: the collection, the format, how many rows, which columns. The data is
 *   the caller's own to read; copying it into a table read by more people would be the leak this file is
 *   supposed to be documenting.
 * - The collection is taken as given, and no access decision is made here (test/singleSource.test.ts: routes
 *   do not decide access, the middleware does - and it already gated this request on `export`). Naming a
 *   collection you did not export forges an entry that INCRIMINATES YOU, under your own name; there is nothing
 *   to gain by it and nothing it can hide, so there is no check worth making.
 */
const recordSchema = z
  .object({
    // What was exported. A real collection name where the export came from one; a view name otherwise (the
    // attendance register, the leave calendar), which is recorded as a label rather than an anchor.
    collection: z.string().min(1).max(64),
    format: z.enum(["csv", "xlsx"]),
    rows: z.number().int().min(0).max(1_000_000),
    columns: z.array(z.string().max(64)).max(64).optional(),
  })
  .strict();

export const exportRecord = new Hono<AppEnv>();

exportRecord.post("/", zValidator("json", recordSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  // Anchor the entry on the exported collection when it IS one, so it lands in that collection's own trail and
  // its type filter. A view export (an attendance register, a leave calendar) is recorded against `export` with
  // its name as a label, which keeps it auditable without inventing a resource for it.
  const known = COLLECTIONS.has(body.collection);
  await audit(
    c.get("deps"),
    user,
    "export.download",
    known ? body.collection : "export",
    undefined,
    {
      // `note` and `fields` are keys the activity feed already renders, so this needs no new renderer.
      note: `${body.rows} row${body.rows === 1 ? "" : "s"} as ${body.format.toUpperCase()}`,
      ...(known ? {} : { of: body.collection }),
      ...(body.columns?.length ? { fields: body.columns } : {}),
    },
  );
  return c.body(null, 204);
});
