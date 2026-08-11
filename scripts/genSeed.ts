// Generates scripts/seed.sql: 10 departments, 100 employees, and real-world activity (leave, attendance,
// reimbursements, kudos, compensation, goals, announcements). DETERMINISTIC - fixed ids/timestamps, no
// Date.now/random - so re-running produces byte-identical output. The 5 role logins + their employees + 2
// base departments keep their fixed ids (start.sh logins depend on them). The access_rules + policy blocks
// come from the same generators the runtime/tests use (test/seedDrift stays green).
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/genSeed.ts > scripts/seed.sql
import { renderAccessRulesSeed } from "./genAccessRulesSeed";
import { DEFAULT_POLICY } from "../src/domain/manifests";
import { bytesToBase32 } from "../src/lib/idCodec";

const T0 = 1700000000000; // fixed created/updated stamp (matches the prior seed)
const NOW = 1780272000000; // "today" anchor = 2026-06-01 UTC, so activity reads as recent in the app
const DAY = 86_400_000;

// Deterministic 13-char base32 id from a counter (>= 1000 to never collide with the fixed login ids).
const idOf = (n: number) => {
  const b = new Uint8Array(8);
  let x = BigInt(n + 1000);
  for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return bytesToBase32(b);
};
let counter = 0;
const nid = () => idOf(counter++);
const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const out: string[] = [];
const emit = (s: string) => out.push(s);

// Tiny deterministic LCG for variety (states, amounts, pairings) - stable across runs.
let seed = 0x2545f491;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length) % a.length]!;
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

type Emp = { uuid: string; code: string; first: string; last: string; email: string; title: string; deptUuid: string; managerUuid: string | null; start: number };

const FIRST = ["Aarav","Vivaan","Aditya","Vihaan","Arjun","Sai","Reyansh","Ayaan","Krishna","Ishaan","Rohan","Kabir","Ananya","Diya","Saanvi","Aadhya","Aarohi","Anika","Navya","Myra","Sara","Riya","Priya","Neha","Pooja","Sneha","Kavya","Meera","Isha","Tara","Liam","Noah","Olivia","Emma","Ava","Sophia","James","Lucas","Mia","Amelia","Daniel","Ethan","Grace","Chloe","Nathan","Ryan","Maya","Zoe","Leo","Nora"];
const LAST = ["Sharma","Verma","Patel","Gupta","Reddy","Nair","Iyer","Rao","Mehta","Shah","Singh","Kumar","Joshi","Desai","Kapoor","Malhotra","Chopra","Bose","Das","Ghosh","Khan","Pillai","Menon","Bhat","Naidu","Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Wilson","Anderson","Taylor","Thomas","Moore","Martin","Lee"];

// Departments: 04 Engineering + 07 Sales already exist (fixed ids/heads); the rest are new.
const DEPTS = [
  { code: "04", name: "Engineering", uuid: "20n3pk2xdszr0", fixed: true },
  { code: "07", name: "Sales", uuid: "24n3rk2ydszr2", fixed: true },
  { code: "02", name: "Product", uuid: nid() },
  { code: "03", name: "Marketing", uuid: nid() },
  { code: "05", name: "Finance", uuid: nid() },
  { code: "06", name: "People & Culture", uuid: nid() },
  { code: "08", name: "Operations", uuid: nid() },
  { code: "09", name: "Customer Support", uuid: nid() },
  { code: "0a", name: "Legal", uuid: nid() },
  { code: "0b", name: "IT", uuid: nid() },
];
const TITLES: Record<string, string[]> = {
  Engineering: ["Engineering Manager","Senior Software Engineer","Software Engineer","Staff Engineer","QA Engineer","DevOps Engineer","Frontend Engineer","Backend Engineer"],
  Sales: ["Sales Director","Account Executive","Sales Development Rep","Regional Sales Manager","Solutions Consultant"],
  Product: ["Head of Product","Senior Product Manager","Product Manager","Product Designer","UX Researcher"],
  Marketing: ["Marketing Manager","Content Strategist","Growth Marketer","Brand Designer","SEO Specialist"],
  Finance: ["Finance Manager","Financial Analyst","Accountant","Payroll Specialist","FP&A Analyst"],
  "People & Culture": ["HR Manager","Talent Acquisition Lead","HR Business Partner","People Ops Specialist","Recruiter"],
  Operations: ["Operations Manager","Operations Analyst","Facilities Coordinator","Program Manager"],
  "Customer Support": ["Support Lead","Customer Success Manager","Support Engineer","Support Specialist"],
  Legal: ["General Counsel","Legal Counsel","Compliance Officer","Contracts Manager"],
  IT: ["IT Manager","Systems Administrator","IT Support Specialist","Security Analyst"],
};

