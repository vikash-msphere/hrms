# Access-control UI: model, coverage, conventions

The web app manages access **in context**: an admin toggles Access mode (user menu → "Access management",
or the floating amber pill to exit) and every governed element sponsors a small amber key icon that opens
the ACL modal scoped to exactly that thing. This document describes the model, what guarantees coverage,
and the conventions every page must follow. UX only throughout - the server authz middleware enforces
every request regardless of what the UI shows.

## The model

One resource - `access-rules` - expresses everything. A rule is
`subject (role|user) × collection × scope × [field] × [verb] → level|allow|deny`, plus a lifecycle
(`status`, `expires_at`) that decides whether the row is loaded at all.

- **Levels** nest: read ⊂ write ⊂ admin ("full" in the UI; adds delete + purge). `deny` wins.
- **Custom methods** (AEP `:verb`) are fail-closed: allowed only by an explicit verb-allow; verb `*` = all
  methods of the collection in one rule (allow-only).
- **Scopes**, narrowest first: `exact` (this object) / `subtree` (this object & below) are object-anchored
  (pinned via `scope_ref`); `self` / `dept` / `all` are subject-relative. The grantable tiers per collection
  come from the backend policy manifest carried on `users/me` (`caller_access.scopes`) - the UI never
  hardcodes them.
- **Create gate** is separate from write-on-existing-objects: a "new X" affordance manages the 1-token
  `<collection>` create rule.
- **Hints**: every serialized row carries `access.can` (effective verbs for the caller, decided server-side
  by the same engine) and `access.why` (the scope by which the caller holds read - shown as "via your own
  record / your department / …" in the modal).
- Virtual capabilities ride the same rails: `activity` (per-entity audit trail) and `export` (table data
  export).
- **Lifecycle** (`src/lib/policyLoad.ts` `live`, the ONE predicate every load path ANDs in): a rule decides
  only while it is `active` and unexpired.
  - **Expiring grants**: optional `expires_at` (must be in the future). The rule stops deciding the instant it
    lapses; the nightly cron (`purgeExpiredAccessRules`) then deletes the row, so a skipped tick can never
    leave access alive. Authored from the ACL modal's add form and the fine-rules editor; shown as an
    "expires in 3d" badge wherever the rule appears.
  - **Four-eyes approval** (opt-in, settings key `access-approval`): while on, a new rule lands `pending`
    (inert) and a removal marks the rule `pending_delete` (still enforcing) until a DIFFERENT access admin
    calls `access-rules:approve` / `:reject`. A pending change never applies itself in either direction. The
    requester may withdraw their own pending row; a one-admin org unblocks by turning the setting off.

## Where affordances come from (coverage by construction)

Wiring is ambient-first so a page opts in once and everything inside lights up:

1. `App.tsx` wraps every route in a `RouteAccessScope`: ambient collection = the route key, corrected by
   the `ROUTE_SCOPE` map for routes whose key is not their wire collection (schedule → `shift-assignments`,
   pipeline → `applications`, org-chart → `employees`, …). `null` entries (dashboard, approvals, documents,
   settings, profile) provide NO ambient scope - on those cross-collection surfaces every affordance carries
   an explicit target, and a forgotten one shows no icon instead of authoring rules on a phantom collection.
   The ambient object pin (`route.id`) applies only when the id is a real object of the route's own
   collection (never for tab ids like `payroll-runs/periods`).
2. Shared primitives read that scope and self-sponsor icons: `DataTable` (per-row icon + export action),
   `RowActions` (verb icons on row menus), `Field`/`FieldAccess` (field-level, only for real field targets),
   `PageHeader accessCollection` (whole-collection icon on the title), `AccessTab` (per-tab sub-resource
   sections on profiles).
3. Anything not built from those uses the explicit primitives:
   - `AccessItem` - any bare card / list item / widget: nests an item-level scope + corner key icon.
   - `AccessAction` - any action element: `create` for "new X" buttons, `verb` for custom-method buttons,
     bare for object/collection targets.

### Page conventions (gated by `test/webAccessCoverage.test.ts`)

- Route key ≠ collection → rebind with an inner `<AccessScope>` (Schedule → `shift-assignments`,
  Timesheets → `time-entries`) and put `accessCollection` on the `PageHeader`.
- Settings-embedded editors (no route scope) bind their collection explicitly and mark the heading, the
  create button, and each card (`ShiftsAdmin`, `ProjectsAdmin`, `BenefitPlansAdmin`, `ReviewCycles`).
- Every button that calls `invoke()`/`upload()` with a verb is wrapped in `<AccessAction verb=…>` carrying
  the row's `objectPath` + `access.can`.
- Card/list pages wrap each item in `<AccessItem>` with `can`/`why` so the modal's "you can / via" context
  is accurate.
- Read-only rollup pages point their header icon at the underlying collection (Recruiting analytics →
  `applications`; Team analytics → `employees`, the roster its rows are; Activity → `audit`). A rollup over
  MANY collections still names one: the report's own columns appear or vanish with the caller's access to the
  collection each was read from, which no icon on the page can change.
- Cross-collection targets never inherit the ambient object: `AccessAction`/`AccessItem` drop the ambient
  `objectPath` whenever their explicit `collection` differs from the ambient one (the export icon on a
  detail route, a settings-blob gear on a feature page). Settings-blob targets always pass
  `collection="settings"` explicitly - the same panel renders both in the Settings hub and in the inline
  gear Sheet on feature pages, where the ambient collection is the host page's.
- `PageHeader accessCollection` resets the scope around its icon, so the whole-collection icon never pins
  to a deep-linked row.
- `Profile` rebinds its content to `employees/<self>` so the shared section components (identity, bank,
  tax, …) target exactly what they target on `employees/<id>`.

`test/webAccessCoverage.test.ts` enforces the mechanical halves of this: every page references an access
affordance; every file calling `invoke()`/`upload()` references `AccessAction`/`RowActions`; every
per-object verb affordance passes the row's `can` hint (allowlisted with a reason only where the object
never arrives as a row); no action is merely `disabled` by a permission check; and every route key in
`App.tsx` has a gate in the nav (or is a declared identity surface).

