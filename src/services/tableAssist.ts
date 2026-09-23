// Describe a grid in words, get a table spec back.
//
// WHY THIS IS THE SAFEST PLACE IN THE APP TO PUT A MODEL. The table builder is a field CATALOGUE, not a
// query language: a spec can only name fields that already exist, with operators from a fixed list. So the
// output space is closed, and every answer is checkable against the catalogue the caller was already
// entitled to see. A field the model invents is not a wrong answer that ships, it is a key that matches
// nothing and gets dropped before anything is rendered.
//
// THE BASE CAN BE CHOSEN THE SAME WAY, and for the same reason: `basesFor` is a closed list of the
// collections this caller may build on, so an answer outside it is refused rather than rendered. A caller who
// names their own base is taken at their word and no inference is spent on it.
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
  /** The base the spec is for: the one the caller named, or the one chosen from their description. Returned
   *  either way, because the caller who left it out has to be told what they got. */
  base: string;
  spec: SuggestedSpec;
  /** Field names the model asked for that the catalogue does not have. Surfaced so the UI can say what it
   *  could not do, rather than quietly returning a narrower grid than the person described. */
  unmatched: string[];
  cached: boolean;
};

/**
 * Turn `question` into a spec for `base`, choosing the base too when the caller did not name one.
 *
 * THE BASE IS THE ONE DECISION A PERSON CANNOT MAKE WITHOUT KNOWING THE MODEL. "One row is" is the builder's
 * first question and its hardest: the answer is a collection name out of eighty, and somebody who can
 * describe the grid they want in a sentence often cannot say whether that sentence counts people, leave
 * requests or payslips. So `base` is optional - left out, it is chosen from the same description, by a model
 * whose answer can only be one of the bases `basesFor` already said this caller may build on. The closed
 * output space is the same argument as for the fields: a collection the model invents matches nothing and is
 * refused, not rendered.
 *
 * It costs a SECOND generation, which is why it is not done when the caller has already answered. A single
 * base is answered without any model call at all.
 *
 * Getting it wrong is recoverable and visible: the chosen base comes back with the spec, the builder names it
 * in the toast, and a saved table's base can be changed afterwards (which clears the columns, because they
 * name fields of the old one).
 */
export async function suggestTableView(
  deps: Deps,
  user: AppUser,
  scopes: ReadonlyMap<string, ListScope>,
  self: Parameters<typeof catalogueFieldGate>[1],
  base: string | null,
  question: string,
): Promise<TableSuggestion> {
  const q = (question ?? "").trim();
  if (!q) throw invalidArgument("say what the table should show");
  if (q.length > MAX_QUESTION) throw invalidArgument(`the description must be under ${MAX_QUESTION} characters`);
  if (base !== null) {
    if (!BASES[base]) throw invalidArgument(`unknown table base: ${base}`);
    // The same check the field catalogue makes: a base this caller cannot get a row of is not a base they can
    // build on, and answering for it would describe a grid that returns nothing.
    if (!basesFor(scopes).some((b) => b.collection === base)) throw invalidArgument(`you cannot build a table on ${base}`);
  }

  if (!deps.ai) throw failedPrecondition("AI table suggestions are not available on this deployment");
  if (!(await aiFeatureOn(deps, "tables.describe"))) throw failedPrecondition("AI table suggestions are switched off for this organisation");

  // Before the catalogue walk, because the walk is per-base: there is nothing to build until this is settled.
  const on = base ?? (await chooseBase(deps, user, scopes, q));

  const all = await reachableFields(deps, on, new Set(scopes.keys()), catalogueFieldGate(user, self), q);
  const offered = rankFields(all, q).slice(0, MAX_OFFERED);
  if (offered.length === 0) throw failedPrecondition("this base has no fields you can use");

  const out = await aiGenerate(
    deps,
    // `reads: "none"`, deliberately, and this was a 500 before it said so.
    //
    // `reads` declares "content from this collection is going into the prompt", and `aiGenerate` answers it
    // with `assertMayReachModel` - which THROWS for anything on the denylist, because sending a
    // payslip's text to a model is a bug rather than a runtime condition to degrade around. Passing `base`
    // here declared something untrue: the prompt is catalogue field KEYS and the caller's own sentence, and
    // no row is ever read. The result was that describing a grid built on `applications`, `candidates`,
    // `compensation` or any other denylisted base answered 500 - a correct assertion, fired at a call site
    // that had mis-described itself.
    //
    // What guards this path instead is `buildCatalogue` above, which was already handed the caller's own
    // `listable` set and field gate: the keys offered to the model are exactly the keys the picker would
    // have offered them, and those are labels they can already see on screen.
    { feature: "tables.describe", userId: user.uuid, reads: "none" },
    {
      system: systemFor(offered),
      user: fence("what the table should show", scrubIdentifiers(q)),
      // The offered key list is part of the cache key: the same question against a different field set is a
      // different question, and two callers with different access must not share an answer.
      promptVersion: `${PROMPT_VERSION}:${hashKeys(offered.map((f) => f.key))}`,
      maxTokens: 700,
    },
  );

  if (!out.ok) throw refusal(out.reason);

  const { spec, unmatched } = coerceSpec(out.value, offered);
  if (spec.columns.length === 0) throw failedPrecondition("could not work out which columns you meant; try naming them");
  return { base: on, spec, unmatched, cached: out.cached };
}