// --- Employees ----------------------------------------------------------------------------------------------
// Fixed login employees (must keep their ids/codes/emails).
const employees: Emp[] = [];
const FIXED: Emp[] = [
  { uuid: "28n3tk2zdszr4", code: "04-001", first: "Mara", last: "Manager", email: "mgr@example.com", title: "Engineering Manager", deptUuid: "20n3pk2xdszr0", managerUuid: null, start: T0 - 800 * DAY },
  { uuid: "2cn3wk30dszr6", code: "04-002", first: "Eve", last: "Employee", email: "emp@example.com", title: "Software Engineer", deptUuid: "20n3pk2xdszr0", managerUuid: "28n3tk2zdszr4", start: T0 - 500 * DAY },
  { uuid: "2gn3yk31dszr8", code: "07-001", first: "Hank", last: "Hr", email: "hr@example.com", title: "HR Manager", deptUuid: "24n3rk2ydszr2", managerUuid: null, start: T0 - 900 * DAY },
  { uuid: "2mn40k32dszra", code: "07-002", first: "Pat", last: "Pay", email: "pay@example.com", title: "Payroll Specialist", deptUuid: "24n3rk2ydszr2", managerUuid: null, start: T0 - 700 * DAY },
  { uuid: "00000000033kg", code: "04-003", first: "Sam", last: "Super", email: "super@example.com", title: "Administrator", deptUuid: "20n3pk2xdszr0", managerUuid: "28n3tk2zdszr4", start: T0 - 1000 * DAY },
];
employees.push(...FIXED);

// Per-dept next employee sequence (Engineering used 001-003 incl. super; Sales used 001-002).
const deptSeq: Record<string, number> = { "04": 4, "07": 3 };
const deptHead: Record<string, string> = { "04": "28n3tk2zdszr4", "07": "2gn3yk31dszr8" };
const usedEmail = new Set(employees.map((e) => e.email));
const mkEmail = (f: string, l: string) => {
  let base = `${f}.${l}`.toLowerCase().replace(/[^a-z.]/g, "");
  let e = `${base}@example.com`, i = 1;
  while (usedEmail.has(e)) e = `${base}${++i}@example.com`;
  usedEmail.add(e);
  return e;
};

// Grow to 100 total: round-robin across departments.
let di = 0;
while (employees.length < 100) {
  const d = DEPTS[di % DEPTS.length]!;
  di++;
  const seq = (deptSeq[d.code] ??= 1);
  deptSeq[d.code] = seq + 1;
  const code = `${d.code}-${String(seq).padStart(3, "0")}`;
  const first = pick(FIRST), last = pick(LAST);
  const isHead = seq === 1 && !deptHead[d.code];
  const titles = TITLES[d.name]!;
  const title = isHead ? titles[0]! : pick(titles.slice(1));
  const uuid = nid();
  if (isHead) deptHead[d.code] = uuid;
  const start = NOW - between(60, 1600) * DAY;
  employees.push({ uuid, code, first, last, email: mkEmail(first, last), title, deptUuid: d.uuid, managerUuid: deptHead[d.code] && deptHead[d.code] !== uuid ? deptHead[d.code]! : null, start });
}
const paid = employees.filter((e) => !FIXED.includes(e)); // generated set for activity (keep fixed clean-ish too)

// --- Emit: departments --------------------------------------------------------------------------------------
emit("-- GENERATED by scripts/genSeed.ts (deterministic). Do not hand-edit; re-run the generator.");
emit("-- DEV/DEMO FIXTURE - NEVER APPLY TO A PRODUCTION DATABASE. Creates predictable accounts");
emit("--   (super@example.com = super_admin, etc). See docs/deploy-security.md.");
emit("-- 10 departments, 100 employees, real-world activity. 5 role logins keep fixed ids (start.sh).");
emit(`-- logins: super@ / mgr@ / hr@ / pay@ / emp@ example.com`);
emit("INSERT INTO departments (uuid,code,name,manager_ids,created_at,updated_at) VALUES");
emit(DEPTS.map((d) => ` (${q(d.uuid)},${q(d.code)},${q(d.name)},${deptHead[d.code] ? q(JSON.stringify([deptHead[d.code]])) : "NULL"},${T0},${T0})`).join(",\n") + ";");

