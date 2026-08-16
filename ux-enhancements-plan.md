# UX enhancements

Status of the full-app UX overhaul (from the 2026-07-31 audit). Everything below is implemented and
typechecked; the last section lists what stays open.

## Tables (DataTable.tsx)

- **Bulk actions**: pass `bulkActions` (label/icon/confirm/disabled/run) to get a leading checkbox column,
  header select-all over the filtered set, and a sticky bulk bar. Selection tracks the filtered rows and only
  clears on success. Adopted on Tickets (Resolve/Close on the servicing queues); `lib/bulk.ts` has
  `bulkInvoke`/`bulkSummary`/`mergeBulkResults` for per-row-fault-tolerant verb fan-out.
- **URL state**: sort + filters mirror into the hash query as one `t.<tableId|accessCollection>` param
  (`history.replaceState`, debounced; dropped when equal to the column defaults). Filtered views are
  shareable and survive navigation; the router's unsaved-changes guard ignores query-only changes.
- **Saved views**: named snapshots of a table's filters, sort, search box and visible columns (Bookmark
  button next to the column picker), stored in tablePrefs so they sync cross-device. The list always opens
  with a built-in "Default" that restores the column defaults; star a saved view to make the table open
  on it (a deep link carrying `t.<key>` state wins over the star). The active view is derived from live table
  state, so the bookmark button names it and the tweak that leaves it clears the label. Same name overwrites
  (keeping its star); delete on hover.
- **Density**: comfortable/compact toggle in the column picker, persisted in tablePrefs.
- **Mobile cards**: below `sm` the table renders as cards - best-ranked column (`mobilePriority` on the
  column def, defaulting to visible order) becomes the title, the next three become labelled lines, trailing
  action columns ride top-right. Children of expandable rows are always visible.
- **Server paging**: `useCollection` exposes `loadMore()` (resourceStore follows `next_page_token` and
  appends). Tables pass it as `onLoadMore`; the footer's "first page only" notice becomes a Load more
  button. Wired on Directory, Tickets (both also have server-side `q` search) and Boards; other pages adopt
  with one prop each.

## Approvals

Pending rows the caller may decide carry checkboxes; the bulk bar (select all / approve / reject) fans out
per collection via `bulkInvoke`, optimistically hides only the rows that succeeded, and keeps failures
selected for retry. Bulk reject sends no note (individual reject still does).

## Resilience

- **Session expiry**: a mid-session 401 no longer replaces the app. `api.ts` hands the event to a handler
  App registers once signed in; the SessionExpiredDialog overlays the still-mounted page (typed work
  survives), sign-in opens in a new tab, and "I've signed in" probes `/users/me` to resume. Initial-load
  401 keeps the redirect. Cross-tab: sibling tabs get the same overlay.
- **Undo over confirm**: `useSoftDelete` deletes immediately and the toast carries an 8s Undo (restore);
  hard delete still confirms. The toast store now supports `action` and per-toast `duration`.

## Speed

- **Optimistic votes**: suggestion up/downvotes apply locally, fold the server's reserialized row, refetch
  nothing (`suggestions:upvote/downvote` map to no invalidation). Notifications and board read/react were
  already optimistic.
- **Self-hosted fonts**: Inter loads from `@fontsource` at the top of index.css; the decorative
  wordmark/post faces lazy-load on first use through `orgNameFontStack` (loaders in `lib/fonts.ts`). No
  Google Fonts request; the SPA CSP carries no remote host.

## Platform

- **PWA**: `manifest.webmanifest` is emitted by a small Vite plugin (name follows VITE_APP_NAME), linked
  with a theme-color meta; the app is installable.
- **Web push**: opt-in browser notifications while no tab is open.
  - Server: `PushSender` port (`lib/webPush.ts`, VAPID + aes128gcm via `@block65/webcrypto-web-push`),
    wired into Deps only when `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set (`VAPID_SUBJECT` optional,
    defaults to mailto:EMAIL_FROM). Single-recipient `notify()` mirrors the notification to the recipient's
    registered browsers (`services/webPush.ts`; one joined D1 read on the no-device path; dead
    subscriptions pruned). The notifyMany broadcast path deliberately does not push (subrequest cap).
  - Subscriptions live in the user's own `preferences` row under `push_subscriptions` (max 5 devices) - no
    new collection, caller-scoped routes gate writes.
  - Client: `web/public/push-sw.js` (show + click-to-focus), `web/src/lib/webPush.ts`
    (enable/disable/state), and a "Browser notifications on this device" row in the notification prefs
    panel. Gated on `VITE_VAPID_PUBLIC_KEY` being baked into the web build.
  - Setup: `npx web-push generate-vapid-keys`; set VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (+ optional
    VAPID_SUBJECT) on the worker and VITE_VAPID_PUBLIC_KEY in `web/.env`.

## Keyboard & navigation

- `ShortcutLayer`: `?` opens the shortcut reference, `g`+letter jumps pages (gated by the sidebar's own
  visibility rules), `[`/`]` walk the current workspace's tabs. Typing surfaces and open dialogs are left
  alone. Table rows already had arrow/Enter navigation.
- Command palette frecency: what you open ranks first - localStorage per user, "Recent" section on empty
  query, tie-break while typing.

## Accessibility & polish

- `prefers-reduced-motion` collapses all animation/transition to one frame (spinners exempt).
- Checkbox primitive renders a real indeterminate state.
- Expenses empty state gained its create CTA (other first-run empty states already had them); dashboard
  widgets already had matching skeletons; kanban cards were already keyboard-movable via the card dialog's
  column select.

## Still open

- Per-page `mobilePriority` tuning and a 375px pass over the top employee-facing pages (generic card layout
  is in; only Boards sets `mobilePriority` today).
- `onLoadMore`/`search` adoption beyond Directory, Tickets and Boards (one prop per page).
- Bulk actions on more DataTable pages (Transitions, payroll items). Only Tickets uses the `bulkActions`
  prop; Approvals runs its own selection over `bulkInvoke` because its rows span collections.
- Column filters translated to server query params on paged tables (client filters carry a truncation hint
  meanwhile).
- Draft autosave beyond leave/post composer (reviews, scorecards, ticket replies).
