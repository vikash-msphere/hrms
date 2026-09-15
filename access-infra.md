# Access control: the infrastructure-dependent work

Each needs a structural change - a code migration, a wider `SelfContext`, a join table, a new column, a rollup
counter, a new endpoint - and each therefore wants the test suite runnable and its own review.

Ordered by value per unit of risk, not by size.

---

## 1. A1b - flat codes with an owner column

**The defect.** Four collections carry an employee owner COLUMN and a FLAT, single-segment code, so the two
lanes of the same grant disagree:

| Collection | Owner column | Code |
|---|---|---|
| `assets` | `assets.assignedTo` (`src/services/assets.ts:210`) | `allocFlatCodes` |
| `background-checks` | `backgroundChecks.employeeId` (`src/services/backgroundChecks.ts:50`) | `crud.ts` default `allocFlatCode` |
| `users` | `users.employeeId` (`src/services/users.ts:24`) | `allocFlatCode` (`middleware/auth.ts:305`) |
| `table-views` | `tableViews.ownerId` (`src/services/tableViews.ts:132`) | `allocFlatCode` |

- The **list** lane answers "own" fine: `actorScope` falls through to `own` (`domain/access.ts`) and
  `applyScope` binds `eq(owner, ownerId)` (`services/listScope.ts`).
- The **item** lane cannot: `assets.me.**` asks `isUnder(callerCode, "0a")` against a flat code, which is
  false. So `GET /v1/assets/<id>` 403s on a row the list just returned.

This is why `background-checks` did NOT get the `self`/`dept` tiers the rest of A1a got, even though it is
employee-owned and sensitive: the chip would have been half-working, which is worse than absent.

**Two ways out, and they are not equivalent.**

*(a) Move the codes to `allocOwnedCode`.* Correct for `background-checks` and `table-views`, whose owner is
fixed at create (or re-pointed rarely, through a path `codeCascade` already handles). It needs the spec's
`allocCode`, a `codeCascade` entry so a re-point moves the subtree, and - because codes are generated -
a regenerated seed. Under the repo's one-migration rule the schema itself does not change, so this is a data
shape change rather than a migration.

Wrong for `assets`: custody moves over an asset's life (`assignedTo` changes on every hand-over), and a code
is immutable by design. An owned code would either lie after the first transfer or force a cascade on every
one of them.

Wrong for `users`: `employeeId` is nullable (service and admin accounts have no employee), so the collection
cannot be uniformly owned-coded at all.

*(b) Teach the item lane to match an owner column.* The general fix, and the only one that helps `assets`.
The middleware already resolves `uuid -> code` for the path id; it would additionally resolve the row's owner
code and carry it on the `Resolved`, so `matchToken`'s `me` / `my-dept` can consult it when the row's own
code is not owner-derived.

**Why it is here and not done:** (b) is a change to `decide()`'s matching semantics - the BOLA-critical core.
Its oracles (`test/bola.test.ts`, `test/grantReach.test.ts`, `test/compileGrants.test.ts`,
`test/keyScope.test.ts`) are exactly what must run before and after, and they could not be run in the
sandbox this work was done in.

**Suggested split:** do (a) for `background-checks` and `table-views` first - contained, and it closes the
sensitive collection. Treat (b) as its own piece with `assets` as the motivating case.

---

## 2. B10 - blast radius on the scope chips

**The idea.** The ACL modal names the target and the scope and warns about denies, but never says how much a
scope choice actually covers. "All = 214 · Department = 12" on the chips is the cheapest nudge toward least
privilege in the whole UI.

**Why it needs infrastructure.** There is no count to read:

- pagination is keyset and returns no total (`http/pagination.ts`), so no list response carries one;
- `POST /v1/access-rules:preview` answers "how many PEOPLE can do this", which is a different question from
  "how many RECORDS does this scope reach".

**Shape.** A scoped `count(*)` endpoint that binds the same `applyScope` predicate a list would, fetched
on demand - only when the scope box is open - because a count per chip per modal open is exactly the eager
read the D1 budget forbids.

**A design point worth settling before building it:** the tiers do not all have a well-defined number.
`all` and `named-dept` do. `self` and `dept` are subject-RELATIVE - they mean something different for every
holder of the rule - so they should keep saying what they mean in words rather than showing a figure computed
against whoever happens to be authoring the rule. A fabricated number here would be worse than none.

