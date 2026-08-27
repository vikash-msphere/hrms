import type { Context } from "hono";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { collectionRoutes } from "../http/collectionRoute";
import { listSessions, clockIn, clockOut } from "../services/attendance";
import { toAttendanceSessionResource } from "../http/serialize";

// Attendance clock sessions. Self clock in/out is `attendance/me:clockIn` / `:clockOut` (the caller acts on
// their own record, so the verbs ignore the path id). `GET /?open=true` lists who's currently clocked in
// (scoped to the caller's visibility), which drives the live presence indicator. A session is written by a
// punch and corrected by an attendance-regularization, never edited or deleted directly - and the table has no
// delete_time - so the factory mounts list, get and the two punches, nothing else.
// The client address the punches are fenced against (ATTENDANCE_ALLOWED_IPS, see src/env.ts). ONLY
// `cf-connecting-ip` - the address Cloudflare itself observed - is trusted here. `x-forwarded-for` is a
// client-supplied header that anyone can write, so accepting it (as the audit trail does, where a spoofed
// value is a wrong log line rather than a bypassed control) would make the fence decorative.
function punchOrigin(c: Context<AppEnv>) {
  return { ip: c.req.header("cf-connecting-ip") ?? null, allowList: c.env.ATTENDANCE_ALLOWED_IPS };
}

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
    clockIn: { run: (deps, user, _id, _body, c) => clockIn(deps, user, punchOrigin(c)) },
    clockOut: { run: (deps, user, _id, _body, c) => clockOut(deps, user, punchOrigin(c)) },
  },
});