/** The four ways a model call can come back with nothing, as the errors this endpoint answers with. One
 *  function because two call sites now make the same call and must say the same thing about it. */
function refusal(reason: "unavailable" | "budget" | "rate" | "error"): Error {
  if (reason === "rate") return resourceExhausted("you have used your AI allowance for this hour");
  if (reason === "budget") return resourceExhausted("the organisation's AI budget for today is spent; it resets at midnight UTC");
  if (reason === "unavailable") return failedPrecondition("AI table suggestions are not available on this deployment");
  return failedPrecondition("the model could not be reached just now");
}

/**
 * Which collection one row of the described table is.
 *
 * The offering is `basesFor(scopes)` - the caller's OWN base picker, already filtered to collections they can
 * get a row of - so this cannot land on a collection they could not have picked by hand. There is no field
 * catalogue in this prompt and no row is read: it is a list of collection names and labels the person is
 * looking at on screen, plus their sentence.
 *
 * NO MODEL WHEN THERE IS NOTHING TO CHOOSE. One reachable base is the answer, and spending a generation to be
 * told so would charge a caller with almost no access more than one with plenty.
 *
 * The whole list goes in, uncapped and unranked, unlike the fields. `BASES` is a hand-maintained registry of
 * around eighty entries, so the prompt is bounded by the source rather than by the request - and a cap here
 * would cut exactly the wrong way: an unranked prefix of eighty bases can omit the only right answer, where
 * an unranked prefix of a base's fields still leaves a usable grid.
 */
async function chooseBase(
  deps: Deps,
  user: AppUser,
  scopes: ReadonlyMap<string, ListScope>,
  question: string,
): Promise<string> {
  const bases = basesFor(scopes);
  if (bases.length === 0) throw failedPrecondition("you cannot build a table on anything yet");
  if (bases.length === 1) return bases[0]!.collection;

  const out = await aiGenerate(
    deps,
    // `reads: "none"`, for the reason spelled out at the call below: nothing from a collection's rows is in
    // this prompt, so declaring one would fire `assertMayReachModel` at a call site that reads nothing.
    { feature: "tables.describe", userId: user.uuid, reads: "none" },
    {
      system: systemForBases(bases),
      user: fence("what the table should show", scrubIdentifiers(question)),
      // The base list is in the cache key for the same reason the field list is: two callers who can build on
      // different collections are asking different questions and must not share an answer.
      promptVersion: `${PROMPT_VERSION}:base:${hashKeys(bases.map((b) => b.collection))}`,
      maxTokens: 40,
    },
  );
  if (!out.ok) throw refusal(out.reason);

  const picked = coerceBase(out.value, bases);
  // No guessing fallback. A base nobody chose is the one mistake this feature can make that quietly rebuilds
  // the grid on the wrong collection, and the picker is right there - so when the answer is not one of the
  // offered collections, say so and let them point at it.
  if (!picked) throw failedPrecondition("could not work out what one row should be; pick it yourself");
  return picked;
}

// ---------------------------------------------------------------------------------------------------------

