import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { listSessions, clockIn, clockOut } from "../services/attendance";
import { toAttendanceSessionResource } from "../http/serialize";

// Attendance clock sessions. Self clock in/out is `attendance/me:clockIn` / `:clockOut` (the caller acts on
// their own record, so the verbs ignore the path id). `GET /?open=true` lists who's currently clocked in
// (scoped to the caller's visibility), which drives the live presence indicator. A session is written by a
// punch and corrected by an attendance-regularization, never edited or deleted directly - and the table has no
// delete_time - so the factory mounts list, get and the two punches, nothing else.
export const attendance = collectionRoutes({
  table: schema.attendanceSessions,
  collection: "attendance",
  auditName: "attendance",
  notFound: "attendance session not found",
  param: "attendance_id",
  serialize: toAttendanceSessionResource,
  list: (c, page) => {
    const from = c.req.query("from") ? Date.parse(c.req.query("from")!) : undefined;
    const to = c.req.query("to") ? Date.parse(c.req.query("to")!) : undefined;
    return listSessions(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      open: c.req.query("open") === "true",
      from: Number.isNaN(from) ? undefined : from,
      to: Number.isNaN(to) ? undefined : to,
    });
  },
  verbs: {
    clockIn: { run: (deps, user) => clockIn(deps, user) },
    clockOut: { run: (deps, user) => clockOut(deps, user) },
  },
});
