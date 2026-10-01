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
  (pinned via `scope_ref`); `self` / `dept` / `named-dept` / `all` are chosen from the chips. The grantable
  tiers per collection come from the backend policy manifest carried on `users/me` (`caller_access.scopes`) -
  the UI never hardcodes them.
  - **`named-dept` ("One department")** is the tier that says WHICH department rather than "the subject's
    own". It brings its own department picker, so unlike `subtree` it needs no object on the page - the
    department being granted has nothing to do with the row the modal was opened on. It is stored as a
    `subtree` rule anchored to a `departments` object, because that is what it is (`<deptCode>-*`), and it is
    **derived**, not declared: a collection that offers `dept` is department-coded, so it can be anchored to
    any department (`supportedScopesOf`). The add buttons stay disabled until a department is picked - without
    an anchor the rule would degrade to org-wide, the opposite of what was asked for.
- **Every row-scoped grant is paired with a list gate.** The engine decides a LIST on the one-token key
  (`leave-requests.read`), which no scoped pattern can match - so "read their own leave requests", authored
  alone, decides every item correctly and 403s the page, and the client cannot warn either (`capabilitiesOf`
  strips the scope, so the SPA believes the collection is readable and fires the request that fails). The
  seeded roles never hit this because each holds the bare collection grant alongside its scoped rules. So the
  modal authors that pairing too: one extra rule at READ (never create - that is the bare rule at WRITE and
  stays the separate "new X" affordance), as its own visible, removable row, skipped when the subject already
  reaches the collection via their own rule, their role or `everyone`. Rules authored elsewhere (the
  fine-rules editor, import, the API) get the `unlistable` lint instead.
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
    requester may withdraw their own request: deleting a pending grant drops it, and re-creating a rule
    exactly as it stands puts its pending removal back to `active` (audited `access-rule.removalWithdraw`).
    Deleting a rule already marked for removal is refused, since that would be the removal applied unapproved.
    A rule on its way out does not block a different rule on the same pattern, so an edit (removal + create)
    queues both halves. A one-admin org unblocks by turning the setting off.

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
   sections on profiles). A page whose tabs were SCOPES of one collection rather than sub-resources keeps the
   collection icon on the heading instead - Support is the one that moved, when its four identity tabs became
   scope chips on a single table (docs/07-table-interactions.md §6).
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
- `/profile` and `/employees/<id>` are ONE page (`pages/EmployeeProfile.tsx`); `pages/Profile.tsx` is a route
  wrapper that passes `basePath="profile"` and handles the one case that never reaches it (an account with no
  employee record). The page binds its OWN `<AccessScope collection="employees" objectPath={empPath}>` rather
  than inheriting the route's, because `ROUTE_SCOPE.profile` is null - so every section affordance targets the
  same record whichever address the reader arrived by, and the tab set, order and names cannot diverge between
  the two.

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
  (see the add-collection checklist). Every name in it must be a real member of `COLLECTIONS`, or the rules
  its row authors are refused as naming an unknown collection - gated by `test/collections.test.ts`. The
  converse is deliberately not gated: `COLLECTIONS` holds plumbing (`batch`, `preferences`, `event-log`,
  `cron-runs`) that no admin should be offered a row for.
- `src/domain/manifests.ts` `COLLECTION_FIELD_CAPABILITIES`: the capabilities whose `field` slot names a
  target COLLECTION (`activity`, `export`). The fine-rules editor shows its "For collection" picker from this
  set, and `isFieldScopeTarget` validates against it, so the picker and the validator cannot disagree.
- `src/domain/notificationConfig.ts` `NOTIFICATION_CATEGORIES` + `web/src/lib/notificationMeta.ts`
  `CATEGORY_META`: the `access` category (requests, grants, four-eyes decisions) lives in both.

## Human context layer

