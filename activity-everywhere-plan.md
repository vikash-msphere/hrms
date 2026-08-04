# Activity everywhere — plan

Goal: surface the append-only audit trail across the whole app (every page/entity), plus a global admin
feed, plus make sensitive-data READS visible (they are already logged; just not shown).

Backend write-logging already exists (`audit()` at ~203 sites → `audit_log`). Sensitive-read logging also
already exists (`accessAudit()` in middleware → `<col>.read.sensitive` + `access.denied`, driven by
`policy.audit`). So this is mostly a **surfacing** effort + widening read coverage + a global feed.

## A. Read visibility (logged already; surface + widen)
- [ ] Tune the `AUDIT` policy (src/domain/manifests.ts) to the reads that are actually accountability events:
      whole-item-sensitive collections (compensation, payslips, settlements, background-checks, offers) +
      sensitive custom methods keyed `collection:verb` (a bare verb name is ambiguous — `payslips:download`
      is one person's pay, `org-documents:download` is the handbook). Sample/template previews, org-level
      catalogs and metadata-only item reads stay silent.
- [ ] Feed vocabulary: add `read` + `denied` tones/labels.
  - server: src/domain/activity.ts — TONE gains `sensitive:"read"`, `denied:"denied"`; ActionTone union.
  - web: web/src/lib/activity.ts — mirror TONE + VERB (`sensitive`→"viewed", `denied`→"was denied").
  - ActivityFeed.tsx — TONE_CLS + TONE_LABEL gain read (slate) + denied (red).

## B. Org-wide Activity page (new)
- [ ] Register `audit` virtual capability in COLLECTIONS (super-only default, admin-grants via ACL —
      mirrors `timeline`/`export`; NOT in COMMON_READ).
- [ ] Global feed: `GET /v1/activity` with NO `resource` → all rows. Middleware activity branch: empty
      resource → gate on `audit` read. Service `listAllActivity(...)` (filters: q, tone, entity, actor).
- [ ] Serializer: add `entity` + `entity_id` (wire ref) to toActivityResource so global rows link out.
- [ ] Web page Activity.tsx (reuses feed UI; adds entity-type + actor filters + entity link). Nav entry
      under Admin, `perm: audit.read`. Route in App.tsx + PAGE_CHUNK.

## C. Per-entity feed in detail dialogs (reuse ActivityFeed)
Thin `<ActivitySection resource={path}/>` wrapper (heading + feed). Wire into entity dialogs:
Assets, Loans, Tickets, Goals, Reviews, Candidates(profile done?), Requisitions, Offers, Interviews,
Announcements, Compliance, BackgroundChecks, Benefits, Suggestions, Referrals, NoticePeriods, Onboarding
(transition), TaxDeclarations, Leaves, Reimbursements, Overtime, RemoteWork, Attendance-regularizations,
Departments, PayComponents/PayGrades/etc (admin). Skip pure inline-edit tables w/ no per-row dialog —
org-wide page covers those (note them).

## Status: DONE
- A: AUDIT policy tuned (qualified `collection:verb` sensitive methods; previews/catalogs/metadata silent);
     read-shaped custom methods excluded from the write backstop; read/denied tones+labels+colors
     (server + web + feed inline meta). ✓
- B: `audit` capability registered; global `listAllActivity` + no-resource route branch + middleware gate;
     serializer entity/entity_ref; ActivityFeed `global` mode (entity filter + type chip); Activity.tsx page
     + nav (Admin, perm audit.read) + App route/chunk; audit_at_idx; seeds + migration regenerated. ✓
- C: ActivitySection wrapper wired into 25 detail/edit dialogs (Assets, Goals, BackgroundChecks,
     NoticePeriods, Offers, Requisitions, Interviews, Referrals, Announcements, Compliance x2, Tickets,
     CandidateProfile, TaxDeclarations x2, Events, Departments, Suggestions, Loans, LeaveTypes,
     PayComponents, Holidays, ProjectsAdmin, ShiftsAdmin, ReimbursementCategories, SalaryStructuresAdmin,
     BenefitPlansAdmin, PayGradesAdmin) + the pre-existing EmployeeProfile/Boards. ✓

Round 2 (list/card surfaces via a reusable `RowActivityButton` icon→dialog, or inline section): request
pages Leaves/Reimbursements/Overtime/RemoteWork (activity col in mine + history), Reviews (ReviewDetail
section), CheckIns (per-card), Onboarding (transition detail section), Approvals (per-inbox-item),
PayrollRuns (run-review dialog), Documents (RowActions "Activity" item → dialog), Timesheets (pending row).

Still NOT wired (org-wide page covers): Schedule (shift grid — no per-row fit), Attendance (computed day
rows, not entities), Payslips/Directory/Dashboard/Notifications/Pipeline/LettersTab/BankFormats/
LetterTemplates/analytics-&-calendar views (no single-entity detail surface or rarely-changed config).

## Org-wide page filters + target (DONE)
- Actor filter: dedicated employee dropdown → `?actor=employees/<token>` (edge decodes to id) → server exact
  `actorId` filter (`listAllActivity` gained `actorId`; route parses the ref); client-match mirrors it.
- Resource type filter: the existing entity dropdown.
- Which record: each global row shows the touched record as a chip — employee→name, else `Type · <short id>`
  (no per-collection name reads) — clickable to DRILL into that record's own trail (nested lazy feed).

## Names, not ids/emails (DONE)
- Bug: middleware `accessAudit` wrote its rows with the actor's EMAIL string, not the AppUser → `actor_id`
  NULL → the feed fell back to email. Fixed: pass `auser` so read/denied rows carry `actor_id`.
- Names resolved server-side at read time (lazy — only when a feed loads, which is already gated behind an
  explicit open): `enrichNames()` in activity.ts does ONE indexed `SELECT *` per distinct collection over the
  page's rows (entity_id/actor_id are already internal ids — no wire decode), `pickName()` chooses the first
  name-ish column (employees = first+last). Serializer emits `entity_name` + `actor_name`; the feed prefers
  them (falls back to cached employee / email / "Type · <short id>"). No schema change (names are transient).
- Verified by a real-D1 test (test/cardsFlow.test.ts): goal.create row resolves title + actor name.

## Click record name → open its page (DONE)
- `web/src/lib/resourceRoute.ts`: `resourceRoute(collection, ref?)` → deep record page for collections whose
  page opens a record by id (employees, candidates), else the collection's list page, else null.
- Activity feed global row: the record-name chip navigates there (tooltip "Open record" vs "Open page"); a
  trailing History icon still drills into that record's own trail. Approvals reuses the same helper (its
  local PAGE_OF map removed).
