# Access control: scope fine-graining + model QOL

## Status

Implemented: **A1a, A2, A3, A6, A7, A8, B1, B2, B3, B7, B8, B9** (plus two defects found while building
them - see below).
Withdrawn on inspection, with the evidence recorded in each section: **A5, A9** - both premises turned out
to be wrong about the code.
Not done: **A1b, A4, B4, B5, B6, B10** - each needs infrastructure the rest did not (a code migration, a
wider `SelfContext`, a join table, a usage rollup, a count endpoint). Those six have moved to
**[access-infra.md](access-infra.md)**, with the shape of each change and why it was not attempted here; the
sections below keep only the original finding, so this file stays the survey and that one the plan.

Two claims in the original survey were wrong and are corrected in place:

- **`background-checks` and `users` are FLAT-coded**, not owner-coded. They have an employee owner COLUMN,
  which is what I read them off, but neither passes `allocCode` to its spec, so both take `crud.ts`'s default
  `allocFlatCode`. They belong in A1b, not A1a. `users` still gained a `self` tier (it is honest there - see
  the manifest note); `background-checks` did not, because a `self`/`dept` chip on a flat code is exactly the
  half-working affordance A1b warns about.
- **`transition-tasks` is not an A5 divergence.** Its code is allocated under the ASSIGNEE
  (`services/transitions.ts` `allocOwnedCode(..., transitionTasks.assigneeId, ...)`), which is the same
  column the list binds - so both lanes mean "assigned to me" and the `self` chip is accurate. A5's remaining
  substance is the flat-code asymmetry already stated in A1b.

Two live defects surfaced while implementing and were fixed:

- **Per-collection `activity` rules could not be authored at all.** The fine-rules editor offers a "For
  collection" picker that writes the collection into the rule's `field` slot, and `isFieldScopeTarget`
  measured that against the record-field tests - a collection name is neither a protected field nor a
  sub-resource - so every such rule was refused as naming a field that does not exist. The capability was
  scopeable in the docs and in the client's capability check, and unauthorable in the one place that decides
  whether a rule may exist. Fixed by `COLLECTION_FIELD_CAPABILITIES` (see A7).
- **A row-scoped rule cannot open the list it scopes.** Covered under A3/A2 below; this is the one that made
  the narrow tiers look broken rather than narrow.

Findings from a read of the live engine, manifest, seed grants and the access UI. Every claim below is
anchored to the file that supports it. Nothing here is implemented yet; this is the ledger of what is
coarse today and what it would take to sharpen it.

The short version: **the engine is more expressive than the policy data and the UI let anyone use.**
`matchToken` (`src/domain/permissions.ts:80-100`) already honours five id-position tokens - `*`, `me`,
`my-dept`, `<prefix>-*`, and a literal code - and `validateAccessRule`
(`src/domain/policyValidate.ts:14`) already accepts six scopes. What is narrow is
`SUPPORTED_SCOPES` (`src/domain/manifests.ts:166-213`), which offers a tier for 39 collections and
`["all"]` for everything else, and `ListScope.breadth` (`src/domain/access.ts:110`), which has three
values and cannot say "a named subtree".

---

## Part A - where scope can be fine-grained

### A1. 42 grantable collections offer org-wide only

`supportedScopesOf` falls back to `["all"]` for anything unlisted (`src/domain/manifests.ts:212`), and
`scopesForCollection` renders exactly those chips (`web/src/components/access/permMatrix.ts:110-124`).
So for these the ACL modal shows a single "All" chip and the explanatory "no narrower tiers" line -
truthfully, but in several cases the narrowing is available and just undeclared.

Full list of matrix collections with no `SUPPORTED_SCOPES` entry:

```
users, shifts, projects, leave-types, holidays, holiday-selections, payroll-runs, pay-components,
pay-grades, salary-structures, pay-periods, bank-formats, reimbursement-categories, expenses,
expense-categories, expense-budgets, vendors, benefit-plans, review-cycles, boards, sprints, events,
kudos, job-requisitions, candidates, applications, interviews, offers, background-checks,
org-documents, letter-templates, letterheads, compliance-events, compliance-rules, ticket-checklists,
assets, asset-categories, stocktakes, approval-delegations, automations, settings, export
```

They split three ways.

**A1a. Owner-coded already - pure manifest additions, no schema work.** These rows carry an employee
owner column AND an owned code (`allocOwnedCode` composes `<employeeCode>-<leaf>`, so the dept prefix
rides along), which is exactly what `me` / `my-dept` match:

