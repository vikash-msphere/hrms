// Generates bootstrap/demo.sql: an OPTIONAL demo overlay for a bootstrapped DB - a handful of departments +
// employees, a populated kudos/recognition board (varied category × level so every card style shows), a couple
// plain announcements, and some reactions/replies so the social features are visible. IDs are DETERMINISTIC
// (counter-based); timestamps are anchored to generation time (demo.sql is regenerated on every `--demo` run)
// so the feed always reads as just-happened and recent kudos light the "New" badge. Not production data.
//
//   Run:    npx tsx bootstrap/genDemo.ts > bootstrap/demo.sql
//   Apply:  scripts/start.sh --demo   (resets, bootstraps, then applies this)
import { bytesToBase32 } from "../src/lib/idCodec";
import { DEFAULT_KUDOS_CONFIG, pointsForLevel } from "../src/domain/kudos";
import { KUDOS_CONFIG } from "./collections/kudos";

const T0 = 1700000000000;
const NOW = Date.now(); // generation time, so the feed always reads as recent (and the "New" badge lights)
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

// --- Demo employee logins (employee role) so you can "act as" a few people -----------------------------------
const userRows = [employees[0]!, employees[4]!, employees[8]!].map(
  (e) => ` (${q(nid())},${q(e.email)},'employee','active',${q(e.uuid)},${T0},${T0})`,
);

const out: string[] = [
  "-- GENERATED by bootstrap/genDemo.ts - OPTIONAL demo overlay (people + kudos). Apply after bootstrap.sql.",
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
  "",
];

process.stdout.write(out.join("\n") + "\n");
