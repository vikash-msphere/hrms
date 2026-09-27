// ⌘K "Ask": a question in plain words ("how do I claim my internet bill", "leave requests waiting on me"),
// answered with WHERE in the app it is answered - up to three of the pages, settings and actions the person
// can already open, each with a one-line reason, and optionally a few words to search records by.
//
// WHAT THE MODEL IS SHOWN: the question, scrubbed and fenced, and the NAMES of the destinations the caller's
// own palette offers (page titles, settings panel names, action labels). No record, no field, no person - it
// routes, it does not answer from data, so it cannot state a leave balance it was never given.
//
// WHAT COMES BACK is parsed strictly and filtered to keys that were offered, so a model that invents a page
// produces nothing rather than a link to somewhere the caller cannot go. Sent on Enter only, never while typing.
import { z } from "zod";
import { UNTRUSTED_PREAMBLE } from "./aiPolicy";

export const ASK_PROMPT_VERSION = "search-ask-v1";
export const MAX_QUESTION = 300;
export const MAX_DESTINATIONS = 400;
export const MAX_PICKS = 3;

export type AskDestination = { key: string; label: string; group?: string | null };
export type AskAnswer = { destinations: { key: string; why: string }[]; search: string | null };

export const ASK_SYSTEM = `${UNTRUSTED_PREAMBLE}

You help someone find their way around an HR app. You are given their question and a list of DESTINATIONS they may open, one per line as "key | label | group".
Choose the destinations that answer the question, best first, at most ${MAX_PICKS}. Use keys from the list only, copied exactly.
For each, give a reason of at most 12 words, addressed to the person ("File the claim here").
If searching records would also help (a person's name, a ticket subject, a document title), give 1 to 4 search words, otherwise null.
If nothing in the list fits, answer with an empty list. Never answer the question itself.
Answer with JSON only, exactly this shape: {"destinations":[{"key":"...","why":"..."}],"search":null}`;

// One line per destination. The fields come from the caller's own client, so they are only the caller's to
// tamper with - but a separator or a newline inside one would still break the format the model is reading.
const flat = (s: string, max: number) => s.replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function destinationLines(destinations: AskDestination[]): string {
  return destinations
    .slice(0, MAX_DESTINATIONS)
    .map((d) => [flat(d.key, 80), flat(d.label, 80), flat(d.group ?? "", 40)].join(" | "))
    .join("\n");
}

const answer = z
  .object({
    destinations: z.array(z.object({ key: z.string().max(120), why: z.string().max(200) }).strict()).max(10),
    search: z.string().max(120).nullable(),
  })
  .partial()
  .strict();

/**
 * The model's answer, filtered to what was offered, or null when it did not answer in the contract's shape.
 * Null is "the model could not be understood", which the caller reports; an empty list is a real answer.
 */
export function parseAskAnswer(raw: string, offered: ReadonlySet<string>): AskAnswer | null {
  const text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = answer.safeParse(parsed);
  if (!result.success) return null;

  const seen = new Set<string>();
  const destinations: AskAnswer["destinations"] = [];
  for (const d of result.data.destinations ?? []) {
    const key = d.key.trim();
    if (!offered.has(key) || seen.has(key)) continue; // an invented or repeated destination is dropped
    seen.add(key);
    destinations.push({ key, why: flat(d.why, 100) });
    if (destinations.length === MAX_PICKS) break;
  }
  // Search words only: letters, digits and spaces, so what the palette types back in is a plain query.
  const words = (result.data.search ?? "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return { destinations, search: words || null };
}
