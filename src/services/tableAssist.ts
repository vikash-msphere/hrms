// Describe a grid in words, get a table spec back.
//
// WHY THIS IS THE SAFEST PLACE IN THE APP TO PUT A MODEL. The table builder is a field CATALOGUE, not a
// query language: a spec can only name fields that already exist, with operators from a fixed list. So the
// output space is closed, and every answer is checkable against the catalogue the caller was already
// entitled to see. A field the model invents is not a wrong answer that ships, it is a key that matches
// nothing and gets dropped before anything is rendered.
//
// THE CATALOGUE IS THE ACCESS BOUNDARY, and it was drawn before this file was involved. `buildCatalogue`
// takes the caller's own `listable` set and the field-level gate, so the fields handed to the model are
// exactly the fields the builder would have offered them in the picker. There is no retrieval step here and
// no row is read: the prompt is a list of column names the caller can already see on screen, plus the
// sentence they typed.
//
// NOTHING IS SAVED. The spec comes back for the builder to render; the user then edits it and saves it
// through the ordinary table-views write, which validates the spec again on its own account. And running a
// view reads every source under the RUNNER's scopes, so even a spec that named something unexpected could
// not widen what its owner sees.
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { failedPrecondition, invalidArgument, resourceExhausted } from "../lib/errors";
import {
  BASES, FILTER_OPS, MAX_COLUMNS, MAX_FILTERS,
  type ViewColumn, type ViewFilter, type ViewSort,
} from "../domain/tableFields";
import { UNTRUSTED_PREAMBLE, fence, scrubIdentifiers } from "../domain/aiPolicy";
import { buildCatalogue, basesFor, type ResolvedField } from "./tableCatalog";
import { catalogueFieldGate } from "../http/tableFieldAccess";
import { aiFeatureOn, aiGenerate } from "./ai";

const PROMPT_VERSION = "v1";
export const MAX_QUESTION = 500;

/**
 * How many catalogue fields are offered to the model.
 *
 * A wide base has hundreds, and every one costs prompt tokens on a feature that spends a shared daily
 * allowance. The cap is applied AFTER a deterministic relevance sort (below), so the fields most likely to be
 * wanted are the ones that survive it - which is a better use of the budget than the first 120 in catalogue
 * order.
 */
const MAX_OFFERED = 120;

/**
 * The spec this file produces, with the three lists REQUIRED.
 *
 * `ViewSpec` makes them optional because a stored view may omit them, but this function always emits all
 * three - so returning the looser type would make every caller null-check something that is never absent,
 * and the test file was the first thing to trip over it.
 */
export type SuggestedSpec = { columns: ViewColumn[]; filters: ViewFilter[]; sort: ViewSort[] };

export type TableSuggestion = {
  spec: SuggestedSpec;
  /** Field names the model asked for that the catalogue does not have. Surfaced so the UI can say what it
   *  could not do, rather than quietly returning a narrower grid than the person described. */
  unmatched: string[];
  cached: boolean;
};

/**
 * Turn `question` into a spec for `base`.
 *
 * The base is NOT chosen by the model. The person is already in the builder with a base selected, so asking
 * a model to pick one would be spending an inference on a question that is already answered - and getting it
 * wrong would silently rebuild their grid on a different collection.
 */
