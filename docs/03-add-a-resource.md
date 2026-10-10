# 03 — Add a Resource (copy-paste recipe)

There is ONE way to build a collection: write a spec, mount it. `collectionRoutes()` in
`src/http/collectionRoute.ts` generates the AEP standard methods from it - list with cursor paging, get, create
(`?id`), patch (`If-Match`), delete (`?force`), the shared lifecycle verbs and `:restore` - so those exist in one
implementation instead of once per route file. `test/collectionLaneDrift.test.ts` fails a hand-rolled one.

The contract for ALL resources already exists in `openapi.yaml`, so you only write code.

## A. A collection

1. **Schema** — confirm the table exists in `src/db/schema.ts` (all tables are already defined). What it has
   decides what gets mounted: a `delete_time` column earns DELETE + `:restore`, `locked`/`disabled` earn the
   lifecycle verbs. No column, no route - the factory never writes a column that does not exist.
2. **Serializer** — a `toXResource` already exists in `src/http/serialize.ts` for every resource. If not, add one
   using `baseResource(row, "<kebab-plural>")` + the resource's own fields.
3. **Spec** — the 10% that is actually this collection's own:
   - `insert(input, deps, actor)` maps the wire body to insert columns, `patch(input, row, deps)` maps a PATCH to
     a `set` object (use `has(patch, "field")` so an absent field is left alone and the audit diff stays honest).
   - Omit `insert` for a collection nothing creates through its own endpoint; omit `patch` for read-only history.
     The route then does not exist, rather than existing and refusing.
   - `allocCode` for an owned or dept-scoped code, `afterCreate`/`afterUpdate` for side effects (notify, emit an
     event), `decorate` for derived data every answer carries, `sort` for presentation order.
   - Keep it in the service (`export const xSpec: CrudSpec<XInput>`) when it needs the service's helpers;
     inline in the route when it does not.
4. **Route** — `export const x = collectionRoutes<XInput>({ ...xSpec, param: "x_id", writeSchema, serialize })`.
   `writeSchema` is the Zod body (snake_case fields); use `createSchema` + `updateSchema` when create demands
   fields patch forbids.
5. **Mount** — add `app.route("/v1/<kebab-plural>", <router>)` in `src/index.ts`.
6. **Verify** — `npm run api:lint && npm run typecheck && npm test`.

> Reminder: wire fields are snake_case; identity is `path` (its id is the opaque wire token); Update is
> merge-patch (no field mask); never return DB-only or `*Enc` columns.

When a standard method genuinely differs, replace that ONE method with `overrides` (`get`, `create`, `update`,
`remove`, `purge`) and keep the rest of the lane. A bespoke `purge` is the common one: it exists because the row
has children to tear down first (a board's cards, a cycle's reviews), and the lane test fails if one is defined
and nothing calls it.

## B. Scoped resource (access depends on the caller)
Template: `employees` / `leave-requests`. Use when access depends on the caller (self / dept / all).
Access control lives in the `authz` middleware, never in the service or the factory. To make a new collection
scoped you supply the *data* the middleware needs:
1. **Give rows a hierarchical `code`.** Allocate it on create via `allocCode` in the spec (owner-embedded for
   employee-owned rows, flat for org-wide), so the middleware can match `me` / `my-dept` / a code prefix.
2. **Register the collection in policy (data).** Add per-role grants at the right scope as `access_rules`
   rows (a fresh database is seeded from the role files in `bootstrap/authz/roles/`; a live one gets them through Access
   Management or a migration) and any protected-field / owner-ref entries in `policy`
   (seeded from `src/domain/manifests.ts`). Owner-scoped collections use `me` / `my-dept` - **never bare
   `**`** (that is a BOLA hole). Sensitive sub-resources are opt-in (no broad grant reaches them). After
   editing the defaults, regenerate the seed rows in `scripts/seed.sql`.
3. **Lists apply the middleware's scope, deciding nothing.** A scoped list is the spec's `list(c)` hook, because
   it needs `c.get("scope")`; the service calls `applyScope(scope, table.code, table.owner)` to bind the `WHERE`.
   Unset scope → empty (fail-closed). The factory still owns the response shape and the access hints. If the
   collection also uses `decorate`, attach the same data in the list hook - a route-level list bypasses it.
4. **Map the collection** in `src/lib/authzResolve.ts` (`TABLES`) and `src/middleware/encodeWireIds.ts`
   (`ENCODABLE`) so the path resolves to a permission key and ids are wire-tokenized.