/**
 * How deep into the link tree the offered fields go.
 *
 * TWO, BECAUSE ONE PUT THE WRONG COLUMN IN THE GRID. Root-only was the first version and it dropped every
 * linked clause into `unmatched`. One hop fixed the obvious half and left a worse failure behind: asked for
 * "open tickets with the requester's department", the model answered `department_id.name` - which on a ticket
 * is the SERVICING department, not the requester's. The field it actually wanted,
 * `employee_id.department_id.name`, sits at depth two and had never been shown to it. A missing column is
 * visible; a plausible column that means something else is not, and it is the one that reaches a report.
 *
 * `MAX_LINK_DEPTH` is 4 and this deliberately stops short of it. Past two hops the phrases stop being things
 * people say in one breath, and the node count starts to matter.
 */
const LINK_HOPS = 2;

/**
 * Catalogue nodes built for one request.
 *
 * The prompt is NOT what this protects - `MAX_OFFERED` already bounds that, which is why going deeper costs
 * no extra tokens. This bounds the WORK: one `buildCatalogue` per node, on a request somebody is waiting on.
 * Bases here carry 2 to 6 links each, so two hops is comfortably inside this; the cap is for the pathological
 * base rather than the normal one.
 */
const MAX_NODES = 24;

/**
 * Fields taken from any ONE node, before the whole set is ranked and capped again.
 *
 * WITHOUT THIS, ONE NODE EATS THE OFFERING. `MAX_OFFERED` is a single global cut, so it is spent in
 * breadth-first order on whatever scored - and a node's field count is wildly uneven: a People node carries
 * 129. Asked for "the department the requester belongs to, and who their manager is", every one of the 129
 * fields under `employee_id.manager_id` scored a point (their keys all contain "manager_id") and filled the
 * cap, so `assignee_id.department_id.name` - a field the sentence also named - was never offered, and the
 * model reported it as one that does not exist.
 *
 * A per-node cut makes the offering a SPREAD over what is reachable rather than a prefix of it. Twenty is
 * comfortably more than anybody names about one neighbour, and small enough that a wide node cannot crowd out
 * a narrow one.
 */
const MAX_PER_NODE = 20;

/**
 * Every field the caller can reach from `base` within `LINK_HOPS`, in breadth-first order.
 *
 * BREADTH-FIRST IS LOAD-BEARING, not a preference. The node cap and the field cap both cut from the end, so
 * the order decides what survives: this way the root's own fields are complete before any neighbour's, and
 * depth one is complete before depth two. Depth-first would spend the whole budget down one link and offer a
 * grid's own columns last.
 *
 * Each node is built with the SAME field gate as the root, so a link into a collection the caller cannot list
 * resolves to nothing and its fields are never offered. Nothing downstream needed changing: a child names its
 * fields by the dotted wire path (`employee_id.department_id.name`), which is exactly what a column spec
 * stores and what `coerceSpec` checks against.
 */
async function reachableFields(
  deps: Deps,
  base: string,
  listable: ReadonlySet<string>,
  gate: ReturnType<typeof catalogueFieldGate>,
  question: string,
): Promise<ResolvedField[]> {
  const fields: ResolvedField[] = [];
  const seen = new Set<string>([""]);
  const queue: string[][] = [[]];
  let built = 0;

  while (queue.length > 0 && built < MAX_NODES) {
    const path = queue.shift()!;
    const node = await buildCatalogue(deps, base, listable, path, gate);
    built++;
    // Ranked and cut WITHIN the node, so each one contributes its most relevant fields rather than its first
    // ones - and so no single wide node can spend the whole offering (see MAX_PER_NODE). The root keeps more
    // of itself, because a grid's own columns are the ones most likely to be wanted.
    const take = path.length === 0 ? MAX_OFFERED : MAX_PER_NODE;
    fields.push(...rankFields(node.fields, question).slice(0, take));
    if (path.length >= LINK_HOPS) continue;
    for (const link of node.links) {
      // A link tree can rejoin itself - an employee's manager is an employee, whose manager is an employee -
      // so without this the walk would spend the node budget going round in a circle.
      if (seen.has(link.path)) continue;
      seen.add(link.path);
      queue.push(link.path.split("."));
    }
  }
  return fields;
}