| Collection | Owner column | Tiers | Status |
|---|---|---|---|
| `expenses` | `expenses.employeeId` (`src/services/expenses.ts:64`) | `self`, `dept`, `all` | **Done.** Genuinely owned-coded (`allocOwnedCode`). The seed already grants `expenses.me.**` and `expenses.my-dept.**` (`src/domain/grants.ts:131,283`) - the tiers worked, the ACL just could not author them |
| `approval-delegations` | `approvalDelegations.delegatorId` (`src/services/approvalDelegations.ts:47`) | `self`, `all` | **Done.** Owned-coded; seed already uses `approval-delegations.me.**`. No `dept` tier: covering for somebody is a personal arrangement |
| `users` | `users.employeeId` (`src/services/users.ts:24`) | `self`, `all` | **Done**, with the flat code stated in the manifest note: `self` means the caller's own account, matched by the literal `me` token on `/v1/users/me` plus the owner column on the list, and deliberately does not reach another account by id |
| `background-checks` | `backgroundChecks.employeeId` (`src/services/backgroundChecks.ts:50`) | - | **Not done - belongs in A1b.** Flat-coded (no `allocCode` in its spec, so `crud.ts` defaults to `allocFlatCode`), so a `self`/`dept` chip would decide items as nothing. Sensitive and org-wide-only remains a real gap; the fix is the A1b one |
| `payroll-runs` | none (`payrollRuns.code` passed as owner, `src/services/payroll.ts:143`) | keep `all` | correctly org-level |

Adding a tier is safe by construction: the manifest's own comment says over-inclusion yields an inert
rule, never a hole (`src/domain/manifests.ts:162`).

**A1b. Owner column but flat code - the list lane and the item lane disagree.** `assets`
(`assets.assignedTo`, `src/services/assets.ts:210`) and `table-views` (`tableViews.ownerId`) have an
owner column, but their codes come from `allocFlatCode`, so they are single-segment and carry no
employee prefix. The consequence is asymmetric and worth naming precisely:

- the **list** lane can answer "own": `actorScope` falls through to `own` (`src/domain/access.ts:50`)
  and `applyScope` binds `eq(owner, ownerId)` (`src/services/listScope.ts:66`) - so a holder of the
  bare `assets` grant lists the assets assigned to them;
- the **item** lane cannot: `assets.me.**` asks `isUnder(callerCode, "0a")` on a flat code, which is
  false, so `GET /v1/assets/<id>` on a row the list just returned is a 403.

So "self" is meaningful for these collections only if either the codes move to `allocOwnedCode`
(a data migration + `codeCascade` entry) or the engine grows an owner-column match - the two options are
weighed per collection in [access-infra.md](access-infra.md) §1, and they are not equivalent: one of them
cannot work for `assets` at all. Declaring the tier
without doing one of those ships a chip that half works. This is the sharp edge behind the
`me-scope-needs-owned-codes` note, stated as a concrete list.

**A1c. Correctly org-level - leave as `all`.** The catalogues and org config: `leave-types`,
`holidays`, `pay-components`, `pay-grades`, `salary-structures`, `pay-periods`, `bank-formats`,
`reimbursement-categories`, `expense-categories`, `asset-categories`, `benefit-plans`, `shifts`,
`projects`, `letter-templates`, `letterheads`, `ticket-checklists`, `compliance-rules`, `automations`,
`settings`. A row here belongs to the company, not a person. (`settings` is already per-section
narrowable via `scope: exact` on the settings row - see `collectionMeta` note.)

That leaves a middle group that is neither catalogue nor employee-owned, covered below in A4.

### A2. Named-department scope: the engine has it, nothing offers it - DONE

Shipped as the **"One department"** chip. `named-dept` is a scope tier DERIVED from `dept` (a collection that
offers `dept` is department-coded, so it can be anchored to any department - `supportedScopesOf` /
`grantableScopes`), it brings its own department picker rather than needing an object on the page, and it is
stored as the `subtree` rule it already was. The three blockers named below are closed: the tier is offered,
the picker supplies the anchor (`anchorPath`, kept separate from the page's `objectPath` so a department grant
can never silently pin itself to whichever row the modal was opened on), and `resolveAnchor` recovers the
anchor for display without a schema change - total, because only `departments` and `employees` produce codes
anything nests under. `validateAccessRule` now refuses a cross-collection anchor on a collection that is not
department-coded, so the silent-no-op case cannot be authored.

