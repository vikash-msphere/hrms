# Security Review — HRMS

Date: 2026-07-04
Scope: full repository (server `src/**`, web `web/src/**`, config, seed/bootstrap). Greenfield, not yet deployed.
Method: manual review of the security-critical core (auth, authz engine, crypto, wire-id codec, CSRF/CORS, middleware chain, automation engine, event bus) plus four parallel deep-dive sweeps (list-scope/IDOR, file upload/download, input validation/injection/info-disclosure, automation/authz).

## Verdict

No critical or currently attacker-reachable vulnerability was found. The access-control architecture is strong and coherent:

- **Fail-closed path-based authz** is the single gate (`src/middleware/authz.ts`): null/error/unresolved/deny all return 403, no `require_` backstop, private by default.
- **Least-privilege grants with separation of duties** (`src/domain/grants.ts`): payroll cannot approve its own runs, the bank file and payroll-debit account are super-only, PII sub-resources (bank/identity/personal-info) are super-only by default and self-service only via `me`.
- **Encryption everywhere**: AES-256-GCM for field data and all R2 objects (`src/lib/crypto.ts`, `src/lib/docstore.ts`).
- **IDOR-resistant identifiers**: wire tokens are authenticated-encrypted, non-enumerable, collection-bound; the inbound decoder fails closed and bounds recursion (`src/lib/idCodec.ts`, `src/middleware/decodeWireIds.ts`).
- **CSRF via custom header with no CORS** (`src/middleware/csrf.ts`, no `Access-Control-Allow-Origin` anywhere) — a valid combination behind Cloudflare Access.
- **Clean error handler** — no stack traces, DB errors, or secrets leak to clients (`src/middleware/errorHandler.ts`).
- **No client-stored tokens** — auth is the Cloudflare Access cookie; `localStorage` holds only UI preferences.
- **No SQL injection** (Drizzle bound params throughout), **no ReDoS**, **no PDF-operator/placeholder injection**, condition trees are pure data (no `eval`).

The findings below are hardening and design-boundary items. The single most important is H1.

---

## Remediation status — ALL APPLIED (2026-07-04)

Every finding below has been fixed. Typecheck and the full test suite (497 tests) pass.

| ID | Fix | Key files |
|----|-----|-----------|
| H1 | `apiCall`/`webhook` actions may only be authored by super_admin (recursive kind check) | `src/services/automations.ts` |
| M1 | Per-request dispatch budget (`MAX_TOTAL_DISPATCHES`) on shared Deps stops apiCall re-entry loops | `src/services/automationEngine.ts`, `src/deps.ts` |
| M2 | 25 MiB upload cap enforced before encrypt/store | `src/services/documentsCommon.ts`, `documentService.ts`, `routes/form16Upload.ts` |
| M3 | WAF rate-limit rules documented in the deploy runbook | `docs/deploy-security.md` |
| M4 | `listDepartments` honors scope; `applyScope` bound in recruiting/compliance/payroll/events lists | `services/departments.ts`, `ats.ts`, `backgroundChecks.ts`, `complianceEvents.ts`, `events.ts`, `payroll.ts` (+ routes) |
| L1 | https-only public-host guard before webhook egress | `src/lib/urlGuard.ts`, `automationEngine.ts` |
| L2 | event-log / automation-run payloads redacted for non-super viewers | `src/http/serialize.ts`, `routes/eventLog.ts`, `routes/automationRuns.ts` |
| L3 | moot — card-templates feature (custom HTML cards) deleted entirely | - |
| L4 | `Content-Disposition: attachment` on binary downloads; SVG dropped from upload allowlist | download routes, `documentsCommon.ts` |
| L5 | type + length validation on personal/identity/suggestion inputs | `personalDetails.ts`, `identityDetails.ts`, `routes/suggestions.ts` |
| L6 | letter `input`/`blocks` size + count caps | `routes/letterPreview.ts`, `letterGenerate.ts` |
| L7 | `ZodError` → 400 (was 500) | `src/middleware/errorHandler.ts` |
| L8 | `resolveField` own-property only; `template` skips prototype keys | `src/domain/automations.ts`, `automationEngine.ts` |
| L9 | `codeCache` bounded (FIFO, 10k) | `src/lib/authzResolve.ts` |
| L10 | prod-guard warnings on seed fixtures + generators; runbook note | `scripts/genSeed.ts`, `bootstrap/genDemo.ts`, `docs/deploy-security.md` |
| Deploy hygiene | secrets rotation, dev-bypass, seed, SPA CSP documented; strict SPA `_headers` added | `docs/deploy-security.md`, `web/public/_headers`, `web/public/theme-init.js`, `web/vite.config.ts` |

