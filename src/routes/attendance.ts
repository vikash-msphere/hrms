import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listSessions, clockIn, clockOut, getSession } from "../services/attendance";
import { toAttendanceSessionResource } from "../http/serialize";
import { withAccess } from "../http/accessHint";
import { customMethod } from "../http/customMethod";
import { clampPageSize } from "../http/pagination";

const COL = "attendance";

// Attendance clock sessions. Self clock in/out is `attendance/me:clockIn` / `:clockOut` (the caller acts on
// their own record). `GET /?open=true` lists who's currently clocked in (scoped to the caller's visibility),
// which drives the live presence indicator.
export const attendance = new Hono<AppEnv>()
  .get("/", async (c) => {
    const maxPageSize = clampPageSize(Number(c.req.query("max_page_size")) || undefined);
    const from = c.req.query("from") ? Date.parse(c.req.query("from")!) : undefined;
    const to = c.req.query("to") ? Date.parse(c.req.query("to")!) : undefined;
    const { items, nextPageToken } = await listSessions(c.get("deps"), c.get("scope"), maxPageSize, c.req.query("page_token"), {
      open: c.req.query("open") === "true",
      from: Number.isNaN(from) ? undefined : from,
      to: Number.isNaN(to) ? undefined : to,
    });
    const user = c.get("user");
    return c.json({ results: items.map((r) => withAccess(toAttendanceSessionResource(r), user, COL, r.code)), next_page_token: nextPageToken });
  })
  .get("/:attendance_id", async (c) => {
    const row = await getSession(c.get("deps"), c.req.param("attendance_id"));
    return c.json(withAccess(toAttendanceSessionResource(row), c.get("user"), COL, row?.code, c.get("objectGrant")));
  })
  // `attendance/me:clockIn` / `attendance/me:clockOut` - self-service clock punch.
  .post("/:attendance_id", async (c) => {
    const { verb } = customMethod(c);
    const deps = c.get("deps");
    const user = c.get("user");
    if (verb === "clockIn") return c.json(toAttendanceSessionResource(await clockIn(deps, user)));
    if (verb === "clockOut") return c.json(toAttendanceSessionResource(await clockOut(deps, user)));
    return c.notFound();
  });