---

## 3. B6 - unused and over-broad rule reports

**The idea.** Two questions an access review actually asks, neither of which anything answers today:

- *Which rules have never authorized anything?* Roll `authorized_by` up per pattern over 90 days and flag
  the zero-hit rules. (Routine reads are deliberately not audited, so this reads as "no writes and no
  sensitive reads" - still the right first cut.)
- *Which org-wide rules could be narrower?* For a rule at `all` on a collection that supports `self`/`dept`,
  compare its holders' actual hits against what a narrower rule would have covered. "This rule is org-wide;
  in 90 days its holders only ever touched their own department" is a recommendation an admin can act on.

**The data already exists.** `decide()` returns `via` - the pattern that authorized the request - and `audit`
stamps it as `authorized_by` in the meta of every audited action (`lib/audit.ts`).

**Why it needs infrastructure.** The original note said "neither needs new storage". That was wrong.
`authorized_by` lives inside the audit row's JSON `meta` column, so rolling it up means matching inside JSON
across the whole table - a scan, which is precisely what `docs/authz.md` §12.2 rules out ("D1 bills rows read
and `LIKE '%q%'` cannot use an index"). On a table that grows with every action in the app, the report would
cost more each month it ran.

**Shape.** A counter per pattern, written where the audit row is written (same statement, so no extra round
trip): `rule_usage(pattern, last_used_at, hits)` keyed by pattern, upserted on each audited allow. The report
then reads a small indexed table instead of scanning a large one. Decide at design time whether the counter
is per pattern or per rule id - the pattern is what `via` carries, and several rules can compile to one
pattern, so "which RULE is unused" needs either the id threaded through `decide()` or the report to answer at
pattern granularity and say so.

---

## 4. B4 - real multi-role

**The gap.** `users.role` is a single text FK (`src/db/schema.ts:57`). Someone who is both a team lead and
the office's asset manager needs a bespoke composite role.

**What already covers the practical case.** The engine unions role rules, `everyone` rules and the user's OWN
rules into one grant (`loadUserGrant` -> `mergeGrants`), and role templates can now be applied to a PERSON
(B3), so a team lead who also runs the asset register is `team_lead` plus the IT template applied to them
directly. The difference that remains is real but narrower than it looks: **their copy does not follow the
template afterwards.** Change the asset-manager bundle and every person who was seeded from it keeps the old
rules.

**Shape of the real thing.**

- a `user_roles` join table (user uuid, role name), with `users.role` kept as the PRIMARY role - it is what
  `actor_role` records point-in-time on every audit row, what view-as swaps, and what the UI labels people
  by, so removing it is a much larger change than adding the table;
- `middleware/auth.ts` loads the extra roles and merges their grants (union semantics are already
  established - `mergeGrants` does exactly this for `everyone`);
- the grant cache key stops being per-role for these callers: the merged result is per USER, so it belongs
  under the `userGrant:` band rather than `grant:<role>`;
- `roleSubjects` in `middleware/authz.ts` (and the three fan-out helpers that build the same list) widens
  from `[role, EVERYONE_ROLE]` to every held role, or per-object role rules silently stop applying;
- `services/roles.ts` delete guard widens: a role is undeletable while ANY user holds it, which is currently
  an FK RESTRICT on one column;
- the role picker becomes multi-select, and the serializer grows a `roles` array.

**Why it is here:** schema plus the auth hot path, and the cache-key change is the kind that is correct in
every test and wrong under concurrency. Worth doing with the suite runnable.

---

## 5. B5 - generalise the materialized-ACL pattern

**The precedent.** `services/ticketShares.ts` solves attribute-based visibility with no engine change: when a
ticket's category changes it writes per-object `access_rules` rows for that category's viewers, marked
`source: "ticket-share"` so a revoke can tell its own rows from hand-authored ones (the `source` column in
`db/schema.ts`). It is the right pattern and it is used exactly once.

**Candidates, one new `source` value each:**

- **project membership** -> the time-entries and cards of that project;
- **board membership** -> the board and its cards;
- **hiring team on a requisition** -> its applications, interviews and feedback;
- **review calibration committee** -> the reviews in that cycle;
- **transition assignees** -> the subject's transition record.

**Why it needs its own judgement per feature, not one sweep.**

- It is one row per (object x viewer). That suits bounded fan-out - a ticket's category viewers - and not
  high-volume collections (`attendance`, `notifications`), where the answer is the scope work (A2/A3), not
  materialization.
- Boards are org-wide **on purpose** today: `boards.**` / `cards.**` are granted to everyone in `OWN_WORK`
  (`domain/grants.ts`), with the reasoning written down - "a column that shows only the cards assigned to the
  reader is a private to-do list, not a board". Narrowing boards to membership is a product decision about
  how collaborative the tool is, not a security fix, and should be argued as one.
- Every writer needs the same care `ticketShares` took: rows it did not author must be untouchable, or a
  routine membership change silently deletes a hand-authored grant at whatever level it granted.

---

## 6. A4 - the scope dimensions the model has no vocabulary for

The largest piece, and the one that changes the engine's inputs rather than its data. Every scope today is a
function of the **code hierarchy**, which encodes exactly one relationship: department nesting.

**Manager chain.** `my-dept` is used as a proxy for "my team" throughout the manager grant, and `deptOf` is a
string operation on the code. Wherever the reporting line diverges from the department tree - a matrix org, a
dotted line, a manager who owns people in two departments, a department with two managers - the grant is
wrong in both directions at once: it shows a manager peers they do not manage, and hides reports who sit
elsewhere. A `my-reports` token (direct) and `my-org` (transitive) matching against `employees.manager` is
the honest primitive. It cannot be a pure `matchToken` addition: the manager chain is not in the code, so it
needs the caller's report set resolved at auth time (one indexed read, cacheable per user like the grant) and
carried on `SelfContext`.

**Location / legal entity / cost centre.** None exist as a scope; an org with two offices cannot grant
"attendance for the Pune site". Same shape as the manager chain - an `employees` attribute that has to reach
`SelfContext` plus a matching token.

**Own department only, excluding sub-departments.** `my-dept` is `isUnder`, which includes the whole subtree,
so a team lead under a 200-person division gets the division.

**Employment type / status.** No way to say "read active employees only, not leavers" - a leaver's record
stays fully readable to anyone holding the tier.

**Record state.** `STATE_VISIBILITY` is a good primitive with exactly one entry (`announcements`). A draft
payroll run, a cancelled requisition, an offer in negotiation and a closed ticket all rely on the collection
grant alone.

**Amount thresholds.** There is no approval limit anywhere in the codebase. `expenses.my-dept.approve`
approves a ₹500 lunch and a ₹5,00,000 invoice identically - the most-requested control in expense, loan and
reimbursement approval, and the model has no slot for it. It does NOT fit `matchToken`, being a predicate on
the row rather than on the code; it fits a per-rule `condition` column evaluated after `decide()` allows,
against fields the middleware has already resolved on the item path.

**Time window.** `expires_at` bounds when a rule is ALIVE; nothing bounds which rows it reaches. "Read
attendance for the current pay period" is not expressible.

**Network.** `lib/ipAllow.ts` is real and strict but is a deploy var applied to the attendance clock punch
only. As a per-rule attribute ("this payroll grant only from the office range") it would be a meaningful
control on the most sensitive grants in the app.

**Why it is last:** `SelfContext` grows, the auth read grows, `matchToken` gains tokens, and the per-rule
`condition` idea is a second evaluation stage next to `decide()`. It is several pieces of work wearing one
heading, and each of them touches the decider.

---

## What holds across all six

- **The engine stays the sole authority.** Every item above either feeds `decide()` better inputs
  (A1b, A4) or reports on what it decided (B6, B10); none of them should introduce a second place where
  access is decided. `test/singleSource.test.ts` is the gate that keeps that true.
- **Fail closed, and prove it.** Each of these has a natural failure direction that leaks - an owner match
  that resolves to null, a merged grant that unions too much, a condition column that is absent rather than
  false. The existing oracles encode that discipline; extend them rather than writing new assertions beside
  them.
- **Run the suite.** All six touch code paths the BOLA oracles cover. `npm test` must be runnable and green
  before and after each.