---

## HIGH

### H1 — Authoring an automation is de-facto privilege escalation from `hr_admin` to `super_admin`
Files: `src/services/automationEngine.ts` (`apiCall`), `src/services/internalDispatch.ts`, `src/lib/systemActor.ts`, `src/domain/grants.ts`, `src/services/eventBus.ts`.

Automation `apiCall` actions dispatch through `internalDispatch` as `systemActor()` = `GRANTS.super_admin`. Rule authoring is gated only to `hr_admin`/`super` (`"automations.**": "write"`). So any `hr_admin` can author a rule whose `apiCall` performs actions they are explicitly denied:
- `POST /v1/access-rules` to grant themselves super, or change roles via `POST /v1/users`.
- `POST /v1/payroll-runs/<id>:approve` — bypasses the deliberately super-only separation-of-duties.
- `GET` all employees' bank/identity PII or `payroll-debit-accounts`, `captureAs`, then exfiltrate through a `notify`/`notifyAudience` body (`{{results...}}`) or a `webhook`.

Compounding it: `emitEvent` runs `dispatchAutomations` **synchronously inside the triggering request**, and `path`/`body` are `{{...}}`-templated over the event context. A lower-privileged actor who can trigger an event with controllable payload can influence which resource/values a super-authority call hits (confused deputy — e.g. self-approval).

The `apiCall` path stays `/v1/`-bound (validated at author time and in `internalDispatch`), so there is no external escape; the risk is entirely internal privilege abuse.

Remediation (pick one, in order of preference):
1. Run `apiCall` under the **rule author's own grant** rather than the system super grant. Preserves the existing access model end-to-end.
2. If system authority is required, restrict authoring of `apiCall`/`webhook` action kinds to `super_admin` only (leave notify/emitEvent kinds for `hr_admin`).
3. At minimum, constrain templating so id/path segments come only from trusted event fields, and never allow templated values into `access-rules`/`users`/payroll-approve targets.

### (bumped from H1 compound) — treated together above.

---

## MEDIUM

### M1 — `apiCall` re-entry bypasses the event-depth guard → unbounded super-authority loop
File: `src/services/automationEngine.ts` (`MAX_EVENT_DEPTH`, `runAction` apiCall).

`MAX_EVENT_DEPTH` only bounds `emitEvent`→`emitEvent` chains (depth is threaded via `opts.depth`). An `apiCall` re-dispatches a real HTTP request; the hit service calls `emitEvent` with no depth, so `dispatchAutomations` restarts at depth 0. A rule whose `apiCall` triggers its own trigger event (e.g. trigger `employee.created`, action `apiCall POST /v1/employees`) loops without bound, each iteration as super — runaway/DoS + data amplification.

Remediation: propagate depth into `apiCall`-induced emissions (carry it through `makeDispatch` via a header or `__sharedCtx`), or enforce a per-trigger fan-out/total-action budget per originating request.

### M2 — No file-size cap on `documentService.upload` and `form16Upload`
Files: `src/services/documentService.ts:151-167` (reached by `src/routes/documentRoutes.ts:72-75` for `org-documents:upload` / `personal-documents:upload`, and `src/services/transitionTasks.ts:69`); `src/routes/form16Upload.ts:34-41`.

These read the full body via `c.req.arrayBuffer()` with no maximum, then AES-encrypt (a second full in-memory copy) and write to R2 — unbounded memory + storage DoS. Any user with write on a personal/org document can POST a multi-hundred-MB body. The attachment path (`src/services/attachments.ts`, 10 MB) and photo/signature (`src/services/employeePhoto.ts`, 3 MB) already cap; these two do not.

Remediation: enforce `maxUploadBytes` in `documentService.upload` and `form16Upload` before encrypt/store. Additionally consider a global `bodyLimit` middleware, since even capped paths buffer the whole body once before the service validates.

