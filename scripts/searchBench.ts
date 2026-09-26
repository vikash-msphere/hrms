// Measures how well ⌘K's semantic half answers, against the REAL embedding model, so the relevance rule
// (SEMANTIC_MIN_SCORE / SEMANTIC_WINDOW / SEMANTIC_MAX) and the embed text (`embedText`), both in
// domain/semanticSearch.ts, are chosen from numbers rather than from how a few searches felt.
// Re-run it before changing either, and after any change to `MODELS.embed`: the floor is a cosine on that
// model's scale and means nothing on another's.
//
// What it does: embeds every indexable row of a local database plus a set of prod-like synthetic rows
// (tickets, assets, vendors, policies - the seed has none), runs 45 labelled queries and 10 nonsense ones, and
// prints for each embed text / rule
//   P      share of the rows kept that are relevant (averaged per labelled query)
//   R      share of the relevant rows (up to the cap) that were kept
//   top1   labelled queries whose first kept row is relevant
//   noise  rows kept across ALL nonsense queries - the "completely unrelated answers" number; want 0
// The labels are strict (a "vacation" query counts only leave types), so P and R understate; compare rows.
//
// The model is reached through a throwaway Worker, because Workers AI has no plain HTTP client this repo can
// use without an API token. In an empty directory:
//
//   worker.js      export default { async fetch(req, env) {
//                    const { texts } = await req.json();
//                    const out = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: texts });
//                    return Response.json({ data: out.data });
//                  } };
//   wrangler.toml  name = "search-bench-scratch"
//                  main = "worker.js"
//                  compatibility_date = "2026-09-01"
//                  [ai]
//                  binding = "AI"
//
//   npx wrangler dev --port 8799 --ip 127.0.0.1     (costs about one neuron per text embedded, ~300 a run)
//
// Then, from the repo root, pointing at the local D1 file (under .wrangler/state/v3/d1/):
//
//   node --import ./scripts/tsResolve.mjs scripts/searchBench.ts <path-to.sqlite> [--url http://127.0.0.1:8799] [--verbose]
import { DatabaseSync } from "node:sqlite";
import { INDEXABLE, MODELS } from "../src/domain/aiPolicy";
import { SEMANTIC_MAX, SEMANTIC_MIN_SCORE, SEMANTIC_WINDOW, embedText, meaningful } from "../src/domain/semanticSearch";

type Row = { collection: string; title: string | null; subtitle: string | null };
type Rel = [collection: string, titleContains: string][];

