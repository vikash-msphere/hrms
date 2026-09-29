// Generates bootstrap/demo.sql: an OPTIONAL demo overlay for a bootstrapped DB - a handful of departments +
// employees, a populated kudos/recognition board (varied category × level so every card style shows), a couple
// plain announcements, and some reactions/replies so the social features are visible. It also carries a
// quarter of performance goals (department-owned team goals, their key results, and personal goals aligned
// under them) and two work boards - a kanban one and a scrum one with sprints - whose cards, movement history
// and checklists give /boards and /goals something real to draw. IDs are DETERMINISTIC
// (counter-based); timestamps are anchored to generation time (demo.sql is regenerated on every `--demo` run)
// so the feed always reads as just-happened and recent kudos light the "New" badge. Not production data.
//
//   Run:    node --import ./scripts/tsResolve.mjs bootstrap/genDemo.ts > bootstrap/demo.sql
//   Apply:  scripts/start.sh --demo   (resets, bootstraps, then applies this)
import { bytesToBase32 } from "../src/lib/idCodec";
import { DEFAULT_BOARD_COLUMNS, DEFAULT_SCRUM_COLUMNS } from "../src/domain/boards";
import { DEFAULT_KUDOS_CONFIG, pointsForLevel } from "../src/domain/kudos";
import { KUDOS_CONFIG } from "./collections/kudos";

const T0 = 1700000000000;
// Generation time, so the feed always reads as recent (and the "New" badge lights) - QUANTIZED TO THE DAY.
// Taken raw, every regeneration rewrote all 83 rows with millisecond-different stamps, so `bootstrap/demo.sql`
// showed up modified in `git status` after any `--demo` run, on a file nobody had edited. That is not free: a
// dirty tree is what makes `npm run preflight` stamp the SPA release `-dirty`, so the noise lands in a deploy
// gate. A demo feed is not less recent for being anchored at midnight, and same-day re-runs are now
// byte-identical - which is the property the ids already had.
const NOW = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;

// Deterministic 13-char base32 id from a counter. Offset 50000 keeps these clear of bootstrap (30000),
// genSeed (1000) and genTemplatesSeed (5000) id spaces.
let counter = 0;
const nid = () => {
  const b = new Uint8Array(8);
  let x = BigInt(counter++ + 50000);
  for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return bytesToBase32(b);
};
const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);

// --- Departments ---------------------------------------------------------------------------------------------
const DEPTS = [
  { code: "02", name: "Product", uuid: nid() },
  { code: "04", name: "Engineering", uuid: nid() },
  { code: "07", name: "Sales", uuid: nid() },
];

// --- Employees (dept-coded: deptCode-seq) --------------------------------------------------------------------
const NAMES: [string, string, string][] = [
  // [first, last, deptCode]
  ["Aarav", "Sharma", "04"], ["Diya", "Patel", "04"], ["Rohan", "Verma", "04"], ["Priya", "Nair", "04"],
  ["Aditya", "Iyer", "02"], ["Meera", "Rao", "02"], ["Ishaan", "Gupta", "02"], ["Neha", "Joshi", "02"],
  ["Vivaan", "Singh", "07"], ["Ananya", "Reddy", "07"], ["Kabir", "Mehta", "07"], ["Sara", "Khan", "07"],
];
const TITLES: Record<string, string[]> = {
  "04": ["Software Engineer", "Senior Engineer", "Engineering Manager", "QA Engineer"],
  "02": ["Product Manager", "Product Designer", "Product Analyst", "UX Researcher"],
  "07": ["Account Executive", "Sales Manager", "SDR", "Solutions Consultant"],
};
const deptSeq: Record<string, number> = {};
const employees = NAMES.map(([first, last, dc]) => {
  const dept = DEPTS.find((d) => d.code === dc)!;
  const seq = (deptSeq[dc] = (deptSeq[dc] ?? 0) + 1);
  const code = `${dc}-${String(seq).padStart(3, "0")}`;
  return { uuid: nid(), code, first, last, email: `${first.toLowerCase()}.${last.toLowerCase()}@demo.example.com`, title: TITLES[dc]![(seq - 1) % 4]!, deptUuid: dept.uuid, start: NOW - (200 + seq * 30) * DAY };
});

// The super_admin dev login (minted by start.sh) as a real employee. work_email matches the login so the
// UPDATE below can link the already-minted user row (bootstrap seeds no employee for it). Kept out of the
// kudos/reaction/login rotations above - it's an admin identity, not demo activity.
const superEmp = { uuid: nid(), code: `04-${String((deptSeq["04"] = (deptSeq["04"] ?? 0) + 1)).padStart(3, "0")}`, first: "Sam", last: "Super", email: "super@example.com", title: "Administrator", deptUuid: DEPTS.find((d) => d.code === "04")!.uuid, start: NOW - 400 * DAY };

// --- Kudos (announcements, kind="kudos") ---------------------------------------------------------------------
const CATS = ["Teamwork", "Innovation", "Customer Focus", "Ownership", "Excellence", "Leadership", "Going the Extra Mile", "Helping Hand", "Learning & Growth", "Positivity"];
const LVLS = ["Appreciation", "Impact", "Exceptional", "Legendary"];
const MSGS = [
  "Went above and beyond to land the launch on time - thank you!",
  "Calm, clear and decisive during the incident. You saved the day.",
  "Mentored two new joiners this sprint without being asked. Legend.",
  "Shipped the feature a week early AND with great tests.",
  "Always the first to jump in on a tricky code review.",
  "Turned a frustrated customer into our biggest fan. Incredible.",
  "Quietly fixed the flaky pipeline everyone complained about.",
  "Brought so much energy to the offsite - thank you for lifting the room.",
  "Your design crit feedback made the whole release better.",
  "Closed the quarter's biggest deal with grace under pressure.",
  "Stayed late to unblock the team, then helped me learn it too.",
  "Relentlessly customer-obsessed - it shows in everything you ship.",
  "Rewrote the onboarding docs - new hires are productive in days now.",
  "Spotted the security gap in review before it ever shipped. Sharp eye.",
  "Volunteered to run the postmortem and made it blameless and useful.",
  "Handled the on-call storm solo overnight without missing a beat.",
  "Your patience walking me through the codebase meant the world.",
  "Took the messy legacy module and left it cleaner than you found it.",
  "Championed accessibility this release - everyone benefits now.",
  "Cross-team collaboration at its finest. You made two orgs click.",
  "Turned my half-baked idea into a shipped feature. Thank you!",
  "Kept the roadmap honest and the team focused under real pressure.",
];
// A card renders exactly the `illustration` its row names and nothing else - there is no fallback from the
// category - so a demo kudos without one would show no art at all. Each takes one of the stickers its own
// category is paired with in bootstrap/collections/kudos.ts, alternating so both of them appear on the board; a
// level-only kudos has no category to draw from and gets a neutral one.
const CAT_ART = new Map((KUDOS_CONFIG.categories ?? []).map((c) => [c.name, c.art ?? []]));
const NEUTRAL_ART = "good-job.png";
const artFor = (category: string | null, i: number) => {
  const set = category ? CAT_ART.get(category) ?? [] : [];
  return set.length ? set[Math.floor(i / CATS.length) % set.length]! : NEUTRAL_ART;
};

