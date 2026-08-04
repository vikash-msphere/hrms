# Inline settings on feature pages (like Boards Configure)

**Status: implemented.** Sheet primitive `web/src/components/ui/sheet.tsx`; lazy panel entry `web/src/settings/panels.tsx` (exports `SettingsPanelContent`, wraps the now-exported `renderSettingsPanel`); trigger + host fan-out `web/src/components/common/SettingsButton.tsx` (`SettingsButton` / `PageSettings`); data map `HOST_SETTINGS` in `web/src/settings/registry.ts`; deep-link via `?setting=<key>` on the page hash (`setQueryParam` in `web/src/router.ts`, `Route.query`). Gears wired into all mapped host pages via `PageHeader actions`. tsc + web build green; panels stay in the on-demand Settings chunk, feature-page bundles unchanged.

**Settings have a `scope` so per-instance / per-user config is not a divergent system.** A registry entry is `entryScope(e)` = `"org"` (default), `"object"`, or `"user"`. Every scope shares the same machinery — one registry, the right Sheet, one gear (`SettingsButton`), the same `?setting=` deep-link:
- **`"org"`** — a singleton (leave policy, pay components). Gated on `settings.write` + `entry.perm`. Hub card opens the panel in place; footer "Open full settings" → `settings/<key>`.
- **`"object"`** — one instance's config (a board's columns/WIP/swimlanes/labels: entry `board-config`, panel `web/src/settings/BoardConfigPanel.tsx`). The inline gear lives on the object's own page and passes `objectPath` + the instance's `can`; gated on the object's own verb (`boards:configure`), not `settings.write`. Deep-link carries the instance: `?setting=board-config&settingObj=<path>` (both move together via `setQueryParams`). The panel reads/writes the object through the shared collection cache (`useCollection` + `invalidateCollections`), so the host view refreshes with no extra fetch. ACL affordance is the panel-header `AccessTarget` (built at runtime with the instance path), replacing the old per-gear `AccessAction verb=configure`.
- **`"user"`** — the caller's own preferences (notification mutes: entry `notification-prefs`, panel `web/src/components/notifications/NotificationPrefsPanel.tsx`, on the Notifications page). Ungated; visible to everyone; the panel derives the employee from `me`.

Non-org entries have no single instance to edit in the central hub, so their hub card + rail item are **nav cards** that jump to `hostPage` (`goToEntry`), and a direct hit on `#/settings/<non-org-key>` bounces there (`SettingsRedirect`). They stay in the one registry so search / command palette / the hub still surface them. Boards' bespoke tabbed Configure `Dialog` and the standalone notification-prefs popover are gone — both now route through the Sheet. New per-instance config = a registry entry with `scope:"object"` + a panel case, not another parallel dialog.


## Context

Boards has a Configure button (gear → tabbed Dialog) that edits the board's settings **on the board page**, no navigation away. Every other configurable surface instead lives in a central Settings hub (`web/src/pages/Settings.tsx`, ~110K) reached at `#/settings/<key>`. To change leave policy, pay components, ticket categories, etc. the user must leave the feature page, go to Settings, find the panel, edit, come back.

Goal: surface each setting **inline** on its natural host page via a gear affordance that opens the same panel in a dialog — without deleting the central hub (it stays as the browse-everything surface).

## How settings work today (Phase-1 findings)

- **Registry** `web/src/settings/registry.ts` — flat `SETTINGS_REGISTRY` of 31 entries, each `{key,title,desc,group,icon,keywords,perm,target}`. Metadata only, cheap to import (already used by nav + command palette). `settingsEntry(key)` looks one up. `canSee(me,entry)` = `!entry.perm || hasCapability(me.capabilities, entry.perm)`.
- **Panel bodies** `renderSettingsPanel(key, me, toast, slot, openId)` — a big `switch(key)` in `Settings.tsx` (NOT exported) returning the JSX panel. Panels are self-contained; most take just `toast`, some take `openId`, a few reuse existing pages in `embedded` mode (`<LeaveTypes embedded/>`, `<PayComponents embedded/>`, `<Departments embedded/>`, …). Only the Access panels (users/roles/permissions) use the `slot` header-portal.
- **Routing** `Settings.tsx` default export renders `SettingsHub` (search + grouped cards + setup checklist) or `SettingsPanel` (left rail + header w/ `AccessTarget` + body). Legacy key remap in `SETTINGS_LEGACY`.
- **Host pages** every feature page uses `PageHeader` (`web/src/components/common/PageHeader.tsx`) which already accepts an `actions` prop — the drop-in point for a gear button. Gating everywhere via `usePermission("settings.write")`.
- **UI kit**: only `dialog.tsx` exists (no Sheet/Drawer). Boards' Configure uses a large centered `Dialog` with `Tabs` + scroll — the proven pattern to mirror.