// employees
// epf_enrolled = 1 for everyone: the compensation split below RESERVES the employer PF share inside each CTC,
// so PF has to actually apply or every seeded split under-reconciles by that amount (and the CTC build-up on the
// profile reads as if PF sat outside the promised CTC).
emit("INSERT INTO employees (uuid,code,first_name,last_name,work_email,job_title,department_id,manager_id,start_date,status,epf_enrolled,created_at,updated_at) VALUES");
emit(employees.map((e) => ` (${q(e.uuid)},${q(e.code)},${q(e.first)},${q(e.last)},${q(e.email)},${q(e.title)},${q(e.deptUuid)},${e.managerUuid ? q(e.managerUuid) : "NULL"},${e.start},'active',1,${T0},${T0})`).join(",\n") + ";");

// roles + access_rules + policy + users (fixed)
emit(`INSERT INTO roles (name,label,protected,created_at,updated_at) VALUES
 ('everyone','Everyone',1,${T0},${T0}),
 ('employee','Employee',1,${T0},${T0}),
 ('manager','Manager',1,${T0},${T0}),
 ('hr_admin','HR Admin',1,${T0},${T0}),
 ('payroll_admin','Payroll Admin',1,${T0},${T0}),
 ('super_admin','Super Admin',1,${T0},${T0});`);
emit(renderAccessRulesSeed());
// Demo: enable in-app notifications for everyone. This is RUNTIME ACL data (pre-seeded access_rules rows for
// the `everyone` pseudo-role) - exactly what an admin would create in the Access Management UI - NOT a
// grants.ts/code grant. Mirrors the leave-requests employee shape: the bare-collection rule grants the LIST
// call (a 1-token pattern never matches an item, so it can't widen breadth), while the `.me.**` self rules
// drive OWN-only breadth + own writes. So a caller only ever sees/marks their OWN notifications.
// The `markAllRead` row is a COLLECTION-level custom method, so it is encoded broad (scope all, match_code
// NULL) exactly as compileGrant encodes a 2-token verb pattern - a match_code would file it in the
// per-object lane, which a verb with no object id never reaches, and the capability would be unreachable.
// Separate INSERT so the generated block above still byte-matches the drift gate.
emit(`INSERT INTO access_rules (uuid,subject,subject_kind,namespace,pattern,scope_kind,scope_code,match_code,level,effect,created_at,updated_at) VALUES
 ('nsntf0001','everyone','role','notifications','notifications','all','',NULL,'read','allow',${T0},${T0}),
 ('nsntf0002','everyone','role','notifications','notifications.me.**','self','',NULL,'read','allow',${T0},${T0}),
 ('nsntf0003','everyone','role','notifications','notifications.me.**','self','',NULL,'write','allow',${T0},${T0}),
 ('nsntf0004','everyone','role','notifications','notifications.markAllRead','all','',NULL,NULL,'allow',${T0},${T0});`);
emit(`INSERT INTO policy (key,value_json,updated_at) VALUES\n ('manifest',${q(JSON.stringify(DEFAULT_POLICY))},${T0});`);
emit(`INSERT INTO users (uuid,email,role,status,employee_id,created_at,updated_at) VALUES
 ('2rn42k33dszrc','super@example.com','super_admin','active','00000000033kg',${T0},${T0}),
 ('2wn44k34dszre','mgr@example.com','manager','active','28n3tk2zdszr4',${T0},${T0}),
 ('30n46k35dszrg','hr@example.com','hr_admin','active','2gn3yk31dszr8',${T0},${T0}),
 ('34n48k36dszrj','pay@example.com','payroll_admin','active','2mn40k32dszra',${T0},${T0}),
 ('38n4ak37dszrm','emp@example.com','employee','active','2cn3wk30dszr6',${T0},${T0});`);

// --- Config: leave types, holidays, reimbursement categories, compliance --------------------------------------
const LT = [
  { uuid: "3gn4ek39dszrr", code: "0a", name: "Annual", accr: 18 },
  { uuid: nid(), code: "0b", name: "Sick", accr: 12 },
  { uuid: nid(), code: "0c", name: "Casual", accr: 12 },
  { uuid: nid(), code: "0d", name: "Unpaid", accr: 0 },
];
emit("INSERT INTO leave_types (uuid,code,name,accrual_days_per_year,paid,created_at,updated_at) VALUES");
emit(LT.map((t) => ` (${q(t.uuid)},${q(t.code)},${q(t.name)},${t.accr},${t.name === "Unpaid" ? 0 : 1},${T0},${T0})`).join(",\n") + ";");