`web/src/components/access/collectionMeta.ts` is the single source for how the access UI *names and
explains* each collection: curated `label` / `singular` / `plural` (the auto kebab→words derivation
produced "all export", "a bonuse"), an `allPhrase` for what the org-wide tier really covers, and a `note` -
the one-paragraph answer to "what does granting this actually do?". Notes exist where real ambiguity does:
`export` (any table, or one named table; exports only what the holder can already read), `activity`
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
  flow by granting `requestAccess` to Everyone from the "Who can manage access" icon, or from the key icon
  the wall's "Request access" button carries in access mode. The web shell offers it automatically, but
  only to a caller who holds the verb: any 403 raises a one-per-collection toast, with a "Request access"
  action for a holder and a plain "ask an access admin" line for everyone else, and the
  `NoAccess` wall shows its button only to a holder. The wall collects a reason and an optional duration (4h / a day / 3 days / a week, capped at a
  fortnight server-side). The duration grants nothing - it travels to the admin so they set a matching
  expiry, which is the existing temporary-access mechanism. Every request also writes an
  `access-request.raised` audit row carrying the reason: a request that every admin ignores used to leave no
  trace at all, and "why did this person get payroll write in March" is the question a reviewer asks.
- **Starter packs** (`web/src/components/access/roleTemplates.ts`): a new role is deny-all, so "Start from a
  template" seeds one from a curated least-privilege bundle - Recruiter, Auditor, Team lead, IT/asset
  manager, Benefits administrator, Front desk. Each is a list of rule bodies replayed through the ordinary
  create path (same validation, same four-eyes queue, same audit), listed in full before it is applied, and
  additive. Applying one to a PERSON rather than a role is how somebody takes on a second job's access
  without inventing a role for it; their copy does not follow the template afterwards, which the dialog says.
- **Recertification**: with the `access-review` setting on, a nightly cron digests the STANDING privileges
  (permanent, active, write-or-better or a custom method, excluding `everyone`) to the access admins every
  90 days. It only reminds - no access is ever changed for anyone - and due-ness lives on the setting, so a
  skipped tick runs late rather than being missed. Toggled beside four-eyes: the two halves of governing a
  rule's life, one guarding how it is made and one asking whether it is still wanted.
