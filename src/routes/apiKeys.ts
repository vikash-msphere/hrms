import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listApiKeys, createApiKey, revokeApiKey, deleteApiKey, type ApiKeyInput } from "../services/apiKeys";
import { toApiKeyResource } from "../http/serialize";

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
    owner: z.string().optional(),
    scope: scopeSchema.optional(),
    expire_time: z.string().optional(),
  })
  .strict();

// Machine credentials. No PATCH: a credential's scope is fixed at mint time. The DELETE is a real removal (the
// table has no delete_time), so there is no `:restore` and no `?force` - and :revoke is the softer move that
// kills the key while keeping the row, so the audit trail can still resolve it.
export const apiKeys = collectionRoutes<ApiKeyInput>({
  table: schema.apiKeys,
  collection: "api-keys",
  auditName: "api_key",
  notFound: "api key not found",
  param: "api_key_id",
  createSchema: writeSchema,
  serialize: toApiKeyResource,
  overrides: {
    // The ONLY response that ever carries the plaintext token. Nothing stores it, so there is no second chance.
    create: async (deps, actor, input, id) => {
      const { row, token } = await createApiKey(deps, actor, input, id);
      return { ...row, secret: token };
    },
    remove: (deps, actor, id, ifMatch) => deleteApiKey(deps, actor, id, ifMatch),
  },
  list: (c, page) => listApiKeys(c.get("deps"), c.get("user"), page.maxPageSize, page.pageToken),
  verbs: {
    revoke: { run: (deps, user, id) => revokeApiKey(deps, user, id) },
  },
});