const ymd = (ms: number) => Math.floor(ms / DAY) * DAY;
const HOL = [
  ["New Year","fixed",Date.UTC(2026, 0, 1)],["Republic Day","fixed",Date.UTC(2026, 0, 26)],["Holi","optional",Date.UTC(2026, 2, 4)],
  ["Good Friday","optional",Date.UTC(2026, 3, 3)],["Independence Day","fixed",Date.UTC(2026, 7, 15)],["Gandhi Jayanti","fixed",Date.UTC(2026, 9, 2)],
  ["Diwali","fixed",Date.UTC(2026, 10, 8)],["Christmas","fixed",Date.UTC(2026, 11, 25)],
] as const;
emit("INSERT INTO holidays (uuid,code,date,name,kind,created_at,updated_at) VALUES");
emit(HOL.map(([n, k, d], i) => ` (${q(nid())},${q((i + 10).toString(36))},${d},${q(n)},${q(k)},${T0},${T0})`).join(",\n") + ";");

const RC = [
  { uuid: nid(), code: "0a", name: "Travel" }, { uuid: nid(), code: "0b", name: "Meals" },
  { uuid: nid(), code: "0c", name: "Equipment" }, { uuid: nid(), code: "0d", name: "Training" },
];
emit("INSERT INTO reimbursement_categories (uuid,code,name,requires_receipt,created_at,updated_at) VALUES");
emit(RC.map((c) => ` (${q(c.uuid)},${q(c.code)},${q(c.name)},${c.name === "Travel" || c.name === "Equipment" ? 1 : 0},${T0},${T0})`).join(",\n") + ";");

// compliance events (kept from the prior seed - good calendar demo)
emit(`INSERT INTO compliance_events (uuid,code,title,category,frequency,due_date,period_label,status,filed_date,reference,assignee_id,notes,created_at,updated_at) VALUES
 ('cmpev1a2b3c4d','0a','TDS deposit (May 2026)','Income Tax (TDS)','monthly',1780790400000,'May 2026','filed',1780617600000,'ITNS281-0001',NULL,'Monthly TDS challan',${T0},${T0}),
 ('cmpev2b3c4d5e','0b','Professional Tax (May 2026)','Professional Tax','monthly',1782000000000,'May 2026','pending',NULL,NULL,NULL,NULL,${T0},${T0}),
 ('cmpev3c4d5e6f','0c','GST GSTR-3B (May 2026)','GST','monthly',1781913600000,'May 2026','filed',1781740800000,'AA0726000001',NULL,NULL,${T0},${T0}),
 ('cmpev4d5e6f7g','0d','PF (EPF) contribution (Jun 2026)','EPFO','monthly',1784073600000,'Jun 2026','pending',NULL,NULL,NULL,NULL,${T0},${T0}),
 ('cmpev5e6f7g8h','0e','TDS deposit (Jun 2026)','Income Tax (TDS)','monthly',1783382400000,'Jun 2026','pending',NULL,NULL,NULL,NULL,${T0},${T0}),
 ('cmpev6f7g8h9j','0f','Annual Return (FY 2025-26)','MCA / Registrar','annual',1790726400000,'FY 2025-26','pending',NULL,NULL,NULL,NULL,${T0},${T0});`);

// --- Activity ------------------------------------------------------------------------------------------------
const ownSeq: Record<string, number> = {};
const ocode = (empCode: string) => `${empCode}-${String((ownSeq[empCode] = (ownSeq[empCode] ?? 0) + 1)).padStart(3, "0")}`;
const userOf: Record<string, string> = { "28n3tk2zdszr4": "2wn44k34dszre", "2gn3yk31dszr8": "30n46k35dszrg" }; // decider user ids

// Leave balances: every employee gets a balance row per paid leave type.
const lbRows: string[] = [];
for (const e of employees) for (const t of LT.filter((x) => x.name !== "Unpaid")) {
  lbRows.push(` (${q(nid())},${q(ocode(e.code))},${q(e.uuid)},${q(t.uuid)},${(between(2, t.accr * 10) / 10).toFixed(1)},${T0},${T0})`);
}
emit("INSERT INTO leave_balances (uuid,code,employee_id,leave_type_id,balance_days,created_at,updated_at) VALUES");
emit(lbRows.join(",\n") + ";");

// Leave requests: ~45, varied states + recent dates.
const LSTATES = ["APPROVED","APPROVED","APPROVED","PENDING","PENDING","REJECTED","CANCELLED"];
const LREASON = ["Family function","Medical","Vacation","Personal work","Festival","Travel","Not feeling well",null];
const lrRows: string[] = [];
for (let i = 0; i < 45; i++) {
  const e = pick(paid);
  const t = pick(LT);
  const startD = ymd(NOW + between(-60, 40) * DAY);
  const len = between(1, 5);
  const state = pick(LSTATES);
  const decided = state === "APPROVED" || state === "REJECTED" ? userOf[e.managerUuid ?? ""] ?? "30n46k35dszrg" : null;
  lrRows.push(` (${q(nid())},${q(ocode(e.code))},${q(e.uuid)},${q(t.uuid)},${startD},${startD + (len - 1) * DAY},${len},${q(state)},${q(pick(LREASON))},${decided ? q(decided) : "NULL"},${T0},${T0})`);
}
emit("INSERT INTO leave_requests (uuid,code,employee_id,leave_type_id,start_date,end_date,days,state,reason,decided_by,created_at,updated_at) VALUES");
emit(lrRows.join(",\n") + ";");