- **"Who can see your data"** (profile → Privacy): the effective-access report aimed at the subject instead of
  an admin - who can currently read each area of their data, whether they can also change it, and why. The
  areas are a catalogue in `services/myViewers.ts`, in four groups: the employee record and its sensitive
  sub-resources, pay and money, work and performance, documents and cover. A sub-resource area is graded as
  `employees.<code>.<field>`; an area that lives in its own collection is graded on one row the caller owns, or
  - with no rows yet - on a code that WOULD be theirs, so the answer is "who would see one" and the record
  count beside it says none exist. It is `previewAccessMany` with every target nailed to the caller's own
  records, which is what makes `employees.me.viewers` safe to hold for everyone. It runs WITHOUT the
  subject-scope bound the ACL panel's `:preview` carries: that bound asks whether the caller may read each
  *reader's* user record, which no ordinary employee can, so it refused the one report written for them. The
  disclosure it would have guarded is narrower here by construction - only people who can already read
  something of the caller's, and only the name and work email the directory shows anyway.
  NOTHING ABOUT THE READER BUT THEIR NAME. No role is in the payload, and the only `why` it sends is `exact` -
  "shared with them specifically", which is a fact about the caller's own record. Every scope-derived reason
  (`dept`, `subtree`, `all`) is dropped rather than reworded: each one describes how far that person's access
  runs, and on a page every employee can open those sentences add up to a survey of who is powerful. No reason
  at all is the safe answer. The role-level view is the access screens' job.
  The web side (`components/common/MyViewers.tsx`) is MASTER-DETAIL: a dense list of areas on the left (in
  foldable sections), the selected area's readers in a sticky pane on the right. It was a column of accordion
  cards, which wasted the right half of the tab on every row and pushed the page down whenever one opened, so
  two areas could not be compared without scrolling between them. Each list row carries two tallies - an eye
  for people who can only look, a pencil for people who can change it - and the two buckets are DISJOINT, the
  same split the detail pane sorts every name into. An eye that meant "readers, editors included" would be two
  numbers silently sharing members. An area nobody else reaches shows a lock rather than a pair of zeroes. Below `lg` there is no second column, so the same
  `AreaDetail` mounts in a Sheet instead; the pane is one function either way. Up/Down move the selection
  through what is on screen, skipping folded sections, on top of normal Tab order.
  It has ONE axis and it is the data. A per-person pivot (one row per colleague, expanded to every area of
  yours they reach) existed briefly and was removed for the reason the roles were: rolled up per person it
  stops being a fact about your data and becomes a profile of that colleague's reach, which any employee could
  page through to map who is powerful. The headline counts stay - they say how exposed you are and name
  nobody - but a per-person breakdown must not come back.
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
  - `unlistable` - a row-scoped level rule with nothing that opens the collection (see the list gate above).
    Rendered as a warning but NOT struck through, unlike the two above: the rule is live and correct for every
    individual record, it just has no page to show them on, so the fix is to add a rule, not delete this one;
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
  page the sidebar hides hands over the wall (with "Request access" where the org enabled it), never the page. The same function
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
- **Per-record panels** (a tab or card about ONE named employee): `useSubjectCanRead(collection)` /
  `useSubjectCanWrite(...)`, reading `access.subject` off the employee resource - never a capability, never a
  breadth, and never `isSelf`. THE CLIENT HOLDS NO POLICY HERE. It does not know that an employee sees their
  own record, that a manager sees their team, or that HR sees everyone: those are rows in `access_rules`,
  editable at runtime, and a real deployment's roles will not resemble the seeded ones.
  - Why not the capability: it is scope-STRIPPED (`domain/permissions.ts` `stripScope`), so `attendance.me.**`
    and `attendance.**` both arrive as `attendance.read`. Every employee clocks in, owns goals, reads their own
    payslips and holds their own bank/identity/tax, so the string is true for everybody about everybody.
  - Why not a per-collection breadth either: a breadth is probed with synthetic codes belonging to nobody, so
    it reports a TIER. A tier cannot say whether THIS person is the caller, is in their department, is in their
    reporting chain, or is the subject of a per-object share - `my-reports` could only be reported as the
    blanket `dept` (tab for everyone, rows for the reports alone) and a share vanished entirely.
  - The answer comes from `domain/access.ts` `subjectScopes(grant, self, subjectCode)`, which probes
    `<collection>.<subjectCode>-<leaf>` - a row OWNED BY that person - so `me`, `my-dept`, `my-reports`,
    `my-org`, `<code>-*` and a merged share each match on their own terms with no case analysis. It runs on the
    employee item, where `ctx.objectGrant` already carries the shares, and ships as `access.subject`
    (`{read, write}` key lists; keys are collection names, `employees.<sub>`, `activity.<collection>`; absent
    means no). Both profile pages provide it through `SubjectScopesContext`, so a card nested deep inside reads
    the same decision the tab did.
- **Caller-level breadth** (`useCanReadOthers` / `useCanWriteOthers`, from `caller_access.read_scopes` /
  `write_scopes`) answers the DIFFERENT question "is there anybody but me I could do this for at all" - should
  the org chart offer a who-is-off overlay, should the approvals page show a queue whose premise is deciding
  for someone else. It names nobody, so it is never a per-record gate.
- Gates: `test/subjectScopes.test.ts` proves each rule shape reaches the right person from SYNTHETIC grants
  (never seeded role names - the mechanism is what must hold); `test/callerScopes.test.ts` scans the per-record
  sources and fails on a stripped capability, a caller-level tier or the retired `useCanReadFor`.
