// What ⌘K's semantic half embeds for a row, and which of the index's neighbours it keeps, as pure rules.
// services/searchEmbed.ts writes the index with `embedText`; services/globalSearch.ts reads it with the rest.
// Kept apart from both so scripts/searchBench.ts can measure exactly what ships, without loading a service.
import { SEARCH_INDEX } from "./searchIndex";

/**
 * What gets embedded: `<noun>: <title> - <subtitle>`, from the same title and subtitle the search result
 * renders. Nothing else of the row - see the argument in domain/aiPolicy.ts for why the embed source is
 * deliberately text already on screen. The noun is the collection's, not the row's (`SearchEntry.noun`), and
 * `TEXT_PINNED` collections get none (see there: other features compare their vectors to each other).
 *
 * "" for a row with no title, which is then never embedded. A subtitle alone is a status or a kind (the
 * kudos posts on the seeded wall have no title and the subtitle `kudos`), so every such row got the SAME
 * vector, one word wide - and a cluster of identical vectors lands near almost any short query, which is how
 * thirty untitled posts came back as the "meaning" of `xyzzy`.
 *
 * Measured 2026-09-26 against bge-small with scripts/searchBench.ts, under the rule below: nouns plus dropped
 * status subtitles put a relevant row first for 33 of 45 queries against 30 for the bare text, and cut the
 * unrelated rows kept for ten nonsense queries from 6 to 1.
 */
export function embedText(collection: string, title: string | null, subtitle: string | null): string {
  const entry = SEARCH_INDEX.find((e) => e.collection === collection);
  const head = (title ?? "").trim();
  if (!head) return "";
  const tail = entry?.embedSubtitle === false ? "" : (subtitle ?? "").trim();
  const body = tail ? `${head} - ${tail}` : head;
  return entry?.noun ? `${entry.noun}: ${body}` : body;
}

// WHICH NEIGHBOURS COUNT AS RELATED. Nearest-neighbour search always answers: ask it about `xyzzy` and it
// returns the hundred rows least far from `xyzzy`. With no rule every one of them was shown, so any query the
// keyword index missed filled the palette with whatever happened to be closest - measured on the seed data,
// a full page of unrelated rows for every one of ten nonsense queries. A row is kept only if it is close in
// absolute terms AND nearly as close as the best row the caller may see, and at most a handful of them.
//
// Tuned 2026-09-26 against `@cf/baai/bge-small-en-v1.5` with scripts/searchBench.ts (45 labelled queries,
// 10 nonsense ones): 1 unrelated row across all ten nonsense queries (50 with no rule), precision 0.67 from
// 0.32, a relevant row first for 33 of 45.
// bge-small scores even unrelated short texts around 0.5-0.6, which is why the floor is not lower. The
// reranker (`@cf/baai/bge-reranker-base`) was measured as a second gate and dropped: on titles this short it
// traded recall for precision one for one, cost a subrequest and neurons per search, and was erratic on
// one-word rows (`football` scored 0.98 against "Meals").
//
// THE FLOOR IS THIS MODEL'S, like the duplicate thresholds in ticketTriage and friends. globalSearch applies
// it only when the model port reports `MODELS.embed`; any other model (a local Ollama one) gets the window and
// the cap alone, since a bge-small cosine means nothing on another model's scale.
export const SEMANTIC_MIN_SCORE = 0.6;
export const SEMANTIC_WINDOW = 0.05;
export const SEMANTIC_MAX = 5;

// A query too short, or made only of filler, carries no meaning to search by, and its neighbours are noise:
// type-ahead sends "ka" and "the" on the way to what the person means. At least four characters, and at
// least one word of three or more that is not filler.
const SEMANTIC_MIN_QUERY = 4;
const FILLER = new Set(["the", "and", "for", "with", "how", "what", "who", "where", "when", "why", "can", "does", "are", "you", "our", "all", "any"]);

/** True when a search-box query is worth embedding. */
export const meaningful = (q: string): boolean =>
  q.trim().length >= SEMANTIC_MIN_QUERY &&
  q.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((t) => t.length >= 3 && !FILLER.has(t));