`buildPattern` already turns `scope: "subtree"` + `scope_ref` into `<code>-*`
(`src/services/accessRules.ts:36-41`), `matchToken` already honours a `-*` prefix
(`src/domain/permissions.ts:97`), and `deriveNarrowing` already compiles it to a broad
`scope_kind: "subtree"` rule (`src/domain/compileGrants.ts:40`). `validateAccessRule` never requires
`scope_ref` to name the rule's own collection (`src/domain/policyValidate.ts:50`), so
`{collection: "leave-requests", scope: "subtree", scope_ref: "departments/<id>"}` is a valid body
**today** and produces `leave-requests.<deptCode>-*.**`, which the engine matches against every leave
request of that department (owned codes are `<dept>-<emp>-<leaf>`).

What blocks it:

1. `SUPPORTED_SCOPES` lists `subtree` only for `departments` (`src/domain/manifests.ts:203`), so
   `scopesForCollection` never offers the chip elsewhere.
2. The chip is gated on `hasObject` (`permMatrix.ts:118`), and the ambient object comes from the route
   (`RouteAccessScope`) - on the Leave page that is a leave request, never a department. There is no
   "pick the anchor object" affordance.
3. `withObjectRefs` resolves `_objectUuid` only for `scope_kind === "exact"`
   (`src/services/accessRules.ts:218`), and it looks the code up in the RULE's namespace - so a
   department-anchored subtree rule on `leave-requests` reads back with no object name at all.

This is the single highest-value item on the list. "HR for the Sales org", "finance approver for
Engineering", "a regional manager over three departments" are the most common real asks in an HRMS and
none of them is authorable, despite the decision engine being ready.

### A3. `subtree` scope is item-path only - lists ignore it - DONE

Shipped as an additive `ListScope.subtrees`, **not** the fourth breadth this section proposed. A caller can
hold `my-dept` AND another department's subtree at once, and a single enum forces a false choice between them;
`subtrees` ORs in exactly like `shares` (same `subtree()` binder, same GLOB index range scan) and adds nothing
at `all` breadth. `actorSubtrees` lifts candidate prefixes from the grant's own patterns and then CONFIRMS each
with the same `decide` probe `actorScope` uses, so the engine stays the sole authority and a deny over the
subtree drops it. `verbScopeFor` gained the same, with one subtlety: a subtree-only approver previously scoped
nothing, and now gets `own` breadth with a NULL owner - the empty breadth (`1 = 0`) - so the subtree carries
the whole predicate and the caller's own rows are not quietly added to a queue they may not act on.

**A related gap this exposed, also fixed.** A row-scoped grant does not, on its own, let anyone open the list
it scopes: the engine decides `GET /v1/leave-requests` on the one-token key `leave-requests.read`, which no
scoped pattern can match. So a narrow rule decided every item correctly and 403'd the page - and the client
could not warn either, because `capabilitiesOf` strips the scope, so the SPA believed the collection readable
and fired the request that failed. The seeded roles never hit it (each holds the bare collection grant beside
its scoped rules), which is why the narrow tiers looked broken rather than narrow. The ACL now authors that
pairing as its own visible, removable rule at READ, skipped when the subject already reaches the collection;
rules authored elsewhere get the `unlistable` lint.

Even where a subtree rule exists, it does not widen a list. Shares reaching `ListScope` come from
`loadObjectExceptionCodes`, which keeps only rows with a `matchCode`
(`src/lib/policyLoad.ts:184`) - and a subtree rule stores its prefix in `scope_code` with
`match_code` NULL (`src/domain/compileGrants.ts:54`). `actorScope` probes only three shapes: a code
under no dept, a sibling in the caller's own dept, else own (`src/domain/access.ts:46-52`). A
`<otherDept>-*` rule matches none of them, so breadth collapses to `own`.

Net effect: a subtree grant lets you open rows you cannot find. Fixing A2 without this is worse than
not fixing it.

The fix is a fourth breadth. `ListScope.breadth` becomes `"all" | "subtree" | "dept" | "own"` with a
`subtreeCodes: string[]`, `actorScope` returns the subtree prefixes it found (they are already on the
rule rows as `scope_code`), and `applyScope` binds them with the `subtree()` helper it already has
(`src/services/listScope.ts:47`) - the GLOB form, so it stays an index range scan. `verbScopeFor`
needs the same, or a subtree approver's badge counts nothing.

### A4. Scope dimensions the model has no vocabulary for

> Not built. The dimensions are surveyed below; the shape of the change - a wider `SelfContext`, new
> `matchToken` tokens, and a per-rule `condition` stage for the ones that are row predicates rather than code
> matches - is in [access-infra.md](access-infra.md) §6.

Every scope today is a function of the **code hierarchy**, which encodes exactly one relationship:
department nesting. These are the axes an HR platform needs that the code cannot express.

