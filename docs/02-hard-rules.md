# 02 — Hard rules

The binding conventions for this codebase. Most are enforced by a test; where one is, the test is named, so
breaking the rule fails `npm run verify` rather than waiting for review.

## NEVER

- **Put an access check in a service or route**, or trust the client. Every access decision lives in the
  `authz` middleware: one gate, fail-closed, private by default. Lists call `applyScope(ctx.scope)`; the
  middleware decides breadth. Gate: `test/singleSource.test.ts`.
- **Hardcode who may do something.** Authority is policy data (roles, grants, access rules, the policy
  manifest), never a role string in code. Payroll approval being super-only is a grant `deny`, not an `if`.
- **Read a gated query parameter with `c.req.query()`.** If the `authz` middleware decides anything from a
  query parameter, the handler reads it through `src/http/query.ts`, which is the same WHATWG parser the gate
  uses. The two parsers disagreed about a URL fragment: `?force=true` is what lifts a `DELETE` from `write` to
  `admin`, the gate read it with `new URL()` (fragment stripped) and the collection factory read it with
  Hono's parser (fragment scanned), so `DELETE /v1/<collection>/<id>#?force=true` was **gated as a soft delete
  and executed as a hard purge**, cascading, by a caller holding only `write`. `package.json` pins
  hono >= 4.13.5 so its parser agrees too, but a version range is a promise about a dependency and this is a
  property of the code - keep both. Gate: `test/forcePurgeGate.test.ts`.
- **Hand-roll a standard method.** A collection is a spec on `collectionRoutes()`; see
  `docs/03-add-a-resource.md`. Gate: `test/collectionLaneDrift.test.ts`.
- **Add or change an endpoint without updating `openapi.yaml` first**, then `npm run api:types`. Gates:
  `test/openapiRoutesDrift.test.ts`, `test/customMethodsDrift.test.ts`, `npm run api:lint`.
- **Put business logic in a route handler or in the frontend.** It belongs in `services/` and `domain/`.
- **Store `national_id`, bank details, tax declarations, personal/identity details or salary in
  plaintext.** Field-encrypt through `deps.encryptor`; document bodies in R2 are encrypted too.
- **Return a DB-only or `*Enc` column**, an unbounded list, a non-AEP path, or a non-RFC-9457 error.
- **Edit a payroll run once `LOCKED` / `PUBLISHED`.** Corrections are new adjusting items in a new run.
- **Move money or file with an authority.** The system computes compensation, statutory deductions
  (EPF/ESI/PT/TDS, employer contributions) and payslips for one jurisdiction, and generates bank files as
  *output*. It initiates no payment and submits no return.
- **Mix currencies.** The app is deliberately single-currency (the org default). A payable in another
  currency fails the payroll build loudly rather than converting.
- **Use KV, Cloudflare Queues, or client-stored auth tokens.** Config is D1 plus a short-TTL in-isolate
  cache; async work is the `jobs` table drained by cron; the session is an HttpOnly cookie.
- **Bypass `round2` / `sum2` for money**, or write a money value that did not come from them. Money is
  stored as `real`; the rounding discipline is what keeps it exact (`src/db/schema.ts:6`).
  `test/moneyDrift.test.ts` enforces it: it fails on an arithmetic write to a money column that was not
  routed through `round2`/`sum2`, and it fails on a new `real` column that the test does not classify as
  money or not - so adding one means deciding, there, which it is.
- **Keep more than one migration.** The project is greenfield: after a schema change, squash back to `0000`
  (remove the sql + meta snapshot, empty the journal, `npm run db:generate`).

  **This rule expires at the first production deploy.** It works because no database has applied `0000` yet,
  so replacing it is free. The moment production has run it, `d1_migrations` holds that migration's name and
  Wrangler will not re-run it - so a squash is no longer a squash, it is a divergence: the new `0000` never
  applies, every later schema change is missing from production, and nothing reports it because
  `d1 migrations apply` correctly says there is nothing to do. On the release commit, freeze `0000` and start
  appending `0001`, `0002`, ... Deleting this bullet is part of that commit.
- **Put a comma inside an inline `{ }` description in `openapi.yaml`.** It crashes the linter; see
  `docs/01-aep-guidelines.md`.

## ALWAYS

- **Validate every request with Zod** and resolve the caller before handling any `/v1` request.
- **Emit AEP resources through `src/http/serialize.ts`**: `path` / `create_time` / `update_time` / `etag`,
  snake_case, the `path` id being the opaque wire token. Gate: `test/serializerContractDrift.test.ts`.
- **Write an `audit_log` row** for every create, update and delete, and for every payroll run transition.
- **Batch heavy work** through the `jobs` table plus cron, surfaced as an AEP Operation, and batch DB access
  through `src/lib/dbBatch.ts` (whole-table prefetch plus one atomic `db.batch`) so a request stays inside
  the free plan's 50-subrequest budget.
- **Regenerate what is generated** after changing its source: seed rows, access rules, the policy manifest,
  the FTS5 DDL, templates. Each has a drift test that fails otherwise.
- **Register a new collection everywhere it must appear**: `domain/collections.ts`, `lib/authzResolve.ts`
  (`TABLES`), `middleware/encodeWireIds.ts` (`ENCODABLE`), grants and policy defaults, the search registry
  if it is searchable, and the web access affordances (`test/webAccessCoverage.test.ts`).
- **Build web UI for a finger as well as a cursor**: no control under 44px on a coarse pointer, no
  hover-only affordance, 16px form text on a phone, and nothing docked to the bottom of a phone screen
  without clearing the home indicator and the on-screen keyboard. See `docs/06-responsive-ui.md` for the
  variants (`coarse:`, `standalone:`, `short:`) and the shared pieces.
- **Spend a wide screen on more, not bigger**: more columns, things side by side, or fewer lines per item -
  never the same items stretched. A wide step keys off `2xl:`/`3xl:` or a container width a 1440px screen
  cannot reach, so nothing at or below 1440 changes. `docs/06-responsive-ui.md`, "Wide screens".
- **Nothing is wider than the viewport except a box that declares itself a scroller.** A phone gives ~328px
  of content column: add up the widths a row states before writing it, let a control row wrap
  (`.editor-row`), and give a `flex-1` wrapper `min-w-0` so the `truncate` inside it can fire. Anything
  deliberately wider needs its own `overflow-x-auto` and a `scroll-shadow-x` to say so. `html` clips
  horizontal overflow as a backstop, which means content past the edge is unreachable, not just off screen.
- **Return the promise from a `<Button>`'s onClick** (`onClick={() => save()}`, never `() => void save()`).
  The button stays disabled with a spinner in place of its leading icon until that promise settles, so an
  action cannot be fired twice while its request is in flight. `loading` is for state the button cannot see,
  such as a save started by a keyboard shortcut. Gated by `test/buttonPendingCoverage.test.ts`.
- **Run `npm run verify`** before calling anything done. It is `api:lint` at `--fail-severity=warn`, then
  `typecheck` (including the web project), then the full test suite.

## Definition of done for a change

- [ ] `npm run verify` green.
- [ ] Contract and code agree; `openapi.yaml` updated first if the surface changed.
- [ ] Access is path-gated by the middleware only; any new authority is policy data, and the seed is
      regenerated.
- [ ] Lists paginate; Update is merge-patch; mutations honour `If-Match`; errors are RFC 9457.
- [ ] Nothing secret, encrypted-at-rest, or DB-internal reaches the wire or a log.
- [ ] New behaviour is covered by a test, and a new *class* of mistake by a drift gate rather than one
      example.