/**
 * The words a question is made of that say nothing about which FIELD is wanted.
 *
 * They have to be dropped rather than tolerated, because the score below is a count and the cap keeps the
 * top of it. "the" is in almost every sentence somebody types here, and once it scores a point the ranking
 * stops being about the question at all.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "who", "whose", "their", "there", "that", "this", "these", "those", "from",
  "into", "onto", "out", "all", "any", "each", "every", "show", "list", "give", "want", "need", "table",
  "grid", "column", "columns", "row", "rows", "field", "fields", "sort", "sorted", "order", "ordered",
  "filter", "filtered", "where", "when", "been", "being", "have", "has", "had", "are", "was", "were",
  "belongs", "belong", "including", "include", "also", "only", "just", "plus", "along", "about",
]);

/**
 * Order the catalogue by how likely each field is to be what was asked for, so the cap keeps the useful ones.
 *
 * Deterministic and cheap: word overlap between the question and the field's label and key. This is not
 * trying to be clever - it only has to beat catalogue order, which is alphabetical within a group and
 * therefore uncorrelated with the question. A field that shares no word keeps its original position among the
 * rest, so an unremarkable question still gets a representative spread rather than nothing.
 *
 * TWO THINGS IT USED TO GET WRONG, both of which only bite once there are more fields than the cap, which is
 * exactly what walking the link tree produced:
 *
 *   - It counted stopwords. Anything over two letters was a search term, so "the", "and", "with" and "who"
 *     each scored, and they match something almost everywhere.
 *   - It matched SUBSTRINGS. `hay.includes("the")` is true of "Other", "Further" and "Theme"; `includes("id")`
 *     is true of half the catalogue. Together they gave hundreds of fields a spurious point each and pushed
 *     the one the person actually named out of the offered set - which the model then reported as a field
 *     that does not exist.
 *
 * Now it compares WORDS, allowing a prefix either way so "department" finds "Departments" and "goal" finds
 * "Goals" without a stemmer.
 */
export function rankFields(fields: ResolvedField[], question: string): ResolvedField[] {
  const words = new Set(
    question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
  const score = (f: ResolvedField): number => {
    const tokens = `${f.label} ${f.key}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let n = 0;
    for (const w of words) {
      // A prefix match in either direction, floored at four characters so it is a shared stem and not a
      // shared first syllable: "dep" must not marry "department" to "dependant".
      if (tokens.some((t) => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t)))) n++;
    }
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

/** The instruction for choosing a base. Collection NAMES are what it must answer with, because that is what a
 *  view stores; the label is given alongside because it is the word the person is more likely to have used. */
export function systemForBases(bases: { collection: string; label: string }[]): string {
  const list = bases.map((b) => `${b.collection} (${b.label})`).join("\n");
  return [
    "You choose which collection a described table is built on.",
    "One row of the table is one row of that collection, and every other field joins onto it.",
    'Answer with a single JSON object and nothing else: {"base":"<collection>"}. No explanation, no markdown, no code fence.',
    `Use ONLY these collection names, exactly as written on the left:\n${list}`,
    // The distinction people get wrong, and the one that decides whether a grid has one row per person or
    // several: a description can mention a collection in passing and still be counting something else.
    "Choose what the description COUNTS, not every collection it mentions: \"people with more than five days of leave left\" is one row per person, so it is employees, not leave-requests.",
    "If nothing fits, answer {} rather than choosing the nearest collection.",
    "",
    UNTRUSTED_PREAMBLE,
  ].join("\n");
}

/** The chosen collection, or null for anything that is not one of the offered ones - including the `{}` the
 *  prompt asks for when nothing fits, and a label used in place of a name. */
export function coerceBase(raw: string, bases: { collection: string }[]): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: { base?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { base?: unknown };
  } catch {
    return null;
  }
  const base = parsed.base;
  if (typeof base !== "string" || !base) return null;
  return bases.some((b) => b.collection === base) ? base : null;
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

/** A short, stable digest of an offered key set - field keys for the spec call, collection names for the base
 *  one. Not a security boundary: it only has to distinguish one offering from another. */
function hashKeys(keys: string[]): string {
  let h = 2166136261;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(36);
}