**Manager chain.** `my-dept` is used as a proxy for "my team" throughout the manager grant
(`src/domain/grants.ts:263-290`) and `deptOf` is a pure string operation on the code
(`src/domain/access.ts:78`). Wherever the reporting line diverges from the department tree - a matrix
org, a dotted line, a manager who owns people in two departments, a department with two managers -
the grant is wrong in both directions at once: it shows a manager peers they do not manage, and hides
reports who sit elsewhere. A `my-reports` token (direct) and `my-org` (transitive) matching against
`employees.manager` would be the honest primitive. It cannot be a pure `matchToken` addition, because
the manager chain is not in the code - it needs the caller's report set resolved at auth time
(one indexed read, cacheable per user like the grant itself) and carried on `SelfContext`.

**Location / legal entity / cost centre.** None exist as a scope. An org with two offices cannot grant
"attendance for the Pune site". Same shape as the manager chain: an attribute on `employees` that
would need to reach `SelfContext` and a matching token.

**Own department only, excluding sub-departments.** `my-dept` is `isUnder`, which includes the whole
subtree (`src/domain/codes.ts:57`). A team lead under a 200-person division gets the division.

**Employment type / status.** No way to say "read contractors only", or the far more common "read
active employees only, not leavers" - a leaver's record stays fully readable to anyone with the tier.

**Record state.** `STATE_VISIBILITY` exists and is a good primitive, but it has exactly one entry:
`announcements` (`src/domain/manifests.ts:221`). The obvious candidates - a draft payroll run, a
cancelled requisition, an offer in negotiation, a closed ticket - all rely on the collection grant
alone.

**Amount thresholds.** There is no approval limit anywhere in the codebase (grep for threshold finds
only budget alerts and tax slabs). `expenses.my-dept.approve` approves a ₹500 lunch and a ₹5,00,000
invoice identically. This is the most-requested control in expense/loan/reimbursement approval and the
model has no slot for it. It does not fit `matchToken` (it is a predicate on the row, not the code); it
fits a per-rule `condition` column evaluated after `decide()` allows, against fields the middleware
already resolves on the item path.

**Time window.** `expires_at` bounds when a rule is alive (`src/lib/policyLoad.ts`, `live`), but
nothing bounds which rows it reaches. "Read attendance for the current pay period" is not expressible.

**Network.** `ipAllow.ts` is real and strict, but it is a deploy var applied to the attendance clock
punch only. As a per-rule attribute ("this payroll grant only from the office range") it would be a
meaningful control for the most sensitive grants in the app.

### A5. Does `self` mean the same thing in both lanes? - checked, and mostly yes

The worry was structural: the grant matches on the CODE while the list binds an OWNER COLUMN, so wherever
the owner column is not the code's parent, one chip labelled "Own" would mean two disjoint row sets.

Checked against the allocation sites, and the cases named in the first draft of this document do NOT
diverge - each code is allocated under the same column its list binds:

- `transition-tasks` - `allocOwnedCode(..., transitionTasks.assigneeId, ...)`
  (`src/services/transitions.ts:75`) against `applyScope(..., transitionTasks.assigneeId)`
  (`src/services/transitionTasks.ts:18`). Both mean "assigned to me".
- `announcements` - `authorEmployeeId` on both sides; `review-feedback` / `interview-feedback` - `authorId`
  on both sides.

What remains is the flat-code case, which is A1b rather than a labelling problem: `assets` binds
`assignedTo` on the list and carries a single-segment code, so `own` works for the list while
`assets.me.**` matches no item. It has no `self` tier today, so no chip currently lies about it - that
asymmetry is precisely why one cannot simply be added.

If a genuine divergence does appear, the mechanism to describe it already exists: `SCOPE_LABEL_OVERRIDES`
(`permMatrix.ts`), already used to relabel `tickets` as "Raised by me".

### A6. Field-level scope reaches three collections - DONE

