# Authorization

How access control works in this codebase, end to end. This is the **current** reference.

## Contents
1. [Principles](#1-principles)
2. [The three identifiers](#2-the-three-identifiers)
3. [Policy is data](#3-policy-is-data)
4. [The compiled store (`access_rules`)](#4-the-compiled-store-access_rules)
5. [The grant shape](#5-the-grant-shape) - [5.1 The API-key ceiling](#51-the-api-key-ceiling-machine-callers)
6. [From request to permission key](#6-from-request-to-permission-key) — [6.1 The owner key](#61-the-owner-key-flat-coded-collections-with-an-owner-column)
7. [The matcher](#7-the-matcher)
8. [The decision](#8-the-decision)
9. [Request lifecycle and read budget](#9-request-lifecycle-and-read-budget)
10. [Per-object rules (a user, or an object-pinned role)](#10-per-object-rules-a-user-or-an-object-pinned-role)
11. [Body access control (fields, references, owners)](#11-body-access-control-fields-references-owners)
12. [List scope](#12-list-scope) — [12.1 Global search](#121-global-search-get-v1search), [12.1.1 KPI counts + the approvals badge](#1211-the-other-fan-outs-kpi-counts-and-the-approvals-badge), [12.2 Why search is indexed](#122-why-search-is-indexed-not-scanned)
13. [Client capabilities](#13-client-capabilities)
14. [Management endpoints](#14-management-endpoints)
15. [Fail-closed guarantees](#15-fail-closed-guarantees)
16. [BOLA invariants](#16-bola-invariants)
17. [How to change policy](#17-how-to-change-policy)
18. [Worked examples](#18-worked-examples)
19. [File map](#19-file-map)

---

## 1. Principles

- **Single source.** The `authz` middleware (`src/middleware/authz.ts`) is the only place an access
  decision is *enforced*. No service or route authorizes. Two authz-shaped calls exist outside the
  middleware, both client affordance payloads that emit a hint and gate nothing: `capabilitiesOf` (coarse
  `/users/me` capability set) and `computeCan` (`src/http/accessHint.ts`, the per-object `access.can` hint,
  section 13). A grep gate (`test/singleSource.test.ts`) keeps services/routes free of any decider import.
- **Policy is data, the engine is code.** Roles, grants, per-object exceptions, protected-field
  designations, references, and owner refs are rows in D1. `src/domain/permissions.ts` interprets them; it
  contains no policy. Authority is **compiled** to an `access_rules` table; the engine `decide()` is the
  sole authority over it.
- **Private by default, fail-closed.** Anything not explicitly allowed is denied. An unresolved path, a
  missing grant, an unset list scope, or a thrown error all deny. Nothing falls through to a handler.
- **DB narrows, the engine decides.** The DB only ever narrows candidate rules by **exact code** (a
  subject, a namespace, an ancestor-code `IN` set) - never a SQL prefix/`LIKE` on the scope key. Every
  BOLA-critical comparison (`me` / `my-dept` / `isUnder` / deny-wins) happens in the tested TS engine.
- **Read-mostly, cached.** A role's compiled rules, the caller's own rules, roles held, reporting lines and the
  global manifest are held in each isolate's memory until the database says they changed (section 9, "How the
  caches stay fresh"), so warm decisions read no rules at all. The cache is correctness-independent (a cold
  isolate computes the identical verdict from the same rows).
- **BOLA-resistant by construction.** Every item decision resolves the object's hierarchical `code` and
  matches it against the caller's scope. Opaque wire ids are defense in depth, never the guard.

## 2. The three identifiers

Every resource row carries up to three identifiers, each with one job:

| Identifier | Where it lives | On the wire? | Role in authz |
|---|---|---|---|
| `uuid` | PK / FK column | no | internal handle; FKs and joins use it |
| `code` | `code` column | no | **the scope key the matcher decides on** |
| wire token | computed | yes (the only one) | opaque public id; not used by the decision |

- **`code`** is a Crockford base32, `-`-delimited, ownership/hierarchy-embedded string, e.g.
  `04-1c-0a9-0kf` (dept, sub-dept, employee, leaf). Built on create by the allocator; it is what `me` /
  `my-dept` / prefix grants match. See `compose`, `segments`, `isUnder`, `ancestorsOf` (`codes.ts`).
- **`isUnder(prefix, code)`** is delimiter-boundary-aware containment: `04` covers `04`, `04-1c`,
  `04-1c-0a9`, but not `041` or `041-x`. This boundary is what stops a prefix-collision BOLA
  (`04-002` must not match `04-0029`).
- The wire token is an encrypted encoding of the `uuid`. The inbound edge decodes it back to the `uuid`
  before authz runs; the middleware then resolves `uuid -> code` (`authzResolve.ts`).

## 3. Policy is data

Policy lives in D1 (`src/db/schema.ts`):

```
roles(name PK, label, protected)         -- the role set; protected core roles are undeletable
policy(key PK, value_json)               -- global manifest row, key = 'manifest' (SOURCE-OF-RECORD)
access_rules(... see section 4 ...)      -- the SOLE authority store for role + user access (source of record)
```

- **`access_rules` is the sole source of record** for both role and user authority (no per-role grant blob).
  Each row is one access rule, created/removed directly through the one management API (section 14); the
  runtime decision reads these rows. Roles and users are the **same primitive** - a row's `subject_kind`
  ('role' | 'user') is the only difference; both carry the full scope vocabulary and are decided by the same
  engine.
- `users.role` is a text FK to `roles` (`ON DELETE RESTRICT`). The TypeScript `Role` type is `string`,
  validated at runtime against the table: an unknown role yields no rules, which fails closed.
- The day-one role set and each role's grant are **seed data in `bootstrap/authz/roles/`**: one JSON file per
  role, every rule carrying its reason, a manager's file `extends` the employee's (format in its README). They
  are rendered into `roles` + `access_rules` rows by `bootstrap/authz/accessRules.ts` for both
  `bootstrap/bootstrap.sql` and `scripts/seed.sql`, and guarded byte-for-byte against drift by
  `test/seedDrift.test.ts`. The running app never reads them (`test/bootstrapBoundary.test.ts`): after the seed,
  the rows are the policy. `src/domain/grants.ts` holds only engine vocabulary - `EMPTY_GRANT` (the fail-closed
  grant for a role with no rows), `SUPER_GRANT`, `EVERYONE_ROLE`, `isSuperGrant`, `roleSubjectsOf`.
- Which role a new account gets is the `roles.provisioned` flag (exactly one row; `services/roles.ts`
  `provisionedRole`), moved in Access Management > Roles. None marked refuses new accounts rather than guessing.
- The policy manifest is the `policy` row (key `manifest`), seeded from `bootstrap/authz/policy.ts`.
  `src/domain/manifests.ts` holds only its shape and the accessors that read a stored one. There is no code
  fallback: a missing, unreadable or incomplete row refuses every request with 503 `/errors/not-configured`
  (`lib/policyLoad.ts` `loadManifest`), never a guessed or emptied policy. Migration 0012 wrote into the live
  row what the old fallback used to supply.

## 4. The compiled store (`access_rules`)

Each row is **one grant/exception pattern flattened to a uniform shape** by `src/domain/compileGrants.ts`:

```
access_rules(
  id           pk
  subject      text   -- role name OR user uuid
  subject_kind text   -- 'role' | 'user'
  namespace    text   -- the collection (first pattern token), or '*' for the super "**" pattern
  pattern      text   -- the VERBATIM grant pattern - the decision input, never re-derived
  scope_kind   text   -- 'all'|'subtree'|'exact'|'self'|'dept'|'reports'|'org'  (derived narrowing metadata)
  scope_code   text   -- code prefix for subtree/exact; '' otherwise
  match_code   text   -- exact object code for per-object rows: user exceptions AND exact (object-pinned) role
                       --   rules (the IN-narrowing key); NULL for SCOPE rules (all/subtree/self/dept)
  level        text   -- read|write|admin for level rules; NULL for verb/deny rules
  effect       text   -- 'allow' | 'deny'
  condition    text   -- optional JSON {field,op,value} threshold on the ROW (section 8); NULL for most rules
  window       text   -- optional JSON {field,within_days} date window on the ROW; NULL for most rules
  from_ip      text   -- optional comma-separated address/CIDR fence on the REQUEST; NULL for most rules
)
  INDEX (subject, namespace, match_code)   -- serves all reads (a left-prefix superset)
```

- `compileGrant(grant)` turns a `Grant`'s `levels` / `allow` / `deny` into rows; `rulesToGrant(rows)` is the
  exact inverse (the runtime reconstructor); `deriveNarrowing` extracts `(namespace, scope_kind, scope_code)`
  from a pattern; `mergeGrants(base, extra)` overlays one grant on another.
- **The `pattern` is carried verbatim and fed to the unchanged `decide()`.** The
  `(namespace, scope_kind, scope_code, match_code)` columns are an INDEX only: the DB uses them to fetch a
  SUPERSET of candidate rows; a too-loose key just fetches extra rows the engine filters out. The one thing
  that must never happen - dropping a row `decide()` would match - is guarded by the differential test
  (`test/compileGrants.test.ts`: compiled-rows decision == blob decision over a generated request space).
- The single composite index serves every read (confirmed via `EXPLAIN QUERY PLAN`): role-rule fetch
  (`subject` prefix), list shares/denies (`subject, namespace` prefix), per-object exact-IN (full key).

## 5. The grant shape

A grant (`permissions.ts`) is:

```ts
type Grant = {
  levels: Record<string, Level>; // resource pattern -> granted level; ladder admin > write > read
  allow: string[];               // custom-method key patterns (resource + verb)
  deny?: string[];               // key patterns (resource + action); deny WINS
};
type Level = "read" | "write" | "admin";
```

- **`levels`** authorizes **standard methods** (List/Get/Create/Update/Delete). The key is a resource
  pattern (no action token); the value is the granted level. The ladder is cumulative: `write` implies
  `read`, `admin` implies `write`.
- **`allow`** authorizes **custom methods** (`:verb`). Each entry is a full key pattern ending in the verb.
  There is **no ladder** for verbs: holding `admin` on a resource does not grant its verbs.
- **`deny`** is checked first and wins outright, for both kinds, with no downward ladder. This expresses
  separation-of-duties (payroll `:approve` is super-only via a deny on every other role) and per-object
  denies (section 10).

### 5.1 The API-key ceiling (machine callers)

A machine caller presents `Authorization: Bearer hrms_<prefix>_<secret>` instead of a Cloudflare Access JWT
or a session cookie. An API key is **not a principal of its own**: it acts as its owner (a `users` row), and
its scope may only narrow that user's authority.

A scope is deliberately not a second `Grant` - intersecting two pattern grants would need pattern algebra
over `me` / `my-dept` / `<prefix>-*`, which is where a BOLA hole would hide. It is three plain facts, each of
which intersects exactly against the grant's own structure (`domain/keyScope.ts`):

```ts
type KeyScope = {
  collections: string[] | "*"; // the FIRST pattern token - the same thing access_rules.namespace stores
  maxLevel: Level;             // clamps every granted level down the ladder
  verbs: string[] | "*";       // the custom-method (last) token
};
```

An empty list is a lock, not a wildcard: `collections: []` grants nothing.

The ceiling is enforced in **two** places, and neither is redundant:

1. **`narrowGrant` at auth time** (`middleware/auth.ts`) rewrites `user.grant` before anything reads it.
   Cross-collection patterns (super's `**`) collapse to one `<col>.**` entry per allowed collection; levels
   clamp; `deny` carries through verbatim, since deny only ever subtracts. This is what makes every
   grant-derived ANSWER correct - list scope, search scopes, dashboard scopes, capability hints - without a
   single one of them special-casing machine callers.
2. **`inScope` on the resolved request** (`middleware/authz.ts`) checks the request itself. Necessary
   because the object lane merges per-object exception rules onto the grant at decision time (section 10),
   and that merge could otherwise re-widen a key past its ceiling.

The transports (`search`, `dashboard-summary`, `activity`, `batch`) get no exemption from the collection
axis: a collection-scoped key cannot use them, and a `"*"`-scoped one can, subject to `max_level`.

Three things a key may never do, regardless of scope:

- **Simulate.** `X-View-As` from a key is refused (`middleware/auth.ts`), not ignored - a key holding
  `access-rules:preview` would otherwise read the app as any employee.
- **Mint another key.** Otherwise a narrow key with write access to `api-keys` could mint an unrestricted
  one for its own owner and escape its ceiling entirely (`services/apiKeys.ts`).
- **Outlive its owner's account.** The owner must exist and be `active` on every request, and the row
  cascades on user delete.

Two properties the rest of the design leans on:

- **The bearer lane is terminal.** A request carrying an `hrms_`-shaped bearer is resolved as that key or
  fails 401 - it never falls back to the cookie. `middleware/csrf.ts` skips its `X-Requested-By` check on the
  mere presence of that header, which is sound *only* because of this rule; a fall-through would let an
  attacker suppress CSRF with a junk bearer and ride the victim's session.
- **The key row is never cached.** One indexed read by `prefix` per request, so revocation and expiry bite on
  the very next call. The stored verifier is an HMAC (key derived from `FIELD_ENCRYPTION_KEY` by HKDF), not a
  bare digest, so a dump of `api_keys` is not a set of working credentials.

`test/keyScope.test.ts` states the top-level claim executably: over every seeded role grant, every scope and
a broad request space, anything the narrowed grant allows the original grant also allows.


## 6. From request to permission key

`resolveRequest(method, codedPath, force)` (`permissions.ts`) turns an HTTP request into one of:

```ts
{ kind: "standard"; resource: string; level: Level }   // e.g. resource "employees.04-1c-0a9", level "read"
{ kind: "custom";   resource: string; verb: string }   // e.g. resource "leave-requests.04-002-7", verb "approve"
```

- The path (with the id already substituted to a `code`) is split on `/` and joined with `.` to form the
  dotted `resource`. A trailing `:verb` becomes a custom method; otherwise it is standard.
- **Standard level** (`levelFor`): `GET -> read`; `POST/PATCH/PUT -> write`; `DELETE -> write`, or `admin`
  when `?force=true` (hard purge).
- Sub-resources are structural tokens: `GET /v1/employees/{id}/bank-account` resolves to
  `employees.<code>.bank-account` with level `read`. The token `bank-account` is matched literally, which is
  why PII can be granted independently of the base record.

The full key the matcher checks is the `resource` tokens plus the action token (level for standard, verb for
custom): `["employees","04-1c-0a9","bank-account","read"]`.

### 6.1 The owner key (flat-coded collections with an owner column)

Almost every scoped collection is **owner-coded**: the row's own `code` is composed under its owner's employee
code, so `me` and `my-dept` match it directly. Two are not - `assets` and `users` - and they carry an owner
*column* instead (`assets.assigned_to`, `users.employee_id`). An owned code is the wrong fix for both: custody
moves over an asset's life and a code is immutable, and a user account need not have an employee at all.

Left alone, the two lanes of one grant disagreed. The **list** lane answers "own" fine (`applyScope` binds
`eq(owner, ownerId)`), while the **item** lane asked `isUnder(callerCode, "0a")` against a flat code, which is
false for everyone - so `GET /v1/assets/<id>` refused a row the list had just returned.

So `Resolved` carries an optional second resource:

```ts
{ kind: "standard"; resource: "assets.0a"; level: "read"; ownerResource: "assets.04-1c-0a9" }
```

`ownerResource` is the same path with the **id token** replaced by the owner's employee code
(`withOwnerResource`). The middleware sets it only for the collections in `OWNER_COLUMN_COLLECTIONS`
(`services/codeCascade.ts`), which is **derived** - a collection with a real owner column in
`LIST_OWNER_COLUMNS` that is *not* in `HIERARCHICAL_TABLES` - so it cannot drift from either registry. The
owner id rides the id->code resolve, and the owner uuid->code hop uses the cached resolver, so warm this costs
no extra read.

Two rules make it safe, and they are not symmetric:

- the **allow** lanes match against either key (this is the widening that makes the item lane answer at all);
- the **deny** lane matches against **both**, or a deny authored on the row's own code would be bypassable
  through the owner key.

And two places deliberately keep deciding on the row's real code only: the **protected-field / reference gate**
(`bodyDecision`) and **field redaction**. The owner key says the row is yours; a protected field is exactly
what you may not set on your own row - without that split, a `users.me.**` rule (which the ACL can author)
would match `users.<ownerCode>.role` and become self-promotion. The API-key ceiling is unaffected: `inScope`
clamps by collection and level, and the owner key never changes the collection token.

## 7. The matcher

`matchTokens(patternTokens, keyTokens, self)` (`permissions.ts`) compares a dot-split pattern to a dot-split
key, with one special token across tokens and a small vocabulary within a token.

Across tokens:
- **`**`** matches zero or more trailing tokens (greedy recursion). `employees.**` matches `employees`,
  `employees.<code>`, `employees.<code>.bank-account.read`, and so on.

Within a single token (`matchToken`), against the concrete key token `kt`:
- **`*`** - matches any one token.
- **`me`** - matches the literal `me`, or any `kt` whose code is under the caller's employee code
  (`isUnder(self.employeeCode, kt)`). This is how "your own" owned objects match.
- **`my-dept`** - matches any `kt` under the caller's department code (`deptOf`).
- **`<prefix>-*`** - explicit code-prefix scope, e.g. `04-*`. This is what a **subtree** rule compiles to,
  and - because every owned code is composed under its employee, which is composed under its department - it
  is also how a rule is anchored to one **named department**: `leave-requests.04-*.**` reaches that
  department's leave requests whether or not it is the caller's own. The ACL offers it as the "one department"
  tier (`scope: subtree` with a `departments` object as `scope_ref`); `dept`/`my-dept` stays the
  subject-relative one.
- **`my-reports`** / **`my-org`** - the MANAGER CHAIN: a code under one of the caller's direct reports, or
  under anyone in their reporting line. These cannot come from the code, which encodes department nesting and
  nothing else, so the caller's report set is resolved at auth time and carried on `SelfContext` - and ONLY
  when the caller's own grant actually uses one of the tokens (`grantNeedsReports`), so nobody else pays a read
  for it. An unresolved set matches nothing. `my-org` is capped at 8 levels and 500 people; both caps truncate,
  which loses access rather than granting it.
- anything else - matched literally (collection names, sub-resource names, concrete codes, verbs).

There is deliberately **no `my-dept-only`** ("my department but not its sub-departments"). An owned row is
`<deptPath>-<employeeSeg>-<leaf>`, so `04-1c-0a9-0kf` is indistinguishable - by shape or by depth - from a row
belonging to an employee in the sub-department `04-1c-0a9`. Separating them needs to know which children a
department has, which is a read the matcher cannot make; expressed on depth alone the tier would be right for
`employees`/`departments` and silently match nothing on the thirty-odd owned collections.

`me` and `my-dept` resolve against `self.employeeCode` (from the JWT via the auth read). No grant names a
concrete employee. A per-object exception names a concrete `code` literally (section 10).

## 8. The decision

`decide(grant, resolved, self)` (`permissions.ts`) returns `{ allow: true }` or `{ allow: false, reason }`:

1. **Deny first.** For each `deny` pattern, if it matches the full key (resource + action) - or the owner key,
   where there is one (section 6.1) - deny and stop. Deny has no ladder and always wins.
2. **Standard methods** - take the maximum granted level over every `levels` pattern that matches the
   resource tokens (or the owner resource tokens); allow if it is at least the required one
   (`read=1 < write=2 < admin=3`).
3. **Custom methods** - allow if any `allow` pattern matches the full key (or the owner key); otherwise deny.
4. **Default** - deny. Nothing reaches a handler without an explicit `{ allow: true }`.

**The delete axis.** A `DELETE` resolves to the standard `write` level, so editing a record and destroying it
are the same key and "may edit but never delete" could not be said. The middleware therefore asks the deny
lane one extra question on a `DELETE` - `denyingPattern(grant, { verb: "delete" })` (or `purge` for `?force`)
- and refuses if a deny matches. This is **subtractive only**: it is the deny pass (`denyingPattern`, the same
loop `decide` runs first), never an allow, so no grant needs a verb it did not need before and nothing is
widened. The `access.can` hint mirrors it, so a row never offers a Delete that would 403.

**State-gated visibility.** `policy.state_visibility` names, per collection, the state a row must be in to be
readable by the collection grant alone; a row outside it needs `requires` on the item. `public_when` compares a
boolean flag, one string, or any of a set - so a draft run, a cancelled requisition or an offer still in
negotiation are all sayable, not just the published/disabled flags this started with. A NULL string status is
NOT public, which is the fail-closed direction. One predicate (`isPublicState`) backs both the item gate
(`stateReadAllowed`) and the list filter (`services/stateFilter.ts`, bound by the collection factory), so the
lane that decides and the lane that filters cannot drift - which they had, the list filter having been
hand-written for one collection while the manifest looked general. The custom-grid runner
(`services/tableRun.ts`) binds the same filter on its base page, on every linked row and on every source, for
the same reason: a grid is a list of the collection it is based on, and a projection that skipped it would be
the one list in the app answering with rows the collection's own list hides.

**Per-rule guards.** Beyond its pattern a rule may carry up to three constraints, all of them SUBTRACTIVE and
all evaluated by one pass (`domain/ruleCondition.ts` `guardAllows`) after `decide()` has already allowed:

| Guard | Column | Predicate on | Applies to |
|---|---|---|---|
| threshold | `condition` | the row's money field | item requests |
| time window | `window` | the row's date field | item requests |
| network fence | `from_ip` | the caller's address | every request under the rule |

The fence is the odd one out because it constrains the REQUEST rather than a row, so it holds on collection
paths too; the other two have nothing to measure there and fail closed, which is what stops a capped rule
authorizing a collection-level call. All three share one union rule: a guard constrains only when EVERY rule
behind the pattern carries one, so an unguarded rule on the same pattern wins and granting somebody an extra
rule can never remove access.

**The threshold axis.** A rule may carry a `condition` - `{field, op, value}` on a money column the collection
declares (`domain/ruleCondition.ts` `CONDITION_FIELDS`) - which is how "approve expenses up to 50,000" is said.
It does not fit `matchToken`: every scope token is a predicate on the CODE, and this is one on the ROW. So it is
a second pass, built exactly like the delete axis above: asked only after `decide()` has ALLOWED, against the
pattern that decision named (`via`), and able only to refuse. Three properties keep it honest:

- **it never grants.** There is no branch that turns a refusal into an allow.
- **it unions.** A condition constrains a request only when every rule behind the pattern carries one; an
  unconditional rule on the same pattern wins, so granting somebody an extra rule can never remove access.
- **it fails closed.** An absent field, a non-numeric value or a row that was not loaded all read as "outside
  the limit" - a cap must not evaporate exactly when the value is missing.

It applies to ITEM requests only. A list has no single row to measure, and a threshold bounds acting on a
record rather than seeing it: a manager reviews every expense in their department and can still be unable to
approve the large ones. Making it a list predicate would hide rows they are meant to look at.

`decide` is the sole authority. Whether the grant came from the role's compiled rules, a reconstructed
blob, or a role+exception merge, the verdict is always rendered here.

## 9. Request lifecycle and read budget

Two middlewares run in order.

**`auth` (`src/middleware/auth.ts`)** - verifies the Cloudflare Access JWT (or `DEV_FAKE_EMAIL` locally),
then resolves the caller and their authority:

- One query left-joins the caller's identity + employee `code`: `users LEFT JOIN employees`.
- The **broad role grant** comes from `loadRoleGrant(role)` (`src/lib/policyLoad.ts`): it reads the role's
  SCOPE rows (`subject = role AND subject_kind = 'role' AND match_code IS NULL`) and reconstructs the `Grant`
  via `rulesToGrant`. Cached per role until the `role_rules` counter moves (below). Object-pinned (exact) role
  rules are excluded here - they ride the per-object narrowed lane (step 3 below), so the cached grant stays
  small.
- The **broad user grant** comes from `loadUserGrant(uuid)` - the caller's OWN scope rules
  (`subject_kind = 'user' AND match_code IS NULL`), merged onto the role grant (`mergeGrants`). Cached per user
  until the `acl_rules` counter moves; the common case is no rows (`EMPTY_GRANT`, so the merge is a no-op).
  This makes a user first-class like a role (it can hold collection/dept/field-scope access, not only
  per-object exceptions).
- The **global manifest** comes from `loadManifest()` (the `policy` row, parsed fail-closed), cached until the
  `policy` counter moves.
- Sets `user = { ..., employeeCode, grant, policy }`. A disabled user is rejected. First login auto-provisions
  a row.

**`authz` (`src/middleware/authz.ts`)** - the gate:

1. `buildCodedPath` resolves the top path id `uuid -> code` (cached in an in-isolate `Map`); `me` / `-` /
   `:verb` stay literal. The resolved object `code` is captured.
2. `resolveRequest` builds the `Resolved`.
3. **Per-object overlay (item paths).** If an object `code` resolved, `loadObjectRulesForRequest` takes the
   per-object rows matching the object's ancestor codes (section 10) - the caller's USER exceptions AND any
   exact ROLE rules - out of the caller's cached per-object rule set (one indexed read per caller, repeated
   only when the `acl_rules` counter moves; `subject IN (uuid, role)` paired by `subject_kind`, sliced in
   memory afterwards); any are overlaid on the
   broad role grant via `mergeGrants`. The merged grant is also stashed on `ctx.objectGrant` for the
   `access.can` hint (section 13). No object code -> the broad grant.
4. `decide(grant, resolved, { employeeCode })` - reads memory, zero queries.
5. If allowed, `bodyDecision` additionally gates protected fields, references, and owner refs (section 11),
   using the same merged grant.
6. `!decision || !decision.allow` -> log the reason server-side, throw a generic 403 (the response never
   leaks the code/path).
7. On allow, set `ctx.scope` (section 12) for list services, then `next()`.

Per-request read budget:

| Read | When | Cold | Warm |
|---|---|---|---|
| `users (+ employees)` identity | every request | 1 | 1 |
| the cache counters (`cache_generations`, one row) | at most once per isolate per 5s | 1 | ~0 |
| broad role grant (scope rows -> `rulesToGrant`) | every request | 1 | ~0 (cached per role) |
| broad user grant (own scope rows) | every request | 1 (usually empty) | ~0 (cached per user) |
| manifest | every request | 1 | ~0 (cached) |
| `uuid -> code` | item / write paths | 1 (cached `Map`) | ~0 |
| per-object rules (user + exact-role rows) | item paths, and every list's shares/denies | 1 (tiny, index-only; usually empty) | ~0 (cached per caller) |
| the decision | every request | **0** (memory) | **0** |

Nothing scales with object or rule count; the decision itself never queries.

### How the caches stay fresh

Every cache above lives in ONE isolate's memory, and Cloudflare runs many isolates, so no code in one of them
can clear another's. What they share is the database: `cache_generations` (`src/db/schema.ts`) is one row with a
counter per kind of cached data, and a trigger on each source table bumps its counter in the same transaction as
the write (migration `0003_release_three.sql`). Every writer is covered - a service, a cron, the code
cascade, a migration, hand-run SQL - and no code path has to remember to clear anything.

| counter | moved by | what reloads |
|---|---|---|
| `role_rules` | a role's broad rule (`subject_kind = 'role'`, no `match_code`) | that role's grant, in every role that unions `everyone` |
| `acl_rules` | any other rule: user rules, per-object rules, ticket shares | callers' user grants and per-object rule sets |
| `user_roles` | a secondary role granted or taken away | roles held |
| `policy` | the manifest row | the manifest |
| `roles` | the role catalog | the role new accounts get |
| `org` | an employee added or removed, or a manager, code or delete-time change | reporting lines |
| `codes` | an employee or department code change (every re-parent) | the `uuid -> code` map |
| `automations` | any automation rule write | the enabled rule set |

`src/lib/cacheGenerations.ts` holds a value for up to 30 days and reloads it only when one of ITS counters has
moved; each isolate re-reads the counter row at most every 5s. The counters are read before the data, in the
same D1 session, so a read replica that is behind can never file old rows under a newer counter, and counters
only go up, so no clock is involved. A change therefore reaches every isolate within about 5s plus replica
lag. Without the row (the migration not applied) every cache falls back to expiring after 5s.

`POST /v1/operations:clearCache` (the "Clear caches" button on Settings > Operations, super-only unless
granted) moves every counter and empties the answering isolate at once, for changes made outside these tables.

## 10. Per-object rules (a user, or an object-pinned role)

Beyond broad role rules, a specific object can be **shared with** or **denied to** a specific user (or pinned
to a role). Each is one `access_rules` row created via `POST /v1/access-rules` with `scope: exact`:
`subject = user uuid` (or role name), `subject_kind = 'user'` (or `'role'`), `namespace = collection`,
`match_code = object code`, and a `pattern` using the **literal object code token**:

- a level share -> `pattern = "<col>.<code>.**"`, `level = read|write|admin` (standard methods + sub-resources);
- a verb share -> `pattern = "<col>.<code>.<verb>"`, `level = NULL`, `effect = 'allow'` (one custom method);
- a deny -> the same pattern with `effect = 'deny'` (the whole object, or just a named verb).

A **role** can also be object-pinned the same way: an exact-code pattern in a role's grant
(e.g. `<col>.<code>.**`) compiles to a role row with `match_code = <code>`, so it rides the identical
narrowed lane instead of the cached broad grant. This makes an object-pinned role grant as cheap as a user
exception (one indexed row, fetched only when its object is in play) rather than bloating every holder's
decision. `test/roleObjectRules.test.ts` is the matching BOLA oracle (narrowed == full, split == wholesale,
prefix-collision, deny-wins, subject isolation).

**Item path (the second read).** For a request on object code `C`, `loadObjectRulesForRequest` fetches the
caller's per-object rows - USER exceptions and exact ROLE rules - where `match_code IN ancestorsOf(C)`
(`codes.ancestorsOf` - exact codes, computed in TS, no SQL prefix; one read, `subject IN (uuid, role)` paired
by `subject_kind`). Those rows are overlaid on the broad role grant (`mergeGrants`) and `decide()` renders the
verdict: a share raises the level / allows the verb for that object, a deny blocks it (deny-wins). Because the
pattern uses a literal code token, it matches exactly that object (and its sub-resources), never a sibling or
a prefix-collision neighbour. `test/grantExceptions.test.ts` proves the narrowing is decision-equivalent to
deciding over all the caller's rows (a correct superset).

**List path.** A collection-level list also loads the caller's per-object codes for the collection
(`loadObjectExceptionCodes`, one indexed read - user exceptions and exact role rules) and surfaces them in
the scope predicate (section 12).

## 11. Body access control (fields, references, owners)

On `POST` / `PATCH` / `PUT` with a JSON body, after the resource-level write passes, `bodyDecision`
(`authz.ts`) consults the manifest (`user.policy`) for the collection, deciding with the same merged grant:

**Read-side field gating** is the mirror of this and runs where every resource is serialized rather than on
the body: `policy.redacted_fields` lists base-record fields whose READ is decided at
`<collection>.<code>.<field>`, and `withAccess` (`http/accessHint.ts`) drops the ones that fail. The two
surfaces that do not serialize a resource decide the identical key for themselves, through the same
`deniedRedactedFields` (`http/fieldAccess.ts`):

- the **custom-grid runner** projects raw columns, so it asks it per row - over the code of the row the field
  LIVES on, base or linked - and blanks the cell. A redaction-gated field is also never pushed into the SQL
  `WHERE`, because a predicate evaluated in the database would judge the real value and turn a hidden filter
  into a way to read the field a letter at a time.
- **global search** renders text the INDEX copied out of the row, which no serializer ever sees. It drops a
  title or subtitle built from a denied field, and then re-explains the hit: a row is kept only if the columns
  this caller MAY read still contain every token, so matching on a withheld field cannot confirm a guess at it.
  The re-check costs one read per affected collection and only for a caller who is actually denied something.

Both are per ROW, because the key is scoped by the row's own code; neither can be answered once for a
collection. A grant ending in `**` (`offers.**`, `leave-requests.my-dept.**`, every rule the ACL editor
writes) matches the trailing field token, so it keeps the field, and listing a field takes nothing from its
holder. What that buys is the ability to take one away with a deny (`offers.*.base_comp.**`), scoped like any
other pattern. A 2-token row grant (`employees.*`, `employees.me`, `employees.my-dept`) stops at the row and
does NOT reach the field, so listing a field on a collection granted that way withholds it from those holders
unless they also carry `<collection>.<scope>.<field>.**` read. `employees.probation_end_date` is listed on
exactly that basis: HR, managers (`my-dept`) and the person themselves hold the field rule, and an org-wide
read-only directory grant does not (migration `0001_redact_probation_end_date` backfilled the rules onto live
roles). PII sub-resources keep their own redactors (`http/fieldAccess.ts`), which are per-key inside the
sub-resource.

- **Protected fields** (`policy.protected_fields`) - for each protected field present, require `write` on
  `<collection>.<code>.<field>` (or `<collection>.<field>` on create). The single place mass-assignment /
  self-escalation is blocked: a plain employee cannot set `department`/`manager`; `compensation` amounts stay
  payroll-only; `users.role`/`status` stay super-only.
- **References** (`policy.references`) - for each declared reference present, resolve its target `uuid -> code`
  and require the configured level on it. Fail-closed if the target does not resolve.
- **Owner refs** (`policy.owner_refs`) - closes the create-side BOLA gap: a body field that assigns ownership
  (`employee` on `leave-requests` / `personal-documents`) must resolve to an owner `code` the caller may
  `write` (their own `me`, or an admin for that namespace). Absent field means owned by the caller.

An unparseable / non-object body adds no constraint (the validator rejects it downstream); an unresolved
reference or owner denies.

## 12. List scope

A `WHERE` runs in the data layer, but the **decision** it encodes is made in the middleware.

- `scopeFor(user, collection)` (`access.ts`) returns
  `ListScope = { breadth: "all" | "dept" | "own", deptCode, ownerId, seeRestricted, shares?, denies?, subtrees? }`.
- `breadth` comes from `actorScope`, which **derives** it from the grant by probing `decide` with synthetic
  codes (no role names): can read a code under no real dept -> `all`; can read a sibling in its own dept ->
  `dept`; else `own`.
- `shares` / `denies` are the caller's per-object exception codes for the collection (section 10), loaded by
  the middleware for list requests.
- `subtrees` are the code prefixes of the caller's explicit **subtree grants** (`actorSubtrees`). The three
  breadths are all relative to the caller, so a grant on somebody else's department matched none of them and
  the list collapsed to `own` while the item path decided that department's rows correctly - a scope that
  could open rows its own list would never show. Candidates are lifted from the grant's own patterns (a
  lookup) and each is then confirmed by the same `decide` probe `actorScope` uses, so the engine stays the
  sole authority; they cost no read, since `scopeFor` already holds the grant. They bind exactly like
  `shares`, and like shares they add nothing at `all` breadth.
- The middleware sets `ctx.scope`. A scoped collection reads it in its spec's `list(c)` hook (the one part of
  the standard lane a collection supplies itself, because only it can see the caller's scope and its own
  filters; `collectionRoute.ts` still owns the response shape and the access hints). That hook calls the
  service, and the list service calls `applyScope(scope, table.code, table.owner)`
  (`listScope.ts`), which only **binds** the decision to columns: `(breadth-predicate OR code in a shared or
  granted subtree) AND code NOT in a denied subtree`, where the breadth predicate is `all` -> no filter,
  `dept` -> `code GLOB '<deptCode>-*'` (boundary-anchored), `own` -> `owner = <ownerId>`. Shares (per-object
  rows) and `subtrees` (subtree grants from the broad grant) bind identically - both mean "this code and
  everything under it" - and are kept as separate fields only because one costs a read and the other does
  not. Each share/grant/deny on code `C`
  binds as its **subtree** `(code = C OR code GLOB 'C-*')` - the same `isUnder` the item path decides with, so
  a share on a PARENT object lists its descendants (not just the exact node). The trailing `-` is the
  delimiter guard: `04-002` lists `04-002` + `04-002-*` but never the prefix-collision neighbour `04-0029`.
  **`GLOB`, not `LIKE`, and that is a performance requirement rather than a preference.** SQLite only turns a
  prefix pattern into an index range scan when the comparison is case-**sensitive**; under the default
  `case_sensitive_like=OFF`, `code LIKE 'C-%'` is a full table SCAN even though `code` is uniquely indexed, and
  D1 offers no way to set that pragma. `EXPLAIN QUERY PLAN` on the exact predicate: the `LIKE` form reports
  `SCAN`, the `GLOB` form `SEARCH ... USING COVERING INDEX (code>? AND code<?)`. This predicate runs for `dept`
  breadth and for **every** share and deny - and denies apply even at `all` breadth, so an admin's list scanned
  too. `GLOB` is case-sensitive where `LIKE` was not, which is strictly tighter and changes no result: codes come
  from the lowercase Crockford alphabet, so no code has a case variant to match.
  The other side of that index: because every branch of the OR can seek one, SQLite answers it as a
  `MULTI-INDEX OR`, which reads every row any branch matches before it sorts and applies a LIMIT. That suits
  narrow branches, and not a newest-first page whose branches cover most of the table. A list whose branches are
  broad passes `applyScope(..., { multiIndexOr: false })`, which binds the OR as `+( ... )` (SQLite's unary plus:
  the same rows, kept out of index selection), so the page walks its `(created_at, uuid)` index and stops at the
  LIMIT. The cards list does this, because the employee role's `ve`/`vr` subtrees are every org-visible board.
  A denied subtree removes its rows even under `all` (deny-wins). Codes are server-generated base32 + `-`
  (no glob metacharacters - no `*`, `?` or `[`), so the pattern needs no escaping; `test/listScope.test.ts`
  covers the collision case and asserts the operator, since which operator is emitted is the whole point.
- **Scope unset -> `1 = 0`** (empty result, fail-closed). The service makes no access decision; forgetting to
  set a scope returns nothing, never everything.

### 12.1 Global search (`GET /v1/search`)

Global search is one query fanned across many collections at once, so it needs the section-12 answer for each
of them rather than for one. `search` is **not a resource**: it holds no data and grants nothing, exactly like
the `/v1/batch:run` envelope. The middleware lets the envelope through for any authenticated caller and then
does all the deciding up front, in `searchScopesFor` (`authz.ts`):

- for every collection in `SEARCH_INDEX` (`domain/searchIndex.ts`), run the same
  `decide(grant, resolveRequest("GET", "/v1/<collection>"))` a real list request would get; drop the ones that
  fail,
- for the survivors, resolve `scopeFor(...)` plus their per-object shares/denies - **one** `access_rules` read
  for all of them (`loadObjectExceptionCodesFor`), not one per collection,
- hand the result over as `ctx.searchScopes` (collection -> `ListScope`).

`services/globalSearch.ts` then only **binds**. Matching runs against `search_fts` (an FTS5 index) joined to
`search_docs`, a plain table holding one row per indexed record. Crucially, `search_docs` copies each row's
`code` and `owner_id` from its source table, so the very same `applyScope(scope, code, owner)` a list service
binds is applied here, against the same values - `SEARCH_INDEX` records which pair each collection uses, and
`test/globalSearch.test.ts` pins the behaviour. Soft-deleted and non-public rows stay indexed but carry
`deleted` / `restricted` flags, so section 11's `public_when` is enforced through the same
`ListScope.seeRestricted` the middleware resolved. Collections sharing an identical scope collapse into one
`collection IN (...)` branch, keeping the statement inside D1's parameter cap.

The index is maintained entirely by **triggers** (generated into the migration from `SEARCH_INDEX` by
`src/db/searchDdl.ts`; see section 12.2), never by a service - so there is no write path that could index a
row the reader is not allowed to see, and no service to forget.

The palette's narrowing (`?in=`, `?owner=employees/<id>`, `?mine=1`, `?team=1`, `?dept=`, `?after=`, `?before=`,
`?status=` - typed as `in:tickets`, `@name`, `is:mine`, `is:team`, `dept:sales`, `after:2026-01`, `before:...`,
`status:pending` - and their `-` forms `?notin=`, `?notowner=`, `?notmine=1`, `?notteam=1`, `?notdept=`,
`?notstatus=`, typed `-in:holidays`, `-@name`, `-is:mine`, `-is:team`, `-dept:sales`, `-status:rejected`) only
ever ANDs another predicate onto those branches, or leaves a collection out of them, so it can narrow a caller's
answer and never widen it. The owner filters (`?owner`, `?mine`, `?team` and their `not` forms), the status filters and `?dept`/`?notdept` ask a question about a
column, so a hit whose owner, status or `department_id` column the caller's field gate withholds
(`policy.redacted_fields`) is dropped from an answer narrowed by it: otherwise "is this row Priya's?" would be
answerable by whether it comes back. `?dept` names only departments the caller's own `departments` list scope
returns, so the word cannot confirm that a department they cannot see exists. A board task typed by its key (`MS-12`) is looked
up by board prefix and number and then read under the same cards branch, so the key finds nothing the
caller's list of tasks would not. The three verbs beside it, `search:feedback`, `search:ask` and
`search:vocabulary`, read no record at all - one bumps a usage counter, one routes a question among the
destinations the caller's own palette sent, and one lists the collections `in:` may name with their status
values - so the middleware resolves no per-collection scopes for them. `search:vocabulary` needs only the
boolean half of the list decision (`listableCollectionsFor`, as `/v1/changes` does), so it names no collection
the caller could not list.

The invariant is therefore unchanged: **a search hit is always a row the caller's list of that collection
would have returned**, and `test/singleSource.test.ts` still holds - no decision is made outside the
middleware.

### 12.1.1 The other fan-outs: KPI counts, the people report and the approvals badge

Three more routes share this shape - an envelope any authenticated caller may hit, with the real decision made
per backing collection in the middleware and only *bound* in the service:

- **`GET /v1/dashboard-summary`** aggregates KPI counts. `scopesForCollections(..., DASHBOARD_SUMMARY_COLLECTIONS)`
  runs the same list decide/scope pair as search and hands over `ctx.summaryScopes`; a KPI whose collection the
  caller may not list is simply absent from the response.
- **`GET /v1/people-analytics`** is the per-person report (attendance and punctuality, leave, tasks, goals,
  reviews, 1:1s, timesheets, recognition) over a window. Same pattern, answering per PERSON rather than per
  collection: `scopesForCollections(..., ANALYTICS_COLLECTIONS)` sets `ctx.analyticsScopes`, the roster comes
  from the caller's own `employees` list decision (no `employees` scope, no rows at all), and each measure is
  bound by its own collection's list scope. A measure whose collection the caller may not list is absent from
  `metrics` and from every row - and a **derived** measure needs every collection it leans on (absence needs
  leave as well as attendance, or it would report somebody's approved holiday as an absence).
- **`GET /v1/approvals-summary`** counts what is awaiting the caller's decision, per queue. Same pattern with
  one axis changed: the decision is the **custom verb** `approve`, not a list read, because the badge counts
  what the caller may act on. `verbScopeFor(user, collection, "approve")` (`domain/access.ts`) probes
  `decide()` with synthetic codes exactly as `actorScope` does for reads, and returns **null** when the caller
  holds the verb at no scope - so an ordinary employee's badge scopes nothing and queries nothing.
  `approvalScopesFor` (`authz.ts`) sets `ctx.approvalScopes`, plus `ctx.taxVerificationsReadable` for the
  prior-employer verification queue (a virtual capability with no table, gated by `tax-verifications.read`).
  Per-object **shares** are deliberately not merged in: a list row's `access.can` hint is computed from the
  role grant, so an object-level share never put a row in this badge; denies still apply.

Both exist for the same reason as the FTS index below: the SPA used to compute them client-side from list
responses, which meant reading whole collections to produce one number. The approvals badge alone cost eleven
list requests on **every** page in the app.

### 12.2 Why search is indexed, not scanned

Worth stating because it constrains any future change here. D1 bills **rows read**, and `LIKE '%q%'` cannot
use an index - it scans. Searching ~60 collections per keystroke therefore cost roughly the size of the
database each time (~100k rows read at 50-employee scale), grew with the data, and would have exhausted the
5M-rows/day free-tier budget after a few dozen searches. Measured on the FTS index instead: **2 rows read for
a hit, 0 for a miss**, flat as the data grows.

The trade is write amplification - a source insert writes ~8-10 rows instead of 1, since the doc row and the
FTS index entries are written with it - and a semantic change: matching is on **token prefixes**, not
substrings, so `kapo` finds `Kapoor` but `apoor` does not. Both are deliberate. If write volume ever becomes
the binding limit, the lever is dropping high-churn low-value collections from `SEARCH_INDEX` (each is one
registry line and its three triggers), not reverting to scans.

## 13. Client capabilities

`capabilitiesOf(grant)` (`permissions.ts`) produces a scope-stripped set of `<collection>.<action>` strings
for the SPA's coarse gating (nav, page access, global buttons). `stripScope` drops scope/id tokens but keeps
structural sub-resource tokens, so `employees.me.bank-account.**` becomes `employees.bank-account`. Levels
expand down the ladder. The super wildcard `**` is emitted as-is; the client treats `**.x` / `**.**` as
match-all. This payload (served at `GET /v1/users/me`) is an affordance hint only - the server decides every
request regardless of what the client shows.

**Capabilities whose field slot names a collection.** `activity` and `export` (`COLLECTION_FIELD_CAPABILITIES`,
`manifests.ts`) carry a target COLLECTION in the field position rather than a record field, so a rule reads
`<capability>.<scope>.<collection>` - "the activity of leave requests", "exporting employees". That is what
makes an app-wide capability grantable in pieces without a second scope axis: the id position says whose
records, the field position says which kind. The client checks the broad capability OR the per-collection one
(`canSeeActivity` / `canExport` in `web/src/lib/perm.ts`); `isFieldScopeTarget` validates the field against
`COLLECTIONS` for exactly these two. `unmask` is field-scoped the ordinary way instead (`unmask.*.identity.uan`),
decided per field by `unmaskGate`.

**Per-collection breadth (`read_scopes` / `write_scopes`).** The same stripping hides a coarser thing than a
single row: whether the caller reaches ANYBODY ELSE. `attendance.me.**` and `attendance.**` both emit
`attendance.read`, and every employee holds the self-service half of attendance, goals, reviews, payslips, the
board and their own bank/identity/tax - so a UI that gates a surface about one named person on the string
shows it to everybody, about everybody. `callerScopes(actor, self)` (`domain/access.ts`) answers the missing
half by running the same synthetic-code probe `actorScope` uses over every collection in `COLLECTIONS`, plus
every field-precise employee sub-resource (`SUBRESOURCE_BODY`) at its own path, at both the read and the write
level. It returns `{ read, write }` maps of `<collection>` (or `employees.<sub>`) to `dept` / `all`; `own` is
OMITTED, so a missing key is the fail-closed answer. Subtree grants and the manager chain count - the self
context comes from `selfContextFor`, so a `my-reports` rule reports as `dept`. Per-object shares and denies do
not: they are grant-exception rows read per request, and this describes what the grant reaches. Served on
`GET /v1/users/me` beside `capabilities`, and consumed by `useCanReadFor` / `useCanWriteFor`
(`web/src/lib/perm.ts`). A hint, like everything else here.

**Per-subject reach (`access.subject`).** `access.can` says which VERBS the caller may run on one row.
A profile asks a different question - "may I see this person's goals, their attendance, their pay" - and each
of those is a DIFFERENT collection whose own grant decides it, about this person. `subjectScopes(grant, self,
subjectCode)` (`domain/access.ts`) answers it by probing `<collection>.<subjectCode>-<SCOPE_PROBE_LEAF>`: a
synthetic LEAF under the subject's REAL code, i.e. "a row of this collection owned by this person". Every
scope token then matches or does not on its own terms - `me` for the owner, `my-dept` / `my-reports` /
`my-org` for the team, `<code>-*` for a granted branch, a merged per-object share for the single record - so
the function contains no case analysis and no policy. Computed on the employees item (`subjectScopes: true` on
the route spec), where `ctx.objectGrant` carries the shares and `ctx.self` the reporting chain; emitted as
`{read, write}` key lists, absent meaning no. Contrast `read_scopes` below, which is a caller-level TIER: it
is probed with codes belonging to nobody, so it can report `my-reports` only as the blanket `dept` and cannot
see a share at all - correct for "is there anyone but me", wrong for "may I see Asha's goals".

**Per-object `access.can`.** Coarse capabilities are scope-stripped, so they can't tell the client whether the
caller may act on a *specific* row. `computeCan(grant, self, collection, code)` (`src/http/accessHint.ts`)
fills that gap: for a small static per-collection verb set (`ACCESS_VERBS`) it asks the same `decide()` whether
the caller may perform each verb on the object's `code`, and the covered routes attach the allowed verbs as
`access.can` on the serialized resource (`withAccess`). Item responses use the per-object-merged grant
(`ctx.objectGrant`, share-accurate); list responses use the broad role grant. Like `capabilitiesOf` this is a
UX hint computed server-side and shipped as data - it gates nothing; the middleware still enforces every
request (force the call and it 403s anyway). A drift test keeps `ACCESS_VERBS` to real collections/verbs.

## 14. Management endpoints

Policy is editable at runtime through governed endpoints (mounted in `src/index.ts`), **super-only by default
purely via access-rule data** (the middleware gates `roles.**` / `policy.**` / `access-rules.**`; there is no
per-route guard, so the single-source gate stays clean). Grantable to a non-super "access admin" by adding an
access rule - no code change.

| Endpoint | Methods | Notes |
|---|---|---|
| `/v1/roles` | list / get / create / update / delete | role catalog; `protected` core roles undeletable |
| `/v1/access-rules` | list / get / create / delete | **the one authority surface** - one rule per row for a role OR a user (section 4); no update (edit = delete + create) |
| `/v1/policy` | list / get / update | the manifest; **strict** shape validation on write |

- **Create an access rule (`src/services/accessRules.ts`).** `validateAccessRule` shapes one rule (exactly one
  of level / verb / deny; known collection; a field rule only on an access-controlled field), the service
  builds the verbatim `pattern` once and reuses `deriveNarrowing` for the narrowing columns (`match_code` set
  only for `exact`) - byte-identical to the seed's `compileGrant` - then inserts the row and busts the role
  cache (`grant:<role>`). Guards: **no author writes a rule for a subject that feeds their own grant** - a
  caller's authority is `user rows` over `mergeGrants(everyone rows, own-role rows)`, so all three are refused:
  the role you are using, your own user row, and `everyone` (super excepted there, since `**` cannot be
  widened). An identical rule 409s. Applies to the bulk copy as well - the target is checked once, up front.
  No blob, no recompile - the row IS the source of record.
- **Policy write** strict-validates the manifest (`validateManifest`): unlike the lenient read path
  (`parsePolicy` falls back to `DEFAULT_POLICY`), a write rejects a malformed body so a bad edit can never
  silently revert the manifest.
- **Lockout guards** (service-level write invariants, no authz import): you cannot edit the grant of the role
  you are using; a `protected` core role cannot be deleted; a role still held by any user cannot be deleted
  (FK `ON DELETE RESTRICT` backstop); an unknown-collection pattern is rejected.

## 15. Fail-closed guarantees

Every place the system could be unsure, it denies:

- Unknown / unconfigured role -> `EMPTY_GRANT` (no `access_rules` rows -> deny-all).
- Corrupt grant data -> `EMPTY_GRANT`; corrupt manifest -> `DEFAULT_POLICY` (never empty, which would fail
  open).
- Unresolved path id, thrown error, or missing user -> `decision = null` -> 403.
- Null or non-allow decision -> 403 (there is no `require_` backstop; the gate is the gate).
- Unresolved body reference / owner -> deny.
- Unset list scope, or missing `deptCode` / `ownerId` for a dept / own scope -> `1 = 0`.
- The cache is correctness-independent: a cold isolate reconstructs the identical grant from the same rows
  (`test/cache.test.ts`).

## 16. BOLA invariants

1. **Every item decision resolves `id -> code` and matches caller scope** in the engine; the `code` is
   server-resolved from the internal `uuid`, never caller-supplied.
2. **Non-admin role rules are `self` / `dept` / `subtree`, never `**` (`namespace = '*'`)** - only super
   compiles a cross-collection rule (`test/compileGrants.test.ts`).
3. **Opaque wire tokens are defense in depth, not the guard.** Invariant 1 is the guard.
4. **Ownership on create is gated, not trusted** (owner refs, section 11).
5. **List scope fails closed by construction** (section 12). Its subtree binding uses a **boundary-anchored**
   `GLOB 'C-*'` (the trailing `-`), the same safe form as the dept predicate - never a bare prefix - and only
   widens VISIBILITY (a too-tight bind over-hides, never over-shows); the item-path decision is unaffected.
6. **The compiler and the exact-IN narrowing (the DECISION path) are security-critical: no SQL prefix match,
   differentially tested against the engine.** A per-object pattern uses a literal code token, so it never
   leaks across a prefix collision (`04-002` vs `04-0029`) - on the item path (exact-IN) and the list path
   (anchored subtree GLOB), both covered by tests.

These are proven by the suite: `compileGrants.test` (compiler == engine, prefix collision), `bola.test`
(cross-employee / cross-dept), `grantExceptions.test` (per-object share/deny, narrowing == full set),
`parity.test` (route x role), `listScope.test` (fail-closed binding), `cache.test` (cold == warm).

## 17. How to change policy

All of these are data changes (no code change, no deploy) - via the management endpoints in production, or by
editing the typed default + regenerating the seed in this repo:

- **Add a role** - `POST /v1/roles` (starts with no rules = deny-all), then add its authority as rules via
  `POST /v1/access-rules`.
- **Grant a role PII** - `POST /v1/access-rules` `{subject_kind:role, subject, collection:employees,
  scope:all, field:"bank-account", level:read}` -> `employees.*.bank-account.**`. By default only super
  reaches PII via `**`; owners reach their own via the seed's `employees.me.bank-account.**`.
- **Tighten / widen a scope** - delete the rule and create one with a different `scope` (e.g. `all` -> `dept`);
  the matcher reinterprets the pattern, the engine is untouched.
- **Share / deny one object to one user (or pin to a role)** - `POST /v1/access-rules`
  `{subject_kind, subject, collection, scope:exact, scope_ref, level | verb | effect:"deny"}`.
- **Mark a field protected** / **authorize a body reference** / **gate ownership on create** - `PATCH
  /v1/policy/manifest` (`protected_fields` / `references` / `owner_refs`).

You only touch engine code to add a brand-new scope **semantics** (say `my-region`) the matcher does not yet
understand. The existing vocabulary (`*`, `**`, `me`, `my-dept`, `<prefix>-*`, literal codes) is pure config.

## 18. Worked examples

**Employee reads their own bank account.** `GET /v1/employees/{me-token}/bank-account` -> key
`employees.04-1c-0a9.bank-account.read`. The employee grant has `employees.me.bank-account.**: write` ->
`me` matches `04-1c-0a9` (`isUnder`), `**` swallows `read`, `write >= read` -> **allow**.

**Same employee reads someone else's bank account.** Key `employees.07-2a-1f1.bank-account.read`. `me` fails;
no other pattern reaches the sub-resource -> **deny** (private by default).

**Manager approves a leave request in their dept.** `POST /v1/leave-requests/{token}:approve` ->
`leave-requests.04-002-7.approve`. Manager allow `leave-requests.my-dept.approve`; `my-dept` is `04-002`,
`isUnder("04-002","04-002-7")` true -> **allow**. Another dept -> `my-dept` fails -> **deny**.

**A specific document shared with an employee.** Super `POST /v1/access-rules` `{ subject_kind: "user",
subject: users/{emp}, collection: personal-documents, scope: exact, scope_ref: personal-documents/{doc},
level: "read" }` -> a USER row `personal-documents.<docCode>.**: read`. The
employee's next `GET` of that doc loads the row (ancestor-IN), merges it, and `decide` allows - while a
sibling doc, having no row, stays denied.

**Payroll admin approves a run.** `POST /v1/payroll-runs/{token}:approve`. Payroll has
`allow: ["payroll-runs.**"]` but also `deny: ["payroll-runs.*.approve"]`. Deny wins -> **deny**. Super
(`allow: ["**"]`, no deny) -> allow.

## 19. File map

| File | Responsibility |
|---|---|
| `src/domain/permissions.ts` | engine: resolve, match, decide, capabilities (the sole authority) |
| `src/domain/codes.ts` | hierarchical code compose / parse / `isUnder` / `ancestorsOf` / allocate |
| `src/domain/compileGrants.ts` | compile a Grant <-> `access_rules` rows; `rulesToGrant`, `mergeGrants`, `deriveNarrowing` |
| `src/domain/collections.ts` | the collection registry (valid grant-pattern namespaces) + drift gate |
| `src/domain/policyValidate.ts` | write-time `validateAccessRule` / `validateManifest` (reject malformed) |
| `src/domain/grants.ts` | engine vocabulary: `EMPTY_GRANT`, `SUPER_GRANT`, `EVERYONE_ROLE`, `isSuperGrant`, `roleSubjectsOf` |
| `src/domain/manifests.ts` | the `Policy` shape + accessors over a stored manifest (no data of its own) |
| `src/domain/access.ts` | `actorScope`, `scopeFor`, `actorVerbScope`, `verbScopeFor`, `ListScope`, `stateReadAllowed` |
| `src/lib/policyLoad.ts` | load broad role grant + broad user grant + manifest (cached); the caller's per-object rules loaded once and sliced (`loadObjectRulesForRequest` / `loadObjectExceptionCodes` / `…For`) |
| `src/http/accessHint.ts` | `computeCan` / `withAccess` - the per-object `access.can` UX hint (gates nothing) |
| `src/http/collectionRoute.ts` + `src/services/crud.ts` | the ONE standard-method surface every collection is built from; shapes requests, decides no permission |
| `src/lib/cache.ts` | in-isolate TTL cache (`cached` / `clearCache`); correctness-independent |
| `src/lib/cacheGenerations.ts` | long-held caches checked against the `cache_generations` counters (`generational`); section 9 |
| `src/services/cacheFlush.ts` | `POST /v1/operations:clearCache`: move every counter, empty this isolate |
| `src/lib/authzResolve.ts` | path -> coded path, `uuid <-> code` resolvers + cache, collection->table map |
| `src/middleware/auth.ts` | resolve caller + employeeCode; load grant + manifest from the store |
| `src/middleware/authz.ts` | the sole gate: resolve, overlay exceptions, decide, body AC, set scope, fail closed |
| `src/services/accessRules.ts` | the one access-rule CRUD (role + user); `validateAccessRule` + `deriveNarrowing` -> row; guards |
| `src/services/{roles,policy}.ts` | the role-catalog + manifest management services + lockout guards |
| `src/services/listScope.ts` | `applyScope` - binds breadth + shares/subtrees/denies to columns, decides nothing |
| `src/http/tableFieldAccess.ts` | a custom grid's two extra questions: per-row PII reads, and `unmaskGate` (per-field unmask) |
| `src/domain/searchIndex.ts` | which collections global search covers, and how each mirrors its list scoping |
| `src/db/searchDdl.ts` | generates the FTS5 index + sync triggers from that registry (appended to the migration) |
| `src/services/globalSearch.ts` | builds the search query from `ctx.searchScopes`; binds, decides nothing |
| `src/services/approvalsSummary.ts` | approval-queue COUNTs from `ctx.approvalScopes`; binds, decides nothing |
| `src/db/schema.ts` | `roles` / `policy` / `access_rules` tables |
| `bootstrap/authz/` (`roles/*.json`, `policy.ts`, `accessRules.ts`) | seed data: the day-one roles, grants and manifest, rendered into both seeds; drift-checked |