export async function suggestTableView(
  deps: Deps,
  user: AppUser,
  scopes: ReadonlyMap<string, ListScope>,
  self: Parameters<typeof catalogueFieldGate>[1],
  base: string,
  question: string,
): Promise<TableSuggestion> {
  const q = (question ?? "").trim();
  if (!q) throw invalidArgument("say what the table should show");
  if (q.length > MAX_QUESTION) throw invalidArgument(`the description must be under ${MAX_QUESTION} characters`);
  if (!BASES[base]) throw invalidArgument(`unknown table base: ${base}`);
  // The same check the field catalogue makes: a base this caller cannot get a row of is not a base they can
  // build on, and answering for it would describe a grid that returns nothing.
  if (!basesFor(scopes).some((b) => b.collection === base)) throw invalidArgument(`you cannot build a table on ${base}`);

  if (!deps.ai) throw failedPrecondition("AI table suggestions are not available on this deployment");
  if (!(await aiFeatureOn(deps, "tables.describe"))) throw failedPrecondition("AI table suggestions are switched off for this organisation");

  // The root node's fields AND one hop through each of its links.
  //
  // Root-only was the original choice and it was wrong in a way that showed up as the feature being stupid:
  // people describe a grid in terms of the things a row is ATTACHED to - "tickets with the requester's
  // department", "candidates with the job they applied for" - and every one of those words named a field the
  // model had never been shown. It could only answer with a key it had been given, so the whole clause was
  // silently dropped into `unmatched` and the grid came back narrower than the sentence asked for.
  //
  // ONE HOP, NOT THE WHOLE TREE. Depth is what makes this expensive: `MAX_LINK_DEPTH` is 4, and each node
  // carries its own links, so flattening the tree would multiply the prompt by the reachable collections and
  // spend the day's allowance on field lists. One hop covers what people actually say out loud, and anything
  // deeper stays a deliberate act in the builder, which is where the link picker lives.
  //
  // Nothing downstream needed changing: a child node already names its fields by the dotted wire path
  // (`employee_id.first_name`), which is exactly what a column spec stores and what `coerceSpec` checks
  // against. And each hop is built with the SAME field gate as the root, so a link into a collection the
  // caller cannot list resolves to nothing and its fields are never offered.
  const listable = new Set(scopes.keys());
  const gate = catalogueFieldGate(user, self);
  const root = await buildCatalogue(deps, base, listable, [], gate);
  const linked = await Promise.all(
    root.links.map((l) => buildCatalogue(deps, base, listable, l.path.split("."), gate)),
  );
  // Root fields first, so that when the cap bites they win the ties: `rankFields` is a stable sort on the
  // original order, and a grid's own columns matter more than a neighbour's.
  const all = [...root.fields, ...linked.flatMap((n) => n.fields)];
  const offered = rankFields(all, q).slice(0, MAX_OFFERED);
  if (offered.length === 0) throw failedPrecondition("this base has no fields you can use");

  const out = await aiGenerate(
    deps,
    // NO `collection`, deliberately, and this was a 500 before it said so.
    //
    // `ctx.collection` declares "content from this collection is going into the prompt", and `aiGenerate`
    // answers it with `assertMayReachModel` - which THROWS for anything on the denylist, because sending a
    // payslip's text to a model is a bug rather than a runtime condition to degrade around. Passing `base`
    // here declared something untrue: the prompt is catalogue field KEYS and the caller's own sentence, and
    // no row is ever read. The result was that describing a grid built on `applications`, `candidates`,
    // `compensation` or any other denylisted base answered 500 - a correct assertion, fired at a call site
    // that had mis-described itself.
    //
    // What guards this path instead is `buildCatalogue` above, which was already handed the caller's own
    // `listable` set and field gate: the keys offered to the model are exactly the keys the picker would
    // have offered them, and those are labels they can already see on screen.
    { feature: "tables.describe", userId: user.uuid },
    {
      system: systemFor(offered),
      user: fence("what the table should show", scrubIdentifiers(q)),
      // The offered key list is part of the cache key: the same question against a different field set is a
      // different question, and two callers with different access must not share an answer.
      promptVersion: `${PROMPT_VERSION}:${hashKeys(offered)}`,
      maxTokens: 700,
    },
  );

  if (!out.ok) {
    if (out.reason === "rate") throw resourceExhausted("you have used your AI allowance for this hour");
    if (out.reason === "budget") throw resourceExhausted("the organisation's AI budget for today is spent; it resets at midnight UTC");
    if (out.reason === "unavailable") throw failedPrecondition("AI table suggestions are not available on this deployment");
    throw failedPrecondition("the model could not be reached just now");
  }

  const { spec, unmatched } = coerceSpec(out.value, offered);
  if (spec.columns.length === 0) throw failedPrecondition("could not work out which columns you meant; try naming them");
  return { spec, unmatched, cached: out.cached };
}

// ---------------------------------------------------------------------------------------------------------

/**
 * Order the catalogue by how likely each field is to be what was asked for, so the cap keeps the useful ones.
 *
 * Deterministic and cheap: word overlap between the question and the field's label and key. This is not
 * trying to be clever - it only has to beat catalogue order, which is alphabetical within a group and
 * therefore uncorrelated with the question. A field that shares no word keeps its original position among the
 * rest, so an unremarkable question still gets a representative spread rather than nothing.
 */