// 30 kudos: a mix of combo (category+level), category-only, and level-only, so every card type renders.
const kudoRows: string[] = [];
const notifRows: string[] = [];
const ownSeq: Record<string, number> = {};
const kudos: { uuid: string; giver: typeof employees[number]; recipient: typeof employees[number] }[] = [];
for (let i = 0; i < 30; i++) {
  const giver = employees[i % employees.length]!;
  // Route the two newest kudos to the super_admin dev login (the default demo view) so it shows unread "New"
  // badges out of the box; the rest rotate through the demo employees.
  const recipient = i < 2 ? superEmp : employees[(i + 5) % employees.length]!;
  if (giver.uuid === recipient.uuid) continue;
  const mode = i % 6; // 0,1,2,3 = combo; 4 = category-only; 5 = level-only
  const category = mode === 5 ? null : CATS[i % CATS.length]!;
  const level = mode === 4 ? null : LVLS[i % LVLS.length]!;
  const points = level ? pointsForLevel(DEFAULT_KUDOS_CONFIG, level) : 0;
  const seq = (ownSeq[giver.code] = (ownSeq[giver.code] ?? 0) + 1);
  const code = `${giver.code}-${String(seq).padStart(3, "0")}`;
  const uuid = nid();
  const msg = MSGS[i % MSGS.length]!;
  kudos.push({ uuid, giver, recipient });
  const pub = NOW - i * 8 * HOUR;
  kudoRows.push(` (${q(uuid)},${q(code)},'kudos','',${q(msg)},${q(msg)},${q(artFor(category, i))},${q(giver.uuid)},${q(recipient.uuid)},NULL,${category ? q(category) : "NULL"},${level ? q(level) : "NULL"},${points},1,${pub},${T0},${T0})`);
  // A "kudos.received" notification to the recipient; `subject` -> the kudo card drives the per-row "New" marker
  // (recency-based, 24h). Recent ones stay unread (bell + New); older ones are pre-read to keep the bell tidy.
  const read = pub >= NOW - 24 * HOUR ? "NULL" : `${T0}`;
  notifRows.push(` (${q(nid())},${q(`kn-${i}`)},${q(recipient.uuid)},'kudos.received','You received kudos',${q(msg)},'announcements',${q(`announcements/${uuid}`)},'normal',NULL,${read},${pub},${T0})`);
}

// --- Plain board posts: an announcement, a casual post, and a poll - so every post type (not just kudos) is on
// the board. Each gets an "announcement.posted" notification to super (the default demo view) with a subject, so
// the "New" badge + bell fire for all of them. Recent ones (<24h) stay unread; the older post is pre-read.
// These take a `<category>/<slug>` illustration from web/public/assets/illustrations rather than a kudos sticker
// (a `<file>.png`), so the demo board shows both kinds of art a post can carry.
const a1 = nid(), a2 = nid(), a3 = nid();
const B1 = "Join us Friday 4pm for the quarterly all-hands. Agenda: roadmap, hiring, Q&A.";
const B2 = "Sharing a few favourite TS patterns over lunch on Thursday. All welcome!";
const B3 = "Pick your favourite - majority wins!";
const annRows = [
  ` (${q(a1)},'a1','announcement','Q2 All-Hands',${q(B1)},${q(B1)},'teamwork-meetings/conference-speaker',${q(employees[2]!.uuid)},NULL,NULL,NULL,NULL,0,1,${NOW - 3 * HOUR},${T0},${T0})`,
  ` (${q(a2)},'a2','post','Lunch & learn: TypeScript tips',${q(B2)},${q(B2)},'education-learning/lecture',${q(employees[0]!.uuid)},NULL,NULL,NULL,NULL,0,1,${NOW - 30 * HOUR},${T0},${T0})`,
  ` (${q(a3)},'a3','poll','Team lunch spot this Friday?',${q(B3)},${q(B3)},'food-drink/eating-together',${q(employees[5]!.uuid)},NULL,NULL,NULL,NULL,0,1,${NOW - 6 * HOUR},${T0},${T0})`,
];
const pollOptRows = ["Sushi", "Tacos", "Pizza"].map(
  (label, i) => ` (${q(nid())},${q(a3)},${q(label)},${i},${T0})`,
);
const plainPosts = [
  { id: a1, title: "New announcement", head: "Q2 All-Hands", pub: NOW - 3 * HOUR },
  { id: a2, title: "New post", head: "Lunch & learn: TypeScript tips", pub: NOW - 30 * HOUR },
  { id: a3, title: "New poll", head: "Team lunch spot this Friday?", pub: NOW - 6 * HOUR },
];
for (let j = 0; j < plainPosts.length; j++) {
  const p = plainPosts[j]!;
  const read = p.pub >= NOW - 24 * HOUR ? "NULL" : `${T0}`;
  notifRows.push(` (${q(nid())},${q(`pn-${j}`)},${q(superEmp.uuid)},'announcement.posted',${q(p.title)},${q(p.head)},'announcements',${q(`announcements/${p.id}`)},'normal',NULL,${read},${p.pub},${T0})`);
}

