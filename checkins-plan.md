# Check-ins (1:1s) enhancements

Page: `web/src/pages/CheckIns.tsx`. Collection: `check-ins` (pair-private: employee + counterpart only; no seeded role grants). Server: `src/services/checkIns.ts` + `src/routes/checkIns.ts`; `action_items` JSON list, `meeting_date`, shared `notes`, `cadence`.

## Baseline UX pass (done)

Collapsed past rows (avatar, date, notes preview, open-count badge) with show-8/show-all, person filter chips, relative-day badges on upcoming (Today / Tomorrow / In N days), "Schedule next" prefill from a past card, Cmd+Enter notes save.

## Phase 1: working ritual (done, web-only)

- [x] **Carry-over open items.** "Schedule next" copies unfinished action items into the create payload (dialog shows "Carries N open action items forward"). After the new 1:1 is created, the source's open items are marked done - "moved forward", so they are never open (or offered) twice.
- [x] **Open-items rollup on upcoming cards.** An upcoming 1:1 shows an amber "N open items from last time - Bring forward" banner (open items across all past 1:1s with the same person). One click PATCHes them into this card and retires them on the old ones.
- [x] **Cadence health chips.** Each person filter chip shows days since the last logged 1:1; amber "Nd ago" when older than 30 days and nothing is scheduled with them. Computed from rows already loaded, no extra reads.
- [x] **Reschedule quick action.** Upcoming cards get a Reschedule popover: "+1 week", a date picker, and the repeat cadence selector.
- [x] **Notes search.** Client-side filter over notes, action-item text, and person name. Searching disables the past-list cutoff so matches are never hidden.

## Phase 2: automation (done, server)

- [x] **Recurring cadence.** `cadence` field on check-ins (`weekly | biweekly | monthly`, nullable) - schema, service, routes, openapi, serializer. Set it in the New 1:1 dialog or the Reschedule popover; shown as an info badge. The nightly cron (`rollRecurringCheckIns` in `src/cron.ts`) creates the next occurrence once the date passes - same pair, next slot on the cadence grid (stepping from the previous date so the weekday / day-of-month sticks), open action items carried forward - and MOVES the cadence onto the new row. Exactly-once via a guarded flip (cadence cleared with a guard on its current value), same shape as leave carry-forward. Tests: `test/checkInRecurrence.test.ts`.
- [x] **Day-before reminder.** `remindUpcomingCheckIns` on the nightly tick notifies both attendees of any 1:1 dated tomorrow (`checkin.reminder`). Cron-native like the compliance-due reminders - engine rules can't match per-row dates, so this lives next to the other scheduled scanners rather than as an automation rule.

## Phase 3: integration + polish (done)

- [x] **Action item to board task.** Kanban icon on any open action item (gated by cards create access) opens "Make a board task": title prefilled, board picker (boards load lazily on open), description links back in prose ("From a 1:1 with X on date"). One-way; the item stays on the 1:1.
- [x] **Talking-point prompts.** "Add talking points" on an empty notes box inserts Wins / Blockers / Growth / Feedback headings as a draft.
- [x] **"No notes" badge.** Past rows with empty notes get a muted "no notes" badge; the preview line falls back to the action-item count.

## Out of scope

- Rich-text notes: plain text fits shared quick notes.
- Per-person private notes: schema + ACL complexity on a collection whose whole design is pair-shared.
- Export: export is a DataTable capability; this page is cards, and 1:1 notes are sensitive by design.