export function rankFields(fields: ResolvedField[], question: string): ResolvedField[] {
  const words = new Set(
    question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2),
  );
  const score = (f: ResolvedField): number => {
    const hay = `${f.label} ${f.key}`.toLowerCase();
    let n = 0;
    for (const w of words) if (hay.includes(w)) n++;
    return n;
  };
  return fields
    .map((f, i) => ({ f, i, s: score(f) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f);
}

/** The instruction, with the offered fields inlined. The model is given keys and labels and told to answer
 *  with keys, because a label is ambiguous across groups and a key is what a spec stores. */
export function systemFor(offered: ResolvedField[]): string {
  const list = offered.map((f) => `${f.key} (${f.label}, ${f.kind})`).join("\n");
  return [
    "You turn a description of a table into a specification for it.",
    "Answer with a single JSON object and nothing else: no explanation, no markdown, no code fence.",
    'The shape is {"columns":[{"field":"<key>"}],"filters":[{"field":"<key>","op":"<op>","value":"<text>"}],"sort":[{"field":"<key>","dir":"asc"|"desc"}]}.',
    `Use ONLY these field keys, exactly as written. Do not invent a key, and do not use a label in place of a key:\n${list}`,
    `Valid filter operators: ${FILTER_OPS.join(", ")}. Use empty or not_empty with no value.`,
    "If the description asks for something none of the keys covers, leave it out rather than substituting a different field.",
    "filters and sort may be empty arrays. columns must not be empty.",
    "",
    UNTRUSTED_PREAMBLE,
  ].join("\n");
}

/**
 * Take the model's answer apart and keep only what the catalogue recognises.
 *
 * Every field name is checked against the offered keys, and anything else is collected into `unmatched`
 * rather than dropped in silence: a grid that is quietly narrower than what somebody described is worse than
 * one that says "I could not find a field for holiday balance". Operators, directions and list lengths are
 * clamped to what a saved spec may hold, so the answer cannot ask the runner for more work than the builder
 * could.
 *
 * Never throws for bad content. A model that returns nothing usable yields an empty spec, and the caller
 * turns that into a message.
 */
export function coerceSpec(raw: string, offered: ResolvedField[]): { spec: SuggestedSpec; unmatched: string[] } {
  const keys = new Set(offered.map((f) => f.key));
  const unmatched = new Set<string>();
  const empty = { spec: { columns: [] as ViewColumn[], filters: [] as ViewFilter[], sort: [] as ViewSort[] }, unmatched: [] as string[] };

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return empty;
  }

  const known = (v: unknown): string | null => {
    if (typeof v !== "string" || !v) return null;
    if (keys.has(v)) return v;
    unmatched.add(v);
    return null;
  };

  const columns: ViewColumn[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(parsed.columns) ? parsed.columns : []) {
    const field = known((c as { field?: unknown })?.field);
    // De-duplicated: a model listing the same column twice would otherwise produce a grid with two identical
    // headers, which reads as a bug in the builder rather than in the answer.
    if (!field || seen.has(field)) continue;
    seen.add(field);
    columns.push({ field });
    if (columns.length >= MAX_COLUMNS) break;
  }

  const filters: ViewFilter[] = [];
  for (const f of Array.isArray(parsed.filters) ? parsed.filters : []) {
    const row = f as { field?: unknown; op?: unknown; value?: unknown };
    const field = known(row.field);
    if (!field) continue;
    const op = FILTER_OPS.find((o) => o === row.op);
    if (!op) continue;
    const needsValue = op !== "empty" && op !== "not_empty";
    const value = row.value;
    if (needsValue && (value === undefined || value === null || value === "")) continue;
    filters.push(needsValue ? { field, op, value: value as string | number | boolean } : { field, op });
    if (filters.length >= MAX_FILTERS) break;
  }

  const sort: ViewSort[] = [];
  for (const s of Array.isArray(parsed.sort) ? parsed.sort : []) {
    const row = s as { field?: unknown; dir?: unknown };
    const field = known(row.field);
    if (!field) continue;
    sort.push({ field, dir: row.dir === "desc" ? "desc" : "asc" });
    if (sort.length >= 4) break; // the same ceiling a saved view's sort has
  }

  return { spec: { columns, filters, sort }, unmatched: [...unmatched] };
}

/** A short, stable digest of the offered key set, for the cache key. Not a security boundary - it only has to
 *  distinguish one field set from another. */
function hashKeys(offered: ResolvedField[]): string {
  let h = 2166136261;
  for (const f of offered) {
    for (let i = 0; i < f.key.length; i++) {
      h ^= f.key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(36);
}