// --- Reactions + replies on a few kudos (show the social features) ------------------------------------------
const EMOJIS = ["👏", "🎉", "❤️", "🙌", "🔥"];
const rxRows: string[] = [];
const rpRows: string[] = [];
for (let k = 0; k < 6; k++) {
  const ku = kudos[k]!;
  const n = 1 + (k % 3); // 1-3 reactions
  for (let r = 0; r < n; r++) {
    const reactor = employees[(k * 3 + r + 1) % employees.length]!;
    if (reactor.uuid === ku.recipient.uuid) continue;
    rxRows.push(` (${q(nid())},${q(ku.uuid)},NULL,${q(reactor.uuid)},${q(EMOJIS[(k + r) % EMOJIS.length])},${T0})`);
  }
}
const REPLIES = ["Well deserved! 🙌", "Couldn't agree more.", "So true - great work!", "100%. Thank you for this."];
for (let k = 0; k < 4; k++) {
  const ku = kudos[k]!;
  const author = employees[(k * 2 + 2) % employees.length]!;
  rpRows.push(` (${q(nid())},${q(ku.uuid)},${q(author.uuid)},${q(author.email)},${q(REPLIES[k % REPLIES.length])},${NOW - k * HOUR})`);
}

// --- Demo employee logins (employee role) ---------------------------------------------------------------------
// One account per demo employee, matching what the app does when HR creates a person (services/employees.ts
// provisionAccount). An access rule names a `users/{id}` subject, so a person with no account row can neither be
// granted access nor appear in the access modal's people picker - seeding three accounts for thirteen employees
// left that picker showing three names.
const userRows = employees.map(
  (e) => ` (${q(nid())},${q(e.email)},'employee','active',${q(e.uuid)},${T0},${T0})`,
);

// --- Goals + team goals ---------------------------------------------------------------------------------------
// A quarter's worth of performance goals: three DEPARTMENT-owned objectives (the "team goals" - `department_id`
// set, so the whole department reads them as theirs), each proven by key results that carry a real measure, and
// personal goals aligned under them via `parent_id`. The mix is deliberate: measured goals (the server derives
// their percentage from baseline/target/current), typed-progress goals, one still PROPOSED and unagreed, one
// blocked by another goal, one cancelled and one closed with a retro - so every state the goal card renders has
// a row behind it.
type GoalStatus = "not_started" | "in_progress" | "completed" | "cancelled";
type GoalSpec = {
  key: string;                       // local handle, for parent/blocked-by links and for the cards below
  owner: number;                     // index into `employees`
  title: string;
  description?: string;
  kind?: "objective" | "key_result";
  parent?: string;                   // goal key this one rolls up under (alignment, or objective -> key result)
  dept?: number;                     // index into DEPTS: a department-owned goal (a team goal)
  weight?: number;
  progress?: number;                 // ignored when the goal carries a measure
  status?: GoalStatus;
  stage?: "DRAFT" | "PROPOSED" | "AGREED";
  ageDays: number;                   // how long ago it was set
  dueInDays?: number;
  confidence?: "on_track" | "at_risk" | "off_track";
  confidenceNote?: string;
  blockedBy?: string;                // goal key this one waits on
  retro?: string;
  unit?: string;
  baseline?: number;
  target?: number;
  current?: number;
};

const GOALS: GoalSpec[] = [
  // Engineering team goal + its key results.
  { key: "tg_eng", owner: 2, dept: 1, title: "Ship the platform rewrite without losing reliability", description: "The rewrite only counts if the service gets faster and breaks less while it lands.", ageDays: 70, dueInDays: 45, status: "in_progress", confidence: "on_track" },
  { key: "tg_eng_kr1", owner: 0, dept: 1, kind: "key_result", parent: "tg_eng", weight: 40, title: "p95 API latency under 300ms", ageDays: 70, dueInDays: 45, unit: "ms", baseline: 640, target: 300, current: 410, status: "in_progress", confidence: "at_risk", confidenceNote: "Cold starts on the worker still dominate the tail." },
  { key: "tg_eng_kr2", owner: 1, dept: 1, kind: "key_result", parent: "tg_eng", weight: 30, title: "Change failure rate under 10%", ageDays: 70, dueInDays: 45, unit: "%", baseline: 24, target: 10, current: 14, status: "in_progress", confidence: "on_track" },
  { key: "tg_eng_kr3", owner: 3, dept: 1, kind: "key_result", parent: "tg_eng", weight: 30, title: "Automated coverage of the payroll path at 80%", ageDays: 70, dueInDays: 45, unit: "%", baseline: 52, target: 80, current: 71, status: "in_progress", confidence: "on_track" },
  // Product team goal + its key results.
  { key: "tg_prd", owner: 4, dept: 0, title: "Make the first week a success for every new admin", description: "Onboarding is where the product is won or lost; measure it like a funnel, not a feeling.", ageDays: 64, dueInDays: 52, status: "in_progress", confidence: "at_risk", confidenceNote: "Activation is moving, time-to-value is not." },
  { key: "tg_prd_kr1", owner: 5, dept: 0, kind: "key_result", parent: "tg_prd", weight: 50, title: "Time to first value under 3 days", ageDays: 64, dueInDays: 52, unit: "days", baseline: 9, target: 3, current: 5, status: "in_progress", confidence: "on_track" },
  { key: "tg_prd_kr2", owner: 6, dept: 0, kind: "key_result", parent: "tg_prd", weight: 50, title: "Week-1 activation at 60%", ageDays: 64, dueInDays: 52, unit: "%", baseline: 38, target: 60, current: 47, status: "in_progress", confidence: "at_risk", confidenceNote: "Two of the five setup steps still lose people." },
  // Sales team goal + its key results.
  { key: "tg_sls", owner: 9, dept: 2, title: "Land 12 new logos this quarter", description: "New business, not expansion. Coverage first, then conversion.", ageDays: 58, dueInDays: 32, status: "in_progress", confidence: "on_track" },
  { key: "tg_sls_kr1", owner: 8, dept: 2, kind: "key_result", parent: "tg_sls", weight: 60, title: "New logos closed", ageDays: 58, dueInDays: 32, unit: "customers", baseline: 0, target: 12, current: 7, status: "in_progress", confidence: "on_track" },
  { key: "tg_sls_kr2", owner: 10, dept: 2, kind: "key_result", parent: "tg_sls", weight: 40, title: "Pipeline coverage at 3x", ageDays: 58, dueInDays: 32, unit: "x", baseline: 1.6, target: 3, current: 2.4, status: "in_progress", confidence: "at_risk", confidenceNote: "Outbound reply rates dropped after the list refresh." },

  // Personal goals. The aligned ones name a team objective as their parent, which is what makes the alignment
  // tree on the goals page non-trivial; the rest are a person's own work with a due date.
  { key: "g_aarav_latency", owner: 0, parent: "tg_eng", weight: 60, title: "Cut cold-start latency on the edge worker", description: "Manifest caching plus a warm path on deploy.", ageDays: 52, dueInDays: 40, progress: 45, status: "in_progress", confidence: "at_risk", confidenceNote: "The cache lands this week; the warm path needs a deploy hook we do not have yet." },
  { key: "g_aarav_ts", owner: 0, weight: 40, title: "Finish the TypeScript 5 upgrade", ageDays: 96, dueInDays: -10, progress: 100, status: "completed", retro: "Landed a week late because two dependencies had no types. Worth it: the strict-mode errors it surfaced were three real bugs." },
  { key: "g_diya_oncall", owner: 1, parent: "tg_eng", weight: 50, title: "Own the reliability on-call rotation", description: "Runbooks for the top five pages, and a handover that takes ten minutes.", ageDays: 60, dueInDays: 35, progress: 70, status: "in_progress", confidence: "on_track" },
  { key: "g_diya_flaky", owner: 1, weight: 50, title: "Take the flaky test count to zero", ageDays: 48, dueInDays: 20, unit: "tests", baseline: 34, target: 0, current: 11, status: "in_progress", confidence: "on_track" },
  { key: "g_priya_regression", owner: 3, parent: "tg_eng", weight: 100, title: "Automate the payroll regression pack", ageDays: 44, dueInDays: 15, progress: 35, status: "in_progress", confidence: "off_track", confidenceNote: "Nothing moves until the latency work frees the staging worker.", blockedBy: "g_aarav_latency" },
  { key: "g_rohan_seniors", owner: 2, weight: 100, title: "Grow two engineers into senior scope", description: "Design ownership, on-call leadership, and a review record to show for it.", ageDays: 80, dueInDays: 60, progress: 50, status: "in_progress", confidence: "on_track" },
  { key: "g_meera_fre", owner: 5, parent: "tg_prd", weight: 60, title: "Redesign the first-run experience", ageDays: 50, dueInDays: 28, progress: 80, status: "in_progress", confidence: "on_track" },
  { key: "g_ishaan_funnel", owner: 6, parent: "tg_prd", weight: 40, title: "Instrument the activation funnel end to end", ageDays: 46, dueInDays: 24, progress: 55, status: "in_progress", confidence: "on_track" },
  { key: "g_ishaan_warehouse", owner: 6, weight: 0, title: "Migrate reporting to the new warehouse", ageDays: 90, dueInDays: -5, progress: 15, status: "cancelled" },
  { key: "g_neha_interviews", owner: 7, weight: 100, title: "Run six onboarding interviews with new admins", ageDays: 9, dueInDays: 30, progress: 20, status: "in_progress", stage: "PROPOSED" },
  { key: "g_vivaan_logos", owner: 8, parent: "tg_sls", weight: 100, title: "Close four enterprise deals", ageDays: 56, dueInDays: 32, unit: "deals", baseline: 0, target: 4, current: 3, status: "in_progress", confidence: "on_track" },
  { key: "g_kabir_meetings", owner: 10, parent: "tg_sls", weight: 100, title: "Book 60 qualified meetings", ageDays: 56, dueInDays: 25, unit: "meetings", baseline: 0, target: 60, current: 22, status: "in_progress", confidence: "at_risk", confidenceNote: "Behind pace since the list refresh; testing two new sequences." },
  { key: "g_sara_poc", owner: 11, weight: 100, title: "Cut proof-of-concept turnaround to 5 days", ageDays: 54, dueInDays: 38, unit: "days", baseline: 12, target: 5, current: 9, status: "in_progress", confidence: "on_track" },
];