### M3 — No application-level rate limiting
Expensive/abusable operations have no per-principal throttling: PDF/letter/Form-16 generation, all uploads, `/v1/batch:run`, `cron-runs:run`, `automations:test`. Auth is handled by Cloudflare Access but there is no volumetric control.

Remediation: configure Cloudflare WAF rate-limiting rules for these paths before production, and/or add per-principal caps for the generation and batch endpoints. Document the required WAF rules in the deploy runbook.

### M4 — List-scope structural fragility (latent bulk-data leak)
File cluster: `src/routes/{applications,candidates,requisitions,offers,interviews,backgroundChecks,complianceEvents,payrollRuns,events}.ts` and their services; **`src/services/departments.ts:22` `listDepartments` is the closest to live.**

Most list handlers that bind no scope are safe *only* because the manifest never offers those collections a self/dept read tier — not because of any handler-level guard. `listDepartments` is worse: `departments` **does** define a `subtree` read tier (`supported_scopes.departments = ["subtree","all"]`) but the service drops the actor and returns the whole tree. Today every role has `departments.** ... all`, so it is not exploitable; the moment a `subtree`-scoped read grant is issued, the full org tree leaks. The recruiting/compliance/payroll lists have the same shape (a future narrow grant turns them into org-wide dumps).

Remediation:
1. Fix `listDepartments` now to honor `applyScope` (a defined tier is being ignored — this is the real latent gap).
2. Defense-in-depth: bind `applyScope` unconditionally in the unscoped list services (it is a no-op for `all`-breadth callers, so no behavior change today) so a future grant cannot silently become a bulk leak.

---

## LOW

### L1 — `webhook` action has no destination allowlist (SSRF/exfiltration, latent)
Files: `src/ports/index.ts` (`WebhookSender.post(url, body)`), `src/services/automationEngine.ts` (`webhook`), `src/deps.ts`.

The port takes an author-controlled URL with no allowlist; the engine passes it straight through. Egress is **off by default** (`deps.webhook` is never wired in `makeDeps`), so it is dormant. But combined with H1 it is an SSRF/exfil primitive the moment egress is enabled. The code comments promise an allowlist that does not exist.

Remediation: enforce a destination allowlist (and block private/link-local ranges) at the port/config layer before any `WebhookSender` is wired.

### L2 — Observability logs leak field data across grant boundaries
Files: `src/http/serialize.ts` (`toEventLogResource`, `toAutomationRunResource`); grants `"event-log.**": "read"`, `"automation-runs.**": "read"` for `hr_admin`.

Serialized event `payload`/`result` embed domain fields (e.g. `loan.approved` carries `{amount, emiAmount}`, `loan.repaymentRecorded` carries balances) even though `hr_admin` has no `loans` read grant. The log is a side channel around per-collection read scoping.

Remediation: restrict these logs to `super_admin`, or redact/whitelist payload fields in the serializer.

### L3 — `safeUrl` in the card-template renderer is too narrow (stored XSS, privilege-gated)
Resolved by removal: the card-templates feature (custom HTML feed cards, `web/src/lib/cardHtml.tsx` renderer, `card-templates` collection) was deleted entirely; feed cards are hardcoded React. No author-controlled HTML surface remains here.

### L4 — Downloads served inline; stored content-type reflected; SVG in upload allowlist
Files: downloads at `src/routes/{candidates,referrals,reimbursements,taxDeclarations,employees}.ts`; allowlist `src/services/documentsCommon.ts:16-26`.

No download sets `Content-Disposition: attachment`; several reflect the attacker-controlled stored content-type, and `svg`/`image/*` is accepted on upload — an inline-SVG stored-XSS shape. It is **mitigated** today by `Content-Security-Policy: default-src 'none'` + `nosniff` applied to every `/v1/*` response (`src/middleware/securityHeaders.ts`), and there is **no download IDOR** (all downloads take the id from the path and are gated by the middleware).

Remediation (defense-in-depth): set `Content-Disposition: attachment; filename="…"` on binary downloads, and either drop `svg` from the allowlist or force `application/octet-stream` for SVG downloads so the mitigation does not rest on CSP alone.

### L5 — Unbounded / type-confused inputs in a few services
Files: `src/services/personalDetails.ts:53-59`, `src/services/identityDetails.ts:97-108`, `src/services/suggestions.ts:95-103`.