// Attendance: last 6 weekdays for ~25 employees.
const atRows: string[] = [];
for (const e of paid.slice(0, 25)) {
  for (let d = 1; d <= 8; d++) {
    const day = new Date(NOW - d * DAY);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const base = ymd(day.getTime());
    const cin = base + (9 * 60 + between(0, 40)) * 60_000;
    const cout = cin + (8 * 60 + between(-20, 90)) * 60_000;
    atRows.push(` (${q(nid())},${q(ocode(e.code))},${q(e.uuid)},${cin},${cout},'clock',NULL,${T0},${T0})`);
  }
}
emit("INSERT INTO attendance_sessions (uuid,code,employee_id,clock_in,clock_out,source,note,created_at,updated_at) VALUES");
emit(atRows.join(",\n") + ";");

// Reimbursements: ~30, varied state/amount.
const RSTATE = ["PENDING","APPROVED","PAID","PAID","REJECTED"];
const RDESC = ["Client dinner","Flight to client site","Laptop stand","Conference ticket","Team lunch","Cab fares","Monitor","Course fee","Hotel stay"];
const rbRows: string[] = [];
for (let i = 0; i < 30; i++) {
  const e = pick(paid); const c = pick(RC); const st = pick(RSTATE);
  const dec = st !== "PENDING" ? "30n46k35dszrg" : null;
  rbRows.push(` (${q(nid())},${q(ocode(e.code))},${q(e.uuid)},${q(c.uuid)},${between(5, 600) * 100},${ymd(NOW - between(2, 80) * DAY)},${q(pick(RDESC))},${q(st)},${dec ? q(dec) : "NULL"},${T0},${T0})`);
}
emit("INSERT INTO reimbursements (uuid,code,employee_id,category_id,amount,incurred_on,description,state,decided_by,created_at,updated_at) VALUES");
emit(rbRows.join(",\n") + ";");

// --- Expenses: operational/company spend (categories, vendors, budgets, expenses) ---------------------------
const EC = [
  { uuid: nid(), code: "0a", name: "Rent & Facilities", rr: 1, gl: "6000" },
  { uuid: nid(), code: "0b", name: "Utilities", rr: 1, gl: "6010" },
  { uuid: nid(), code: "0c", name: "Software & Subscriptions", rr: 1, gl: "6020" },
  { uuid: nid(), code: "0d", name: "Office Supplies", rr: 0, gl: "6030" },
  { uuid: nid(), code: "0e", name: "Travel & Transport", rr: 1, gl: "6040" },
  { uuid: nid(), code: "0f", name: "Professional Services", rr: 1, gl: "6050" },
];
emit("INSERT INTO expense_categories (uuid,code,name,requires_receipt,gl_code,created_at,updated_at) VALUES");
emit(EC.map((c) => ` (${q(c.uuid)},${q(c.code)},${q(c.name)},${c.rr},${q(c.gl)},${T0},${T0})`).join(",\n") + ";");

const VEN = [
  { uuid: nid(), code: "0a", name: "Coworking Spaces Co", tax: "27AAACW1234A1Z5", terms: "Net 30", cat: 0 },
  { uuid: nid(), code: "0b", name: "Cloud Hosting Co", tax: "29AAACA1234B1Z1", terms: "Net 15", cat: 2 },
  { uuid: nid(), code: "0c", name: "Office Supplies Co", tax: null, terms: "Net 30", cat: 3 },
  { uuid: nid(), code: "0d", name: "Advisory Partners LLP", tax: "07AAACD1234C1Z9", terms: "Net 45", cat: 5 },
];
emit("INSERT INTO vendors (uuid,code,name,tax_id,payment_terms,default_category_id,created_at,updated_at) VALUES");
emit(VEN.map((v) => ` (${q(v.uuid)},${q(v.code)},${q(v.name)},${q(v.tax)},${q(v.terms)},${q(EC[v.cat]!.uuid)},${T0},${T0})`).join(",\n") + ";");