## Registries that must stay in lock-step

- `src/http/accessHint.ts` `ACCESS_VERBS` / `KNOWN_VERBS`: the verbs probed for `access.can` per collection.
- `web/src/components/access/customMethods.ts` `CUSTOM_METHODS`: the web mirror (drift-gated by
  `test/customMethodsDrift.test.ts`; `tickets` intentionally excluded - its actions are managed by their
  own verb-scoped icons).
- `web/src/components/access/permMatrix.ts` `BASE_COLLECTIONS`: every grantable collection, grouped by
  module - the row set of the Permissions matrix and the fine-rules editor. Add new collections here
  (see the add-collection checklist).
- `src/domain/notificationConfig.ts` `NOTIFICATION_CATEGORIES` + `web/src/lib/notificationMeta.ts`
  `CATEGORY_META`: the `access` category (requests, grants, four-eyes decisions) lives in both.

## Human context layer

`web/src/components/access/collectionMeta.ts` is the single source for how the access UI *names and
explains* each collection: curated `label` / `singular` / `plural` (the auto kebab→words derivation
produced "all export", "a bonuse"), an `allPhrase` for what the org-wide tier really covers, and a `note` -
the one-paragraph answer to "what does granting this actually do?". Notes exist where real ambiguity does:
`export` (one app-wide switch, not per-table; exports only what the holder can already read), `activity`
(ANDed with record access), `settings` (per-section vs all sections), `users` (accounts, not employee
records), `leave-balances` (system-maintained; write = manual adjustment), and the like. `permMatrix.labelOf`
and the key-icon tooltips (`AccessTarget.describeTarget`) resolve through the same meta, so the matrix, the
fine-rules editor, and every hover name resources identically.

The ACL modal renders: the meta label in the title, a "Who can …" sentence for the exact target, the note
(info panel) when one exists, and - when the backend manifest offers only one scope tier - an explanatory
"Scope: org-wide - this is an app-wide capability with no narrower tiers" line instead of a lone
pre-selected chip that reads as a broken picker.

## Effective-access tooling

- **Preview endpoint**: `POST /v1/access-rules:preview` (service `src/services/accessPreview.ts`,
  real-D1 tested in `test/accessPreview.test.ts`) runs the SAME engine assembly the middleware uses
  (role + everyone + user grants + per-object exception rules) for up to 100 arbitrary subject users
  against one target (collection / object / field / verb) and reports read/write/admin, the asked verb,
  read provenance (`why`), explicit-deny flag, and disabled-account state. Read-only report, never an
  enforcement path (allow-listed as such in `test/singleSource.test.ts`). The verb `access-rules.preview`
  is fail-closed: super by default, grantable via the ACL itself.
- **View-as panel** in the ACL modal ("Check a person's access"): pick a person, see the engine's verdict
  for exactly the open target - ladder badges (or "can create" / "can <verb>"), deny flag, provenance.
- **Impact warnings**: setting a role to deny, denying a verb, or removing a rule first asks the engine
  how many people can currently do the thing and says so in the confirm dialog.
- **Deny visibility**: in access mode the key icon turns red when an explicit deny (approximately) covers
  its target - broad denies tint everywhere, object-pinned denies only their object; the tooltip says so.
  Rules are cached in `AccessModeProvider` (fetched on mode-on, refreshed when the modal closes).