// The two derivations the goal service applies on every write, so a seeded row reads the same as one the app
// produced: a measure gives the percentage (services/goals.ts#measuredProgress) and an objective with key
// results takes theirs, weighted (services/goals.ts#recomputeObjectiveProgress).
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const measured = (g: GoalSpec): number | null => {
  if (g.target == null || g.current == null) return null;
  const from = g.baseline ?? 0;
  const span = g.target - from;
  return span === 0 ? null : clampPct(((g.current - from) / span) * 100);
};
const goalProgress = (g: GoalSpec): number => {
  const krs = GOALS.filter((k) => k.kind === "key_result" && k.parent === g.key && k.status !== "cancelled");
  if (krs.length) {
    const w = (k: GoalSpec) => Math.max(0, k.weight ?? 0);
    return krs.every((k) => w(k) > 0)
      ? Math.round(krs.reduce((s, k) => s + w(k) * (measured(k) ?? k.progress ?? 0), 0) / krs.reduce((s, k) => s + w(k), 0))
      : Math.round(krs.reduce((s, k) => s + (measured(k) ?? k.progress ?? 0), 0) / krs.length);
  }
  return measured(g) ?? g.progress ?? 0;
};

// The manager who agreed each goal: the department's lead. A goal carries WHO accepted it and when, because an
// attainment figure computed from goals of unknown provenance is not defensible at review time.
const DEPT_LEAD: Record<string, typeof employees[number]> = {
  [DEPTS[1]!.uuid]: employees[2]!,  // Engineering  -> Rohan Verma
  [DEPTS[0]!.uuid]: employees[4]!,  // Product      -> Aditya Iyer
  [DEPTS[2]!.uuid]: employees[9]!,  // Sales        -> Ananya Reddy
};

const num = (v: number | null | undefined) => (v == null ? "NULL" : String(v));
const goalSeq: Record<string, number> = {};
const goalIds = new Map<string, string>();
for (const g of GOALS) goalIds.set(g.key, nid());
const goalRows = GOALS.map((g) => {
  const owner = employees[g.owner]!;
  const seq = (goalSeq[owner.code] = (goalSeq[owner.code] ?? 0) + 1);
  const created = NOW - g.ageDays * DAY;
  const stage = g.stage ?? "AGREED";
  const lead = DEPT_LEAD[owner.deptUuid]!;
  const agreed = stage === "AGREED" ? { at: created, by: lead.uuid } : { at: null, by: null };
  const due = g.dueInDays == null ? null : NOW + g.dueInDays * DAY;
  const status: GoalStatus = g.status ?? "not_started";
  return ` (${q(goalIds.get(g.key))},${q(`${owner.code}-${String(seq).padStart(3, "0")}`)},${q(owner.uuid)},${g.parent ? q(goalIds.get(g.parent)) : "NULL"},NULL,${q(g.kind ?? "objective")},${q(g.title)},${q(g.description ?? null)},${g.weight ?? 0},${goalProgress(g)},${q(status)},${q(stage)},${num(agreed.at)},${agreed.by ? q(agreed.by) : "NULL"},${num(due)},${g.confidence ? q(g.confidence) : "NULL"},${q(g.confidenceNote ?? null)},${g.blockedBy ? q(goalIds.get(g.blockedBy)) : "NULL"},${q(g.retro ?? null)},${g.dept == null ? "NULL" : q(DEPTS[g.dept]!.uuid)},${q(g.unit ?? null)},${num(g.baseline)},${num(g.target)},${num(g.current)},${created},${T0})`;
});

