// What the AI layer actually costs, against what it assumed it would cost.
//
//   CF_ANALYTICS_TOKEN=... node --import ./scripts/tsResolve.mjs scripts/aiSpend.ts [--days 1]
//   CF_ANALYTICS_TOKEN=... node --import ./scripts/tsResolve.mjs scripts/aiSpend.ts --introspect
//
// `ESTIMATED_NEURONS` in src/domain/aiPolicy.ts is four guesses, and `ai_usage.estimated_neurons` is those
// same guesses written down by the code being checked - so our own table cannot tell us whether they are
// right. Cloudflare's account-level inference logs can. This script reads both for the same window and prints
// the ratio, which is the multiplier to apply to the constants.
//
// WHY THE TOKEN IS NOT READ FROM .dev.vars, unlike every other script here. An account-scoped Analytics Read
// token can read the whole account, and .dev.vars is the file whose contents become Worker secrets. Anything
// that lands there is one `wrangler secret put` away from an isolate that serves employee requests, which has
// no use for account analytics. It is passed in the environment for one command, and lives nowhere.
//
// WHY THERE IS AN --introspect MODE. `aiInferenceAdaptiveGroups` is in the GraphQL schema but not in the
// published docs, so its metric names are whatever the schema says today. Rather than hardcode a guess, the
// script asks the endpoint what the dataset offers and picks the neuron metric out of what comes back; if it
// recognises nothing it prints the fields and stops, instead of reporting a confident zero.
import { execFileSync } from "node:child_process";
import { MODELS, ESTIMATED_NEURONS, type ModelRole } from "../src/domain/aiPolicy";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const DATASET = "aiInferenceAdaptiveGroups";

// WHAT THE SCHEMA ACTUALLY OFFERS, read off `--introspect` on 2026-09-22:
//   fields: confidence, count, dimensions, sum
//   sum:    totalAudioSeconds, totalCostMetricValue1, totalCostMetricValue2, totalInferenceSteps,
//           totalInferenceTimeMs, totalInputLength, totalInputTokens, totalNeurons, totalOutputTokens,
//           totalProcessedPixels, totalProcessedTiles, totalRequestBytesIn, totalRequestBytesOut, totalTiles
// The candidate lists below are still resolved against the live schema rather than hardcoded, because the
// move off neurons onto per-model token units will change which of these exists.

/** Metric names, best first, that have carried the neuron figure. The first one the schema offers wins. */
const NEURON_METRIC_CANDIDATES = ["totalNeurons", "neurons", "neuronsUsed", "sumNeurons"];

/** Metrics worth printing beside the neuron figure when the schema has them. */
const EXTRA_METRICS = ["totalInputTokens", "totalOutputTokens", "totalInferenceTimeMs"] as const;

/** The dimension carrying the `@cf/...` id. Resolved, not assumed: an unknown name makes the query 400. */
const MODEL_DIMENSION_CANDIDATES = ["modelId", "model", "modelName"];

/**
 * Dimensions taken alongside the model id when the schema has them, because both answer a question
 * `ai_usage` cannot ask of itself.
 *
 * `errorCode` is Cloudflare's count of calls that failed, against our `outcome='error'`. Ours is written by
 * the same code that made the call, so a call that died before `recordUsage` ran is invisible to us and
 * present here; the two disagreeing is the trail being lossy, which is worth knowing on the one table the
 * accountability story rests on.
 *
 * `requestSource` says how the inference arrived - a Worker binding, the REST API, a gateway. Every call this
 * app makes goes through the binding in `src/lib/ai.ts`, so anything else in this column is inference on this
 * account that did not come from here.
 */
const AUDIT_DIMENSIONS = ["errorCode", "requestSource"] as const;

/** `@cf/...` id back to the role it fills, so Cloudflare's per-model rows line up with our per-role ones. */
const ROLE_OF_MODEL = new Map<string, ModelRole>(
  (Object.entries(MODELS) as [ModelRole, string][]).map(([role, id]) => [id, role]),
);

type Args = { days: number; introspect: boolean };

function parseArgs(argv: string[]): Args {
  const days = Number(argv[argv.indexOf("--days") + 1]);
  return {
    days: argv.includes("--days") && Number.isFinite(days) && days > 0 ? days : 1,
    introspect: argv.includes("--introspect"),
  };
}

