# 04 — Testing

`npm test` runs the whole suite with Vitest under `@cloudflare/vitest-pool-workers`: **110 files, 1252
tests**. Pure-domain files need no Worker runtime and are the fastest signal; service, route and flow files
run against the real `workerd` with live D1 and R2 bindings, applying the migrations from
`src/db/migrations/` into a fresh database per file.

`npm run verify` (`api:lint` → `typecheck` → `test`) is the only gate that matters. It runs as a pre-commit
hook (`.husky/pre-commit`, installed by `npm install`) and in CI (`.github/workflows/verify.yml`).

> **A false green to know about.** If the local command sandbox denies `.dev.vars`, the pool fails to build
> its Miniflare options, vitest reports `Test Files no tests` and still **exits 0**. A run that says "no
> tests" has not tested anything. Rerun outside the sandbox and confirm the counts.

## The suite by family

**Authz engine** (pure, fast, the heart of the system) - `permissions` (path matcher `*` / `**` / `me` /
`my-dept` / `<prefix>-*`, the read < write < admin ladder, deny-wins, fail-closed on unknown), `codes`
(hierarchical compose/parse, boundary match), `grants`, `manifests`, `access` (list scope), `compileGrants`,
`policyValidate`, `ruleLogic`, `loadGrant`, `authzResolve` (request path → permission key), `keyScope`.

**Access enforcement over real requests** - `bola` (cross-employee and cross-dept denial), `parity`
(route × role), `listScope` and `usersListScope` (breadth binding, fail-closed on unset), `createGate`,
`fieldAccess` (protected fields), `grantExceptions`, `roleObjectRules`, `accessRuleScope`, `accessLifecycle`,
`accessPreview`, `accessHint`, `collectionVerbGrant`, `auditAccess`, `ticketShares`, `viewAs`, `apiKeys`,
`sessionBinding`, `googleAuth`, `cache`.

**Invariant / drift gates** (these are what keep conventions true without anyone remembering them):

| Test | What it fails on |
|---|---|
| `singleSource` | any access decision found in a service or route (the DoD #1 gate) |
| `collectionLaneDrift` | a hand-rolled standard method, or a bespoke purge nothing calls |
| `openapiRoutesDrift` / `customMethodsDrift` | code and `openapi.yaml` disagreeing on paths or verbs |
| `serializerContractDrift` / `requiredReadOnlyDrift` | serializer output drifting from the contract |
| `wireRegistry` | a collection reachable by authz that is not wire-tokenized |
| `seedDrift` / `manifestSeedDrift` / `searchDdlDrift` / `payslipTemplateDrift` / `ticketWorkflowDrift` | a generated artifact (seed rows, policy manifest, FTS DDL, templates, ticket workflow) not regenerated after its source changed |
| `manifestCompleteness` / `webAccessCoverage` | a collection missing policy entries, or a page missing its access affordance |
| `reparenting` | a hierarchical table missing from the code-cascade set |

**Money and payroll** - `payroll` (totals, rounding, run state machine), `money`, `currency`, `moneyFlow`,
`statutory`, `incomeTax`, `taxProjection`, `compensation`, `payComponentWrite`, `settlement`, `encashment`,
`carryForward`, `loanRepayment`, `attendanceLop`, `bankFormats`, `letters`, `payslipTemplate`.

**Feature flows** (workerd + D1, end to end through the HTTP app) - `ats`, `cardsFlow`, `expensesFlow`,
`reviewFlow`, `workflowsE2E`, `automations`, `scheduledAutomations`, `bootstrapAutomations`, `jobQueue`
(retry ladder, attempt cap, `run_after`, who gets notified, a failed nightly subtask turning its cron run
red), `documentAck`, `esign`, `employeeSignature`, `attendanceRegularizationFlow`, `checkInRecurrence`,
`complianceRecurrence`, `expenseBudgetRecurring`, `referrals`, `goalAlignment`, `kudos`, `kudosSelf`,
`boardEngagement`, `announcementDraft` / `announcementReadBy` / `announcementSticker`, `ticketRouting`,
`foundPage`, `assetTags`, `assetBatchCreate` (a delivery: quantity + serial list, one contiguous tag run),
`assetBulk` (the paste/scan parsing behind it), `globalSearch`, `dashboardSummary`,
`celebrations`, `listTruncation`, `employeeNumber`, `employeeCompleteness`, `profileCompleteness`.

**Platform** - `crypto` (field encryption round-trip, ciphertext ≠ plaintext), `idCodec` (round-trip,
determinism, collection binding, tamper and length rejection), `encodeWireIds` / `decodeWireIds`,
`stateMachines`, `richText`, `illustration`, `silhouette`, `activitySerialize`, `collectionFactory` (the
lane itself: paging, `?id`, `If-Match`, `?force`, lifecycle verbs, overrides, decorate).

**`productionReadiness`** is the cross-cutting safety net: payroll `deleteRun` releasing every paid-by-run
payout, leave reservation refusing to overdraw, the real auth + middleware + wire-id chain over
`/v1/users/me`, the `code` uniqueness backstop, and `ALLOWED_EMAIL_DOMAINS` gating first-login
auto-provisioning.

## Writing a new test

- Pure domain logic: no runtime imports, no DB. Keep it in the fast lane.
- Anything touching a route: go through `app.fetch` so the middleware chain (auth, authz, wire ids, CSRF)
  runs. A service called directly proves nothing about access.
- New collection, new drift risk: prefer a gate that fails on the whole class over one example test. Every
  drift test above exists because a conversion or a copy-paste silently dropped behaviour once.