- Deep-open extended (DONE): `useDeepOpen(openId, rows, openHandler)` hook (web/src/hooks/useDeepOpen.ts) —
  App passes `route.id` as `openId`; the page finds the row once its collection loads and opens its dialog
  once. Wired into 13 more pages (Goals, Assets, Tickets, Offers, Requisitions, Interviews, Compliance,
  BackgroundChecks, NoticePeriods, Announcements, Events, Referrals, Suggestions) + the existing
  employees/candidates. `DEEP_OPEN` in resourceRoute lists all 15 → the activity chip opens the EXACT record.
  Now 17 (added TaxDeclarations + Holidays). Remaining land on their list page — two blockers:
  (1) no per-record detail dialog exists (Payslips/Attendance/Schedule/Timesheets/Leaves/Reimbursements/
      Overtime/RemoteWork request tables) — would need to BUILD detail UI;
  (2) record is nested / elsewhere — HANDLED for two:
      • Kanban cards: `#/boards/<cardId>` → Boards parent maps the card to its board (shared `cards` cache, no
        extra read) + selects it; BoardView/ScrumView `useDeepOpen(openId, cards, setEditing)` opens the task.
      • Admin catalogs (leave-types/shifts/pay-components/pay-grades/salary-structures/projects/benefit-plans/
        reimbursement-categories): router gained a 3rd segment → `#/settings/<panel>/<recordId>`; App forwards
        `route.sub` → Settings → SettingsPanel → renderSettingsPanel → the panel, which `useDeepOpen`s its
        openEdit. `SETTINGS_PANEL` map in resourceRoute produces the route.
      Still open (needs new UI / different flow): employee sub-resources (EmployeeProfile tabs), Reviews'
      review flow, Documents' multi-dialog. Total deep-open now 26 collections.

## Verify: PASS
- server tsc clean · web tsc clean · api:lint 0/0 · 614/614 tests · drift tests green.
- Fixed pre-existing web build blocker: useCardFilter(meId?: string | null) in Boards.tsx.