// The conversation on a goal: a manager's note on the record rather than in chat.
const GOAL_COMMENTS: [string, number, string, number][] = [
  // [goal key, author index, body, days ago]
  ["g_aarav_latency", 2, "The cache alone should take us most of the way. Let's not block on the deploy hook.", 6],
  ["g_priya_regression", 2, "Parked with my agreement while the staging worker is tied up. Not a slip on you.", 4],
  ["g_kabir_meetings", 9, "Two sequences is the right experiment. Review the reply rates with me on Friday.", 3],
  ["tg_prd_kr2", 4, "Step 3 is where the drop is. Meera's redesign covers it - keep them linked.", 5],
];
const goalCommentRows = GOAL_COMMENTS.map(([goal, author, body, ago]) => {
  const a = employees[author]!;
  return ` (${q(nid())},${q(goalIds.get(goal))},${q(a.uuid)},${q(a.email)},${q(body)},${NOW - ago * DAY})`;
});

// Contributors: a share of a goal's attainment credited to somebody who is not its owner, so cross-team work
// counts once for everyone rather than being retyped as a near-duplicate goal.
const GOAL_CONTRIBUTORS: [string, number, number, string][] = [
  ["g_aarav_latency", 1, 30, "Owned the manifest cache design and the load testing."],
  ["g_aarav_latency", 3, 20, "Built the latency regression harness."],
  ["g_meera_fre", 7, 25, "Ran the research that set the flow."],
];
const goalContributorRows = GOAL_CONTRIBUTORS.map(([goal, emp, share, note]) =>
  ` (${q(nid())},${q(goalIds.get(goal))},${q(employees[emp]!.uuid)},${share},${q(note)},${T0})`,
);

// Watchers: the people a slip has to reach. The owner of a goal that is BLOCKED BY this one hears about it
// first, which is the case that used to be silent.
const GOAL_WATCHERS: [string, number][] = [
  ["g_aarav_latency", 3],  // Priya - her regression pack waits on it
  ["g_aarav_latency", 2],  // Rohan - the engineering lead
  ["g_kabir_meetings", 9], // Ananya - the sales lead
];
const goalWatcherRows = GOAL_WATCHERS.map(([goal, emp]) =>
  ` (${q(nid())},${q(goalIds.get(goal))},${q(employees[emp]!.uuid)},${T0})`,
);

// --- Boards + tasks (/boards) ----------------------------------------------------------------------------------
// Two boards, because the two modes read differently: a continuous-flow kanban board for engineering (WIP limits
// on the working columns, work-type swimlanes) and a scrum board for product (sprints, swimlanes by assignee).
// bootstrap.sql seeds an empty "General" board so a fresh org has somewhere to drop work; these carry the cards,
// so the board view, the WIP chips, the sprint burndown and the flow analytics all have something to draw.
// Board codes start at ve-02: `ve-01` is the bootstrapped board, and `code` is UNIQUE. Both are in the
// everyone-works-it segment (domain/boardAccess.ts); sprints and cards are coded under their board.
type BoardDef = {
  uuid: string; code: string; name: string; description: string; prefix: string;
  mode: "kanban" | "scrum"; columns: typeof DEFAULT_BOARD_COLUMNS;
  swimlaneMode: "none" | "assignee" | "goal" | "priority" | "department" | "custom";
  swimlanes: { key: string; label: string }[];
  labels: { key: string; label: string; color: string }[];
};
const engBoard: BoardDef = {
  uuid: nid(), code: "ve-02", name: "Engineering delivery", description: "Platform work in flow. Swimlanes are the type of work; the WIP limits are the team's.",
  prefix: "ENG", mode: "kanban", columns: DEFAULT_BOARD_COLUMNS, swimlaneMode: "custom",
  swimlanes: [{ key: "feature", label: "Feature" }, { key: "bug", label: "Bug" }, { key: "chore", label: "Chore" }, { key: "tech_debt", label: "Tech debt" }],
  labels: [
    { key: "api", label: "API", color: "#2563eb" },
    { key: "ui", label: "UI", color: "#7c3aed" },
    { key: "infra", label: "Infra", color: "#0891b2" },
    { key: "perf", label: "Performance", color: "#ea580c" },
    { key: "security", label: "Security", color: "#dc2626" },
    { key: "ci", label: "CI", color: "#16a34a" },
    { key: "docs", label: "Docs", color: "#64748b" },
  ],
};
const prdBoard: BoardDef = {
  uuid: nid(), code: "ve-03", name: "Product delivery", description: "Two-week sprints. The product backlog is everything not yet pulled into one.",
  prefix: "PRD", mode: "scrum", columns: DEFAULT_SCRUM_COLUMNS, swimlaneMode: "assignee", swimlanes: [],
  labels: [
    { key: "research", label: "Research", color: "#0d9488" },
    { key: "design", label: "Design", color: "#7c3aed" },
    { key: "analytics", label: "Analytics", color: "#2563eb" },
    { key: "copy", label: "Copy", color: "#d97706" },
  ],
};
const BOARDS = [engBoard, prdBoard];
const boardRows = BOARDS.map((b) =>
  ` (${q(b.uuid)},${q(b.code)},${q(b.name)},${q(b.description)},${q(b.prefix)},${q(b.mode)},${q(JSON.stringify(b.columns))},${q(b.swimlaneMode)},${q(JSON.stringify(b.swimlanes))},NULL,${q(JSON.stringify(b.labels))},0,0,${T0},${T0})`,
);

// Sprints on the scrum board: one finished (so velocity has a data point) and one running.
const SPRINTS: { key: string; code: string; name: string; goal: string; startInDays: number; endInDays: number; state: "planning" | "active" | "completed" }[] = [
  { key: "s12", code: `${prdBoard.code}-001`, name: "Sprint 12", goal: "Ship the onboarding checklist and the funnel dashboard.", startInDays: -28, endInDays: -13, state: "completed" },
  { key: "s13", code: `${prdBoard.code}-002`, name: "Sprint 13", goal: "First-run experience: empty states, guided tour, and the research behind them.", startInDays: -7, endInDays: 7, state: "active" },
];
const sprintIds = new Map(SPRINTS.map((s) => [s.key, nid()]));
const sprintRows = SPRINTS.map((s) =>
  ` (${q(sprintIds.get(s.key))},${q(s.code)},${q(prdBoard.uuid)},${q(s.name)},${q(s.goal)},${NOW + s.startInDays * DAY},${NOW + s.endInDays * DAY},${q(s.state)},${T0},${T0})`,
);