const finDept = DEPTS.find((d) => d.code === "05")!.uuid; // Finance
const itDept = DEPTS.find((d) => d.code === "0b")!.uuid;  // IT
const engDept = "20n3pk2xdszr0";                           // Engineering (fixed)
const HR_EMP = "2gn3yk31dszr8", EVE_EMP = "2cn3wk30dszr6"; // submitters
const HR_USER = "30n46k35dszrg", PAY_USER = "34n48k36dszrj"; // decider / payer user ids
const rentTpl = nid();
const EXP_COLS = "uuid,code,employee_id,vendor_id,category_id,department_id,amount,tax_amount,incurred_on,description,invoice_number,payment_method,state,reimbursable,reimbursement_id,decided_by,paid_by,paid_at,is_recurring,recurrence_rule,next_occurrence_on,last_generated_on,template_id,created_at,updated_at";
const exp = (o: Record<string, any>) =>
  ` (${q(o.uuid ?? nid())},${q(ocode(o.ownerCode))},${q(o.emp)},${o.vendor ? q(o.vendor) : "NULL"},${o.cat ? q(o.cat) : "NULL"},${o.dept ? q(o.dept) : "NULL"},` +
  `${o.amount},${o.tax ?? 0},${o.incurred ?? "NULL"},${q(o.desc)},${o.inv ? q(o.inv) : "NULL"},${o.pm ? q(o.pm) : "NULL"},${q(o.state)},${o.reimb ? 1 : 0},` +
  `${o.reimbId ? q(o.reimbId) : "NULL"},${o.decided ? q(o.decided) : "NULL"},${o.paidBy ? q(o.paidBy) : "NULL"},${o.paidAt ?? "NULL"},${o.recurring ? 1 : 0},` +
  `${o.rule ? q(o.rule) : "NULL"},${o.next ?? "NULL"},${o.lastGen ?? "NULL"},${o.tpl ? q(o.tpl) : "NULL"},${T0},${T0})`;
const exRows = [
  exp({ ownerCode: "07-001", emp: HR_EMP, vendor: VEN[1]!.uuid, cat: EC[2]!.uuid, dept: itDept, amount: 125000, tax: 22500, incurred: ymd(NOW - 20 * DAY), desc: "AWS cloud hosting - June", inv: "AWS-2026-06", pm: "bank", state: "PAID", decided: HR_USER, paidBy: PAY_USER, paidAt: NOW - 5 * DAY }),
  exp({ ownerCode: "07-001", emp: HR_EMP, vendor: VEN[0]!.uuid, cat: EC[0]!.uuid, dept: finDept, amount: 450000, tax: 81000, incurred: ymd(NOW - 12 * DAY), desc: "Office rent - June", inv: "WW-JUN26", state: "SUBMITTED" }),
  exp({ ownerCode: "07-001", emp: HR_EMP, vendor: VEN[3]!.uuid, cat: EC[5]!.uuid, dept: finDept, amount: 90000, tax: 16200, incurred: ymd(NOW - 8 * DAY), desc: "Statutory audit fees", inv: "DLT-4471", state: "APPROVED", decided: HR_USER }),
  exp({ ownerCode: "04-002", emp: EVE_EMP, cat: EC[4]!.uuid, dept: engDept, amount: 18500, incurred: ymd(NOW - 6 * DAY), desc: "Cab + flight to client (fronted)", state: "APPROVED", reimb: 1, decided: HR_USER }),
  exp({ ownerCode: "04-002", emp: EVE_EMP, vendor: VEN[2]!.uuid, cat: EC[3]!.uuid, dept: engDept, amount: 3400, incurred: ymd(NOW - 2 * DAY), desc: "Desk supplies", state: "DRAFT" }),
  exp({ uuid: rentTpl, ownerCode: "07-001", emp: HR_EMP, vendor: VEN[0]!.uuid, cat: EC[0]!.uuid, dept: finDept, amount: 450000, tax: 81000, desc: "Monthly office rent (recurring)", state: "DRAFT", recurring: 1, rule: "monthly", next: ymd(NOW + 10 * DAY) }),
];
emit(`INSERT INTO expenses (${EXP_COLS}) VALUES`);
emit(exRows.join(",\n") + ";");

const BUD = [
  { code: "0a", dept: null, cat: EC[2]!.uuid, pt: "monthly", pk: "2026-06", amt: 200000 },
  { code: "0b", dept: finDept, cat: EC[0]!.uuid, pt: "monthly", pk: "2026-06", amt: 500000 },
  { code: "0c", dept: null, cat: null, pt: "yearly", pk: "2026", amt: 5000000 },
];
emit("INSERT INTO expense_budgets (uuid,code,department_id,category_id,period_type,period_key,amount,alert_level,created_at,updated_at) VALUES");
emit(BUD.map((x) => ` (${q(nid())},${q(x.code)},${x.dept ? q(x.dept) : "NULL"},${x.cat ? q(x.cat) : "NULL"},${q(x.pt)},${q(x.pk)},${x.amt},0,${T0},${T0})`).join(",\n") + ";");

