// A check on what the MANAGER WROTE, before it is shared. Never a check on the person being reviewed.
//
// This is the one place in the app where somebody writes a durable judgement about a colleague, usually in
// twenty minutes, usually at the end of a cycle, and nothing has ever read it back to them. The well-known
// failures of that moment are not subtle and they are not about the employee: a review with no specific piece
// of work in it, a review that describes a personality rather than what happened, a review that compares one
// person to another, a review built out of "always" and "never".
//
// IT RUNS IN THE BROWSER, on text that has not been saved yet. No request, no model, no neurons - and the
// draft does not leave the page to be checked, which is the strongest possible version of "nothing is sent
// anywhere". It is also why this is a lexicon rather than a classifier: a rule somebody can read is a rule
// they can disagree with, and every flag here names the phrase it found.
//
// THE THREE RULES THAT KEEP IT HONEST:
//   1. It cannot block sharing. Every flag is dismissible and advisory, and the Share button never depends
//      on it. A writing aid with a veto is an approval step nobody agreed to.
//   2. It touches no rating and no score, and it is never stored - not as a flag on the review, not as a
//      measure of the manager. It is read once, by the person writing, and then it is gone.
//   3. It says nothing about the employee. Every message is about the sentence.

export type DraftFlagCode = "no_specifics" | "personality" | "absolutes" | "comparison" | "very_short";

export type DraftFlag = {
  code: DraftFlagCode;
  /** What was found, in the author's own words, so the flag can be checked rather than believed. */
  found?: string;
  /** One line, addressed to the writer, about the writing. */
  message: string;
};

/**
 * Words that describe a person rather than their work.
 *
 * Two groups, and the second is the reason this list exists at all. The first is ordinary character language
 * ("attitude", "lazy", "rockstar") which is unfalsifiable in a review: nobody can improve on it and nobody
 * can appeal it. The second is the set repeatedly shown to be applied unevenly - "abrasive", "bossy",
 * "emotional", "aggressive" - which lands on some people far more than others for the same behaviour.
 *
 * The flag does not say the word is wrong. It says: name what happened instead.
 */
const PERSONALITY = [
  "attitude", "personality", "lazy", "smart", "brilliant", "arrogant", "nice", "likeable", "difficult",
  "rockstar", "ninja", "superstar", "hungry", "passionate", "abrasive", "bossy", "emotional", "aggressive",
  "shrill", "pushy", "too quiet", "not a team player", "culture fit",
];

/** Words that turn one occasion into a character trait, and that a person cannot answer. */
const ABSOLUTES = ["always", "never", "constantly", "every time", "all the time"];

/** Phrases that measure one person against another, which is a calibration conversation, not a review. */
const COMPARISONS = [
  "compared to", "unlike", "better than", "worse than", "the best on the team", "the weakest",
  "more than anyone", "less than anyone", "unlike the rest",
];

/** Under this many words, a review is a note. It is flagged as thin rather than judged. */
const SHORT_WORDS = 25;

/** A number, a date, a quarter, a ticket key or a quoted name: something that happened, rather than a claim
 *  about how somebody is. One is enough - this is a floor, not a standard. */
const SPECIFIC = /\b(\d+%?|q[1-4]\b|[A-Z]{2,}-\d+|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** The first listed phrase this text contains, as it was written. */
function firstMatch(text: string, phrases: string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const p of phrases) {
    const at = lower.indexOf(p);
    // Word-boundary for single words, so "nice" does not match "unnoticed"; phrases carry their own spaces.
    if (at < 0) continue;
    if (!p.includes(" ")) {
      const before = lower[at - 1];
      const after = lower[at + p.length];
      if ((before && /[a-z]/.test(before)) || (after && /[a-z]/.test(after))) continue;
    }
    return text.slice(at, at + p.length);
  }
  return undefined;
}

/**
 * What is worth saying about this draft, or nothing.
 *
 * Order matters: "no specific work named" is the finding that changes a review most, so it leads.
 */
export function checkReviewDraft(text: string): DraftFlag[] {
  const body = (text ?? "").trim();
  if (body.length === 0) return [];
  const flags: DraftFlag[] = [];
  const words = wordsOf(body);

  if (words.length < SHORT_WORDS) {
    flags.push({
      code: "very_short",
      message: "This is shorter than most reviews. Somebody will read it once a year and keep it - is there a piece of work worth naming?",
    });
  } else if (!SPECIFIC.test(body)) {
    // Only asked once the review is long enough to be expected to contain one: a two-line note is already
    // flagged as thin, and saying both is nagging.
    flags.push({
      code: "no_specifics",
      message: "No date, number or named piece of work. A review that cites one is easier to act on and easier to stand behind.",
    });
  }

  const personality = firstMatch(body, PERSONALITY);
  if (personality) {
    flags.push({
      code: "personality",
      found: personality,
      message: `“${personality}” describes the person rather than the work. What did they do, and what came of it?`,
    });
  }

  const absolute = firstMatch(body, ABSOLUTES);
  if (absolute) {
    flags.push({
      code: "absolutes",
      found: absolute,
      message: `“${absolute}” is hard to answer. Naming the occasions makes it a conversation instead of a verdict.`,
    });
  }

  const comparison = firstMatch(body, COMPARISONS);
  if (comparison) {
    flags.push({
      code: "comparison",
      found: comparison,
      message: `“${comparison}” measures this person against somebody else. That belongs in calibration, not in their review.`,
    });
  }

  return flags;
}
