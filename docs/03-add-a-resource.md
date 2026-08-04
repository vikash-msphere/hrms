# 03 — Add a Resource (copy-paste recipe)

Most remaining resources are CRUD. You add each by copying a template and renaming. The contract for
ALL resources already exists in `openapi.yaml`, so you only write code.

## A. Simple resource (no scoping, no encryption)
Template: `departments`. Examples to create this way: `holidays`, `announcements`, `leave-types`,
`pay-components`, `pay-periods`.

1. **Schema** — confirm the table exists in `src/db/schema.ts` (all tables are already defined).
2. **Serializer** — a `toXResource` already exists in `src/http/serialize.ts` for every resource. If
   not, add one using `baseResource(row, "<kebab-plural>")` + the resource's own fields.
3. **Service** — copy `src/services/departments.ts` to `src/services/<camelPlural>.ts`. Rename the
   table, the serializer, the `toInsert`/`applyPatch` field maps, and the capability.
4. **Route** — copy `src/routes/departments.ts` to `src/routes/<camelPlural>.ts`. Change the import,
   the param name (`{x_id}`), the Zod `writeSchema` (snake_case fields), and the serializer.
5. **Mount** — add `app.route("/v1/<kebab-plural>", <router>)` in `src/index.ts`.
6. **Verify** — `npm run api:lint && npm run typecheck && npm test`.

> Reminder: wire fields are snake_case; identity is `path` (its id is the opaque wire token); Update is
> merge-patch (no field mask); never return DB-only or `*Enc` columns.

## B. Scoped resource (access depends on the caller)
Template: `employees` / `leave-requests`. Use when access depends on the caller (self / dept / all).
Access control lives in the `authz` middleware, never in the service. To make a new collection scoped you
supply the *data* the middleware needs:
1. **Give rows a hierarchical `code`.** Allocate it on create via `codeAlloc` (owner-embedded for
   employee-owned rows, flat for org-wide), so the middleware can match `me` / `my-dept` / a code prefix.
2. **Register the collection in policy (data).** Add per-role grants at the right scope in the `grants`
   table (seeded from `src/domain/grants.ts`) and any protected-field / owner-ref entries in `policy`
   (seeded from `src/domain/manifests.ts`). Owner-scoped collections use `me` / `my-dept` - **never bare
   `**`** (that is a BOLA hole). Sensitive sub-resources are opt-in (no broad grant reaches them). After
   editing the defaults, regenerate the seed rows in `scripts/seed.sql`.
3. **Lists apply the middleware's scope, deciding nothing.** The route passes `c.get("scope")`; the
   service calls `applyScope(scope, table.code, table.owner)` to bind the `WHERE`. Unset scope → empty
   (fail-closed).
4. **Map the collection** in `src/lib/authzResolve.ts` (`TABLES`) and `src/middleware/encodeWireIds.ts`
   (`ENCODABLE`) so the path resolves to a permission key and ids are wire-tokenized.

The middleware decides; the service only binds columns. See `docs/authz.md` for the model.

## C. Resource with encrypted fields
Template: `employees` (`national_id`, `bank_details`).
- Encrypt on create/update with `deps.encryptor.encrypt(...)`; store in the `*Enc` column.
- The serializer MUST omit `*Enc` columns. Never log decrypted values.

## D. Resource with custom methods
Template: `leave-requests` (`:approve`, `:reject`, `:cancel`) and `payroll-runs` (state machine).
- Add a service function per verb; enforce the transition/precondition (throw the right Problem).
- Route: `app.post("/v1/<col>/:x_id\\:verb", ...)`. The wire path must be the `:verb` form.
- If the action is long-running, return **202** + an Operation (template: `payroll-runs:publish`),
  and ensure the `/v1/operations` + `/v1/operations/{operation}` routes exist (they do).

## E. File resource (R2 + :download)
Templates: `org-documents` (company-wide, flat code), `personal-documents` (employee-owned, owner-embedded
code), `payslips`. Access is the middleware's code-scoped grant.
- Store the object in R2 via `deps.docs.put(key, bytes, contentType)`; persist the `r2Key`.
- `:download` just fetches: the middleware already gated the path, so the service `deps.docs.get(key)` and
  returns bytes with the right `Content-Type`. The bucket is never public.
- The `documentService` / `documentRoutes` factories parametrize org vs personal; a new file resource
  follows the same shape (code allocation + wire encoding).

## Checklist before you call a resource "done"
- [ ] Endpoint(s) present in `openapi.yaml`; `npm run api:lint` clean.
- [ ] List paginated; Update is merge-patch; errors are RFC 9457.
- [ ] Serializer emits `path`/`create_time`/`update_time`/`etag` (+ `state` if lifecycle), snake_case, no
      secrets, no `*Enc`.
- [ ] Access is path-gated by the middleware - **no** in-service checks. Scoped collections allocate a
      `code`, are registered in `grants`/`policy` (+ seed regenerated), and lists call `applyScope(ctx.scope)`.
- [ ] Collection mapped in `authzResolve.TABLES` + `encodeWireIds.ENCODABLE` (ids are wire-tokenized).
- [ ] `npm run verify` green.