function token(): string {
  const t = process.env.CF_ANALYTICS_TOKEN;
  if (!t) {
    throw new Error(
      "CF_ANALYTICS_TOKEN missing. Create an account-scoped API token with Account Analytics Read and pass it\n" +
        "in the environment for this command only. Do not put it in .dev.vars or wrangler.toml.",
    );
  }
  return t;
}

/** The account the `hrms` worker deploys into. `wrangler whoami` is the fallback so nobody has to look it up. */
function accountId(): string {
  const fromEnv = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (fromEnv) return fromEnv;
  const out = execFileSync("npx", ["wrangler", "whoami"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // The table prints the id as a 32-character hex field; there may be several accounts, and the first is the
  // one wrangler would deploy to.
  const id = out.match(/\b[0-9a-f]{32}\b/)?.[0];
  if (!id) throw new Error("could not read an account id from `wrangler whoami`; set CF_ACCOUNT_ID");
  return id;
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  // A GraphQL error arrives with HTTP 200, so the status check above is not the one that matters.
  if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
  if (!body.data) throw new Error("GraphQL returned no data");
  return body.data;
}

type TypeRef = { name: string | null; kind: string; ofType: TypeRef | null };
type FieldInfo = { name: string; type: TypeRef };

/**
 * The named type behind a field, through however many LIST / NON_NULL wrappers the schema puts around it.
 *
 * `viewer.accounts` is `[Account!]!` - NON_NULL of LIST of NON_NULL of Account, three wrappers deep. An
 * earlier version of this unwrapped two levels and asked for two, so the innermost name never arrived and the
 * script reported that it could not resolve a type that was there all along. Six levels is the depth the
 * reference introspection query uses; only the wrapper kinds carry a null `name`, so the loop stops on the
 * first real one.
 */
function unwrap(t: TypeRef | null): string | null {
  for (let cur = t; cur; cur = cur.ofType) if (cur.name) return cur.name;
  return null;
}

/** Nested `ofType` to the depth the spec's own introspection query uses. */
const TYPE_REF = "name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind ofType { name kind } } } } } }";

/** One type's fields, or null if the schema has no type by that name. */
async function fieldsOf(typeName: string): Promise<FieldInfo[] | null> {
  const r = await graphql<{ __type: { fields: FieldInfo[] | null } | null }>(
    `query ($n: String!) { __type(name: $n) { fields { name type { ${TYPE_REF} } } } }`,
    { n: typeName },
  );
  return r.__type?.fields ?? null;
}

/**
 * The type that account-level datasets hang off, found by walking the schema rather than assuming a name.
 *
 * The first version of this asked for `__type(name: "Account")` and reported "no AI datasets" when that came
 * back null - which is not a fact about the account, it is the wrong type name producing an empty list. The
 * root query type is the only name in a GraphQL schema that can be discovered rather than guessed, so the
 * walk starts there: query type -> `viewer` -> `accounts` -> that type's fields.
 */
async function accountTypeName(): Promise<string> {
  const root = await graphql<{ __schema: { queryType: { name: string } } }>(`{ __schema { queryType { name } } }`);
  const rootFields = await fieldsOf(root.__schema.queryType.name);
  const viewer = rootFields?.find((f) => f.name === "viewer");
  if (!viewer) throw new Error(`the schema's root type \`${root.__schema.queryType.name}\` has no \`viewer\``);
  const viewerType = unwrap(viewer.type);
  if (!viewerType) throw new Error("could not resolve the type behind `viewer`");

  const viewerFields = await fieldsOf(viewerType);
  const accounts = viewerFields?.find((f) => f.name === "accounts");
  if (!accounts) {
    throw new Error(`\`${viewerType}\` has no \`accounts\`. It has: ${(viewerFields ?? []).map((f) => f.name).join(", ") || "(nothing)"}`);
  }
  const name = unwrap(accounts.type);
  if (!name) throw new Error("could not resolve the type behind `viewer.accounts`");
  return name;
}

/** What the dataset offers today, walked from the schema root. */
async function describeDataset(): Promise<{ typeName: string; fields: string[]; sumFields: string[]; dimensionFields: string[] }> {
  const accountType = await accountTypeName();
  const accountFields = await fieldsOf(accountType);
  const field = accountFields?.find((f) => f.name === DATASET);
  if (!field) {
    // Report by shape, not by an exact name that may have changed: anything inference-ish is the candidate,
    // and the full list is the fallback because it is the only thing that settles what is actually there.
    const all = (accountFields ?? []).map((f) => f.name);
    const likely = all.filter((n) => /\b(ai|inference|neuron|workersai)/i.test(n));
    throw new Error(
      `\`${accountType}\` has no \`${DATASET}\`.\n` +
        `Inference-ish datasets it does have: ${likely.join(", ") || "none"}\n` +
        `All ${all.length} datasets on this type:\n  ${all.join("\n  ") || "(none - which means the token cannot see any)"}\n\n` +
        `Cloudflare filters this schema by token scope, so an empty or short list is usually the token, not\n` +
        `the account: check it has Account > Account Analytics > Read for the right account.`,
    );
  }
  const typeName = unwrap(field.type);
  if (!typeName) throw new Error(`could not resolve the type behind \`${DATASET}\``);

  const nodeFields = await fieldsOf(typeName);
  const fields = (nodeFields ?? []).map((f) => f.name);

  // Aggregated datasets put their numeric metrics under `sum` and their group-by keys under `dimensions`, so
  // neither the neuron figure nor the model id is at the top level and both need their own look.
  const inner = async (fieldName: string): Promise<string[]> => {
    const f = nodeFields?.find((x) => x.name === fieldName);
    const t = f ? unwrap(f.type) : null;
    return t ? ((await fieldsOf(t))?.map((x) => x.name) ?? []) : [];
  };
  const [sumFields, dimensionFields] = [await inner("sum"), await inner("dimensions")];
  return { typeName, fields, sumFields, dimensionFields };
}

/** UTC midnight `days` ago, and now. The budget resets at 00:00 UTC, so the window has to agree with it. */
function window(days: number): { fromMs: number; toMs: number; fromIso: string; toIso: string } {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fromMs = midnight - (days - 1) * 86_400_000;
  return { fromMs, toMs: now.getTime(), fromIso: new Date(fromMs).toISOString(), toIso: now.toISOString() };
}

type TheirRow = { calls: number; neurons: number; extras: Record<string, number> };
type TheirSpend = {
  byModel: Map<string, TheirRow>;
  /** `"<errorCode>"` to calls, so a run can be compared with our own `outcome='error'` count. */
  byError: Map<string, number>;
  /** `"<requestSource>"` to calls. Anything but the Worker binding did not come from this app. */
  bySource: Map<string, number>;
};

/** Cloudflare's own count of what each model was asked to do, what it cost, and how it arrived. */
async function cloudflareSpend(
  metric: string,
  modelDim: string,
  extras: string[],
  auditDims: string[],
  w: ReturnType<typeof window>,
): Promise<TheirSpend> {
  const data = await graphql<{ viewer: { accounts: { [k: string]: { dimensions: Record<string, string>; count: number; sum: Record<string, number> }[] }[] } }>(
    `query ($account: String!, $from: Time!, $to: Time!) {
       viewer {
         accounts(filter: { accountTag: $account }) {
           ${DATASET}(limit: 10000, filter: { datetime_geq: $from, datetime_leq: $to }) {
             dimensions { ${[modelDim, ...auditDims].join(" ")} }
             count
             sum { ${[metric, ...extras].join(" ")} }
           }
         }
       }
     }`,
    { account: accountId(), from: w.fromIso, to: w.toIso },
  );
  const rows = data.viewer.accounts[0]?.[DATASET] ?? [];
  const out: TheirSpend = { byModel: new Map(), byError: new Map(), bySource: new Map() };
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  for (const r of rows) {
    const id = r.dimensions[modelDim] ?? "(unknown)";
    const prev = out.byModel.get(id) ?? { calls: 0, neurons: 0, extras: {} };
    for (const e of extras) prev.extras[e] = (prev.extras[e] ?? 0) + (r.sum?.[e] ?? 0);
    out.byModel.set(id, { calls: prev.calls + r.count, neurons: prev.neurons + (r.sum?.[metric] ?? 0), extras: prev.extras });

    // Adding the audit dimensions to the group-by splits each model's row by them, so these are read off the
    // same rows rather than costing a second query.
    if (r.dimensions.errorCode !== undefined) bump(out.byError, String(r.dimensions.errorCode), r.count);
    if (r.dimensions.requestSource !== undefined) bump(out.bySource, String(r.dimensions.requestSource), r.count);
  }
  return out;
}

/** The JSON array out of a `wrangler --json` run, whether or not a banner was printed above it. */
function parseWranglerJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // The array starts at the first line that begins with `[`; anything before it is wrangler talking.
    const start = raw.search(/^\[/m);
    if (start < 0) throw new Error(`could not find JSON in wrangler's output:\n${raw.slice(0, 400)}`);
    return JSON.parse(raw.slice(start));
  }
}

/** What the app believed it spent, from its own trail. Cache hits are excluded: they cost no inference, and
 *  counting them would make our side look busier than Cloudflare's for a reason that is not an error. */
function ourSpend(w: ReturnType<typeof window>): Map<string, { calls: number; neurons: number; errors: number }> {
  const sql =
    `select model, count(*) calls, sum(estimated_neurons) neurons, ` +
    `sum(case when outcome='error' then 1 else 0 end) errors ` +
    `from ai_usage where created_at >= ${w.fromMs} and cache_hit = 0 group by model`;
  const raw = execFileSync("npx", ["wrangler", "d1", "execute", "hrms", "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
  // `--json` prints one array of result sets, each with its own `results` - but which wrangler versions put a
  // banner above it varies, and slicing from the first `[` in the output would take a bracket out of that
  // banner. Parse the whole thing first, and only fall back to finding where the array starts.
  const parsed = parseWranglerJson(raw) as { results: { model: string; calls: number; neurons: number; errors: number }[] }[];
  const out = new Map<string, { calls: number; neurons: number; errors: number }>();
  for (const row of parsed[0]?.results ?? []) out.set(row.model, { calls: row.calls, neurons: row.neurons ?? 0, errors: row.errors ?? 0 });
  return out;
}

function pad(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const described = await describeDataset();
  if (args.introspect) {
    console.log(`\n${DATASET} -> ${described.typeName}`);
    console.log(`  fields:     ${described.fields.join(", ")}`);
    console.log(`  sum:        ${described.sumFields.join(", ") || "(none)"}`);
    console.log(`  dimensions: ${described.dimensionFields.join(", ") || "(none)"}\n`);
    return;
  }

  const modelDim = MODEL_DIMENSION_CANDIDATES.find((c) => described.dimensionFields.includes(c));
  if (!modelDim) {
    console.error(
      `\nNone of ${MODEL_DIMENSION_CANDIDATES.join(", ")} is offered under \`dimensions\`.\n` +
        `What the dataset does offer: ${described.dimensionFields.join(", ") || "(nothing)"}\n` +
        `Add the right name to MODEL_DIMENSION_CANDIDATES at the top of this file.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const metric = NEURON_METRIC_CANDIDATES.find((c) => described.sumFields.includes(c));
  if (!metric) {
    console.error(
      `\nNone of ${NEURON_METRIC_CANDIDATES.join(", ")} is offered under \`sum\`.\n` +
        `What the dataset does offer: ${described.sumFields.join(", ") || "(nothing)"}\n` +
        `Add the right name to NEURON_METRIC_CANDIDATES at the top of this file.\n` +
        `Cloudflare is moving Workers AI pricing off neurons onto per-model token units, so a token-shaped\n` +
        `name here is the expected form of that change rather than a fault.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const extras = EXTRA_METRICS.filter((m) => described.sumFields.includes(m));
  const auditDims = AUDIT_DIMENSIONS.filter((d) => described.dimensionFields.includes(d));
  const w = window(args.days);
  console.log(`\nWindow: ${w.fromIso} .. ${w.toIso}  (${args.days} day${args.days === 1 ? "" : "s"}, UTC)`);
  console.log(`Metric: sum.${metric}  dimension: ${modelDim}${extras.length ? `  also: ${extras.join(", ")}` : ""}\n`);

  const [spend, ours] = [await cloudflareSpend(metric, modelDim, [...extras], [...auditDims], w), ourSpend(w)];
  const theirs = spend.byModel;

  console.log(`${pad("role", 10)}${pad("model", 38)}${pad("calls o/t", 14)}${pad("our est", 10)}${pad("actual", 10)}ratio`);
  console.log("-".repeat(92));

  const models = new Set([...theirs.keys(), ...ours.keys()]);
  for (const model of [...models].sort()) {
    const role = ROLE_OF_MODEL.get(model);
    const t = theirs.get(model);
    const o = ours.get(model);
    const ratio = t && o && o.neurons > 0 ? (t.neurons / o.neurons).toFixed(2) : "-";
    console.log(
      pad(role ?? "(other)", 10) + pad(model, 38) +
        pad(`${o?.calls ?? 0}/${t?.calls ?? 0}`, 14) +
        pad(o?.neurons ?? 0, 10) + pad(t?.neurons?.toFixed(0) ?? "-", 10) + ratio,
    );
  }

  console.log(`\nESTIMATED_NEURONS today: ${JSON.stringify(ESTIMATED_NEURONS)}`);
  console.log("Multiply each role's constant by its ratio and record the date beside it in aiPolicy.ts.");

  // The token columns are what the neuron ones become. Cloudflare is moving Workers AI onto per-model token
  // pricing, so a run that records tokens per call today is the baseline for reading the change when it
  // lands, rather than a second measuring exercise then.
  //
  // `totalInferenceTimeMs` is the MODEL's own time, not the round trip from the Worker. The embed-cache
  // decision in ai-observability-plan.md needs the round trip, which only `ai_usage.duration_ms` has: the
  // difference between the two is the network, and the network is the term that decides it.
  if (extras.length) {
    console.log(`\n${pad("role", 10)}${pad("model", 38)}${extras.map((e) => pad(e.replace(/^total/, ""), 18)).join("")}per call`);
    console.log("-".repeat(92));
    for (const model of [...models].sort()) {
      const t = theirs.get(model);
      if (!t) continue;
      const perCall = t.calls > 0 && t.extras.totalInferenceTimeMs !== undefined ? `${(t.extras.totalInferenceTimeMs / t.calls).toFixed(1)}ms inference` : "";
      console.log(
        pad(ROLE_OF_MODEL.get(model) ?? "(other)", 10) + pad(model, 38) +
          extras.map((e) => pad(Math.round(t.extras[e] ?? 0), 18)).join("") + perCall,
      );
    }
  }
  console.log("");

  // A model Cloudflare billed for and we have no row for is the one result worth stopping on: either
  // something is calling Workers AI outside services/ai.ts, or the trail is not recording every call.
  for (const model of models) {
    if (!ours.has(model) && theirs.has(model)) {
      console.warn(`WARNING: ${model} was billed but has no ai_usage rows. Something is calling Workers AI off the trail.`);
    }
  }

  // How the inference arrived. Everything this app does goes through the binding in src/lib/ai.ts, so a
  // second source is inference on this account that did not come from here.
  if (spend.bySource.size > 0) {
    const sources = [...spend.bySource].map(([s, n]) => `${s || "(blank)"}=${n}`).join("  ");
    console.log(`Request sources: ${sources}`);
    if (spend.bySource.size > 1) console.warn("More than one request source. Only one of them is this app.");
  }

  // Cloudflare's failures against ours. A call that died before `recordUsage` ran is invisible to us and
  // present there, so the two disagreeing says the trail is lossy rather than that the models are fine.
  const ourErrs = [...ours.values()].reduce((n, r) => n + r.errors, 0);
  const theirErrs = [...spend.byError].filter(([code]) => code !== "0" && code !== "null").reduce((n, [, c]) => n + c, 0);
  if (theirErrs > 0 || ourErrs > 0) {
    const codes = [...spend.byError].filter(([c]) => c !== "0" && c !== "null").map(([c, n]) => `${c}=${n}`).join("  ");
    console.log(`Errors: ai_usage ${ourErrs}, Cloudflare ${theirErrs}${codes ? `  (${codes})` : ""}`);
    if (theirErrs > ourErrs) {
      console.warn(`${theirErrs - ourErrs} failed call(s) never reached ai_usage. The trail is missing calls that were made.`);
    }
  }
  if (ourErrs > 0) console.warn(`${ourErrs} call(s) in this window ended in outcome='error'. Read the Worker logs.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
