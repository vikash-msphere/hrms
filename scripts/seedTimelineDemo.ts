// Dev-only: seed demo events into the CURRENT fortnight so the Dashboard team timeline has something to show.
// Leaves + holidays are additive and tagged for easy cleanup (reason='__demo__', holiday name 'Demo …'); a few
// employee start/probation dates are nudged to demo the marker types. Re-runnable. `scripts/start.sh --seed`
// fully resets everything. Run: node --import ./scripts/tsResolve.mjs scripts/seedTimelineDemo.ts
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { genId } from "../src/lib/idCodec";

const d1 = (sql: string, json = false) =>
  execSync(`npx wrangler d1 execute hrms --local ${json ? "--json " : ""}--command ${JSON.stringify(sql)}`, { encoding: "utf8" });
const query = (sql: string): Record<string, any>[] => JSON.parse(d1(sql, true))[0].results;

const emps = query("SELECT uuid, code FROM employees WHERE delete_time IS NULL ORDER BY code");
const types = query("SELECT uuid, name FROM leave_types WHERE delete_time IS NULL AND disabled = 0 ORDER BY name");
if (emps.length < 1 || types.length < 1) { console.error("Need at least 1 employee and 1 leave type seeded."); process.exit(1); }

const DAY = 86400000;
const now = new Date();
const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const weekStart = todayUtc - new Date(todayUtc).getUTCDay() * DAY; // Sunday that starts this fortnight
const day = (i: number) => weekStart + i * DAY; // i in 0..13
const ts = Date.now();
const E = (i: number) => emps[i % emps.length];
const T = (i: number) => types[i % types.length];

const lines: string[] = [
  "DELETE FROM leave_requests WHERE reason = '__demo__';",
  "DELETE FROM holidays WHERE name LIKE 'Demo %';",
];

const holiday = (i: number, name: string) =>
  lines.push(`INSERT INTO holidays (uuid, code, date, name, kind, disabled, locked, created_at, updated_at) VALUES ('${genId()}', NULL, ${day(i)}, '${name}', 'fixed', 0, 0, ${ts}, ${ts});`);
holiday(3, "Demo Festival");
holiday(10, "Demo Holiday");

// [employeeIndex, typeIndex, startDayIdx, endDayIdx, state, startSession?, endSession?] (session 1=AM, 2=PM)
const reqs: [number, number, number, number, string, number?, number?][] = [
  [0, 0, 1, 2, "APPROVED"],
  [1, 1, 4, 6, "APPROVED", 2, 2], // starts in the afternoon
  [1, 0, 9, 9, "PENDING"],
  [2, 0, 5, 8, "APPROVED", 1, 1], // ends at midday
  [3, 1, 12, 12, "APPROVED", 2, 2], // single afternoon half day
  [4, 0, 8, 9, "APPROVED"],
];
reqs.forEach(([ei, ti, a, b, state, ss = 1, es = 2], n) => {
  const e = E(ei);
  const code = `${e.code}-d${n}`;
  const days = (b - a + 1) - (ss === 2 ? 0.5 : 0) - (es === 1 ? 0.5 : 0);
  lines.push(
    `INSERT INTO leave_requests (uuid, code, employee_id, leave_type_id, start_date, end_date, days, start_session, end_session, state, reason, created_at, updated_at) ` +
      `VALUES ('${genId()}', '${code}', '${e.uuid}', '${T(ti).uuid}', ${day(a)}, ${day(b)}, ${days}, ${ss}, ${es}, '${state}', '__demo__', ${ts}, ${ts});`,
  );
});

// Marker demos (reset by a reseed): new joiner, probation ending, work anniversary.
lines.push(`UPDATE employees SET start_date = ${day(2)} WHERE uuid = '${E(2).uuid}';`); // joined this fortnight
lines.push(`UPDATE employees SET probation_end_date = ${day(7)} WHERE uuid = '${E(3).uuid}';`); // probation ends
const a = new Date(day(12));
lines.push(`UPDATE employees SET start_date = ${Date.UTC(a.getUTCFullYear() - 3, a.getUTCMonth(), a.getUTCDate())} WHERE uuid = '${E(0).uuid}';`); // 3-yr anniversary

const file = "scripts/.timeline-demo.sql";
writeFileSync(file, lines.join("\n") + "\n");
d1; // (keep import used)
execSync(`npx wrangler d1 execute hrms --local --file=${file}`, { stdio: "inherit" });
console.log(`\nSeeded ${reqs.length} leaves + 2 holidays + 3 markers into ${new Date(day(0)).toISOString().slice(0, 10)} … ${new Date(day(13)).toISOString().slice(0, 10)}.`);
