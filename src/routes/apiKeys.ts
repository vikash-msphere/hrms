import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listApiKeys, createApiKey, revokeApiKey, type ApiKeyInput } from "../services/apiKeys";
import { toApiKeyResource } from "../http/serialize";
import { failedPrecondition } from "../lib/errors";

const scopeSchema = z
  .object({
    collections: z.union([z.literal("*"), z.array(z.string())]).optional(),
    max_level: z.enum(["read", "write", "admin"]).optional(),
    verbs: z.union([z.literal("*"), z.array(z.string())]).optional(),
  })
  .strict();

const writeSchema = z
  .object({
    display_name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    owner: z.string().optional(),
    scope: scopeSchema.optional(),
    expire_time: z.string().optional(),
  })
  .strict();

// PATCH reaches the LABELS and nothing else. What a key can do (`scope`), who it acts as (`owner`) and how
// long it lives (`expire_time`) are fixed at mint time: a credential whose authority can be edited after the
// fact is one whose authority nobody can reason about from the audit trail, and rotation exists precisely so
// a changed scope means a changed secret. Naming it, and saying what it is for, carries none of that - and
// getting those wrong is otherwise permanent.
const updateSchema = z
  .object({
    display_name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .strict();

// Machine credentials. PATCH edits the name and description only - the scope, the owner and the expiry are
// fixed at mint time (see updateSchema).
//
// DELETE is a SOFT delete, for the reason the whole collection is shaped around: the audit trail resolves a
// credential by its id, so destroying the row orphans every line that key ever wrote. Deleting hides it and
// stops it authenticating; `:restore` brings it back and `?force` purges when a record genuinely has to go.
// :revoke remains the narrower move - the key dies, the row stays visible - and is what an incident wants.
export const apiKeys = collectionRoutes<ApiKeyInput, typeof schema.apiKeys>({
  table: schema.apiKeys,
  collection: "api-keys",
  auditName: "api_key",
  notFound: "api key not found",
  param: "api_key_id",
  createSchema: writeSchema,
  updateSchema,
  serialize: toApiKeyResource,
  overrides: {
    // The ONLY response that ever carries the plaintext token. Nothing stores it, so there is no second chance.
    create: async (deps, actor, input, id) => {
      const { row, token } = await createApiKey(deps, actor, input, id);
      return { ...row, secret: token };
    },
  },
  // Wire patch -> columns. Only the keys the caller actually sent, so a PATCH of one field leaves the other
  // alone; an explicit null clears the description.
  patch: (input, row) => {
    // A revoked key is a CLOSED record. It survives revocation for one reason - so the audit trail can still
    // resolve the credential that did something - and renaming it after the fact rewrites the label those
    // rows are read by. The credential is gone; its record stops moving with it.
    if (row.revokedAt) throw failedPrecondition("a revoked key cannot be edited");
    return {
      ...(input.display_name !== undefined ? { name: input.display_name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
    };
  },
  list: (c, page) => listApiKeys(c.get("deps"), c.get("user"), c.get("scope"), page.maxPageSize, page.pageToken, page.showDeleted, c.req.query("q"), page.deletedOnly),
  verbs: {
    revoke: { run: (deps, user, id) => revokeApiKey(deps, user, id) },
  },
});
