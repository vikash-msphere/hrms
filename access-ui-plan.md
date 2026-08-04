# Access-control UI: model, coverage, conventions

The web app manages access **in context**: an admin toggles Access mode (user menu → "Access management",
or the floating amber pill to exit) and every governed element sponsors a small amber key icon that opens
the ACL modal scoped to exactly that thing. This document describes the model, what guarantees coverage,
and the conventions every page must follow. UX only throughout - the server authz middleware enforces
every request regardless of what the UI shows.

## The model

One resource - `access-rules` - expresses everything. A rule is
`subject (role|user) × collection × scope × [field] × [verb] → level|allow|deny`.

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
  `applications`; Activity → `audit`).
- Cross-collection targets never inherit the ambient object: `AccessAction`/`AccessItem` drop the ambient
  `objectPath` whenever their explicit `collection` differs from the ambient one (the export icon on a
  detail route, a settings-blob gear on a feature page). Settings-blob targets always pass
  `collection="settings"` explicitly - the same panel renders both in the Settings hub and in the inline
  gear Sheet on feature pages, where the ambient collection is the host page's.
- `PageHeader accessCollection` resets the scope around its icon, so the whole-collection icon never pins
  to a deep-linked row.
- `Profile` rebinds its content to `employees/<self>` so the shared section components (identity, bank,
  tax, …) target exactly what they target on `employees/<id>`.

`test/webAccessCoverage.test.ts` enforces the two mechanical halves of this: every page references an
access affordance, and every file calling `invoke()`/`upload()` references `AccessAction`/`RowActions`
(allowlist with reason for true exceptions).

## Registries that must stay in lock-step

- `src/http/accessHint.ts` `ACCESS_VERBS` / `KNOWN_VERBS`: the verbs probed for `access.can` per collection.
- `web/src/components/access/customMethods.ts` `CUSTOM_METHODS`: the web mirror (drift-gated by
  `test/customMethodsDrift.test.ts`; `tickets` intentionally excluded - its actions are managed by their
  own verb-scoped icons).
- `web/src/components/access/permMatrix.ts` `BASE_COLLECTIONS`: every grantable collection, grouped by
  module - the row set of the Permissions matrix and the fine-rules editor. Add new collections here
  (see the add-collection checklist).

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
  one page; the per-subject permissions matrix is grouped by module (`COLLECTION_GROUPS`) with a filter.

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
- **Create buttons**: `AccessAction create` returns null without `<collection>.write` - one gate for
  every "new <X>" button app-wide. Access mode overrides so admins can manage the create gate itself.
- **Row actions**: `RowActions` drops any verb-carrying action the row's server-computed `access.can`
  does not include (callers still pre-filter; this is the backstop). Verb buttons are NOT capability-gated
  - a per-object share grants a verb with no broad capability, and `access.can` is the authority there.
- **Bell**: the notifications provider treats the read capability (not just fetch errors) as
  `available`, so the bell disappears for holders of nothing.
- Settings gear (`settings.write` + per-entry perm), export button (`export.read`), activity affordances
  (`activity.read` / per-collection), quick-create menu and ⌘K actions (per-action caps) were already
  centrally gated.

## Access-mode UX

- Toggle lives in the user menu (visible only to `access-rules.write` holders); state is per-user in
  localStorage.
- While ON, a fixed amber pill (bottom-center) names the mode and offers one-click exit.
- The ACL modal shows: the human-readable target ("the *approve* method on their department's loans"),
  the caller's own `can`/`why` context, scope chips (narrowest-first, backend-driven), custom-method
  drill-in chips, and Users/Roles tabs with the reserved **Everyone** role pinned first.

## Remaining opportunities (not yet built)

### 1. Seeing the current state

- **Current-holders summary line** in the modal header: "2 roles + 1 person can approve" before the tabs,
  so the state is readable without scanning eight selects per page.
- **Org access overview page**: a collections × roles heatmap (effective level per cell, click-through to
  the modal). The per-subject matrix exists; there is no whole-org view.
- **Access-change feed**: the audit log already records access-rules writes; surface "what changed in
  permissions recently" as a filtered activity view + a "recent changes to this target" link in the modal.
- **Rule metadata in the modal**: who added a rule and when (joinable from the audit log) - "added by
  Vikash, 2w ago" turns mystery rules into accountable ones.

### 2. Authoring flow in the modal

- **Bulk grant**: select several users in one add.
- **Conflict warnings at author time**: adding an allow where a deny exists silently authors a dead rule -
  say "a deny is in place; this allow has no effect until it is removed". (The red key + "also" chips make
  the deny visible; the authoring-time warning is still missing.)
- **Undo toast** after every rule change (the app already has an undo-toast pattern).
- **Commit sentence**: the modal already builds "who can …" sentences - echo the final sentence on the add
  button ("Grant: managers can approve their department's leave requests") so the rule reads before it lands.
- **Create-vs-write note**: the create gate's relation to write on existing objects is a recurring
  confusion; one meta-note line in create mode.

### 3. Access-mode ergonomics

- **Discoverability**: the toggle lives only in the user menu - add a ⌘K action ("Toggle access mode"),
  and a one-time coach mark for fresh admins.
- **Icon density**: busy tables render a key per row plus keys per action; consider hover-reveal for row
  icons (the column stays, icons fade in per-row) to cut visual noise while keeping targets discoverable.
- **Pill upgrades**: a "Manage roles" shortcut on the floating pill; possibly a count of manageable
  targets on the current page.
- **Tab-bar stability**: AccessTab icons widen tabs when the mode toggles; reserve the space or overlay.
- **Mobile**: hover tooltips don't exist on touch; the pill can collide with small viewports - audit tap
  targets and modal scrolling.
- **Mode-change announcement**: aria-live on toggle so screen readers hear the mode flip.

### 4. Matrix & fine-rules editors

- **Group + search the matrix**: the per-subject "By collection" list is now ~65 flat rows - add the
  module group headers (the data is already grouped in BASE_COLLECTIONS) and a filter box.
- **Sentence-rendered rules**: the fine-rules table shows Collection/Scope/Field/Permission columns;
  render each rule as its sentence ("HR · write on their department's employees · bank-account field").
- **Role diff / copy**: compare two roles side by side; clone a role's grants to a new role or a user.
- **Rules export/import**: JSON dump + load for review, backup, and env promotion.
- **Dead-rule lint**: flag rules shadowed by a broader allow or nullified by a deny.

### 5. Model extensions (server + UI)

- **Expiring grants**: optional `expires_at` on a rule (contractor/temp access) + cron cleanup + "expires
  in 3d" badge.
- **Grant notifications**: notify a user when they gain meaningful new access ("You can now approve
  leave requests") - the notification rail exists.
- **Permission-change approval**: route access-rules writes through the existing approval/workflow engine
  for orgs that want four-eyes on grants.
