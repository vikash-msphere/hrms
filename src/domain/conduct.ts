// Workplace conduct: the second half of what a public wall has to be read for, and the half a safety model
// does not answer.
//
// WHY THIS EXISTS AT ALL. `domain/moderation.ts` carries Llama Guard's taxonomy, which is a taxonomy of
// DANGEROUS content - violent crime, weapons, self-harm, child exploitation, hate against a protected
// attribute. It is the right list for "may this text exist on the internet" and the wrong list for "should
// somebody at this company look at this post". The overlap is small and the gap is most of what a noticeboard
// actually needs a person for: an employee sneering at a named colleague, a post calling a team incompetent,
// somebody pasting another person's salary or a disciplinary outcome, a rant about the company that states
// things as fact which are not. Llama Guard answers "safe" to every one of those, correctly by its own
// definition, and the queue stayed empty while the wall did not.
//
// SO THIS IS AN ORG'S CONDUCT POLICY, NOT A SAFETY STANDARD, and the difference sets every rule below. The
// codes are ours, the judgement is a general instruct model's against a rubric we wrote, and the accuracy is
// therefore worse than the guard model's on its own ground. That is affordable HERE and nowhere else: a
// conduct flag still only ever adds a queue item for a person to read, exactly like a hazard flag, and the
// post stays on the wall until that person decides. Nothing in this file can hide anything.
//
// It is also why this is a SEPARATE org switch (`moderation.conduct`, domain/aiPolicy.ts). Reading the wall
// for statutory harm and reading it for tone are different decisions with different false-positive costs and
// different costs per post, and an org that wants the first must not be signed up to the second by an
// upgrade.
import { z } from "zod";

/**
 * The conduct codes, and what each is called on screen.
 *
 * `W` for workplace, deliberately NOT overlapping Llama Guard's `S*`: one flag's `hazards` array can hold
 * both (a post can be hateful AND disclose somebody's pay), the queue renders them side by side, and a code's
 * prefix is what says which pass objected without a second column to carry it.
 *
 * SIX, AND SHORT. Every category here has to be one a moderator can agree or disagree with from the excerpt
 * in front of them - a rubric fine enough to need the policy document open is a rubric that produces flags
 * nobody can act on. The descriptions are the prompt's text as well as this file's documentation, which is
 * the point: there is no second copy of the rubric to drift from.
 */
export const CONDUCT_RULES: { code: string; label: string; test: string }[] = [
  {
    code: "W1",
    label: "Personal abuse",
    test: "Insults, mocks, humiliates or is hostile towards a person or an identifiable group of colleagues.",
  },
  {
    code: "W2",
    label: "Discriminatory",
    test: "Demeans people by a shared characteristic (sex, caste, religion, race, age, disability, origin), including as a joke or a generalisation.",
  },
  {
    code: "W3",
    label: "Threatening",
    test: "Threatens, intimidates, or hints at retaliation against somebody.",
  },
  {
    code: "W4",
    label: "Confidential disclosure",
    test: "Discloses what is not the author's to publish: another person's pay, medical details, disciplinary or performance outcomes, home contact details, credentials, or unannounced business information.",
  },
  {
    code: "W5",
    label: "Defamatory claim",
    test: "States as fact something damaging about a named person or about the organisation that reads as an accusation rather than an opinion (fraud, theft, dishonesty, misconduct).",
  },
  {
    code: "W6",
    label: "Unprofessional",
    test: "Sexual content or innuendo, sustained profanity, or material plainly out of place on a workplace noticeboard.",
  },
];

/** Code to label, for the queue. Shared with `domain/moderation.ts hazardLabel`, which is the only renderer. */
export const CONDUCT_HAZARDS: Record<string, string> = Object.fromEntries(
  CONDUCT_RULES.map((r) => [r.code, r.label]),
);

const CONDUCT_CODES = new Set(CONDUCT_RULES.map((r) => r.code));

/** The rubric as the model is shown it: one line per code, in code order. Generated rather than written out
 *  a second time, so a rule cannot be added here and forgotten there. */
export const conductRubric = (): string => CONDUCT_RULES.map((r) => `${r.code} (${r.label}): ${r.test}`).join("\n");

/**
 * What the model is asked to return: the codes that apply, and nothing else.
 *
 * An EMPTY ARRAY IS THE EXPECTED ANSWER for almost every post, and asking for the empty case explicitly is
 * what keeps it available: a schema whose only valid answer names a violation is a schema that teaches the
 * model to find one.
 */
const conductAnswer = z.object({ codes: z.array(z.string()).max(6) });

/**
 * Read the conduct pass's answer.
 *
 * Null means "the model did not answer the question asked" - prose, a refusal, a code fence around nothing,
 * an invented code. The caller records the post as scanned and unflagged, the same as the hazard pass does
 * with an unparseable verdict: the safe direction for a feature whose only power is to add work for a human.
 *
 * An answer naming codes we did not give it is not null on that account alone - the known ones are kept and
 * the rest dropped - because a model that returns `["W1","harassment"]` has still identified W1, and throwing
 * the whole answer away over the second element would lose a true flag to a formatting slip.
 */
export function parseConduct(raw: string): { codes: string[] } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = conductAnswer.safeParse(parsed);
  if (!result.success) return null;
  const codes = result.data.codes
    .map((c) => c.trim().toUpperCase())
    .filter((c) => CONDUCT_CODES.has(c));
  // De-duplicated and ordered, for the same reason the hazard verdict is: two scans of one post must produce
  // the same row.
  return { codes: [...new Set(codes)].sort() };
}