- **Cross-scope context**: each role/user row in the modal shows "also: <scope> · <perm>" for the same
  subject's rules on the same target at other scope tiers, so a broader existing rule is visible while
  authoring a narrower one.
- **Presets** (plain collection targets): one-click Everyone bundles - "can view" (read all), "adds +
  sees all" (open wall), "adds + sees own" (self-service; offered only when the collection supports the
  self tier). Additive, deduplicating, confirm-first.
- **Access requests**: `POST /v1/access-rules:requestAccess` notifies every access admin (roles holding
  `access-rules.write`) that the caller wants a collection/verb. Fail-closed verb - an org enables the
  flow by granting `requestAccess` to Everyone from the "Who can manage access" icon. The web shell offers
  it automatically: any 403 raises a one-per-collection toast with a "Request access" action.
- **App-wide view-as**: with access mode on, the floating pill offers "view as…" (preview-capability
  holders): pick a person and the whole shell re-gates on THEIR server-computed capability set + role
  (`include_capabilities` on `:preview` returns the same scope-stripped set `/users/me` carries). The
  selection lives in a tiny external store (`lib/viewAsStore.ts`); `App` reads it and swaps
  `capabilities`/`role` on the `me` object it prop-drills everywhere AND on the `CapabilitiesContext` -
  so both context consumers (`usePermission`) and prop consumers (Sidebar, CommandPalette, workspace tabs,
  quick actions, pages checking `me.capabilities`/`me.role`) simulate consistently. Identity
  (email/employee_id) stays the admin's, so every data query still runs as the admin; per-row `access.can`
  hints also stay the admin's - the pill says so. The access-mode chrome runs on the REAL capabilities
  (passed to `AccessModeProvider` as a prop and re-provided around the pill + modal), so the simulation
  can never hide its own exit. Pickers that must be complete (view-as, add-user) use `listAll()` -
  cursor-following, not the 100-row first page.
- **verbMeta** (`web/src/components/access/verbMeta.ts`): labels + one-line descriptions for custom
  methods (generic verbs + per-collection overrides), used by the modal's chips/badges/sentences and the
  key-icon tooltips.
- **Findability**: modal user picker is a typeahead combobox; role/user rule lists grow filter boxes past
  one page; both permissions matrices (per-subject dialog and the org-wide roles × collections grid) are
  grouped by module (`COLLECTION_GROUPS`) with a filter box.
- **Rule reading + lint** (`web/src/components/access/ruleLogic.ts`, unit-tested in `test/ruleLogic.test.ts`):
  the pure counterpart to `accessRuleScope.ts` (which authors rules). It renders a rule as one sentence
  ("HR Admin has write access to their department's leave requests"), and judges whether it does anything:
  - `denied` - a deny covering the same target beats it (including an `everyone` deny, which the engine
    unions into every role);
  - `shadowed` - a broader allow already grants at least as much;
  - lifecycle notes (pending approval, expiry).
  The fine-rules table leads with the sentence and strikes through dead rules; the ACL modal uses the same
  logic for its author-time "a deny is already in place" warning and its commit line.

## Render + request gating (least-privilege UI)

Every layer that shows or fetches is capability-gated, each at ONE central place:

- **Fetches**: `useCollection` refuses to fire without `<collection>.read` - it settles `ready`+empty, so
  data-driven UI collapses to its empty state instead of skeleton-ing or spraying 403s. (Self-scoped
  grants still strip to `<collection>.read`, so self-service pages keep fetching; the server narrows
  rows.) Direct `get()` calls are page-gated (nav) or fall back silently; the request-access 403 toast
  fires only for non-GET (user actions), never background reads.
- **Nav**: `navPerm()` derives `<collection>.read` for every entry/tab without an explicit `perm`; only
  Dashboard/Profile are unconditionally visible. Applied by Sidebar, CommandPalette, ShortcutLayer, and
  the workspace tab bars.
- **Routes**: `pageGate()`/`pageVisible()` (nav.ts) answer what a ROUTE requires, and `App` renders
  `<NoAccess>` instead of the page when the answer is no - so typing, bookmarking or pasting the URL of a
  page the sidebar hides hands over the wall (with "Request access"), never the page. The same function
  gates the sidebar, ⌘K and the g-chords, so all four can't disagree. Routes that render another page's
  component (the Settings deep links) or arrive from chrome (Support) declare their gate in `ALIAS_GATE`;
  only Dashboard, Profile and Notifications are identity surfaces open to everyone.
- **Create buttons**: `AccessAction create` returns null without `<collection>.write` - one gate for
  every "new <X>" button app-wide. Access mode overrides so admins can manage the create gate itself.