The middleware decides; the service only binds columns. See `docs/authz.md` for the model.

## C. Resource with encrypted fields
Template: `employees` (`national_id`, `bank_details`).
- Encrypt on create/update with `deps.encryptor.encrypt(...)`; store in the `*Enc` column.
- The serializer MUST omit `*Enc` columns. Never log decrypted values.

## D. Resource with custom methods
Template: `leave-requests` (`:approve`, `:reject`, `:cancel`) and `tickets` (twelve of them).
- Add a service function per verb; enforce the transition/precondition (throw the right Problem).
- Add one `verbs` entry per verb: `{ schema?, run(deps, user, id, body, c) }`. The factory parses the body,
  calls `run`, then serializes the returned row with the item access hint. A verb body is optional on the wire,
  so a missing or non-JSON body parses as `{}`.
- Use `{ raw(c, id) }` only when the verb does not answer with the resource - it streams bytes or returns a
  receipt - and then it owns its whole Response.
- A request's `:reject` takes `schema: rejectBody` (`http/rejectBody.ts`): the reason is required, the service
  runs it through `requireRejectReason` (`services/decisionGuard.ts`), stores it as `decision_note` and puts it
  in the requester's notification. In the SPA a reject asks through `askRejectReason` / `askDecision`
  (`lib/confirmDecision.ts`) or `useRejectRequest` (`components/common/ApprovalRow.tsx`), never a bare confirm.
- The verb name is the access hint: a factory-built collection advertises exactly the verbs it mounted, so
  `ACCESS_VERBS` is not consulted for it.
- If the action is long-running, return **202** + an Operation (template: `payroll-runs:publish`),
  and ensure the `/v1/operations` + `/v1/operations/{operation}` routes exist (they do).

## E. File resource (R2 + :download)
Templates: `org-documents` (company-wide, flat code), `personal-documents` (employee-owned, owner-embedded
code), `payslips`. Access is the middleware's code-scoped grant.
- Store the object in R2 via `deps.docs.put(key, bytes, contentType)`; persist the `r2Key`.
- `:download` is a `raw` verb: the middleware already gated the path, so the service `deps.docs.get(key)` and
  returns bytes with the right `Content-Type`. The bucket is never public.
- `:upload` is a normal verb that happens to read `c.req.arrayBuffer()` and answers with the resource.
- Whether the file is attached is derived data: resolve it in `decorate` so every single-row answer agrees, and
  in the list hook for the whole page in one query (template: `expenses`, `reimbursements`, `candidates`).
- The `documentService` / `documentRoutes` factories parametrize org vs personal; a new file resource
  follows the same shape (code allocation + wire encoding).

## F. Not a collection
A key/value config surface (`settings`, `preferences`, `policy`, `payroll-debit`, `bank-formats`) borrows the
route shape but has no collection semantics: the caller names the item id, so PATCH upserts and there is nothing
to create or delete. These stay hand-written and are named in `NOT_COLLECTIONS` in the lane test, which pins
that they have no collection-level `POST /` and no DELETE. If yours grows either, it has become a collection.

## Checklist before you call a resource "done"
- [ ] Built with `collectionRoutes()` — no hand-rolled `GET /` + `GET /:id` pair.
- [ ] Endpoint(s) present in `openapi.yaml`; `npm run api:lint` clean.
- [ ] List paginated; Update is merge-patch; errors are RFC 9457.
- [ ] Serializer emits `path`/`create_time`/`update_time`/`etag` (+ `state` if lifecycle), snake_case, no
      secrets, no `*Enc`.
- [ ] Access is path-gated by the middleware - **no** in-service checks. Scoped collections allocate a
      `code`, are registered in `grants`/`policy` (+ seed regenerated), and lists call `applyScope(ctx.scope)`.
- [ ] Collection mapped in `authzResolve.TABLES` + `encodeWireIds.ENCODABLE` (ids are wire-tokenized).
- [ ] **Grantable in the UI, not just by the seed**: a row in `web/src/components/access/permMatrix.ts`
      `COLLECTION_GROUPS` (plus a `collectionMeta.ts` entry where the kebab name reads badly or the grant needs
      a sentence). The permissions matrix is the only place an admin DISCOVERS a resource to grant it, so a
      scope-grantable collection missing from it is an access control the product honours and no one can
      author - `attendance-day-marks` shipped that way. `test/collections.test.ts` fails on it now.
- [ ] `npm run verify` green.
