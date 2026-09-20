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
  /**
   * The `CONSENTED_PATHS` key this kind goes through, for the few kinds whose collection is on the denylist.
   *
   * Absent for almost every kind, and that is the point: without it `draftText` runs the ordinary
   * `assertMayReachModel` and a kind wired onto a sensitive collection fails loudly. Naming a path here is
   * the deliberate, reviewable act of claiming an exception, and `assertConsentedPath` then checks the path
   * and the collection AGREE, so the string cannot be borrowed to unlock a different collection.
   */
  consentedPath?: string;
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
    // The CONTEXT under a poll, never the question itself. The question is the `title` field, one line, and
    // asking a model to invent what you want to ask people is the version of this that should not exist. The
    // body is "Description (optional)" - the paragraph explaining why the poll is being run and what the
    // options mean - and that is ordinary prose. The two were refused together because the gate sat on the
    // body while the reasoning was about the title.
    id: "poll",
    collection: "announcements",
    label: "Poll description",
    promptVersion: "v1",
    maxTokens: 300,
    system:
      `You help somebody write the short description under a poll on a company's internal board. ${HOUSE_STYLE} ` +
      "A sentence or two of context: why the question is being asked, what the options mean, and by when " +
      "people should vote if the request says. " +
      "Do NOT write the poll question itself and do NOT invent or list the answer options: the person has " +
      "written those, and this text sits underneath them.",
  },
  {
    // A board card's description. `cards` is indexable and not on the denylist: a card says what work is to
    // be done, which is the company's own business rather than anybody's record.
    //
    // The TITLE is left alone on purpose - it is the card's human key on the wall and in every list, and it
    // is one line somebody has already written by the time they want the description filled in.
    id: "task",
    collection: "cards",
    label: "Task",
    promptVersion: "v1",
    maxTokens: 400,
    system:
      `You help somebody write the description of a task on a team's board. ${HOUSE_STYLE} ` +
      "Say what needs doing and how somebody would know it is done. Keep it to a short paragraph, or a few " +
      "bullet lines if the request lists steps. " +
      "Do not invent acceptance criteria, dates, owners or ticket references that were not given, and do not " +
      "assess anybody's work or performance.",
  },
  // The two review kinds. Both go through `reviews.draft` (domain/aiPolicy.ts CONSENTED_PATHS), because
  // `reviews` is on the denylist and this is a named exception rather than a hole.
  //
  // WHAT EVERY REVIEW PROMPT MUST SAY, and why it is repeated in both rather than folded into HOUSE_STYLE:
  // the model must not judge, score or recommend a rating. It has nothing to judge FROM - `draftText` reads
  // no record - but a model asked to "write a performance review" will happily invent an assessment out of
  // the adjectives in the instruction, and that invented verdict would arrive in a field a person then signs.
  // The instruction is the author's own observations; the model's job is to put them in sentences.
  {
    id: "review-self",
    collection: "reviews",
    consentedPath: "reviews.draft",
    label: "Self-assessment",
    promptVersion: "v1",
    maxTokens: 500,
    system:
      `You help somebody write their own self-assessment for a performance review. ${HOUSE_STYLE} ` +
      "Write in the first person, as the person themselves. Turn what they tell you into clear prose: what " +
      "they worked on, what came of it, and what they want to do next. " +
      "Use ONLY what the instruction gives you. Do not add achievements, metrics or dates that were not " +
      "mentioned, do not rate or score anything, and do not say whether the year was good or bad - those are " +
      "the author's to decide and the reader's to weigh.",
  },
  {
    id: "review-summary",
    collection: "reviews",
    consentedPath: "reviews.draft",
    label: "Review comments",
    promptVersion: "v1",
    maxTokens: 500,
    system:
      `You help a manager put their own review comments into sentences. ${HOUSE_STYLE} ` +
      "The instruction is what the manager has observed. Your job is to write it clearly and specifically, " +
      "addressed to the person being reviewed. " +
      "Do NOT form a view of your own: add no judgement, no score, no rating, no recommendation about " +
      "promotion, pay or performance, and nothing the manager did not say. If the instruction is thin, write " +
      "less rather than filling it in.",
  },
  {
    // Turn a task into the steps it takes. The one kind whose answer is not prose: the caller splits it into
    // checklist items, so the shape of the output is part of the contract and the prompt has to be strict
    // about it - a numbered list or a preamble would arrive as checklist items reading "1." and "Sure!".
    //
    // `existing` here is the task's DESCRIPTION, sent as context rather than as text to rewrite
    // (DraftButton `existingIsContext`), because the steps are a different field and the description must
    // come back untouched.
    id: "task-checklist",
    collection: "cards",
    label: "Suggest steps",
    promptVersion: "v1",
    maxTokens: 300,
    system:
      `You break a task down into the steps needed to finish it. ${HOUSE_STYLE} ` +
      "Answer with between three and seven steps, ONE PER LINE, in the order they would be done. " +
      "No numbering, no bullet characters, no heading, no blank lines and no closing sentence: every line " +
      "you write becomes a checklist item exactly as it is. " +
      "Keep each step short enough to read at a glance, and make it an action somebody could tick off. " +
      "Use only what the task says - invent no owners, dates, tools or acceptance criteria.",
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