const args = process.argv.slice(2);
const dbPath = args.find((a) => !a.startsWith("--"));
const url = args.includes("--url") ? args[args.indexOf("--url") + 1]! : "http://127.0.0.1:8799";
const verbose = args.includes("--verbose");
if (!dbPath || dbPath === url) {
  console.error("usage: scripts/searchBench.ts <path-to-local-d1.sqlite> [--url <worker>] [--verbose]");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const indexable = [...INDEXABLE];
const seeded = db
  .prepare(`select collection, title, subtitle from search_docs where deleted = 0 and restricted = 0 and collection in (${indexable.map(() => "?").join(",")})`)
  .all(...indexable) as Row[];

// Collections the seed leaves empty, written the way a live org fills them.
const SYNTHETIC: Row[] = ([
  ["tickets", "Laptop not charging", "IT"], ["tickets", "VPN keeps disconnecting", "IT"],
  ["tickets", "Payslip shows wrong tax", "Payroll"], ["tickets", "Need access to Figma", "IT"],
  ["tickets", "Broken chair at desk 14", "Facilities"], ["tickets", "Salary not credited this month", "Payroll"],
  ["tickets", "Update my bank account", "HR"], ["tickets", "AC too cold in meeting room", "Facilities"],
  ["assets", "MacBook Pro 14 M3", "LAP-0012"], ["assets", "Dell UltraSharp 27", "MON-0004"],
  ["assets", "iPhone 15", "PHN-0002"], ["assets", "Logitech MX Keys", "PER-0009"],
  ["assets", "Herman Miller Aeron", "FUR-0001"], ["assets", "Cisco Meraki MR36", "NET-0003"],
  ["projects", "Website redesign", "Acme Corp"], ["projects", "Mobile app v2", "Globex"],
  ["projects", "Data warehouse migration", "Internal"],
  ["vendors", "Amazon Web Services", "billing@aws.example.com"], ["vendors", "WeWork", "ops@wework.example.com"],
  ["vendors", "Zomato Business", "corp@zomato.example.com"], ["vendors", "Dell Technologies", "sales@dell.example.com"],
  ["org-documents", "Employee Handbook 2026", "POLICY"], ["org-documents", "Travel Policy", "POLICY"],
  ["org-documents", "Code of Conduct", "POLICY"], ["org-documents", "Work from home guidelines", "POLICY"],
  ["org-documents", "POSH Policy", "POLICY"],
  ["job-requisitions", "Senior Backend Engineer", "Bengaluru"], ["job-requisitions", "Product Designer", "Remote"],
  ["job-requisitions", "Account Executive", "Mumbai"],
  ["suggestions", "Better coffee in the pantry", "workplace"], ["suggestions", "Standing desks for everyone", "workplace"],
  ["suggestions", "Monthly hackathon", "culture"],
  ["events", "Annual offsite", "Two days in Goa with the whole team"], ["events", "Town hall", "Quarterly company update"],
] as const).map(([collection, title, subtitle]) => ({ collection, title, subtitle }));

// Relevance is judged against the seed and the rows above; a row is relevant when its collection matches and
// its title contains the string ("" = any row of that collection).
const QUERIES: [string, Rel][] = [
  ["laptop", [["asset-categories", "Laptop"], ["assets", "MacBook"], ["tickets", "Laptop"]]],
  ["macbook", [["assets", "MacBook"], ["asset-categories", "Laptop"]]],
  ["computer", [["asset-categories", "Laptop"], ["asset-categories", "Desktop"], ["assets", "MacBook"]]],
  ["screen", [["asset-categories", "Monitor"], ["assets", "Dell UltraSharp"]]],
  ["time off", [["leave-types", ""]]],
  ["vacation", [["leave-types", "Earned"], ["leave-types", "Casual"]]],
  ["sick", [["leave-types", "Sick"], ["reimbursement-categories", "Medical"]]],
  ["having a baby", [["leave-types", "Maternity"], ["leave-types", "Paternity"]]],
  ["funeral", [["leave-types", "Bereavement"]]],
  ["festival of lights", [["holidays", "Diwali"]]],
  ["national holiday", [["holidays", "Republic"], ["holidays", "Independence"], ["holidays", "Gandhi"]]],
  ["wifi", [["asset-categories", "Networking"], ["assets", "Meraki"], ["reimbursement-categories", "Internet"], ["tickets", "VPN"]]],
  ["internet bill", [["reimbursement-categories", "Internet"], ["expense-categories", "Utilities"]]],
  ["food", [["reimbursement-categories", "Meals"], ["vendors", "Zomato"], ["suggestions", "coffee"], ["announcements", "lunch"]]],
  ["hotel", [["reimbursement-categories", "Accommodation"], ["reimbursement-categories", "Travel"]]],
  ["flight tickets", [["reimbursement-categories", "Travel"], ["expense-categories", "Travel"], ["org-documents", "Travel"]]],
  ["resignation", [["letter-templates", "Resignation"], ["letter-templates", "Relieving"], ["letter-templates", "Experience"], ["letter-templates", "Full & Final"]]],
  ["quit my job", [["letter-templates", "Resignation"], ["letter-templates", "Relieving"], ["letter-templates", "Experience"], ["letter-templates", "Full & Final"]]],
  ["salary slip", [["letter-templates", "Salary Certificate"], ["tickets", "Payslip"], ["cards", "payslip"], ["tickets", "Salary"]]],
  ["pay raise", [["letter-templates", "Increment"], ["letter-templates", "Promotion"]]],
  ["health insurance", [["benefit-plans", "Health"]]],
  ["retirement", [["benefit-plans", "Pension"]]],
  ["harassment", [["org-documents", "POSH"], ["org-documents", "Conduct"]]],
  ["remote work", [["org-documents", "Work from home"]]],
  ["open positions", [["job-requisitions", ""]]],
  ["designer", [["employees", "Meera"], ["job-requisitions", "Designer"]]],
  ["tester", [["employees", "Priya"], ["cards", "Regression"], ["goals", "flaky"]]],
  ["my manager", [["employees", "Rohan"], ["employees", "Ananya"]]],
  ["speed up the api", [["goals", "p95"], ["goals", "cold-start"], ["cards", "Warm the worker"], ["cards", "Cache resource"]]],
  ["flaky tests", [["cards", "Flaky"], ["goals", "flaky"]]],
  ["new hire onboarding", [["cards", "Onboarding"], ["goals", "first week"], ["sprints", "12"], ["letter-templates", "Offer"], ["letter-templates", "Appointment"]]],
  ["cloud hosting", [["vendors", "Amazon"]]],
  ["office chair", [["assets", "Aeron"], ["tickets", "Broken chair"], ["asset-categories", "Furniture"]]],
  ["overnight shift", [["shifts", "Night"]]],
  ["team party", [["events", "offsite"], ["announcements", "lunch"]]],
  ["vpn", [["tickets", "VPN"], ["asset-categories", "Networking"]]],
  ["keyboard", [["assets", "MX Keys"], ["asset-categories", "Peripheral"]]],
  ["mobile phone", [["asset-categories", "Phone"], ["assets", "iPhone"]]],
  ["employee handbook", [["org-documents", "Handbook"]]],
  ["experience letter", [["letter-templates", "Experience"], ["letter-templates", "Relieving"]]],
  ["sales team", [["departments", "Sales"], ["employees", "Vivaan"], ["employees", "Ananya"], ["employees", "Kabir"]]],
  ["new customers", [["goals", "logos"], ["goals", "enterprise deals"], ["goals", "qualified meetings"]]],
  ["dark mode", [["cards", "Dark-mode"]]],
  ["bank details", [["tickets", "bank account"]]],
  ["air conditioning", [["tickets", "AC too cold"]]],
];
const NONSENSE = ["xyzzy", "banana", "quantum physics", "football", "asdf qwer", "ka", "lapt", "the", "how", "purple elephant"];

async function embed(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ texts: texts.slice(i, i + 50) }) });
    if (!res.ok) throw new Error(`embed worker answered ${res.status}: ${await res.text()}`);
    out.push(...((await res.json()) as { data: number[][] }).data);
  }
  return out;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return dot / Math.sqrt(na * nb);
};
const isRelevant = (r: Row, rel: Rel) => rel.some(([c, t]) => r.collection === c && (r.title ?? "").toLowerCase().includes(t.toLowerCase()));