Bodies are allowlisted (no mass-assignment) but not type/length validated: a non-string value hits `.trim()` → TypeError → generic 500 (self-inflicted), and strings are stored unbounded (arbitrarily large encrypted blob).

Remediation: validate with zod (correct types + reasonable length caps) at these routes.

### L6 — Unbounded letter `input`/`blocks` (PDF resource exhaustion, HR-gated)
Files: `src/routes/letterPreview.ts:15-27`, `src/routes/letterGenerate.ts:24`, `src/domain/letters.ts:286`.

`input: z.record(z.string(), z.string())` and `blocks: z.array(z.any())` have no size/count bounds; a huge value (one paragraph per line) or huge `blocks` array yields a very large PDF / CPU exhaustion. Reachable only by HR/super.

Remediation: cap array length and per-value string size in the route schemas.

### L7 — `.parse()` routes return 500 instead of 400
File: `src/middleware/errorHandler.ts`.

Routes using `.parse()` (tickets, reviews, goals, loans, transitions, some announcement verbs) throw `ZodError`, which falls through to the generic 500. No disclosure (body stays generic) — just a wrong status code.

Remediation: add a `ZodError` → 400 branch in the error handler.

### L8 — `resolveField` walks the prototype chain; `template` can touch `__proto__`
Files: `src/domain/automations.ts:42-45` (`p in cur`), `src/services/automationEngine.ts:78-83` (`template`).

`resolveField` uses `in`, so `payload.constructor` / `__proto__` resolve from the prototype chain (read-only; values are only stringified/compared — no invocation, no RCE). `template` rebuilds objects with `out[k] = …`, so a `__proto__` key in a templated object could hit the prototype setter. Low exploitability.

Remediation: use `Object.hasOwn(cur, p)` in `resolveField` and skip `__proto__`/`constructor`/`prototype` keys in `template`.

### L9 — Unbounded module-level `codeCache`
File: `src/lib/authzResolve.ts:90` (`codeCache`).

A never-evicted `Map<uuid, code>` grows for the isolate's lifetime. Codes are immutable so there is no correctness/cross-tenant issue, but it is a slow memory leak.

Remediation: bound it (LRU or size cap).

### L10 — Demo/seed fixtures create predictable admin accounts
Files: `scripts/seed.sql`, `bootstrap/demo.sql`.

Seed data creates `super@example.com` mapped to `super_admin` and other fixed accounts. If loaded in production, that is a predictable privileged identity (login still requires a matching Cloudflare Access identity, so not a direct backdoor).

Remediation: guard seeding to non-production and document that these fixtures must never be applied to a prod database.

---

## Deployment hygiene (not code defects)

- **Secrets**: `.dev.vars` is git-ignored and not in history (verified), but it contains real-looking `FIELD_ENCRYPTION_KEY` and `WIRE_ID_KEY`. Generate fresh, distinct keys for production via `wrangler secret put` and never reuse the local/example values. Losing/rotating `FIELD_ENCRYPTION_KEY` or `WIRE_ID_KEY` breaks decryption and all issued wire tokens respectively — document key management.
- **Dev auth bypass** (`src/middleware/auth.ts`) is sound: requires both `DEV_FAKE_EMAIL` and `ALLOW_DEV_AUTH=true`; production secrets set neither. Keep it that way — never set `ALLOW_DEV_AUTH` in a deployed environment.
- **SPA CSP**: the API CSP is locked down, but the SPA's own HTML CSP is described as configured "at the static-asset layer." Confirm a strict CSP is actually served for `web/dist` (the app shell) before production — that is the real XSS boundary for the SPA.

---

## Suggested remediation order

1. **H1** — decide the automation authority model (run `apiCall` under the author's grant, or restrict authoring). This is the one design boundary that materially weakens the otherwise-tight model.
2. **M1, M2** — depth propagation and upload size caps (small, contained fixes closing DoS).
3. **M4** — fix `listDepartments` scope now; bind `applyScope` unconditionally elsewhere as defense-in-depth.
4. **M3** — WAF rate-limit rules in the deploy runbook.
5. **L1, L2** — before enabling webhook egress / before exposing observability logs to HR.
6. **L3–L10** — hardening batch as time allows.
7. Deployment hygiene items before first deploy.