## Design

1. **Extract panels into a lazily-loadable module** `web/src/settings/panels.tsx`:
   - Move `renderSettingsPanel` + all its heavy imports out of `Settings.tsx` into `panels.tsx`, exported as `SettingsPanelContent({ entryKey, me, toast, openId })`.
   - `Settings.tsx` imports it from there (no behavior change to the hub/page).
   - Keeps ALL panel code in one chunk, loaded on demand — so feature pages don't bloat their bundles.

2. **New Sheet/Drawer primitive** `web/src/components/common/sheet.tsx`:
   - Right-side, full-height, ~720px wide, its own scroll region; sticky header + sticky footer; overlay + focus trap + Esc close, mirroring `dialog.tsx` conventions.
   - This is the single presentation for all inline settings — roomy enough for big panels (Letters, Pay components, ATS), fine for small ones, no branch-by-size. Uniform model: gear → panel slides in from the right, everywhere.
   - Centered `Dialog` is NOT reused for settings. Boards Configure keeps its own tabbed Dialog (different shape: multi-tab config); optional later migration, not blocking.

3. **New reusable trigger** `web/src/components/common/SettingsButton.tsx`:
   - Props `{ settingKey: string; openId?: string }`.
   - Reads `settingsEntry(settingKey)` + `useMe()`; renders nothing if `!usePermission("settings.write")` or `!canSee`.
   - Renders a gear `IconButton` (tooltip = entry.title). On open → `Sheet` whose body lazy-loads `panels.tsx` (`React.lazy` + `Suspense`). Sticky header shows `entry.title` / `entry.desc` / `<AccessTarget target={entry.target}/>` (mirrors `SettingsPanel`'s header); sticky footer has an "Open full settings" link to `settings/<key>`.
   - **Open state is deep-linked to the hash**, not local state: a `?setting=<key>` param on the host page hash (e.g. `#/leaves?setting=leave-policy`). Shareable, back-button closes, survives refresh, CmdK/nav can target an inline panel. Invalid or not-permitted key for that host → falls back to closed.

4. **Data-driven host mapping** (not hand-wired per page):
   - Host→setting mapping lives as data in the registry module — `HOST_SETTINGS: Record<HostKey, string[]>` (or `hosts?: string[]` on each registry entry).
   - `PageHeader` renders a small `<PageSettings host="leaves"/>` in its `actions` slot; that component reads the map and emits the right gear(s) automatically. New settings self-wire by adding a map row; "which pages have inline config" is inspectable data, not scattered JSX.
   - First pass covers ALL mapped pages (data-driven means one mechanism, not 30 edits). Mapping (host page → setting key(s)):
     - Leaves/LeaveCalendar → `leave-policy`, `leave-types`
     - Attendance → `attendance`; Schedule → `shifts`; Timesheets → `projects`
     - PayrollRuns/Payslips → `pay-components`, `payroll-policy`, `pay-grades`, `salary-structures`, `bank-formats`
     - Reimbursements → `reimbursements`; Benefits → `benefit-plans`
     - Pipeline/Requisitions/Candidates → `recruiting`; Referrals → `referrals`
     - Reviews/ReviewCycles/Goals → `performance`; Onboarding → `onboarding-templates`
     - Documents/Letters → `letters`, `letter-defaults`, `esign`
     - Tickets → `ticket-categories`, `ticket-checklists`; Notifications → `notifications`
     - Directory/EmployeeProfile → `employee-fields`, `employee-ids`; Dashboard → `dashboard`; Kudos → `kudos`; Departments/OrgChart → `departments`
     - No inline host (stay Settings-only): identity, banks-currency, defaults, users, roles, permissions, operations.

## Verification

- `npx tsc --noEmit` (root + `web`).
- Manual: on each wired page, gear appears only for `settings.write` holders; opens the correct panel in the Sheet; deep-link `?setting=<key>` opens it directly and back-button closes; edits persist (same API calls as the hub); central `#/settings` hub still works unchanged.
- Bundle check: `npm run build:web` — confirm `panels` split into its own chunk, feature-page chunks not bloated.