const corpus = [...seeded, ...SYNTHETIC];
const TEXTS: Record<string, (r: Row) => string> = {
  shipped: (r) => embedText(r.collection, r.title, r.subtitle),
  // What was embedded before 2026-09-26, for comparison: bare `title - subtitle`, untitled rows included.
  bare: (r) => [r.title, r.subtitle].map((s) => (s ?? "").trim()).filter(Boolean).join(" - "),
};
const queries = [...QUERIES.map(([q, rel]) => ({ q, rel })), ...NONSENSE.map((q) => ({ q, rel: [] as Rel }))];
const qv = await embed(queries.map((x) => x.q));

console.log(`model ${MODELS.embed}; ${seeded.length} seeded + ${SYNTHETIC.length} synthetic rows; rule: score >= max(${SEMANTIC_MIN_SCORE}, best - ${SEMANTIC_WINDOW}), at most ${SEMANTIC_MAX}\n`);
for (const [name, text] of Object.entries(TEXTS)) {
  const docs = corpus.map((r) => ({ ...r, text: text(r) })).filter((d) => d.text);
  const dv = await embed(docs.map((d) => d.text));
  const ranked = queries.map((x, i) => ({ ...x, list: docs.map((d, j) => ({ d, s: cosine(qv[i]!, dv[j]!) })).sort((a, b) => b.s - a.s) }));

  const run = (label: string, floor: number, window: number, gate: boolean) => {
    let p = 0, r = 0, top1 = 0, noise = 0;
    const lines: string[] = [];
    const show = verbose && label === "SHIPPED RULE";
    for (const x of ranked) {
      const best = x.list[0]?.s ?? 0;
      const kept = gate && !meaningful(x.q) ? [] : x.list.filter((l) => l.s >= Math.max(floor, best - window)).slice(0, SEMANTIC_MAX);
      if (show) lines.push(`  ${x.q.padEnd(20)} ${kept.map((k) => `${isRelevant(k.d, x.rel) ? "+" : "-"}${k.d.text.slice(0, 36)} (${k.s.toFixed(2)})`).join(" | ") || "(nothing)"}`);
      if (!x.rel.length) { noise += kept.length; continue; }
      const good = kept.filter((k) => isRelevant(k.d, x.rel)).length;
      const want = Math.min(SEMANTIC_MAX, x.list.filter((l) => isRelevant(l.d, x.rel)).length);
      p += kept.length ? good / kept.length : 1;
      r += want ? good / want : 1;
      if (kept[0] && isRelevant(kept[0].d, x.rel)) top1++;
    }
    const n = QUERIES.length;
    console.log(`${`${name} ${label}`.padEnd(48)} P=${(p / n).toFixed(2)} R=${(r / n).toFixed(2)} top1=${top1}/${n} noise=${noise}`);
    if (show) console.log(lines.join("\n"));
  };

  run("no rule (before 2026-09-26)", -1, 2, false);
  run("SHIPPED RULE", SEMANTIC_MIN_SCORE, SEMANTIC_WINDOW, true);
  if (name === "shipped") {
    for (const floor of [0.55, 0.58, 0.62, 0.65]) run(`floor ${floor}`, floor, SEMANTIC_WINDOW, true);
    for (const window of [0.03, 0.08]) run(`window ${window}`, SEMANTIC_MIN_SCORE, window, true);
  }
}
