# Pre-production review — new findings (sixth pass)

Continuation of [defects.md](defects.md), which holds findings 1–24. Numbering continues from there. Same
rules: no gates run, every claim traced to the file and line that proves it.

- [27](#27) **`review-cycles:variablePay` publishes a protected compensation field to a role with no compensation grant** — live
- [25](#25) Money inputs are unbounded, and a float overflow makes `round2` answer 0 silently
- [28](#28) `employees:upcomingCelebrations` reads the whole employee table and decrypts a PII blob per row, uncached, per dashboard load — and broadcasts a disabled employee's birthday
- [26](#26) `audienceEmployeeIds` promises "(active)" and one of its three arms does not filter
- [27a](#27a-the-same-gap-latent-in-the-file-that-documents-the-rule) The same ungated-source gap, latent, in `letterData.ts`
- [Corroboration for #22](#corroboration-for-22-defectsmd-a-fourth-registry-agrees-and-it-is-the-storage-pair-that-does-not) — a fourth registry agrees; the on-disk cache is the one that does not

---

## 25. Money inputs are unbounded, and a float overflow makes `round2` answer 0 — silently

**Files:** `src/routes/loans.ts:13-17` (the one input that was bounded, and why),
`src/domain/money.ts:34-44`, `src/services/expenseBudgets.ts:104-119`, `src/domain/expenses.ts:53-55`,
plus the schemas listed below.

`routes/loans.ts` identified this hazard and fixed it for loans, with the reasoning written out:

> A bare `z.number()` accepts 1e9 installments, and the EMI is `principal / installments` put through … and
> `.finite()` because `z.number()` admits Infinity (JSON cannot carry it, but a non-JSON caller can) …

It is the only money input in the app that got the treatment (`z.number().finite().positive().max(1_000_000_000)`).
Every other one kept the bare form — no upper bound, no `.finite()`:

```
routes/expenses.ts:24         amount: z.number().positive()            <- employee-writable
routes/expenses.ts:27         tax_amount: z.number().nonnegative()     <- employee-writable
routes/reimbursements.ts:20   amount: z.number().positive()            <- employee-writable
routes/leaveEncashments.ts:17 days: z.number().positive()              <- employee-writable
routes/bonuses.ts:17,31       amount: z.number().positive()
routes/expenseBudgets.ts:11   amount: z.number().positive()
routes/compensation.ts:19,20  annual_ctc / variable_pay_target
routes/offers.ts:16           base_comp: z.number().nullable()
routes/payGrades.ts:9-11      band_min / band_mid / band_max
routes/benefitPlans.ts:11,12  employee_cost / employer_cost
```

`1e308` is a perfectly ordinary JSON number and passes `.positive()`. It also **stores**: `round2(1e308)`
falls through its own guard (`Number("1e308e2")` is NaN) to `Math.round(n)` and returns `1e308` unchanged.

The damage is not the one huge row — it is the next aggregate over it. Verified against the real helpers:

```
round2(1e308)            -> 1e+308      (stored as given)
round2(Infinity)         -> 0
sum2([1e308, 1e308])     -> 0
sum2([1e308, 5000])      -> 1e+308      (the 5000 is simply gone)
```

`domain/money.ts`'s own header names this as the failure mode it exists to prevent — *"a money helper whose
failure mode is 'returns zero without saying so' is the exact shape this function exists to prevent"* — and the
comment fixes the `5e20` case. The **overflow** case still does exactly that, and every money total in the app
is a `sum2` or a `round2` over a plain `+=`.

**Worked example, traced end to end** (`services/expenseBudgets.ts#computeBudgetSpendMany`):

```ts
if (r.state === "SUBMITTED") pending += r.amount ?? 0;   // plain float accumulation
else spent += r.amount ?? 0;
...
out.set(key(b), { spent: round2(spent), pending: round2(pending) });   // Infinity -> 0
```

`STATES_CHARGED = ["SUBMITTED", "APPROVED", "PAID"]`, so a **SUBMITTED** expense charges `pending` with no
approver involved. Two submissions of `1e308` against one department/period overflow the accumulator, and
`budgetUtilization` then reports `pending: 0`, `spent: round2(spent)`, `remaining: the full cap`,
`utilization: 0`. The budget page reads as untouched and `checkBudgetThresholds` never fires. The `spent` side
needs an approver to pass an absurd figure, which is a real gate — the `pending` side has none.

The same accumulate-then-`round2` shape is in `domain/payroll.ts#computeRunItem` (gross / taxableGross /
totalDeductions), `domain/settlement.ts` (`sum2` over the line list) and every run total.

**Fix:** bound the inputs the way `loans` already does — `.finite()` plus a sane `.max()` on every money and
day field (a shared `money()`/`days()` zod helper, so the next one cannot be written bare). And make `round2`
say so rather than returning 0 on a non-finite input: at that magnitude nothing legitimate is being rounded, so
throwing is the honest answer and matches what `monthlyTds` already does (*"an arrival is worth a throw rather
than a zero"*).

---

## 26. `audienceEmployeeIds` promises "(active)" and one of its three arms does not filter

**Files:** `src/services/notifications.ts:270-285`, `src/services/emailFanOut.ts:76-84`

```ts
// Resolve an audience to the (active) employee uuids it targets.
export async function audienceEmployeeIds(deps: Deps, audience: Audience): Promise<string[]> {
  if (audience.kind === "none")      return [];
  if (audience.kind === "everyone")  return activeEmployeeIds(deps);              // LIVE_EMPLOYEE
  if (audience.kind === "employees") return audience.employees.map(bareId);       // <- no filter at all
  // department: ... .where(and(eq(departmentId, ...), ...LIVE_EMPLOYEE));        // LIVE_EMPLOYEE
}
```

`LIVE_EMPLOYEE` is `status = "active"` AND `delete_time IS NULL` AND `disabled = false`, and the comment above
it explains why all three are needed and notes this roster was *"the outlier, and the broadcast one"*. Two arms
apply it. The `employees` arm — an automation rule that names specific people — returns the list verbatim, with
no liveness check and no existence check.

**The email half is covered, but by a different file.** `services/emailFanOut.ts:76-84` re-reads the recipients
and filters `status = "active"` + `delete_time IS NULL` before sending, so an `emailAudience` action naming a
leaver sends nothing. That is the right outcome reached by a second filter somewhere else — this function's own
promise is still false.

**The in-app half has nothing behind it.** `notifyAudience` → `notifyMany` writes a `notifications` row per id,
so a rule naming a terminated or soft-deleted employee mints rows nobody can ever read (they cannot sign in —
`middleware/auth.ts#assertLive` refuses them), each one consuming a `code_sequences` allocation. A stale id
that no longer resolves fails the FK and is swallowed as the non-fatal `[notify] insert failed`.

**Fix:** filter the `employees` arm through the same `LIVE_EMPLOYEE` predicate as its two siblings — one `IN`
query, and the function then means what its first line says.

---

## 27. `review-cycles:variablePay` publishes a protected compensation field to a role with no compensation grant

**Files:** `src/services/variablePay.ts:74,86-89,131-151`, `src/routes/reviewCycles.ts:62-70`,
`src/domain/manifests.ts` (`PROTECTED_FIELDS.compensation`), `src/services/letterData.ts:23-41` (the sibling
that does it right)

`variablePayRun` binds the caller's scope to **reviews**, then reads the `compensation` table for everyone in
that list with no access decision of any kind:

```ts
const reviews = await deps.db.select().from(schema.reviews)
  .where(and(applyScope(scope, schema.reviews.code, schema.reviews.employeeId), eq(..., cycleId)));
...
const compByEmployee = await effectiveCompensationFor(deps, employeeIds, on);   // plain select, no actor
...
const target = comp?.variablePayTarget ?? null;
lines.push({ employee, review, attainment, target, currency: comp?.currency ?? "INR", recommended, awarded, ... });
```

`target` and `currency` go straight onto the wire as `VariablePayLine.target` / `.currency`. Both are
`compensation` columns, and both are declared **protected fields** on that collection in the policy manifest:

```
"compensation": ["annual_ctc", "variable_pay_target", "currency_code", "pay_grade", "salary_structure"]
```

`compensation` is also in `AUDIT.sensitive_collections`, so a direct item read writes a
`compensation.read.sensitive` row. Reading the same figures through this verb writes none.

**Who reaches it.** Checked against the seed: the only subject with a custom-method allow on review-cycles is
`hr_admin` (`review-cycles.**`, `level NULL`) plus super. And `compensation` is granted to **`payroll_admin`
only** — `hr_admin` has no compensation row at all. So the role this endpoint is written for is exactly the
role the app deliberately keeps out of salary data.

**The sibling states the hazard in as many words.** `services/letterData.ts:23-29`:

> THE ACTOR IS NOT OPTIONAL DECORATION … The seeded `hr_admin` grant deliberately holds NO compensation entry
> … anyone who could generate a letter could read anyone's CTC through one, with no compensation grant
> anywhere.

and gates its read with `canReadObjectCode(deps, viewer, "compensation", emp.code)`. `services/tableRun.ts`
makes the same call the other way, dropping the `compensation` source when it is absent from the caller's
`scopes` map. Of the eight readers of this table, `variablePay.ts` is the only one that asks nothing.

**Sub-point — the comment describes a grant that does not exist.** `routes/reviewCycles.ts:63-64` says of both
verbs: *"Both read reviews through the caller's own scope, so a manager sees their team and HR sees
everyone."* No manager grant carries a review-cycles verb allow (manager has `review-cycles.**` at `read`
only), so a manager gets 403 on `:variablePay` rather than seeing their team. Either the grant or the comment
is wrong.

**Fix:** gate `effectiveCompensationFor` the way `letterData` gates its read — resolve
`canReadObjectCode(deps, actor, "compensation", <employee code>)` per employee (or once per scope) and leave
`target`/`currency` null where it fails, exactly as `ctx.comp` is left undefined for a letter. The line still
renders, it just cannot state a figure its reader may not see. `awardVariablePay` needs the unfiltered figure
to price the bonus, which is fine — it recomputes server-side and writes a `bonuses` row that `hr_admin` is
separately granted; what must not travel is the per-person target on the REPORT.

---

## 28. `employees:upcomingCelebrations` reads the whole employee table and decrypts a PII blob per row, on every dashboard load

**Files:** `src/services/celebrations.ts:60-72`, `src/routes/celebrations.ts`,
`web/src/pages/Dashboard.tsx:214`, `web/src/pages/LeaveCalendar.tsx:169`,
`src/services/notifications.ts:339-343` (`LIVE_EMPLOYEE`, the rule this one does not follow)

```ts
const rows = await deps.db.select().from(schema.employees).where(eq(schema.employees.status, "active"));
for (const e of rows) {
  if (e.deleteTime) continue;                                    // filtered in the isolate, not in SQL
  ...
  const md = monthDay(await readDob(deps, e.personalDetailsEnc)); // one AES-GCM decrypt per employee
```

Three problems, one line apart.

**1. `select()` pulls every column.** The function needs seven (`uuid`, `firstName`, `lastName`, `photoKey`,
`startDate`, `personalDetailsEnc`, plus the liveness columns). It reads the whole row — including
`bankDetailsEnc`, `identityDetailsEnc`, `taxDetailsEnc` and `nationalIdEnc`, four encrypted blobs it never
opens, hauled into isolate memory for every employee in the org.

**2. Liveness is decided in the isolate.** `deleteTime` is filtered in JS after the read, and `disabled` is not
checked at all. `services/notifications.ts` states the rule for exactly this shape and explains why all three
columns belong in it:

> `LIVE_EMPLOYEE` = `status = "active"` AND `delete_time IS NULL` AND `disabled = false` … an account switched
> off is not somebody to broadcast to either. … **Filtered in SQL rather than in the isolate: the rows it drops
> do not have to be read, and D1 bills rows read.**

So a **disabled** employee's birthday is still broadcast to the whole org on the dashboard card — which is the
one outcome that comment names. That is a correctness bug, not only a cost one.

**3. It is uncached and everyone hits it.** The route is a bespoke Hono handler (`c.json({ results })`) with no
`ETag`, so the collection factory's conditional-GET path (`http/listEtag.ts`) never applies. The SPA calls it
with a bare `get()` — not `useCollection` — so `resourceStore` does not cache it either. `Dashboard.tsx:214`
fires it on every dashboard mount, and `employees.upcomingCelebrations` is in the seeded allow list for every
role. Per dashboard load, per user: one full-table `employees` read plus one AES-GCM decrypt per active
employee.

**Fix:** select the seven columns, put all three liveness conditions in the `WHERE` (reusing the
`LIVE_EMPLOYEE` predicate rather than a fourth spelling of it), and give the route an ETag — the answer changes
only when an employee row changes, which the `employees` change stamp already reports.

### 27a. The same gap, latent, in the file that documents the rule

`services/letterData.ts` gates `compensation` with `canReadObjectCode` and then assembles two more sensitive
sources with no check at all:

```ts
const bonusRow  = await ...select().from(schema.bonuses).where(eq(employeeId, ...)).orderBy(desc(awardDate)).limit(1);
const settleRow = await ...select().from(schema.settlements).where(eq(employeeId, ...)).orderBy(desc(settlementDate)).limit(1);
```

`ctx.settlement` carries the net **and the full line breakdown** (salary, encashment, gratuity, notice
recovery, loan recovery, TDS) into `{{settlement_net}}` and the `settlement_table` computed block;
`ctx.bonus` carries the amount and reason. `settlements` is in `AUDIT.sensitive_collections` alongside
`compensation`.

Not live on the seeded policy: `hr_admin` holds `settlements.**` and `bonuses.**`, and is the only non-super
role with the `personal-documents` verb allow — so today's letter author can read both directly anyway. It
becomes live the moment settlements is narrowed through the ACL, or letter generation is granted to another
role. Same shape as #27, same cause: the actor check is applied per source by hand, so one source gets it and
the next does not.

---

## Corroboration for #22 (defects.md): a fourth registry agrees, and it is the storage pair that does not

While reading `src/lib/audit.ts` I found the same three collections judged sensitive a third and fourth time,
which makes #22's omission much harder to read as deliberate. The app maintains **four** registries that each
answer "is this too sensitive to copy somewhere wider than the record's own readership":

| registry | file | check-ins | reviews | suggestions |
|---|---|---|---|---|
| audit-meta denies | `src/lib/audit.ts` `AUDIT_DENY` | `employeeNote`, `counterpartNote` | `managerComment`, `overallRating` | `submitterId` |
| grid projection | `src/domain/tableFields.ts` | excluded base | `deny: [managerComment, overallRating]` | `deny: [submitterId]` |
| session replay | `web/src/instrument.ts` `SENSITIVE_PAGES` | yes | yes | yes |
| **on-disk cache** | `web/src/lib/resourceStore.ts` `MEMORY_ONLY` | **no** | **no** | **no** |

Three of the four agree, and each states the same rule in its own words — `audit.ts` puts it best: *"material
whose own access control lives somewhere else must not be copied here."* Writing the row to a browser's
IndexedDB for seven days is that, with the widest readership of the four.

`audit.ts`'s note on `check-ins` is the sharpest statement of it: *"Out of the box only super reads that table
— and super is precisely who the serializer says must not see these."* The disk cache has no reader gate at
all — it is whoever can open the browser profile.

Nothing new to fix beyond #22; recorded because the weight of evidence changes.