type CardSpec = {
  key: string; board: BoardDef; column: string; lane?: string;
  title: string; description?: string;
  owner: number; assignee?: number; reporter?: number;
  priority: "low" | "medium" | "high" | "urgent";
  labels: string[]; size?: number; dueInDays?: number;
  blocked?: boolean; blockReason?: string; blockedBy?: string; // card key
  goal?: string;                                               // goal key
  cadence?: "weekly" | "biweekly" | "monthly" | "quarterly";
  sprint?: string;                                             // sprint key; absent on a scrum board = product backlog
  ageDays: number;
  doneDaysAgo?: number;                                        // when it reached the last column it has reached
};

// Engineering board. Ordered oldest-first so a card that blocks another is always inserted before it, and so
// the per-board task keys (ENG-1, ENG-2...) run in the order the work was filed.
const CARDS: CardSpec[] = [
  { key: "e_importer", board: engBoard, column: "done", lane: "tech_debt", title: "Retire the legacy attendance importer", description: "Nothing has written to it since the shift roster landed.", owner: 1, assignee: 1, reporter: 2, priority: "medium", labels: ["infra"], size: 5, ageDays: 30, doneDaysAgo: 20 },
  { key: "e_csv", board: engBoard, column: "done", lane: "feature", title: "Streaming CSV export for large reports", description: "Exports over 50k rows timed out; stream them instead of buffering.", owner: 1, assignee: 1, reporter: 4, priority: "high", labels: ["api", "perf"], size: 5, ageDays: 26, doneDaysAgo: 16 },
  { key: "e_payslip", board: engBoard, column: "done", lane: "bug", title: "Duplicate payslip PDF on retry", description: "A retried run re-rendered the PDF and left two documents on the employee.", owner: 0, assignee: 0, reporter: 3, priority: "urgent", labels: ["api"], size: 3, ageDays: 21, doneDaysAgo: 12 },
  { key: "e_cache", board: engBoard, column: "done", lane: "feature", title: "Cache resource manifests in the edge worker", description: "Manifest reads were the single biggest source of cold-start latency.", owner: 0, assignee: 0, reporter: 2, priority: "high", labels: ["perf", "infra"], size: 8, goal: "g_aarav_latency", ageDays: 18, doneDaysAgo: 6 },
  { key: "e_rotate", board: engBoard, column: "review", lane: "chore", title: "Rotate the D1 credentials", description: "Quarterly rotation, with the runbook updated as part of it.", owner: 3, assignee: 3, reporter: 2, priority: "medium", labels: ["security"], size: 2, dueInDays: 12, cadence: "quarterly", ageDays: 9 },
  { key: "e_warm", board: engBoard, column: "review", lane: "feature", title: "Warm the worker on deploy", description: "The last piece of the cold-start work: a post-deploy hook that takes the first hit.", owner: 0, assignee: 0, reporter: 2, priority: "high", labels: ["perf"], size: 3, goal: "g_aarav_latency", ageDays: 8 },
  { key: "e_regression", board: engBoard, column: "in_progress", lane: "chore", title: "Regression pack for payroll runs", description: "Golden-file runs over the statutory deductions, wired into CI.", owner: 3, assignee: 3, reporter: 2, priority: "medium", labels: ["ci"], size: 8, goal: "g_priya_regression", blocked: true, blockReason: "Staging worker is tied up by the latency work.", blockedBy: "e_warm", dueInDays: 14, ageDays: 7 },
  { key: "e_flaky", board: engBoard, column: "in_progress", lane: "bug", title: "Flaky clock-in e2e spec", description: "Fails about one run in six, always on the fence check.", owner: 1, assignee: 1, reporter: 3, priority: "high", labels: ["ci"], size: 3, goal: "g_diya_flaky", ageDays: 6 },
  { key: "e_audit", board: engBoard, column: "ready", lane: "chore", title: "Audit log retention policy", description: "Decide the window, then enforce it in the nightly sweep.", owner: 3, reporter: 2, priority: "low", labels: ["security", "docs"], size: 2, ageDays: 5 },
  { key: "e_tags", board: engBoard, column: "ready", lane: "feature", title: "Bulk import for asset tags", description: "Sales keep onboarding kit in batches of forty; one at a time does not scale.", owner: 0, reporter: 8, priority: "medium", labels: ["ui", "api"], size: 5, dueInDays: 18, ageDays: 4 },
  { key: "e_search", board: engBoard, column: "ready", lane: "feature", title: "Search ranking for people results", description: "An exact name match should outrank a body-text hit.", owner: 1, reporter: 5, priority: "medium", labels: ["api"], size: 3, ageDays: 3 },
  { key: "e_columns", board: engBoard, column: "backlog", lane: "tech_debt", title: "Drop the dead reimbursement columns", owner: 1, reporter: 2, priority: "low", labels: ["infra"], size: 2, ageDays: 2 },
  { key: "e_factory", board: engBoard, column: "backlog", lane: "chore", title: "Document the collection factory", description: "The add-a-collection checklist exists; the why behind it does not.", owner: 0, reporter: 2, priority: "low", labels: ["docs"], size: 1, ageDays: 2 },
  { key: "e_contrast", board: engBoard, column: "backlog", lane: "bug", title: "Dark-mode contrast on dense tables", owner: 3, reporter: 7, priority: "low", labels: ["ui"], size: 3, ageDays: 1 },

  // Product board. The two oldest sat in the sprint that closed; the middle set is the running sprint; the last
  // two carry no sprint at all, which on a scrum board IS the product backlog.
  { key: "p_checklist", board: prdBoard, column: "done", title: "Onboarding checklist redesign", description: "Five steps, each one finishable in a sitting.", owner: 5, assignee: 5, reporter: 4, priority: "high", labels: ["design"], size: 5, goal: "g_meera_fre", sprint: "s12", ageDays: 26, doneDaysAgo: 17 },
  { key: "p_dashboard", board: prdBoard, column: "done", title: "Activation funnel dashboard", description: "Signup to first payroll run, step by step.", owner: 6, assignee: 6, reporter: 4, priority: "medium", labels: ["analytics"], size: 8, goal: "g_ishaan_funnel", sprint: "s12", ageDays: 24, doneDaysAgo: 14 },
  { key: "p_empty", board: prdBoard, column: "review", title: "First-run empty states", description: "Every empty table says what to do next, not that it is empty.", owner: 5, assignee: 5, reporter: 4, priority: "high", labels: ["design", "copy"], size: 3, goal: "g_meera_fre", sprint: "s13", ageDays: 6 },
  { key: "p_interviews", board: prdBoard, column: "in_progress", title: "Interview six new admins", description: "Week-one calls, recorded, with the drop-off points tagged.", owner: 7, assignee: 7, reporter: 4, priority: "medium", labels: ["research"], size: 5, goal: "g_neha_interviews", sprint: "s13", ageDays: 5 },
  { key: "p_metric", board: prdBoard, column: "in_progress", title: "Define the week-1 activation metric", description: "One definition, agreed once, before anyone reports against it.", owner: 6, assignee: 6, reporter: 4, priority: "high", labels: ["analytics"], size: 3, goal: "g_ishaan_funnel", sprint: "s13", ageDays: 4 },
  { key: "p_tour", board: prdBoard, column: "to_do", title: "Guided tour for the dashboard", owner: 5, assignee: 5, reporter: 4, priority: "medium", labels: ["design"], size: 8, dueInDays: 9, sprint: "s13", ageDays: 3 },
  { key: "p_pricing", board: prdBoard, column: "to_do", title: "Pricing page copy refresh", owner: 4, assignee: 4, reporter: 4, priority: "low", labels: ["copy"], size: 2, sprint: "s13", ageDays: 3 },
  { key: "p_churn", board: prdBoard, column: "to_do", title: "Churn survey instrument", description: "Backlog: worth doing once the onboarding work stops moving.", owner: 7, reporter: 4, priority: "low", labels: ["research"], size: 5, ageDays: 2 },
  { key: "p_trial", board: prdBoard, column: "to_do", title: "Self-serve trial funnel", description: "Backlog: needs sizing before it goes near a sprint.", owner: 4, reporter: 4, priority: "medium", labels: ["analytics"], size: 13, ageDays: 2 },
];

