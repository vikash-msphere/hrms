import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { invalidArgument } from "../lib/errors";
import { DRAFT_COLLECTIONS, DRAFT_KINDS, MAX_DRAFT_INPUT, draftKind } from "../domain/aiDraft";
import { draftText } from "../services/aiDraft";

// Collection-level custom method `<collection>:draft` - write a first draft of some text from an instruction
// the caller typed, and hand it back for them to edit.
//
// COLLECTION-LEVEL, not item-level, because drafting happens BEFORE the record exists: somebody composing a
// new announcement has no announcement to address a verb to. `/v1/announcements:draft` resolves as
// `{resource: "announcements", verb: "draft"}`, so the authz middleware gates it with the announcements
// grant like any other custom method, and a role that may not write announcements cannot draft one either.
//
// ONE MOUNT PER HOST COLLECTION rather than a single `/v1/ai:draft`, and that is the whole reason the shape
// is this way. A single endpoint would need its own capability, and "may this caller draft for announcements"
// would then be a second authorization question answered in a second place - which is the thing this codebase
// keeps out of code and in policy data. Gating each draft with the grant on the thing being drafted means
// there is no new access decision anywhere.
const schema = z
  .object({
    kind: z.string().min(1),
    instruction: z.string().min(1).max(MAX_DRAFT_INPUT),
    existing: z.string().max(MAX_DRAFT_INPUT).nullable().optional(),
  })
  .strict();

/** One Hono app per collection, mounted at `/v1/<collection>:draft` in src/index.ts. */
export function draftRoute(collection: string) {
  const app = new Hono<AppEnv>();
  app.post("/", async (c) => {
    const parsed = schema.safeParse(await jsonBody(c));
    if (!parsed.success) throw invalidArgument("body must be { kind, instruction, existing? }");

    // The kind has to belong to the collection whose grant just authorized this request. Without this check
    // the mounts would be interchangeable: a caller with announcements access could POST
    // `/v1/announcements:draft` with `kind: "job-description"` and use a grant they do have to reach a
    // prompt gated behind one they do not.
    const kind = draftKind(parsed.data.kind);
    if (!kind || kind.collection !== collection) {
      const offered = DRAFT_KINDS.filter((k) => k.collection === collection).map((k) => k.id);
      throw invalidArgument(`kind must be one of ${offered.join(", ")} for ${collection}`);
    }

    const out = await draftText(c.get("deps"), c.get("user"), parsed.data);
    return c.json({ text: out.text, kind: kind.id, cached: out.cached });
  });
  return app;
}

/** Every mount the app needs, as data, so index.ts cannot forget one when a kind is added. */
export const draftRoutes = DRAFT_COLLECTIONS.map((collection) => ({ path: `/v1/${collection}:draft`, app: draftRoute(collection) }));