// Kudos: ~35 peer recognitions.
const VALUES = ["Teamwork","Ownership","Customer First","Craft","Integrity"];
// Kudos are board posts now (announcements, kind="kudos"): owner-coded by the giver (= author), recipient +
// recognition meta in the new columns, message in `body`. Categories + levels are assigned so both the
// category cards and the level cards render (every 3rd is level-only). points = the level's weight.
const KMSG = ["Went above and beyond on the release","Amazing support during the incident","Great mentorship this sprint","Shipped the feature ahead of schedule","Always helpful in code reviews","Saved the customer demo","Fantastic cross-team collaboration"];
const KCAT = ["Teamwork","Innovation","Customer Focus","Ownership","Excellence","Leadership","Going the Extra Mile","Helping Hand","Learning & Growth","Positivity"];
const KLVL: [string, number][] = [["Appreciation", 1], ["Impact", 2], ["Exceptional", 3], ["Legendary", 5]];
const kuRows: string[] = [];
for (let i = 0; i < 35; i++) {
  const g = pick(paid); let r = pick(employees);
  if (r.uuid === g.uuid) r = employees[(employees.indexOf(r) + 1) % employees.length]!;
  const [lvl, pts] = KLVL[i % KLVL.length]!;
  const cat = i % 3 === 0 ? null : KCAT[i % KCAT.length]!; // every 3rd is level-only (exercises both card types)
  const pub = NOW - (i + 1) * DAY;
  kuRows.push(` (${q(nid())},${q(ocode(g.code))},'kudos','',${q(pick(KMSG))},${q(g.uuid)},${q(r.uuid)},${q(pick(VALUES))},${cat ? q(cat) : "NULL"},${q(lvl)},${pts},1,${pub},${T0},${T0})`);
}
emit("INSERT INTO announcements (uuid,code,kind,title,body,author_employee_id,recipient_employee_id,value,category,level,points,published,publish_time,created_at,updated_at) VALUES");
emit(kuRows.join(",\n") + ";");

// Compensation: one current row per employee. CTC is the authoritative figure (₹6L–₹60L annual, matching the
// pay-grade bands); base_pay + special_allowance are its DERIVED split. Reconciles with the standard bootstrap
// components + provisions so the demo matches what the server's splitCtc produces (gross < CTC):
//   basic = 50% of monthly CTC;  HRA = 40% of basic;  Conveyance 1600 + Medical 1250 (fixed earnings);
//   employer PF = 1800 (12% capped at the 15000 wage ceiling, and basic always exceeds it here);
//   gratuity = 4.81% of basic;  ESI = 0 (gross above the 21000 ceiling for this pay range).
//   CTC = gross + employerPF + gratuity  =>  special = monthlyCTC - 1.4481*basic - 2850 - 1800.
const cmRows = employees.map((e) => {
  const ctcAnnual = between(6, 60) * 100000;
  const monthly = ctcAnnual / 12;
  const basePay = Math.round(monthly * 0.5);
  const special = Math.max(0, Math.round(monthly - 1.4481 * basePay - 2850 - 1800));
  return ` (${q(nid())},${q(ocode(e.code))},${q(e.uuid)},${ctcAnnual},${basePay},${special},'INR',${e.start},NULL,0,${T0},${T0})`;
});
emit("INSERT INTO compensation (uuid,code,employee_id,ctc_annual,base_pay,special_allowance,currency,effective_from,effective_to,arrears_amount,created_at,updated_at) VALUES");
emit(cmRows.join(",\n") + ";");

// Goals: ~24.
const GSTATE = ["in_progress","in_progress","completed","not_started"];
const GTITLE = ["Improve test coverage to 80%","Close 10 enterprise deals","Launch the new onboarding flow","Reduce p95 latency by 30%","Publish 6 blog posts","Mentor two juniors","Cut cloud spend by 15%","Ship the mobile app beta"];
const goRows: string[] = [];
for (let i = 0; i < 24; i++) {
  const e = pick(paid); const st = pick(GSTATE);
  goRows.push(` (${q(nid())},${q(ocode(e.code))},${q(e.uuid)},${q(pick(GTITLE))},${between(1, 5) * 10},${st === "completed" ? 100 : st === "not_started" ? 0 : between(20, 80)},${q(st)},${ymd(NOW + between(10, 120) * DAY)},${T0},${T0})`);
}
emit("INSERT INTO goals (uuid,code,employee_id,title,weight,progress,status,due_date,created_at,updated_at) VALUES");
emit(goRows.join(",\n") + ";");