// Cards, their flow stamps, and the movement log behind the cumulative flow diagram.
//
// A card that sits in the third column got there by passing through the first two, and the analytics read that
// history rather than the card's current state - so each card is walked through its board's columns from the
// left, one `card_movements` row per crossing. The stamps the board itself shows (`committed_at`, `started_at`,
// `deliveredAt`) are taken from that same walk, which is what makes lead time and cycle time come out as real
// durations instead of zero.
const RANK_STEP = 1024;
const cardIds = new Map<string, string>();
for (const c of CARDS) cardIds.set(c.key, nid());
const cardSeq: Record<string, number> = {};
const cardRank: Record<string, number> = {};
const cardRows: string[] = [];
const moveRows: string[] = [];
for (const c of CARDS) {
  const owner = employees[c.owner]!;
  const cols = c.board.columns;
  const idx = cols.findIndex((col) => col.key === c.column);
  const created = NOW - c.ageDays * DAY;
  // Entry time per column, spread evenly between the card being filed and it reaching the column it is in now.
  // `doneDaysAgo` pins that last crossing, which is what keeps a card delivered in a CLOSED sprint inside that
  // sprint's dates; without one it lands short of today, leaving a plausible age in the current column.
  const last = c.doneDaysAgo == null ? created + (NOW - created) * 0.8 : NOW - c.doneDaysAgo * DAY;
  const at = (k: number) => (idx === 0 ? created : Math.round(created + ((last - created) * k) / idx));
  const reached = (key: string) => {
    const i = cols.findIndex((col) => col.key === key);
    return i >= 0 && i <= idx ? at(i) : null;
  };
  const committed = (() => { const col = cols.find((x) => x.commitment); return col ? reached(col.key) : null; })();
  const started = reached("in_progress");
  const delivered = (() => { const col = cols.find((x) => x.delivery); return col ? reached(col.key) : null; })();
  const seq = (cardSeq[c.board.code] = (cardSeq[c.board.code] ?? 0) + 1);
  const rankKey = `${c.board.code}:${c.column}`;
  const rank = (cardRank[rankKey] = (cardRank[rankKey] ?? 0) + RANK_STEP);
  // Coded under the board (domain/boardAccess.ts), leaf = the per-board sequence behind the task key.
  const code = `${c.board.code}-${String(seq).padStart(3, "0")}`;
  cardRows.push(
    ` (${q(cardIds.get(c.key))},${q(code)},${q(c.board.uuid)},${seq},${q(c.board.prefix)},${c.sprint ? q(sprintIds.get(c.sprint)) : "NULL"},${q(owner.uuid)},${q(owner.deptUuid)},${q(c.column)},${c.lane ? q(c.lane) : "NULL"},${rank},${q(c.title)},${q(c.description ?? null)},${c.assignee == null ? "NULL" : q(employees[c.assignee]!.uuid)},${c.reporter == null ? "NULL" : q(employees[c.reporter]!.uuid)},${q(c.priority)},${q(JSON.stringify(c.labels))},'[]',${num(c.size)},${c.dueInDays == null ? "NULL" : NOW + c.dueInDays * DAY},${c.blocked ? 1 : 0},${q(c.blockReason ?? null)},${c.blockedBy ? q(cardIds.get(c.blockedBy)) : "NULL"},${c.goal ? q(goalIds.get(c.goal)) : "NULL"},${q(c.cadence ?? null)},NULL,${num(committed)},${num(started)},${num(delivered)},${created},${T0})`,
  );
  const actor = employees[c.assignee ?? c.owner]!;
  for (let k = 0; k <= idx; k++) {
    moveRows.push(
      ` (${q(nid())},${q(cardIds.get(c.key))},${q(c.board.uuid)},${k === 0 ? "NULL" : q(cols[k - 1]!.key)},${q(cols[k]!.key)},${q(actor.uuid)},${at(k)})`,
    );
  }
}

