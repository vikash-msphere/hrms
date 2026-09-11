import { Hono } from "hono";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { buildIcs } from "../lib/ics";
import { getSettingValue } from "../services/settings";
import { holidayApplies } from "../services/holidays";
import { refHolidays } from "../lib/refData";

// PUBLIC, SUBSCRIBABLE holiday calendar: `<origin>/calendar/holidays/<token>` pasted into Google Calendar or
// Outlook keeps someone's days off in sync, instead of the one-shot .ics the page downloads. No session - a
// calendar client has none. Deliberately narrow, and OPT-IN:
//   - 404 unless the org enabled it (settings/holidays `feed_enabled`).
//   - The token is an authenticated wire id under its OWN domain ("holiday-feed", see idCodec): unguessable,
//     unforgeable, and NOT equal to the employee's wire id used elsewhere in the API, so an id someone already
//     holds can't be turned into a feed URL.
//   - Serves ONLY that employee's days off: company-wide + their-location holidays, plus the optional ones
//     they picked. No names, no leave, nothing about anyone else.
// NOTE for Cloudflare Access deployments: CF sits in front of the whole worker, so `/calendar/*` needs a
// bypass rule before an external calendar client can fetch it.

const ymd = (d: Date | number | string) => new Date(d).toISOString().slice(0, 10);

export const holidayFeed = new Hono<AppEnv>().get("/holidays/:token", async (c) => {
  const deps = c.get("deps");
  // Decode BEFORE reading anything: this route is unauthenticated (a calendar client has no session) and token
  // validation is pure compute, so a forged token should cost zero D1 reads rather than a settings read each.
  const employeeId = await deps.idCodec.decode("holiday-feed", c.req.param("token").replace(/\.ics$/, ""));
  if (!employeeId) return c.notFound();

  const cfg = await getSettingValue<{ feed_enabled?: boolean }>(deps, "holidays", {});
  if (!cfg.feed_enabled) return c.notFound();
  const emp = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  // A LEAVER's subscription stops here. This is the one surface that answers with no session at all: the URL
  // lives on in whatever calendar client they pasted it into, so nothing else ever revokes it. Offboarding
  // stamps `terminated` (services/transitions.ts), which is what says the subscription is no longer theirs -
  // checking only `delete_time` kept a departed employee's feed live indefinitely. Same rule /found applies to
  // a retired asset, and the same one payroll's roster reads.
  if (!emp || emp.deleteTime || emp.status === "terminated") return c.notFound();

  // Their work location decides which regional holidays are theirs (current position row = the open one).
  const positions = await deps.db
    .select({ location: schema.positions.location, effectiveTo: schema.positions.effectiveTo })
    .from(schema.positions)
    .where(eq(schema.positions.employeeId, employeeId));
  const where = positions.find((p) => !p.effectiveTo)?.location ?? null;

  const picked = new Set(
    (await deps.db.select().from(schema.holidaySelections).where(eq(schema.holidaySelections.employeeId, employeeId))).map((r) => r.holidayId),
  );
  // A calendar subscription is a rolling window, not the whole archive: last year through next year.
  const now = +deps.clock.now();
  const thisYear = new Date(now).getUTCFullYear();
  const from = Date.UTC(thisYear - 1, 0, 1);
  const to = Date.UTC(thisYear + 2, 0, 1);
  const rows = (await refHolidays(deps)).filter(
    (h) =>
      !h.deleteTime &&
      !h.disabled &&
      +new Date(h.date) >= from &&
      +new Date(h.date) < to &&
      holidayApplies(h.location, where) &&
      (h.kind !== "optional" || picked.has(h.uuid)),
  );

  const org = await getSettingValue<{ name?: string }>(deps, "organization", {});
  const ics = buildIcs(
    rows.map((h) => ({
      uid: `holiday-${h.uuid}@hrms`,
      start: ymd(h.date),
      end: ymd(h.date),
      summary: h.halfDay ? `${h.name} (half day)` : h.name,
      description: [h.kind === "optional" ? "Optional holiday" : "Company holiday", h.location ?? ""].filter(Boolean).join(" · "),
    })),
    `Holidays${org.name ? ` · ${org.name}` : ""}`,
    now,
  );
  return c.body(ics, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'inline; filename="holidays.ics"',
    // Personal (their picks), so no shared cache may keep it; a calendar client polls on its own schedule.
    "Cache-Control": "private, max-age=0, no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
});
