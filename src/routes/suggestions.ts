import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import { listSuggestions, createSuggestion, updateSuggestion, respondSuggestion, voteSuggestion, mergeSuggestion, purgeSuggestion, decorate, type SuggestionInput } from "../services/suggestions";
import { toSuggestionResource } from "../http/serialize";
import { invalidArgument } from "../lib/errors";
import { MAX_RICH_BODY } from "../domain/richText";

const writeSchema = z
  .object({
    category: z.string().nullable().optional(),
    title: z.string().optional(),
    body: z.string().max(MAX_RICH_BODY).optional(),
    anonymous: z.boolean().optional(),
  })
  .strict();
const respondSchema = z.object({ status: z.string().max(64).optional(), response: z.string().max(10_000).nullable().optional() }).strict();
const mergeSchema = z.object({ into: z.string().min(1) }).strict();

// The suggestion box. The create carries anonymity (the submitter is stored but hidden from readers), HR
// triages with :respond, and everyone else moves the count with :upvote / :downvote.
export const suggestions = collectionRoutes<SuggestionInput, typeof schema.suggestions>({
  table: schema.suggestions,
  collection: "suggestions",
  auditName: "suggestion",
  notFound: "suggestion not found",
  param: "suggestion_id",
  writeSchema,
  serialize: toSuggestionResource,
  // Up/down counts and the caller's own vote come from the votes table, one read per page or row.
  decorate: (deps, actor, rows) => decorate(deps, actor, rows),
  overrides: {
    create: (deps, actor, input) => createSuggestion(deps, actor, input),
    update: (deps, actor, id, patch, ifMatch) => updateSuggestion(deps, actor, id, patch, ifMatch),
    // A hard purge has to take the suggestion's votes with it - they are rows in another table.
    purge: (deps, actor, id, ifMatch) => purgeSuggestion(deps, actor, id, ifMatch),
  },
  list: (c, page) =>
    listSuggestions(c.get("deps"), c.get("scope"), page.maxPageSize, {
      pageToken: page.pageToken,
      status: c.req.query("status"),
      category: c.req.query("category"),
      q: c.req.query("q"),
      submitter: c.req.query("submitter"),
      // Who is asking, so the anonymity guard in the service can tell "my own box" from "somebody else's".
      actorEmployeeId: c.get("user").employeeId ?? null,
      showDeleted: page.showDeleted,
      deletedOnly: page.deletedOnly,
    }),
  verbs: {
    respond: {
      run: async (deps, user, id, _body, c) => {
        const parsed = respondSchema.safeParse(await jsonBody(c));
        if (!parsed.success) throw invalidArgument("body must be { status?, response? }");
        return respondSuggestion(deps, user, id, parsed.data);
      },
    },
    upvote: { run: (deps, user, id) => voteSuggestion(deps, user, id, 1) },
    downvote: { run: (deps, user, id) => voteSuggestion(deps, user, id, -1) },
    merge: { schema: mergeSchema, run: (deps, user, id, body) => mergeSuggestion(deps, user, id, body.into) },
  },
});
