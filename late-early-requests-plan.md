# Late arrival and early departure requests

An employee asks, ahead of time or after the fact, to come in late or leave early on one day. A manager or HR
approves it. HR decides everything else through one policy (`settings/punctuality`, Settings → Time & leave →
"Late & early policy", also reachable from the gear on the Attendance, Late & Early and Payroll runs pages): who
may file what and when, what an approved request does to the attendance record, and what unexcused lateness
costs in pay.

## The request

Collection `late-early-requests` (table `late_early_requests`, migration `0002`), employee-owned and code-scoped
like `overtime-requests`: the employee files, a manager (own department) or HR approves or rejects, the owner
cancels while it is pending. Page: Time → "Late & Early" (`/late-early`), with Requests / History tabs, the
policy in plain words, and a request form that shows the policy's verdict before anything is sent.

| Field | Meaning |
|---|---|
| `employee` | whose day it is (defaults to the caller) |
| `date` | the org-local day, `YYYY-MM-DD` |
| `kind` | `late_arrival` or `early_departure` |
| `at` | wall-clock `HH:MM` in the org timezone: the time they will arrive (late arrival) or leave (early departure) |
| `minutes` | how far `at` is from the shift start or end, fixed when the request is filed |
| `reason` | free text, required when the policy says so |
| `state` | `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` |
| `over_limit` | filed past the monthly allowance while the policy allows it, shown to the approver |
| `auto_approved` | approved by the policy on filing, not by a person |

One live request (pending or approved) per person, day and kind, held by a partial unique index. The day must be
a working day inside the person's employment, not a whole-day company holiday, and not a day of full-day approved
leave. Approving is refused to the person the request is about (maker-checker, `settings/approvals`), and every
decision is a guarded flip, so a double press decides once.

## The policy (`settings/punctuality`)

Defaults change nothing in pay: requests can be filed and need approval, and nothing reaches payroll until HR
turns it on. The blob is validated leaf by leaf on save (`domain/punctuality.ts#validatePunctuality`), and every
reader goes through one normaliser (`punctualityPolicyOf`).

**Requests** (who may file what, and when)
- `enabled`, `late_arrival`, `early_departure`: the feature and each kind.
- `max_minutes`: the longest single request (null = no cap).
- `monthly_count`, `monthly_minutes`: allowance per calendar month over pending and approved requests (null = none),
  counted across both kinds or per kind (`limit_scope`).
- `over_limit`: `refuse` a request past the allowance, or `allow` it flagged for the approver.
- `backdate_days` (null = any), `advance_days` (null = any): how far back and ahead a day may be.
- `before_time`: a request has to be filed before the time it covers (shift start for a late arrival, the planned
  departure for an early one).
- `reason_required`.
- `auto_approve_minutes`: requests of at most this many minutes, inside the allowance, are approved on filing (null =
  a person always decides).

**Attendance** (what an approved request does to the day)
- The approved time becomes that day's shift start (late arrival) or end (early departure), and the day is judged
  against it. Arriving by the approved time plus grace is on time; later than that is late, by the minutes past the
  approved time. Always on: it is what approving means.
- `grace_on_top`: the org's grace minutes still apply after the approved time.
- `credit_minutes`: the approved gap counts as worked time for the full-day and half-day thresholds. Only the part
  actually missed is credited, and only on a day with punches, so a no-show is never credited.

**Pay** (what unexcused lateness costs; charged through automatic loss of pay, so it needs `lop_enabled`)
- `penalties.enabled`.
- `penalties.counts`: `late`, `early` or `both` kinds of unexcused mark count toward the tally.
- `penalties.free_marks`: marks per pay period before any deduction.
- `penalties.every` + `penalties.deduct_days` (0.5 or 1): each further block of `every` marks docks that much.
- `penalties.max_days`: cap per period on what the marks dock (null = none).
- `penalties.severe_minutes`: a single unexcused lateness or early departure longer than this counts the day as at
  most a half day (null = off). Such a day is not also counted as a mark.

Never counted as a mark: an excused (approved) window, a grace-exception day, a flexible-hours org, a half the person
spent on approved leave, a day HR marked (the mark decides the day), a holiday and a non-working day. Absence and
marks together never dock more days than the period owed.

## Where it shows

- **Payroll** (`services/payroll.ts#employeeLop`, `domain/punctuality.ts#periodLop`): one loss-of-pay line whose
  day-units include the marks' penalty, with a `parts` breakdown (absence, late and early marks). The payslip
  attendance strip, the PF/ESI non-contributing days and the restatement of a published period read the same
  total. Approving a request for a day in a published period restates that period through `lop_adjustments`. A
  built run reports itself stale when a request for its period is decided (while the policy touches pay) or when
  `settings/punctuality` changes.
- **Final settlement**: the exit month is docked by the same rule (`services/settlements.ts#finalMonthLopDays`).
- **Attendance**: every grid (the Attendance page, a profile's attendance tab, the team drill-in, the dashboard's
  team timeline) judges the day against the approved window, shows "In by 10:30 approved" beside the status, and
  exports it. A late or left-early day offers "Request a late arrival / early departure for this day", prefilled.
  "Not in yet" on the team panel respects an approved late start. A morning on approved leave is not a late
  arrival and an afternoon on leave is not an early departure.
- **Analytics**: "Late & early approved" is a measure, and late arrivals, early departures, punctuality and minutes
  late skip excused windows (when the caller may list the requests). The table builder offers the collection as a
  base.
- **Approvals inbox and dashboard** "waiting on you", notifications (category `lateEarly`), workflow events
  (`lateEarly.requested`, `lateEarly.approved`), ⌘K / "+" quick action.

## Access

Private by default in production: nothing is granted until an admin grants it in Permissions. The seeded demo
roles mirror remote-work requests (self-service for everyone, managers decide their department, HR decides
everyone, payroll reads). The "Team lead" role template includes reading and deciding the department's requests.
Migration `0002` adds the table, its change-stamp triggers, and the owner-ref and scope-tier entries to the live
policy manifest.

## Change-stamp triggers after the freeze

`0002` is the first migration to add a table since `0000` was frozen. The trigger block in `0000` is never
rewritten, so `src/db/changeDdl.ts` now checks the triggers ALL migrations leave in place, applied in order
(`appliedChangeTriggers`), and `npm run db:generate` prints exactly the statements a new migration has to carry
(`changeDdlDelta`).