- **One tab, several grants**: a merged tab carries ONE `AccessTab` target, so every card under it that is a
  separate grant carries its own `AccessAction` key. The tab names a single collection while the tab holds
  several - Performance is goals + cards + reviews behind a `goals` tab, Posts is announcements + suggestions
  behind an `announcements` one, Compensation holds the `employees.tax` sub-resource beside `compensation` -
  so without the per-card keys an admin asked for sight of somebody's reviews opens the only key on screen and
  grants goals: the ACL says yes, the tab does not change, and nothing says why. A `RevealCard` takes a
  `target` for the same reason one step on - the panel that owns the key is not mounted while it is closed.
  `test/webAccessCoverage.test.ts` fails a per-record panel that references no affordance at all.
- **A collection nobody can find is a permission nobody can grant**: every collection in `SUPPORTED_SCOPES`
  (the ones the engine honours a scoped rule for) has a row in `permMatrix.ts` `COLLECTION_GROUPS` and, where
  the kebab name reads badly or the grant needs explaining, an entry in `collectionMeta.ts`. The matrix is the
  only place an admin discovers a grantable resource; `attendance-day-marks` shipped with seeded grants and no
  row, so the only way to author one was the raw API. `test/collections.test.ts` pins both directions (phantom
  rows, missing rows). Starter bundles in `roleTemplates.ts` are held to the seeded role they mirror: a
  template for the line manager that omits what `manager` holds is a suggestion that quietly under-grants.
- **Every tier the engine has, everywhere a tier is read**: the manager chain (`my-reports` / `my-org`, stored
  as `reports` / `org`) is a scope like any other, and the places that enumerate tiers by hand have to carry
  it - the modal's provenance labels, the `unlistable` lint's row-scoped set, the rule sentences in the audit
  trail and the permissions panel, and the `why` unions on the client. Each one that missed it failed quietly:
  a chain rule with no list gate drew no warning, and "via " rendered with nothing after it.

- **Bell**: the notifications provider treats the read capability (not just fetch errors) as
  `available`, so the bell disappears for holders of nothing.
- Settings gear (`settings.write` + per-entry perm), export button (`export.read` / per-collection), activity
  affordances (`activity.read` / per-collection), quick-create menu and ⌘K actions (per-action caps) are all
  centrally gated. The export button reads the TABLE's own collection, so `export.<collection>.read` lights up
  that table alone; the custom-grid builder deliberately requires the broad capability, since one grid draws
  columns from several collections and no single one stands for what the file would hold.

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
- **Users × collections grid**: the same cells for per-user grants. A per-user rule is the exception in this
  app, so the grid is mostly empty by construction: "Only collections with access" drops every column no
  visible user has anything on, and says how many it hid. Off by default, like "Only rows with access" on the
  roles side, because a matrix that hides most of itself on arrival makes a different claim about the data.
- **All rules**: every rule as a sentence with the dead-rule lint, filterable by subject, collection, scope,
  permission and state. Each row is edited in place - scope, field, level or method, effect, expiry, and the
  limit / window / network fence where the collection takes one - or removed. The API has no in-place rewrite
  of a grant, so an edit replaces the rule (`cloneRules.ts` `replaceAccessRule`): the new rule is created
  first, which doubles as the dry run because the server checks a body before it looks for a duplicate, and
  only a body that keeps the old rule's pattern takes that rule out first, putting it back if the create
  still fails. An object-anchored rule keeps its object for as long as it keeps its scope.
- **Pending changes queue**: everything awaiting four-eyes approval across every collection, with the
  approve/reject buttons (each a grantable verb target of its own) and the switch that turns the
  requirement on.
- **Compare roles**: two roles side by side, differing collections first, with one-click copy of either
  role's rules onto the other. The copy is `POST /v1/access-rules:clone` (`{from, to}`, each
  `{subject_kind, subject}`) - one request, own fail-closed verb (`access-rules.clone`, so bulk copying is
  grantable apart from authoring single rules), and ACTIVE rules only. The server authors each rule, guards
  included, through the normal create path (same validation, same four-eyes queue, one audit entry each) and parks one
  correlation id on all of them plus an `access-rule.clone` summary entry, so the whole copy replays as a
  single act in the activity feed; the response returns that `correlation_id` with `added`/`skipped`/
  `failed`. One notification covers the batch instead of one per rule.
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
