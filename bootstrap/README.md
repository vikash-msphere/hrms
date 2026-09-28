# Production bootstrap

Catalog + config for a **fresh production database**. India statutory defaults (EPF/ESI/PT/TDS, Asia/Kolkata,
INR). This is distinct from `scripts/seed.sql`, which is the **dev/demo** seed (100 fake employees, activity, 5
role logins).

## What it seeds

- **Authz** - one JSON file per role in `authz/roles/` (the role row, including which role new accounts get,
  and every rule it starts with, each with its reason; format in `authz/roles/README.md`), compiled into
  `access_rules` rows by `authz/accessRules.ts`, plus the policy manifest (`authz/policy.ts`). Seeded once:
  after that the rows are the policy, edited in Access Management, and the running app never reads these files.
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

# 2. apply to a FRESH database (migrated, otherwise empty - applying over an existing seed collides on role/PK rows)
npx wrangler d1 execute hrms --local --file=bootstrap/bootstrap.sql   # drop --local for remote
```

Only the roles and permissions, for a database that already has its catalog:

```bash
npm run -s bootstrap:authz > bootstrap/authz.sql
npx wrangler d1 execute hrms --local --file=bootstrap/authz.sql       # drop --local for remote
```

Catalog automations added after a database was bootstrapped, into that live database. Name each rule; a rule of
that name already there is left alone, and the code is taken from the app's own counter:

```bash
npm run -s bootstrap:automations -- "<rule name>" > bootstrap/automations.sql
npx wrangler d1 execute hrms --local --file=bootstrap/automations.sql  # swap --local for --remote
```

## Layout

```
genBootstrap.ts            thin orchestrator: wires the collection modules in a fixed order, concatenates
genAuthz.ts                the authz block alone (npm run bootstrap:authz)
genAutomations.ts          named automations a live database is missing (npm run bootstrap:automations)
lib.ts                     shared helpers (id gen, SQL quoting, code2, rows) + the HOLIDAY_YEAR/FY_START_YEAR knobs
authz/
  roles/*.json             one file per role: everyone, employee, manager, hr_admin, payroll_admin, super_admin
  grants.ts                loads + validates the role files into Grants (resolves `extends`)
  roles.ts                 the role rows, read from the same files
  policy.ts                the day-one policy manifest
  accessRules.ts           renders roles + compiled access_rules rows (shared with scripts/genSeed.ts)
collections/
  authz.ts                 authz/ rendered + the policy manifest row
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

- Each collection's data lives in its own `collections/*.ts` - edit there. Roles and their grants live in `authz/`.
- Nothing under `src/` or `web/src` may import from `bootstrap/` (test/bootstrapBoundary.test.ts): the app reads
  its configuration from the database, and this folder only fills it once.
- Bump `HOLIDAY_YEAR` / `FY_START_YEAR` in `lib.ts` once a year (festival dates shift) and regenerate.
- Ids stay deterministic as long as the orchestrator invokes the modules in the same order (a shared counter).
- Roles/policy/templates/settings reuse the canonical generators + `DEFAULT_*` configs — never fork that data here.