// Checklists and comments on the cards where the work is actually happening.
const CARD_TODOS: [string, string, boolean][] = [
  ["e_regression", "Golden files for PF, ESI and PT", true],
  ["e_regression", "TDS slabs, including the declaration cut", false],
  ["e_regression", "Wire the pack into the nightly CI run", false],
  ["e_rotate", "Rotate the local D1 token", true],
  ["e_rotate", "Update the rotation runbook", false],
  ["p_interviews", "Recruit six admins from the last 30 days of signups", true],
  ["p_interviews", "Run the calls", false],
  ["p_interviews", "Tag the drop-off points against the funnel steps", false],
];
const cardTodoRows = CARD_TODOS.map(([card, text, done]) =>
  ` (${q(nid())},${q(cardIds.get(card))},${q(text)},${done ? 1 : 0},${T0},${T0})`,
);
const CARD_COMMENTS: [string, number, string, number][] = [
  ["e_regression", 2, "Blocked with my agreement - ENG-6 frees the staging worker, then this moves.", 3],
  ["e_flaky", 3, "Reproduced it on the fence check: the clock rolls over mid-assertion.", 2],
  ["e_warm", 2, "Once this is in review, ping Priya so the regression pack can start.", 1],
  ["p_interviews", 4, "Tag the drop-offs against the funnel steps so this feeds the dashboard.", 2],
];
const cardCommentRows = CARD_COMMENTS.map(([card, author, body, ago]) => {
  const a = employees[author]!;
  return ` (${q(nid())},${q(cardIds.get(card))},${q(a.uuid)},${q(a.email)},${q(body)},${NOW - ago * DAY},${T0})`;
});

const out: string[] = [
  "-- GENERATED by bootstrap/genDemo.ts - OPTIONAL demo overlay (people, kudos, boards + goals). Apply after bootstrap.sql.",
  "-- DEV/DEMO FIXTURE - NEVER APPLY TO A PRODUCTION DATABASE. See docs/deploy-security.md.",
  "-- Apply with: scripts/start.sh --demo",
  "INSERT INTO departments (uuid,code,name,manager_ids,created_at,updated_at) VALUES",
  DEPTS.map((d) => ` (${q(d.uuid)},${q(d.code)},${q(d.name)},NULL,${T0},${T0})`).join(",\n") + ";",
  "INSERT INTO employees (uuid,code,first_name,last_name,work_email,job_title,department_id,start_date,status,created_at,updated_at) VALUES",
  [...employees, superEmp].map((e) => ` (${q(e.uuid)},${q(e.code)},${q(e.first)},${q(e.last)},${q(e.email)},${q(e.title)},${q(e.deptUuid)},${e.start},'active',${T0},${T0})`).join(",\n") + ";",
  "INSERT INTO users (uuid,email,role,status,employee_id,created_at,updated_at) VALUES",
  userRows.join(",\n") + ";",
  // Link the already-minted super_admin dev login (start.sh) to its new employee record.
  `UPDATE users SET employee_id=${q(superEmp.uuid)},updated_at=${T0} WHERE email='super@example.com';`,
  // `body_text` is the markup-stripped mirror the search index binds to. The service derives it on every write,
  // so a seeded row has to carry it too or none of this board is findable; these bodies are plain prose, so it is
  // the body verbatim.
  "INSERT INTO announcements (uuid,code,kind,title,body,body_text,illustration,author_employee_id,recipient_employee_id,value,category,level,points,published,publish_time,created_at,updated_at) VALUES",
  [...annRows, ...kudoRows].join(",\n") + ";",
  "INSERT INTO announcement_poll_options (uuid,announcement_id,label,position,created_at) VALUES",
  pollOptRows.join(",\n") + ";",
  "INSERT INTO announcement_reactions (uuid,announcement_id,reply_id,employee_id,emoji,created_at) VALUES",
  rxRows.join(",\n") + ";",
  "INSERT INTO announcement_replies (uuid,announcement_id,author_id,author_email,body,created_at) VALUES",
  rpRows.join(",\n") + ";",
  "INSERT INTO notifications (uuid,code,recipient_id,type,title,body,link,subject,priority,action,read_time,created_at,updated_at) VALUES",
  notifRows.join(",\n") + ";",
  // Goals before cards: a card links to the goal its delivery advances, so the goal row has to exist first.
  // Within the goals themselves, a parent is written before the children that name it (`parent_id`), and the
  // goal something waits on before the one that waits (`blocked_by_id`) - the GOALS list is ordered for that.
  "INSERT INTO goals (uuid,code,employee_id,parent_id,cycle_id,kind,title,description,weight,progress,status,stage,agreed_at,agreed_by_id,due_date,confidence,confidence_note,blocked_by_id,retro,department_id,unit,baseline_value,target_value,current_value,created_at,updated_at) VALUES",
  goalRows.join(",\n") + ";",
  "INSERT INTO goal_comments (uuid,goal_id,author_id,author_email,body,created_at) VALUES",
  goalCommentRows.join(",\n") + ";",
  "INSERT INTO goal_contributors (uuid,goal_id,employee_id,share,note,created_at) VALUES",
  goalContributorRows.join(",\n") + ";",
  "INSERT INTO goal_watchers (uuid,goal_id,employee_id,created_at) VALUES",
  goalWatcherRows.join(",\n") + ";",
  "INSERT INTO boards (uuid,code,name,description,task_prefix,mode,columns_json,swimlane_mode,swimlanes_json,no_lane_label,labels_json,hide_empty_lanes,reassign_lane_on_move,created_at,updated_at) VALUES",
  boardRows.join(",\n") + ";",
  "INSERT INTO sprints (uuid,code,board_id,name,goal,start_date,end_date,state,created_at,updated_at) VALUES",
  sprintRows.join(",\n") + ";",
  "INSERT INTO cards (uuid,code,board_id,seq,key_prefix,sprint_id,employee_id,department_id,column_key,swimlane_key,rank,title,description,assignee_id,reporter_id,priority,labels_json,documents_json,size,due_date,blocked,block_reason,blocked_by_id,goal_id,cadence,cadence_anchor_day,committed_at,started_at,delivered_at,created_at,updated_at) VALUES",
  cardRows.join(",\n") + ";",
  "INSERT INTO card_movements (uuid,card_id,board_id,from_column,to_column,actor_id,at) VALUES",
  moveRows.join(",\n") + ";",
  "INSERT INTO card_todos (uuid,card_id,text,done,created_at,updated_at) VALUES",
  cardTodoRows.join(",\n") + ";",
  "INSERT INTO card_comments (uuid,card_id,author_id,author_email,body,created_at,updated_at) VALUES",
  cardCommentRows.join(",\n") + ";",
  "",
];

process.stdout.write(out.join("\n") + "\n");