`policy.redacted_fields` adds a READ gate for base-record fields, applied in `withAccess` - the one place
every serialized resource passes - so no collection has to remember it. Each listed field is decided at
`<collection>.<code>.<field>` read and DROPPED from the payload (not nulled: an absent key reads as "not
provided", where `null` would be indistinguishable from a real empty value).

The design point is that listing a field is **additive**, which is what makes the list safe to grow. A
pattern's `**` matches trailing tokens, so `offers.**` and `leave-requests.my-dept.**` already satisfy the
field key and nobody loses a field by it being listed. What the entry BUYS is the ability to take one away:
a deny on `offers.*.base_comp.**` removes exactly that field from exactly those callers, scoped like any
other pattern. Same subtractive shape as the delete axis in A8.

Shipped for `offers.base_comp`, `candidates.{email,phone,notes}`, `leave-requests.reason` and
`tickets.description`. `reviews` was considered and left out: its manager comments and ratings are already
withheld by the review's own state machine, and two mechanisms over one field is two places deciding one
question. The Recruiter role template uses this deny, so the feature has a caller, not just a manifest entry.

### A6 (original survey)

`isFieldScopeTarget` accepts a field only if it is a declared protected field or a field-bearing
sub-resource (`src/domain/manifests.ts:64-71`), and `PROTECTED_FIELDS` has three entries: `users`,
`employees`, `compensation` (`src/domain/manifests.ts:44-48`). `SUBRESOURCE_BODY` adds four:
`identity`, `bank-account`, `personal-info`, `tax`.

Everything else is all-or-nothing at the row. Candidates with a clear reason to be field-scoped:

- `offers.salary` / `offers.equity` - a recruiter coordinating interviews should not see the number;
- `candidates` contact details - the hiring panel needs the CV, not the phone number;
- `reviews` rating vs narrative - calibration wants ratings, a peer reviewer should not see the rest;
- `leave-requests.reason` and its attachment - a sick note is medical data behind a plain `read`;
- `expenses` / `reimbursements` amount vs description for a categorising clerk;
- `employees.date_of_birth`, `marital_status` - PII sitting on the base record rather than behind
  `personal-info`.

The mechanism needs no engine change - `bodyDecision` already gates writes per field and
`http/fieldAccess.ts` already redacts reads per field. What is missing is declaring more fields and
extending the read-redaction call sites beyond the four sub-resources.

### A7. Virtual capabilities are booleans; `activity` shows the fix - DONE (export, unmask)

`COLLECTION_FIELD_CAPABILITIES` (`manifests.ts`) now declares the capabilities whose field slot names a target
COLLECTION - `activity` and `export` - and `isFieldScopeTarget` validates that slot against `COLLECTIONS` for
them. That both fixes the `activity` defect in the status note above and gives `export` the same axis:
`canExport(caps, collection)` mirrors `canSeeActivity`, and every DataTable passes its own collection, so
`export.<collection>.read` lights up one table while the broad `export.read` still covers all. The custom-grid
builder deliberately keeps the broad requirement - one grid draws columns from several collections, so no
single one stands for what the file would hold.

`unmask` is field-scoped the ordinary way instead of via the collection slot, because its meaningful unit is a
FIELD: `unmaskGate` decides `unmask.*.<subresource>.<key>` per field (memoised per run), so payroll can read
account numbers for a bank file without also reading everyone's statutory ids. The sensitive-run audit row now
names WHICH fields came back unmasked rather than carrying one boolean, which would have said
"unmasked: true" for a run that revealed an account number and masked every id.

`timeline` and `tax-verifications` are still all-or-nothing; both now at least appear in the matrix (B2).

`activity` is scoped AND collection-filtered by riding the collection name in the field slot -
`activity.<scope>.<collection>` (`src/domain/manifests.ts:207-210`). None of its siblings do:

| Capability | Today | Proposed |
|---|---|---|
| `export` | one app-wide switch; `collectionMeta` says so in as many words | `export.<scope>.<collection>` - "may export leave data, not payroll" |
| `unmask` | app-wide; turns every masked PAN/account real (`src/http/tableFieldAccess.ts:45`) | per-field at least (`unmask.*.identity.pan`), per-scope ideally |
| `timeline` | app-wide widget gate | `dept` tier |
| `tax-verifications` | app-wide queue | `dept` tier |
| `batch` | app-wide (correct - it grants no data) | leave |

`export` and `unmask` are the two that matter: both are the difference between "can read their team's
records one at a time" and "can walk out with the file".

### A8. The level ladder cannot separate delete from write - DONE

Done SUBTRACTIVELY rather than by adding a rung or moving DELETE onto the custom lane - both of those
re-decide every grant that exists today, and the repo's oracles for that could not be run here (see the note
at the end). `denyingPattern` exposes the deny lane on its own (the same loop `decide` already runs first),
and the middleware asks it one extra question on a DELETE: is the `delete` verb (or `purge`, for `?force`)
denied for this resource? If so the request is refused. Nothing is granted that was not granted before, no
role needs a verb it did not need, and the standard lane is untouched - so "may edit, may never delete" is now
one deny, scoped like any other pattern (`goals.07-*.delete` takes deletion away in one department only).
`computeCan` mirrors it so a row never offers a Delete button that would 403.