- **Verb buttons**: `AccessAction verb=…` returns null unless the caller may perform that verb - the row's
  `access.can` when a row is in hand (the precise, per-object answer), else the caller's capability for the
  verb (a collection-level action like "submit the week" has no row to ask about; a standard `update`/
  `delete` maps to the write level). So an action declares what it needs and hands over the row's hint, and
  no button reaches the screen whose only outcome is 403. `manageOnly` opts out for a child that is a
  DISPLAY element naming the verb (a read-only Status select still showing which column a task is in).
  Access mode overrides both, except mid-simulation, where the simulated user's own answer must show.
- **Row actions**: `RowActions` drops any verb-carrying action the row's server-computed `access.can`
  does not include (callers still pre-filter; this is the backstop).
- **Never `disabled`**: a permission answer belongs in the render decision. `disabled` is for STATE (busy,
  invalid, a locked row); an action the caller may never perform is absent, not greyed out. The exception is
  a control that IS the data (a checklist tick-box showing what is done) - it stays, read-only.
- **Bell**: the notifications provider treats the read capability (not just fetch errors) as
  `available`, so the bell disappears for holders of nothing.
- Settings gear (`settings.write` + per-entry perm), export button (`export.read`), activity affordances
  (`activity.read` / per-collection), quick-create menu and ⌘K actions (per-action caps) were already
  centrally gated.

## Access-mode UX

- Entry points: the user menu (visible only to `access-rules.write` holders) and a ⌘K action ("Turn on
  access mode"); state is per-user in localStorage. Toggling announces itself on an `aria-live` region, and
  the first time an admin turns it on a one-time coach card explains what the keys are.
- While ON, a fixed amber pill (bottom-center) names the mode, counts the manageable targets on the current
  page, links to the org-wide permissions grid, offers "view as…", and exits in one click.
- Icon density: table row keys hold their column but fade back until the row is hovered (`.access-row-key`);
  tab keys are overlaid, not laid out, so toggling the mode never re-flows a tab bar; on touch every key gets
  a finger-sized hit area (`.access-key`).
- The ACL modal shows, top to bottom: the human-readable target ("the *approve* method on their department's
  loans"), the caller's own `can`/`why` context, **who currently holds it** ("2 roles + 1 person can see
  this", plus anything awaiting approval) with a "recent changes" strip read from the audit trail, the
  collection note, scope chips (narrowest-first, backend-driven), any deny in force on this exact target,
  presets, the view-as panel, custom-method drill-in chips, and Users/Roles tabs with the reserved
  **Everyone** role pinned first. Every rule row carries who added it and when, its expiry, and - for a
  pending four-eyes change - approve/reject.
- Authoring: the user tab grants to SEVERAL people at once (chips), takes an optional expiry, warns before
  writing an allow a deny would nullify, echoes the exact rule as a sentence on the Add button ("Grant: ana@…
  has read access to all leave requests"), explains create-vs-write in create mode, and follows every change
  with an 8-second **Undo** that restores the previous rules exactly.
- The modal caps its height against the dynamic viewport and scrolls internally, so it stays usable on a phone.

## Org-wide views (Settings → Permissions)

- **Roles × collections grid**: the editable org-wide level per cell, grouped by module with a filter, plus
  the effective-access context the cell alone can't show - `+all:<level>` when the `everyone` role already
  grants it, `+N` when narrower (own/department/field/method/object) rules exist - and a key on every cell
  that opens the full ACL modal for that collection.
- **Pending changes queue**: everything awaiting four-eyes approval across every collection, with the
  approve/reject buttons (each a grantable verb target of its own) and the switch that turns the
  requirement on.
- **Compare roles**: two roles side by side, differing collections first, with one-click copy of either
  role's rules onto the other.
- **Export / import**: every rule as JSON for review, backup or promotion between environments. Import
  replays the bodies through the same POST endpoint, so validation, the four-eyes queue and the audit trail
  all apply; it only ever ADDS (duplicates are skipped, nothing is removed).
- **Permission-change feed**: Activity → "Permission changes" is the org-wide audit feed pre-filtered to
  `access-rules`. Every rule event carries meta (rule id, collection, pattern, effect, a readable sentence),
  which is also what the modal's provenance lines and history strip read.

## Notifications

Access changes announce themselves on the existing rail (category `access`, default priority high):
`access.requested` (someone hit a wall and asked), `access.granted` ("You now have write access to …",
allows only, `everyone` grants excluded so an org-wide rule doesn't page the whole company),
`access.changePending` (a four-eyes change needs a second admin) and `access.changeDecided` (the requester
hears the outcome).
