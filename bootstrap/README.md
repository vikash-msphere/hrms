# Production bootstrap

Catalog + config for a **fresh production database**. India statutory defaults (EPF/ESI/PT/TDS, Asia/Kolkata,
INR). This is distinct from `scripts/seed.sql`, which is the **dev/demo** seed (100 fake employees, activity, 5
role logins).

## What it seeds

- **Authz** — roles, access rules, policy manifest (reused from `scripts/genAccessRulesSeed` + `src/domain`),
  plus own-only in-app notifications for `everyone`.
- **Leave** — 8 leave types (Earned/Sick/Casual + Maternity/Paternity/Comp-off/Bereavement/Loss of Pay).
- **Holidays** — India public holidays for the calendar year (`HOLIDAY_YEAR` in `catalog.ts`).
- **Payroll** — pay components (HRA, allowances, EPF/ESI/PT/TDS), 2 salary structures, 6 pay grades, 12
  monthly pay periods for the financial year (`FY_START_YEAR`).
- **Reimbursements** — 8 categories.
- **Benefits** — 4 plans (health, PA, term life, NPS).
- **Shifts** — General/Morning/Evening/Night.
- **Compliance** — 8 recurring statutory rules (the daily cron rolls these into dated `compliance_events`).
- **Settings** — organization, probation, ctc, tax-config, professional-tax, attendance, overtime,
  transition-templates (reuses the canonical `DEFAULT_*` config objects the app reads).
- **Templates** — default letter + card templates (reused from `scripts/genTemplatesSeed`).

## What it does NOT seed

Employees, departments, users. No demo identities and **no login** — the customer provisions their org and
first admin out-of-band.

## Use

```bash
# 1. regenerate the SQL (deterministic - byte-identical on re-run)
node --import ./scripts/tsResolve.mjs bootstrap/genBootstrap.ts > bootstrap/bootstrap.sql

# 2. apply to a FRESH database (empty - applying over an existing seed collides on role/PK rows)
npx wrangler d1 execute hrms --local --file=bootstrap/bootstrap.sql   # drop --local for remote
```

## Layout

```
genBootstrap.ts            thin orchestrator: wires the collection modules in a fixed order, concatenates
lib.ts                     shared helpers (id gen, SQL quoting, code2, rows) + the HOLIDAY_YEAR/FY_START_YEAR knobs
collections/
  authz.ts                 roles + access_rules + notifications ACL + policy (reuses genAccessRulesSeed, DEFAULT_POLICY)
  leaveTypes.ts            one file per collection: its data + its INSERT render
  holidays.ts
  reimbursementCategories.ts
  payComponents.ts         returns SQL + a key->uuid map
  salaryStructures.ts      consumes payComponents' key->uuid map
  payGrades.ts
  payPeriods.ts
  benefitPlans.ts
  shifts.ts
  complianceRules.ts
  settings.ts              reuses the DEFAULT_* config objects the app reads
  templates.ts             reuses genTemplatesSeed
bootstrap.sql              generated
```

## Editing

- Each collection's data lives in its own `collections/*.ts` — edit there.
- Bump `HOLIDAY_YEAR` / `FY_START_YEAR` in `lib.ts` once a year (festival dates shift) and regenerate.
- Ids stay deterministic as long as the orchestrator invokes the modules in the same order (a shared counter).
- Roles/policy/templates/settings reuse the canonical generators + `DEFAULT_*` configs — never fork that data here.