`levelFor` maps `DELETE` to `write` and `DELETE ?force` to `admin`
(`src/domain/permissions.ts:14-18`). So there is no way to grant "edit but never delete" - the single
most common request after read-only. A fourth rung, or a `delete` verb in the `allow` lane (verbs have
no ladder, which is exactly the property wanted here), would cover it. The verb route is cheaper:
`ACCESS_VERBS` already lists `delete` for most collections (`src/http/accessHint.ts:22+`), so the
affordance exists; it is `levelFor` that pre-empts it.

### A9. Announcement audience is a notification target - and the app already says so. WITHDRAWN

`audience_scope: "everyone" | "department" | "none"` decides who gets **notified**
(`src/services/announcements.ts:62-68`); reading stays `announcements.**` for every role via `COMMON_READ`.
The concern was that the UI might imply the audience limits visibility. It does not - it says the opposite,
in both places a person meets it:

- the composer's field is labelled "Audience - who gets a notification", with the info text "It is not access
  control: the post sits on the board for everyone who can read the board, whichever audience you pick"
  (`web/src/components/common/PostComposer.tsx`);
- the card's audience chip is tooltipped "Only <dept> was notified about this. It is not restricted - anyone
  who can see the board can read it" (`web/src/pages/Announcements.tsx`).

The code even records WHY it is not a permission: "a second quiet access system in a content field is how a
'private' post gets read by everyone." Binding visibility to the audience would contradict a deliberate
decision, not fix an oversight. Withdrawn. If per-audience visibility is ever genuinely wanted, it belongs in
the ACL as an ordinary rule, not in a content field.

---

## Part B - presets, QOL and UX

The access UI is already well past the basics (`docs/access-ui.md`): in-context key icons, a preview
endpoint, view-as, four-eyes, expiry, impact warnings, rule lint, clone, import/export, a permission
feed, and request-access. What follows are gaps in that, not a re-listing of it.

### B1. `kudos` is a dead row in the permissions matrix (a bug) - DONE

`BASE_COLLECTIONS` and `collectionMeta` both carry `kudos`
(`web/src/components/access/permMatrix.ts:44`, `collectionMeta.ts:71`), but `kudos` is not in
`COLLECTIONS` - kudos were folded into `announcements` with `kind="kudos"`. `validateAccessRule`
rejects an unknown collection with a 400 (`src/domain/policyValidate.ts:48`), so every cell in that
matrix row errors.

Removed, from `BASE_COLLECTIONS` and from `collectionMeta`. The gate that would have caught it is now in
`test/collections.test.ts`: every name in the matrix must be a member of `COLLECTIONS`. The converse is
deliberately NOT asserted - `COLLECTIONS` legitimately holds plumbing no admin should be offered a row for,
so absence from the matrix is a product decision while presence without a backing collection is a defect.

### B2. 23 grantable collections never appear in the matrix - DONE

`COLLECTIONS` has 101 entries, `BASE_COLLECTIONS` 79. Missing:

```
api-keys, positions, settlements, goal-templates, notifications, cron-runs, event-log,
automation-runs, workflow-instances, workflow-meta, esign-providers, preferences,
payroll-debit-accounts, roles, policy, access-rules, timeline, batch, tax-verifications,
table-views, table-fields, unmask, audit
```

Some are deliberately invisible plumbing (`batch`, `preferences`, `event-log`). But `api-keys`,
`positions`, `settlements`, `payroll-debit-accounts`, `table-views`, `unmask`, `timeline`,
`tax-verifications`, `roles`, `policy` and `access-rules` are all things an admin has a legitimate
reason to grant, and the only route to them is an already-existing rule (`collectionsForRules`,
`permMatrix.ts:70`) or the API. Worse, `positions` and `settlements` have `SUPPORTED_SCOPES` entries -
declared tiers for rows nobody can author.

Done: a **Platform & security** group now carries `access-rules`, `roles`, `policy`, `api-keys`, `audit`,
`notifications` and `table-views`; `positions` joined People & org, `settlements` and
`payroll-debit-accounts` joined Payroll, `goal-templates` joined Performance, and `unmask`, `timeline` and
`tax-verifications` joined Capabilities. Each got a `collectionMeta` entry, because these are exactly the
resources where "what does granting this actually do?" has a non-obvious answer (an API key acts AS its
owner; `roles` is the catalog, not the authority; `access-rules` write is effectively the keys to the
workspace). The remaining omissions are the plumbing - `batch`, `preferences`, `event-log`, `cron-runs`,
`workflow-*`, `esign-providers`, `table-fields` - left out on purpose.