// Announcements: a few published company posts.
const ANN = [
  ["Q2 All-Hands","Join us Friday 4pm for the quarterly all-hands. Agenda: roadmap, hiring, Q&A."],
  ["New Health Insurance Plan","We've upgraded our group health cover effective July 1. Details in the People portal."],
  ["Office closed for Diwali","The office will be closed Nov 8-10. Wishing everyone a happy Diwali!"],
  ["Welcome our new hires","Please welcome the 12 new folks who joined this month across Engineering, Sales and Product."],
];
emit("INSERT INTO announcements (uuid,code,kind,title,body,author_employee_id,published,publish_time,created_at,updated_at) VALUES");
emit(ANN.map(([t, b], i) => ` (${q(nid())},${q((i + 10).toString(36))},'announcement',${q(t)},${q(b)},'2gn3yk31dszr8',1,${NOW - (i + 1) * 3 * DAY},${T0},${T0})`).join(",\n") + ";");

// Notifications: per-recipient unread/read items so the bell badge + page light up. emp@ (Eve, 04-002) gets
// several UNREAD so the demo login sees badges immediately. (notifications are normally emitted by events;
// these are pre-seeded so the feature is visibly populated without running every workflow.)
const NT: { type: string; title: string; body: string; link: string; priority?: string; action?: string }[] = [
  { type: "document.ackRequired", title: "Review & sign: Code of Conduct", body: "This document requires your acknowledgement.", link: "documents", priority: "high", action: "sign" },
  { type: "leave.approved", title: "Leave approved", body: "Your leave request was approved.", link: "leave-requests/history" },
  { type: "leave.rejected", title: "Leave rejected", body: "Your leave request was rejected.", link: "leave-requests/history" },
  { type: "reimbursement.approved", title: "Reimbursement approved", body: "Your reimbursement claim was approved.", link: "reimbursements/history" },
  { type: "reimbursement.paid", title: "Reimbursement paid", body: "Your approved claim was paid out.", link: "reimbursements/history" },
  { type: "kudos.received", title: "You received kudos", body: "Great work on the release!", link: "announcements" },
  { type: "announcement.published", title: "New announcement", body: "Q2 All-Hands", link: "announcements" },
  { type: "overtime.approved", title: "Overtime approved", body: "Your overtime request was approved.", link: "overtime" },
  { type: "remote.approved", title: "Remote work approved", body: "Your remote work request was approved.", link: "remote-work" },
  { type: "payslip.published", title: "Payslip available", body: "Your payslip for this period is ready.", link: "payslips" },
  { type: "ticket.assigned", title: "Ticket assigned to you", body: "Laptop not booting", link: "tickets", action: "respond" },
];
const ntRows: string[] = [];
const pushN = (e: Emp, n: number, unread: number) => {
  for (let i = 0; i < n; i++) {
    const t = NT[(counter + i) % NT.length]!;
    const read = i >= unread; // first `unread` are unread (read_time NULL)
    const ts = NOW - between(1, 20) * DAY - i * 3600_000;
    ntRows.push(` (${q(nid())},${q(ocode(e.code))},${q(e.uuid)},${q(t.type)},${q(t.title)},${q(t.body)},${q(t.link)},${q(t.priority ?? "normal")},${t.action ? q(t.action) : "NULL"},${read ? ts + 3600_000 : "NULL"},${ts},${ts})`);
  }
};
const eve = employees.find((e) => e.code === "04-002")!;
pushN(eve, 6, 4); // emp@ login: 6 total, 4 unread -> bell badge "4"
pushN(employees.find((e) => e.code === "04-001")!, 3, 2); // mgr@
pushN(employees.find((e) => e.code === "07-001")!, 3, 1); // hr@
for (const e of paid.slice(0, 30)) pushN(e, between(1, 4), between(0, 3));
emit("INSERT INTO notifications (uuid,code,recipient_id,type,title,body,link,priority,action,read_time,created_at,updated_at) VALUES");
emit(ntRows.join(",\n") + ";");

// keep the demo personal document (item-path demo)
emit(`INSERT INTO personal_documents (uuid,code,employee_id,document_type,title,r2_key,created_at,updated_at) VALUES ('3rn4jk3bdszrw','04-002-001','2cn3wk30dszr6','CONTRACT','Contract','personal-documents/3rn4jk3b',${T0},${T0});`);

process.stdout.write(out.join("\n") + "\n");
