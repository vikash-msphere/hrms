// The drafting prompts, as data.
//
// They live here, together and in one list, because a prompt is the part of an AI feature most likely to be
// edited casually and least likely to be reviewed. Scattered across the services that use them, nobody ever
// sees the set; in one file a reviewer can read every instruction this app gives a model in about a minute.
//
// THE SAFETY PROPERTY OF THIS WHOLE FEATURE IS WHAT IS **NOT** IN THE PROMPT.
//
// A draft is built from exactly two things: the fixed instruction below, and text the CALLER TYPED into the
// box. No record is read, no employee is looked up, no row from the database is interpolated. That is what
// makes drafting safe in a way that a "summarise this employee" feature would not be - there is no retrieval
// step, so there is nothing for a scope bug to leak and nothing for the denylist to have to catch. The host
// collection is still checked against `NEVER_TO_MODEL` as a second fence, but the first fence is that the
// prompt has no way to reach data in the first place.
//
// Model output goes into an editor for the caller to read, edit and save. It is never written anywhere on its
// own, which is what keeps a hallucinated sentence a typo rather than a record.
import { UNTRUSTED_PREAMBLE, fence, scrubIdentifiers } from "./aiPolicy";

/**
 * `promptVersion` is part of the generation cache key. BUMP IT whenever the instruction below changes, or the
 * cache will keep serving answers produced by the old wording - the failure where an edit to a prompt appears
 * to do nothing, and the more time passes the more confusing it gets.
 */
export type DraftKind = {
  id: string;
  /** The collection whose write grant gates this draft. Also what the denylist is checked against. */
  collection: string;
  label: string;
  promptVersion: string;
  maxTokens: number;
  /** The instruction. Written in plain imperative, because a model follows a clear instruction better than a
   *  role-play, and because the next person to read it has to be able to tell what it will do. */
  system: string;
};

const HOUSE_STYLE =
  "Write in plain British English. Be specific and brief. Do not use em dashes. Do not open with a greeting " +
  "or close with a sign-off unless asked. Do not invent facts, names, dates, figures or policies: if a detail " +
  "is needed and was not given, leave an obvious placeholder in square brackets such as [date]. " +
  "Return only the text itself, with no preamble, no explanation and no markdown code fences.";

export const DRAFT_KINDS: DraftKind[] = [
  {
    id: "announcement",
    collection: "announcements",
    label: "Announcement",
    promptVersion: "v1",
    maxTokens: 500,
    system:
      `You help an HR team write an internal announcement for staff. ${HOUSE_STYLE} ` +
      "Aim for two or three short paragraphs. Say what is happening, when, and what the reader needs to do. " +
      "Do not add a subject line unless the request asks for one.",
  },
  {
    // A POST IS NOT AN ANNOUNCEMENT, and it had been sharing that kind's prompt. The board carries four
    // things (web/src/components/common/PostComposer.tsx): an announcement, a post, a poll and a kudos. The
    // first two both offered drafting and both sent `announcement`, so somebody writing a personal note to
    // their colleagues got "You help an HR team write an internal announcement for staff. Say what is
    // happening, when, and what the reader needs to do" - which is why a drafted post read like a circular.
    // Same collection, so the same write grant and the same denylist check still gate it.
    id: "post",
    collection: "announcements",
    label: "Post",
    promptVersion: "v1",
    maxTokens: 400,
    system:
      `You help somebody write a short post for their company's internal board. ${HOUSE_STYLE} ` +
      "Write as the person themselves, in the first person, to colleagues rather than to staff. " +
      "Keep it to a paragraph or two. This is not an official announcement: do not write it as policy, do " +
      "not add a subject line, and do not tell people what they are required to do.",
  },
  {
    id: "job-description",
    collection: "job-requisitions",
    label: "Job description",
    promptVersion: "v1",
    maxTokens: 700,
    system:
      `You help a hiring team write a job description. ${HOUSE_STYLE} ` +
      "Cover the purpose of the role, the main responsibilities, and what experience is needed. " +
      "Describe the work, not the person: avoid requirements that are not about doing the job, and do not " +
      "mention age, gender, marital status, nationality, religion, caste or health.",
  },
  {
    id: "goal",
    collection: "goals",
    label: "Goal",
    promptVersion: "v1",
    maxTokens: 300,
    system:
      `You help someone write a work goal. ${HOUSE_STYLE} ` +
      "State the outcome, how it will be measured, and by when. Keep it to a few sentences. " +
      "Write it from the goal owner's point of view. Do not assess anybody's performance.",
  },
  {
    id: "suggestion-response",
    collection: "suggestions",
    label: "Response to a suggestion",
    promptVersion: "v1",
    maxTokens: 400,
    system:
      `You help an HR team reply to a suggestion an employee submitted. ${HOUSE_STYLE} ` +
      "Acknowledge the suggestion, give the decision or the current position, and say what happens next. " +
      "Be straightforward about a no. Do not promise anything the request did not say was being promised.",
  },
];

export const draftKind = (id: string): DraftKind | undefined => DRAFT_KINDS.find((k) => k.id === id);

/** Every collection that has at least one draft kind, which is the set of routes to mount. */
export const DRAFT_COLLECTIONS: string[] = [...new Set(DRAFT_KINDS.map((k) => k.collection))];

export const MAX_DRAFT_INPUT = 4000;

/**
 * Build the user half of the prompt.
 *
 * The caller's text is FENCED and the fence delimiters are stripped from it, so it cannot close its own fence
 * and continue as instructions; then identifiers that should never have been typed into a drafting box are
 * scrubbed. Both are defence in depth rather than the defence: the guarantee is that the output is text in an
 * editor, wired to nothing, so a model that decides to follow an injected instruction still cannot act.
 *
 * The scrub is applied even though the author is drafting their own text. Somebody pasting a whole email into
 * "rewrite this" is the normal case, and an email can easily carry a PAN or an account number.
 */
export function draftPrompt(instruction: string, existing?: string | null): string {
  const parts = [fence("what to write", scrubIdentifiers(instruction.slice(0, MAX_DRAFT_INPUT)))];
  if (existing && existing.trim()) {
    parts.push(fence("the current draft, to improve rather than replace", scrubIdentifiers(existing.slice(0, MAX_DRAFT_INPUT))));
  }
  return parts.join("\n\n");
}

/** The system half: the kind's instruction plus the standing rule about untrusted content. */
export const draftSystem = (kind: DraftKind): string => `${kind.system}\n\n${UNTRUSTED_PREAMBLE}`;