### B3. A new role starts at deny-all, and there are no starter packs - DONE

Six templates (`web/src/components/access/roleTemplates.ts`): Recruiter, Auditor, Team lead, IT/asset
manager, Benefits administrator, Front desk. Each is a named bundle of rule BODIES replayed through the
ordinary `POST /v1/access-rules` create path exactly as the JSON import does - so every rule is validated,
audited, and queued behind four-eyes if it is on, and a template can never author something an admin could
not write by hand. Deliberately no server-side template resource: that would be a second way to author
authority, and the value here is the curation.

Each bundle pairs every row-scoped rule with the collection gate that lets its page be OPENED (the A3 trap),
and `test/roleTemplates.test.ts` runs the real validator over every rule of every template plus that pairing -
a template whose rules are rejected one at a time is worse than none, because the admin is left with half a
role and no idea which half.

Templates apply to a PERSON as well as a role, which is also this app's answer to B4 short of a join table:
the engine already unions role, `everyone` and the user's own rules, so a team lead who also runs the asset
register is `team_lead` plus the IT template applied to them. The trade is that their copy does not follow
the template afterwards - stated in the file and in the dialog rather than left to be discovered.

### B3 (original survey)

`createRole` writes no rules (`src/services/roles.ts:35`). Building a "Recruiter" means authoring
rules across `job-requisitions`, `candidates`, `applications`, `interviews`, `offers`, `referrals`
one at a time, or cloning `hr_admin` and subtracting - which is the wrong direction for least
privilege. `:clone` exists but only copies an existing role.

Proposal: **role templates** as seed data - a named bundle of `AccessRuleInput` bodies replayed through
the normal create path (same validation, same four-eyes queue, same audit, exactly as import already
does). Candidates that fall straight out of the module groups: Recruiter, Finance/AP clerk, IT asset
manager, Team lead (self + reports), Auditor (read-only across the org, no unmask, no export),
Front-desk/attendance, Benefits administrator. Presets today exist only for the `everyone` bundles on a
single collection (`docs/access-ui.md`, "Presets"); this is the same idea one level up.

### B4. One role per user

> Partly covered by B3 (a template applies to a PERSON, and the engine already unions role + `everyone` +
> user rules), with one difference that remains: a copy does not follow the template afterwards. The real
> join-table change is specified in [access-infra.md](access-infra.md) §4.

`users.role` is a single text FK (`src/db/schema.ts:57`). Someone who is both a team lead and the
office's asset manager needs a bespoke composite role or a pile of user rules. The engine would not
mind more - `loadUserGrant` already merges a user grant onto a role grant via `mergeGrants`
(`docs/authz.md` §9), and `everyone` is already unioned in, so union semantics are established. A
`user_roles` join table merging N role grants the same way is a contained change; the compiled store
needs nothing new.

### B5. Generalize the materialized-ACL pattern

> Not built. Per-feature fan-out judgement and the boards caveat are in
> [access-infra.md](access-infra.md) §5.

`ticketShares.ts` solves attribute-based visibility with no engine change: when a ticket's category
changes, it writes per-object `access_rules` rows for that category's viewers, marked
`source: "ticket-share"` so a revoke can tell its own rows from hand-authored ones
(`src/services/ticketShares.ts:1-45`, `schema.ts` `source` column). That is the right pattern and it is
used once.

The same shape covers, with only a new `source` value each:

- **project membership** → time-entries and cards of that project;
- **board membership** → the board and its cards (today `boards.**`/`cards.**` are org-wide for every
  employee, `src/domain/grants.ts:81-88` - a deliberate call for collaboration, but it means every
  employee reads every team's board);
- **hiring team on a requisition** → its applications, interviews, feedback;
- **review calibration committee** → the reviews in that cycle;
- **transition assignees** → the subject's transition record.

Caveat worth stating up front: it is one row per (object × viewer), so it suits bounded fan-out
(a ticket's category viewers) and not high-volume collections (`attendance`, `notifications`). For
those the answer is A2/A3, not materialization.

### B6. Nothing surfaces unused or over-broad rules

> Not built, and the last line of this section was wrong: it DOES need new storage. `authorized_by` lives
> inside the audit row's JSON `meta`, so rolling it up means matching inside JSON across a table that grows
> with every action - the scan `docs/authz.md` §12.2 rules out. The counter that makes the report affordable
> is specified in [access-infra.md](access-infra.md) §3.

`decide()` returns `via` - the pattern that authorized the request - and `audit` stamps it as
`authorized_by` in the meta of every audited action (`src/lib/audit.ts:480-482`). That is the raw
material for the two questions an access review actually asks, and neither is asked today:

- **"Which rules have never authorized anything?"** Roll `authorized_by` up per pattern over 90 days
  and flag the rules with zero hits. (Caveat: routine reads are not audited by design - volume - so
  this reads as "no writes and no sensitive reads", which is still the right first cut.)
- **"Which org-wide rules could be narrower?"** For a rule at `all` on a collection that supports
  `self`/`dept`, compare the holder's actual `authorized_by` hits against what a narrower rule would
  have covered. "This rule is org-wide; in 90 days its holders only ever touched their own department"
  is a recommendation an admin can act on in one click.

Both fit the existing Settings → Permissions surface next to the pending queue - once the rollup above
exists to read from.

### B7. Periodic recertification - DONE

`reviewStandingAccess`, a nightly cron job that no-ops unless the org opts in (`access-review` settings
blob, toggled beside four-eyes in the permissions panel) and unless the cadence is due. It names the
**standing** privileges - permanent, active, write-or-better or a custom method, excluding `everyone`'s
self-service baseline - and points at the screen where they are already removable.

Deliberately a digest and NOT a new attestation resource: the decision an admin makes is to keep a rule or
delete it, both of which the existing surface does and audits, and a parallel record of "confirmed on this
date" would be a second source of truth about access that nothing enforces. Due-ness is stored on the
setting, so a skipped tick runs late rather than being missed - the same reasoning that makes the expiry
sweep hygiene rather than the enforcement mechanism.

### B8. Break-glass elevation - DONE (as composition, which is what it was)

`requestAccess` already carried a `note` and notified the admins. Two things were missing and are now there:

- **a duration.** The request takes optional `hours` (capped at a fortnight - past that it is not
  break-glass, it is a grant, and should be authored as one), carried into the notification so the admin
  knows to set a matching expiry. It grants nothing by itself; the expiry mechanism is the existing one.
- **an audit row.** A request left NO trace - only a notification. If every admin ignored or cleared it,
  nothing anywhere recorded that the ask had been made. It now writes `access-request.raised` with the
  collection, the verb, the hours and the reason, because "why did this person get payroll write in March"
  is the question a reviewer actually asks and the answer only ever lived in a notification body.

The `NoAccess` wall collects both, so the ask carries its own context instead of starting a side conversation.

### B9. The employee-facing inverse view - DONE

`POST /v1/employees/{id}:viewers` (`services/myViewers.ts`) reports who can currently read the caller's own
record and each of its sensitive sub-resources, rendered as a **Privacy** tab on the profile.

It is `previewAccess` with the target NAILED to the caller's own employee id - the path id never chooses
whose record is graded - which is the whole security argument for giving the verb to everybody
(`employees.me.viewers`, held by every role for themselves). A person being able to find out who reads their
bank details is the feature, so it is deliberately not an admin affordance, and `test/webAccessCoverage.test.ts`
records that as its one allow-listed exception rather than leaving it to look like an oversight. Where the
org outruns one page of subjects the response says the list is a sample - a trust feature that
under-reports who can see your bank details would be worse than none.

### B10. Scope chips carry no consequence preview

> Not built. "The count is one scoped `count(*)`" below understates it - there is no endpoint that returns
> one, keyset pagination carries no total, and `self`/`dept` have no single well-defined number to show.
> See [access-infra.md](access-infra.md) §2.

The modal names the target and the scope, and warns about denies and impact on removal
(`docs/access-ui.md`). What it does not say is how much a scope choice actually covers: "All = 214
employees; Department = 12". The count is one scoped `count(*)` against the same `applyScope` predicate
the list would bind. Choosing between "Own", "Department" and "All" with the blast radius on the chip
is the single cheapest nudge toward least privilege in the whole UI.

---

## Order

Done, in this order: **A1a → B1/B2 → A3 → A2 → A7 → A8 → A6 → B3 → B9 → B8 → B7**. A3 before A2
deliberately - reversed, the department anchor would have shipped deciding items and listing nothing.

What is left all needs structural change - a code migration, a new column, a join table, a rollup counter, a
count endpoint, a wider `SelfContext` - so it lives in **[access-infra.md](access-infra.md)**, which carries
the shape of each and the order I would take them:

1. **A1b** - flat codes with an owner column. The prerequisite for several A1a-shaped wins, and the reason
   `background-checks` did not get its tiers here.
2. **B10** - blast radius on the scope chips.
3. **B6** - unused / over-broad rule reports.
4. **B4** - real multi-role.
5. **B5** - generalising the materialized-ACL pattern.
6. **A4** - the missing scope dimensions.
