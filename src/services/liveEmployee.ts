// WHO COUNTS AS A LIVE EMPLOYEE, as one predicate.
//
// THREE COLUMNS, and `status` is the one that keeps getting missed. `status` and the soft-delete mark are
// independent: offboarding stamps `status: "terminated"` and disables the login (services/transitions.ts) and
// never touches `delete_time`, while the generic soft delete stamps `delete_time` and never touches `status`.
// Filtering only the second keeps every leaver the org has ever offboarded in an org-wide roster. `disabled`
// joins them because it is the same statement: an account switched off is not somebody to broadcast to either.
//
// FILTERED IN SQL RATHER THAN IN THE ISOLATE. The rows it drops do not have to be read, and D1 bills rows
// read. That is not only a cost argument: a roster filtered after the read is one `continue` away from being
// filtered on two of the three columns, which is exactly how the dashboard's celebrations card came to
// broadcast a disabled employee's birthday to the whole company.
//
// A LEAF ON PURPOSE. This lived privately inside services/notifications.ts, so the surfaces that needed the
// same rule either imported that whole module (the push sender, the digest queue, the wire-id encoder) or -
// what actually happened - spelled the rule again and got it wrong. Nothing here but the schema and drizzle.
//
// The SPA's rosters apply the same rule to wire rows: `isCurrentEmployee` in web/src/lib/employees.ts.
import { eq, isNull } from "drizzle-orm";
import * as schema from "../db/schema";

/**
 * The conditions a live employee row satisfies, ready to spread into an `and(...)`.
 *
 * A function rather than a const because these are drizzle condition objects and a shared array invites a
 * caller to push onto it; each call hands back its own.
 */
export const liveEmployee = () => [
  eq(schema.employees.status, "active"),
  isNull(schema.employees.deleteTime),
  eq(schema.employees.disabled, false),
];

/**
 * The three columns the predicate above tests, as a select shape - and the same test applied to a row already
 * in hand.
 *
 * TWO FORMS OF ONE RULE, kept adjacent so they cannot drift. The SQL form is still the one to reach for
 * (see the note above): it drops rows nobody has to read. But some callers must read the row ANYWAY and for
 * another reason - `notify()` reads the recipient for their mute preferences and the actor for a display
 * name in the same statement, and a departed ACTOR's name still belongs on the row a live recipient is about
 * to be shown. Binding the predicate in SQL there would drop the actor along with the dead recipient. So
 * those callers select these columns and ask `isLiveEmployee` about the specific person they are choosing.
 */
export const LIVE_EMPLOYEE_COLUMNS = {
  status: schema.employees.status,
  deleteTime: schema.employees.deleteTime,
  disabled: schema.employees.disabled,
};

export type LiveEmployeeColumns = { status: string; deleteTime: Date | number | null; disabled: boolean | null };

/** Whether a row selected with `LIVE_EMPLOYEE_COLUMNS` is somebody the app may still address. */
export const isLiveEmployee = (row: LiveEmployeeColumns | undefined | null): boolean =>
  !!row && row.status === "active" && row.deleteTime == null && row.disabled !== true;
