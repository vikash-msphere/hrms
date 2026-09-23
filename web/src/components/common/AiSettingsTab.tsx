import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Info, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { FilterChips } from "@/components/common/FilterChips";
import { useToast } from "@/components/ui/use-toast";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { getSetting, saveSetting } from "@/lib/settingsStore";
// The switch list and the code that reads a switch share ONE list of keys: this panel had its own copy, so
// adding a feature compiled here and quietly did nothing where it was read.
import type { AiFeatureKey } from "@/lib/aiFeatures";

// The org's AI switches (settings/ai). Two things are decided here and they are different decisions:
// WHICH features may use a model at all, and HOW MUCH of the shared daily allowance they may spend.
//
// Everything defaults to OFF, and the copy says so plainly rather than hiding it behind a toggle that looks
// pre-enabled. Binding Workers AI in the deployment is an operator's act; deciding that this organisation's
// ticket text and directory entries may be processed by a model belongs to whoever is accountable for the
// employee data. Each feature also states what it does WITHOUT AI, because every one of them has a working
// non-AI path and switching it off is not a loss of function.

type AiConfig = { features?: Partial<Record<AiFeatureKey, boolean>>; dailyNeurons?: number; perUserHourlyGenerations?: number; resume_fields?: string[]; receipt_fields?: string[]; cardDuplicateSensitivity?: string; moderationFallback?: string; moderationScope?: Record<string, string> };

// Which fields a CV may be read into, and which of those are the model doing more than copying. Mirrors
// src/domain/resumeFields.ts; the server validates the names on write, so a drift here is a 400 rather than a
// silently ignored setting.
const RESUME_FIELDS: { key: string; label: string; caution?: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email address" },
  { key: "phone", label: "Phone number" },
  { key: "skills", label: "Skills", caution: "The model decides what counts as a skill." },
  { key: "current_employer", label: "Current employer" },
  { key: "current_title", label: "Current job title" },
  { key: "years_experience", label: "Years of experience", caution: "Only when the CV states it, but this is the field most likely to read as fact when it is not." },
  { key: "summary", label: "Summary of experience", caution: "A paraphrase in the model's words, which a recruiter will read as what the CV said." },
];
const DEFAULT_RESUME_FIELDS = ["name", "email", "phone", "skills", "current_employer", "current_title"];

// Mirrors src/domain/receiptFields.ts; the server validates the names on write, so a drift here is a 400
// rather than a silent mismatch. `caution` marks the ones where the model is doing more than copying a
// number off the page.
const RECEIPT_FIELDS: { key: string; label: string; caution?: string }[] = [
  { key: "amount", label: "Total amount", caution: "A receipt often shows several totals - subtotal, tax, tip, amount paid. The model picks one, and the person accepting it is the check." },
  { key: "tax_amount", label: "Tax amount" },
  { key: "incurred_on", label: "Date incurred", caution: "An invoice can carry an issue date, a service date and a due date. Only the person filing knows which one the claim is for." },
  { key: "vendor_name", label: "Vendor name", caution: "Shown as text to match against the vendor list, never picked for them - a wrong vendor misattributes spend silently." },
  { key: "invoice_number", label: "Invoice number" },
];
const DEFAULT_RECEIPT_FIELDS = ["amount", "tax_amount", "incurred_on", "invoice_number"];

// Copy lives next to the key so adding a feature is one edit, and so no switch can ship without an
// explanation of what it turns on and what happens when it is off.
const FEATURES: { key: AiFeatureKey; title: string; on: string; off: string }[] = [
  {
    key: "search.semantic",
    title: "Semantic search",
    on: "Search also matches by MEANING, so \"maternity\" finds \"parental leave\". Titles and subtitles of the collections listed for indexing are embedded - the same text a search result already shows you.",
    off: "Search matches words and prefixes only, exactly as it does today. Nothing is embedded and the index is emptied as records change.",
  },
  {
    key: "tickets.triage",
    title: "Ticket triage suggestions",
    on: "A new ticket is compared to the resolved tickets nearest it, and the servicing department, category and priority they agree on is offered as a suggestion, with the tickets that voted. Possible duplicates are flagged. No text is generated and nothing is applied automatically.",
    off: "Tickets are routed and prioritised by hand, exactly as they are today.",
  },
  {
    key: "cards.triage",
    title: "Board task filing suggestions",
    on: "On a task, show what comparable DELIVERED tasks say its department, priority and size should be, with the tasks that voted - and flag tasks still in flight that look like the same work. Evidence is finished work only: an open task's filing is a guess the board has not tested yet. No text is generated and nothing is applied automatically.",
    off: "Tasks are filed and sized by hand, and duplicated work is noticed by somebody recognising it, as today.",
  },
  {
    key: "goals.similar",
    title: "Goals aiming at the same thing",
    on: "On a goal, show goals that read like the same work in different words - usually another team planning a quarter around it - and offer the goal this one could roll up under. Nothing is generated and nothing is linked: the index already holds each goal's title and description, and a person decides what to do about the match.",
    off: "Overlapping goals are found by somebody reading the whole list side by side, and alignment is filled in by hand, as today.",
  },
  {
    key: "goals.measure",
    title: "Suggest how a goal could be measured",
    on: "On a goal with no measure, someone can ask for a unit, a starting value and a target to be proposed from what the goal says. The three numbers land in the form for them to change or discard, one at a time, and nothing is saved on their behalf. The model is shown the goal's own title and description and nothing else - no progress, no owner, no review - and it is not asked whether the goal is any good.",
    off: "Goals are given their unit, baseline and target by hand, and a goal without them keeps progress as an estimate, as today.",
  },
  {
    key: "boards.narrate",
    title: "Write up what changed on a board",
    on: "On a board's analytics, a short paragraph saying how delivery, cycle time, lead time and work in flight moved against the period before. The comparison is arithmetic and always shown; the model only puts those movements into sentences, and a sentence containing a figure nobody computed is discarded. No task title, assignee or department is sent - four labels and two numbers each.",
    off: "The movements are listed as figures, exactly as they are today. Nothing is sent to a model.",
  },
  {
    key: "drafting",
    title: "Writing assistance",
    on: "A Draft button appears on announcements, job descriptions, goals and suggestion responses. It writes from what the person types into the box and nothing else: no record is read and no employee data goes into the request. The result lands in the editor for them to change and save, and is never saved on their behalf.",
    off: "No Draft buttons appear. Every one of those fields is typed by hand, as it is today.",
  },
  {
    key: "ats.extraction",
    title: "Read a CV into the candidate form",
    on: "A recruiter can have a candidate's CV read into the form fields, then accept or discard each one. The model transcribes only: it does not score, rank or comment on a candidate's suitability, and it is not asked to. Nothing is saved to the candidate until the recruiter accepts it. This is the one place candidate data is sent to a model, and it happens per candidate on a recruiter's action - never in bulk and never in the background.",
    off: "CVs are read by people. Candidate data is never sent to a model at all.",
  },
  {
    key: "expenses.receiptExtraction",
    title: "Read a receipt into the expense form",
    on: "On a draft claim with a PDF invoice attached, the person filing can have it read into the form and accept or discard each field. The model transcribes only: it does not judge whether a claim is reasonable, in policy or a duplicate, and it is not asked to. Nothing is saved until the person accepts it, and the vendor is never picked for them - the name is shown as printed so they choose the catalogue entry themselves. PDFs only: a photographed receipt has no text to read, and images are deliberately not sent to a model, because text can be stripped of statutory ids before it goes and a picture cannot.",
    off: "Receipts are typed in by hand, as they are today. No expense data is sent to a model.",
  },
  {
    key: "tables.describe",
    title: "Describe a table in words",
    on: "In the table builder, someone can say what they want the grid to show and get columns, filters and sorting laid out for them to adjust. The model is shown only the field names that person can already pick from, and can only answer with those - anything it invents is reported back as not found rather than used. No rows are read and nothing is saved.",
    off: "Grids are built by picking fields from the catalogue, as they are today.",
  },
  {
    key: "analytics.narrate",
    title: "Write up what changed in team reports",
    on: "A team report can be summarised against the previous period in a sentence or two. Which measures moved is worked out arithmetically, not by the model, so it cannot report a change that did not happen; and a summary containing any number that was not in those measures is thrown away in favour of a plain one. Team totals only, never individuals.",
    off: "Reports show their numbers without a written summary, as they do today.",
  },
  {
    key: "moderation",
    title: "Check public posts before they go up",
    on: "THIS IS A GATE. A post on any wall you choose below - announcements and kudos, replies, the suggestion box - is withheld the moment it is written and reaches nobody until a safety model has read it. Every wall is checked unless you narrow it, and the suggestion box can be narrowed further to the posts nobody's name is on. Cleared, it goes up as normal and the author sees no difference. Objected to, it is held: the author is told it is waiting, and it appears on a queue for whoever holds the moderation permission to release or hide - never automatically, and a hide is reversible and tells the author. Anonymous suggestions stay anonymous on the queue. WHEN THE MODEL CANNOT ANSWER - it is down, or the organisation's daily AI allowance is spent - what happens is yours to choose below, and it is worth choosing before you turn this on rather than the first afternoon posting stops.",
    off: "Nothing posted is read by a model, and there is no queue. Posts go up the moment they are written and are moderated by people noticing them, as they are today.",
  },
  {
    key: "moderation.conduct",
    title: "Also check public posts against our conduct rules",
    on: "A second reading of the same posts at the same moment, against this organisation's conduct rules rather than a safety standard: personal abuse, discriminatory remarks, threats, disclosing somebody's pay or medical or disciplinary details, accusations stated as fact, and material plainly out of place at work. The safety check above catches dangerous content and answers \"safe\" to most of that list, which is why this is separate. Same gate, same queue, same person deciding. It costs a second model call per post - so it roughly halves how many posts the daily allowance covers - and it is a judgement about tone, so expect it to be wrong in both directions more often than the safety check.",
    off: "Posts are read for dangerous content only. A post that is merely abusive, discriminatory or indiscreet goes up without reaching the queue.",
  },
  {
    key: "budgets.narrate",
    title: "Write up how a budget is tracking",
    on: "On an expense budget, a short paragraph saying how spend is moving against the plan and what is driving it. Which lines moved is worked out arithmetically, not by the model, and a summary containing any figure that was not in those lines is thrown away in favour of a plain one. Category totals only - no claimant, no vendor, no individual claim.",
    off: "The budget shows its figures with the same plain summary the arithmetic produces, as it does today. Nothing is sent to a model.",
  },
  {
    key: "suggestions.similar",
    title: "Group suggestions asking the same thing",
    on: "On a suggestion, show the others that look like the same ask, so they can be merged rather than splitting the votes between them. This reuses the search index and generates nothing. No submitter is shown, signed or anonymous, and only suggestions the reader could already see are listed.",
    off: "Suggestions stand on their own. The same idea submitted in five wordings reads as five separate asks, as it does today.",
  },
  {
    key: "attention.summary",
    title: "Say what to look at first on \"Needs you\"",
    on: "When the dashboard's \"Needs you\" list has more than one thing on it, add a sentence naming the one to start with. The list itself is worked out from dates and progress and does not use a model, so this adds a line and changes nothing else. Goal and task titles are sent; reviews are sent only as a count, never by name.",
    off: "The list appears as it does today, ranked worst first, with no sentence over it.",
  },
];

/**
 * ONE LINE PER FEATURE, so the page can be read at a glance and the paragraph above is what somebody opens
 * when they are deciding rather than what they scroll past sixteen times.
 *
 * The long copy is not optional and is not a tooltip: it is the record of what this organisation agreed to
 * when they turned a switch on, and it stays a click away at all times - and opens by itself at the moment
 * the switch goes ON, which is the moment it is about.
 */
const SUMMARY: Record<AiFeatureKey, string> = {
  "search.semantic": "⌘K also matches by meaning, not just by words.",
  "tickets.triage": "A new ticket is filed the way resolved ones like it were.",
  "cards.triage": "A board task is filed the way comparable delivered work was.",
  "goals.similar": "Goals that are the same work in other words.",
  "suggestions.similar": "\"Others asked for this\" on a suggestion.",
  "goals.measure": "Proposes a unit, baseline and target for a goal that has none.",
  drafting: "Draft buttons on announcements, job descriptions, goals and replies.",
  "boards.narrate": "A paragraph over a board's analytics saying how flow moved.",
  "analytics.narrate": "A written summary on the team report.",
  "budgets.narrate": "A written summary of how an expense budget is tracking.",
  "attention.summary": "A line over \"Needs you\" saying what to look at first.",
  "tables.describe": "Say what a grid should show and get it laid out.",
  "ats.extraction": "Read a candidate's CV into the form, field by field.",
  "expenses.receiptExtraction": "Read a PDF receipt into an expense claim, field by field.",
  moderation: "Nothing reaches a public wall until a model has read it.",
  "moderation.conduct": "Read the same posts again against this org's conduct rules.",
};

/**
 * The page in four sections, because sixteen switches in one list is a wall rather than a choice.
 *
 * GROUPED BY WHAT THE MODEL IS ASKED TO DO, which is also how they differ in cost and in risk: matching text
 * it has already indexed, writing a sentence, transcribing a document somebody uploaded, or judging a post
 * before anybody sees it. An admin deciding about one of these is deciding about the group.
 *
 * The first group's shared dependency is the reason it is a group at all: every feature in it reads the
 * semantic index, and nothing fills that index while `search.semantic` is off (services/searchEmbed.ts
 * returns before embedding anything). Turned on alone, those features are not broken - they simply never
 * have anything to say, which is the worst way for a setting to fail.
 */
const GROUPS: { title: string; blurb: string; keys: AiFeatureKey[] }[] = [
  {
    title: "Search and similarity",
    blurb: "These read the semantic index. Nothing is generated: text is compared with text the index already holds, and a person decides what to do about a match.",
    keys: ["search.semantic", "tickets.triage", "cards.triage", "goals.similar", "suggestions.similar"],
  },
  {
    title: "Writing and summarising",
    blurb: "These ask a model for words. Each one lands in a form or beside the figures it describes, and none of them is ever saved on somebody's behalf.",
    keys: ["drafting", "goals.measure", "tables.describe", "boards.narrate", "analytics.narrate", "budgets.narrate", "attention.summary"],
  },
  {
    title: "Reading documents",
    blurb: "These transcribe a document somebody uploaded into form fields, which the person then accepts or discards one by one. The model copies; it does not judge.",
    keys: ["ats.extraction", "expenses.receiptExtraction"],
  },
  {
    title: "Public walls",
    blurb: "The one place a model decides something before a person does - so it decides only to WITHHOLD, never to hide, and a person releases or takes down.",
    keys: ["moderation"],
  },
];

/** Features whose answers come out of the semantic index, so they say nothing until it is being filled. */
const NEEDS_INDEX: AiFeatureKey[] = ["tickets.triage", "cards.triage", "goals.similar", "suggestions.similar"];

/** Sub-features shown INSIDE their parent's row, because they do nothing without it. `moderation.conduct` is
 *  a second pass within the same gate: with `moderation` off it is read by nothing at all. */
const NESTED: Partial<Record<AiFeatureKey, AiFeatureKey[]>> = { moderation: ["moderation.conduct"] };

// The three named positions behind `cardDuplicateSensitivity`. Mirrors CARD_DUPLICATE_SCORES in
// src/domain/aiPolicy.ts, which argues why this is a CHOICE and not a number: the underlying knob is a cosine
// score, and 0.82 is not a thing an HR admin can reason about. The server validates the name on write, so a
// drift here is a 400 rather than a value silently coerced back to the default.
const DUPLICATE_SENSITIVITIES: { key: string; label: string; blurb: string }[] = [
  { key: "loose", label: "Loose", blurb: "Offer anything that reads like related work. Catches more real duplicates and points at more unrelated tasks." },
  { key: "balanced", label: "Balanced", blurb: "The default. Two tasks have to be saying much the same thing in different words." },
  { key: "strict", label: "Strict", blurb: "Only near-identical tasks. Almost never wrong when it speaks, and stays quiet about duplicates worded differently." },
];
const DEFAULT_DUPLICATE_SENSITIVITY = "balanced";

// What the gate does when the model never answered. Mirrors MODERATION_FALLBACKS in src/domain/aiPolicy.ts,
// which argues the boundary this copy has to carry: the choice is about the model being SILENT - no
// allowance left, an outage, a reply that was not a verdict - and never about a model that read the post and
// objected. That case holds under both positions, and saying so here is the difference between an admin
// choosing a failure mode and an admin believing they have switched moderation off by the back door.
const MODERATION_FALLBACKS: { key: string; label: string; blurb: string }[] = [
  {
    key: "hold",
    label: "Hold the post until somebody looks at it",
    blurb: "The safe position, and the default. Nothing reaches a wall unread, ever. The cost is that posting stops working while the model is unavailable - the author is told their post is waiting, it lands on the queue, and somebody with the moderation permission has to release it. If the daily allowance runs out mid-morning, that is every post until midnight UTC.",
  },
  {
    key: "publish",
    label: "Let the post go up, and flag it as unchecked",
    blurb: "Posting keeps working when the model does not. The post goes up as normal, and a queue item marked \"Not checked\" is left over it so you can read afterwards exactly what went up unread and take any of it down. Choose this where the walls are low-risk and somebody watches the queue. A post the model DID read and object to is still held either way.",
  },
];
const DEFAULT_MODERATION_FALLBACK = "hold";

// WHICH posts the model reads, per wall. Mirrors MODERATABLE + MODERATION_WALL_SCOPES in
// src/domain/moderation.ts: `anonymity` there is what decides whether "Anonymous only" is offered, and the
// server refuses that position on a wall without it rather than storing something that would mean "none".
//
// Default is every wall on "Every post", which is what the feature did before this existed - so an org that
// never opens this section sees no change from turning moderation on.
const MODERATION_WALLS: { key: string; label: string; blurb: string; anonymity: boolean }[] = [
  {
    key: "announcements",
    label: "Announcements, posts, polls and kudos",
    blurb: "The noticeboard. Every post here carries its author's name.",
    anonymity: false,
  },
  {
    key: "announcement-replies",
    label: "Replies on the noticeboard",
    blurb: "Checked separately from the post they sit under, because they are written by somebody else.",
    anonymity: false,
  },
  {
    key: "suggestions",
    label: "The suggestion box",
    blurb: "The one wall where a post can be unattributed, which is where a check earns the most.",
    anonymity: true,
  },
];
const WALL_POSITIONS = [
  { key: "all", label: "Every post" },
  { key: "anonymous", label: "Anonymous only" },
  { key: "off", label: "Don't check" },
];
const DEFAULT_WALL_POSITION = "all";

/** The positions one wall may take. "Anonymous only" is offered where it describes something and left out
 *  where it would be "off" under a friendlier name - the server refuses it there. */
const positionsFor = (wall: { anonymity: boolean }) => WALL_POSITIONS.filter((p) => p.key !== "anonymous" || wall.anonymity);

const DEFAULTS = { dailyNeurons: 7000, perUserHourlyGenerations: 20 };

export function AiSettingsTab() {
  const { toast } = useToast();
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [resumeFields, setResumeFields] = useState<string[]>([...DEFAULT_RESUME_FIELDS]);
  const [receiptFields, setReceiptFields] = useState<string[]>([...DEFAULT_RECEIPT_FIELDS]);
  const [dailyNeurons, setDailyNeurons] = useState(DEFAULTS.dailyNeurons);
  const [perUserHourly, setPerUserHourly] = useState(DEFAULTS.perUserHourlyGenerations);
  const [duplicateSensitivity, setDuplicateSensitivity] = useState(DEFAULT_DUPLICATE_SENSITIVITY);
  const [moderationFallback, setModerationFallback] = useState(DEFAULT_MODERATION_FALLBACK);
  const [moderationScope, setModerationScope] = useState<Record<string, string>>(
    Object.fromEntries(MODERATION_WALLS.map((w) => [w.key, DEFAULT_WALL_POSITION])),
  );
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * WHICH FEATURES HAVE THEIR SETTINGS PANEL OPEN.
   *
   * A LIST, NOT ONE KEY, and that is a bug fix rather than a preference. A feature can be nested inside
   * another's panel (`moderation.conduct` lives in the gate's), and the child is rendered by the parent - so
   * with a single open key, touching the child's switch moved the key to the child, the parent's panel
   * closed, and the row the person was working in vanished from under their cursor. Nothing that happens
   * inside a panel may close the panel it happened in.
   *
   * The page is still mostly one-line rows: only four features have settings at all, and a panel opens
   * because somebody asked for it rather than by following the last thing they touched.
   *
   * The alternative page shapes were worse for this screen rather than merely different. A second pane is
   * out: the Settings page is ALREADY master/detail (a 230px entry list beside this panel) and this same
   * component renders inside the narrow `?setting=` Sheet, so a nested two-pane would be a list beside a list
   * beside a list, with nowhere to go in the Sheet at all. Sub-tabs are out because they break the one
   * question this screen exists to answer at a glance - what is switched on - into four answers nobody can
   * see at once.
   */
  const [openPanels, setOpenPanels] = useState<string[]>([]);
  const togglePanel = (key: AiFeatureKey) =>
    setOpenPanels((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  /**
   * Which features have their description open, from the `i`. Separate from the settings panels because
   * reading what a feature means and configuring it are different errands - and one is done far more often.
   *
   * A LIST, for the same reason the panels are one: a description can be opened from INSIDE a panel (the
   * nested conduct row has its own `i`), and one-at-a-time would close the parent's description under the
   * cursor, shifting everything below it up mid-click. Every disclosure on this page now behaves the same
   * way - press to open, press to close, and nothing else on the page moves.
   */
  const [info, setInfo] = useState<string[]>([]);
  const toggleInfo = (key: AiFeatureKey) =>
    setInfo((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  /**
   * Which explanatory notes are unfolded, by heading.
   *
   * EVERY paragraph on this page that explains rather than asks is behind an `i`, not only the feature
   * descriptions: the page's own preamble, each group, each block of settings inside a feature, and the
   * allowance. A heading with a paragraph under it is prose somebody reads once and then scrolls past for
   * ever, and sixteen features' worth of that was the whole complaint.
   *
   * A LIST RATHER THAN ONE KEY, unlike `info`: these are small, they sit beside the control they describe,
   * and somebody comparing "which posts are checked" with "when the model cannot answer" wants both open.
   */
  const [notes, setNotes] = useState<string[]>([]);
  /** Find a feature by name, for somebody who came here to change one thing and knows what it is called. */
  const [query, setQuery] = useState("");
  /** Which rows to show at all. `todo` is the one that pays for itself: features on but not finished. */
  const [view, setView] = useState<"all" | "on" | "todo">("all");

  useEffect(() => {
    getSetting<AiConfig>("ai")
      .then((s) => {
        setFeatures({ ...(s.value?.features ?? {}) });
        if (Array.isArray(s.value?.resume_fields)) setResumeFields(s.value.resume_fields);
        if (Array.isArray(s.value?.receipt_fields)) setReceiptFields(s.value.receipt_fields);
        if (typeof s.value?.dailyNeurons === "number") setDailyNeurons(s.value.dailyNeurons);
        if (typeof s.value?.perUserHourlyGenerations === "number") setPerUserHourly(s.value.perUserHourlyGenerations);
        if (DUPLICATE_SENSITIVITIES.some((d) => d.key === s.value?.cardDuplicateSensitivity)) setDuplicateSensitivity(s.value!.cardDuplicateSensitivity!);
        // An unrecognised stored value leaves the SAFE position selected, which is what the server does with
        // it too (`aiConfig` coerces anything it does not know back to `hold`). The screen and the gate
        // agreeing about that matters more here than on any other leaf on this page.
        if (MODERATION_FALLBACKS.some((f) => f.key === s.value?.moderationFallback)) setModerationFallback(s.value!.moderationFallback!);
        // Per wall, and each one taken only if it is a position that wall actually has - a stored
        // "anonymous" on a signed wall is refused by the server today, so one in an older blob would be a
        // value this screen must not show as chosen.
        if (s.value?.moderationScope && typeof s.value.moderationScope === "object") {
          const stored = s.value.moderationScope as Record<string, string>;
          setModerationScope((cur) => ({
            ...cur,
            ...Object.fromEntries(
              MODERATION_WALLS
                .filter((w) => positionsFor(w).some((p) => p.key === stored[w.key]))
                .map((w) => [w.key, stored[w.key]!]),
            ),
          }));
        }
      })
      .catch(() => { /* nothing saved yet: everything stays off, which is the default */ })
      .finally(() => setReady(true));
  }, []);

  const { markSaved } = useUnsaved({ features, resumeFields, receiptFields, dailyNeurons, perUserHourly, duplicateSensitivity, moderationFallback, moderationScope }, ready, save);
  async function save() {
    setSaving(true);
    try {
      await saveSetting("ai", {
        value: {
          features,
          // Sent in the canonical order rather than click order, so the stored blob is stable for one chosen
          // set - the server derives a cache key from it.
          resume_fields: RESUME_FIELDS.map((f) => f.key).filter((k) => resumeFields.includes(k)),
          receipt_fields: RECEIPT_FIELDS.map((f) => f.key).filter((k) => receiptFields.includes(k)),
          // Clamped here as well as on the server. The server's clamp is the one that matters - a number
          // above the free allocation cannot buy any more of it - and this only keeps the field from
          // displaying a figure the app will not honour.
          dailyNeurons: Math.max(1, Math.min(Number(dailyNeurons) || 0, DEFAULTS.dailyNeurons)),
          // One a hour is the floor, not zero: zero passes every numeric test and refuses every generation,
          // which reads as the feature being broken rather than as having been turned off.
          perUserHourlyGenerations: Math.max(1, Math.min(Number(perUserHourly) || 0, DEFAULTS.perUserHourlyGenerations)),
          cardDuplicateSensitivity: duplicateSensitivity,
          moderationFallback,
          moderationScope,
        },
      });
      markSaved();
      toast({ title: "AI settings saved", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const byKey = Object.fromEntries(FEATURES.map((f) => [f.key, f])) as Record<AiFeatureKey, (typeof FEATURES)[number]>;
  const onCount = FEATURES.filter((f) => features[f.key] === true).length;
  const indexOff = features["search.semantic"] !== true;
  const todoCount = FEATURES.filter((f) => features[f.key] === true && needsChoice(f.key)).length;

  /** Every feature in reading order, nested ones included - the order the groups put them in. */
  const allKeys = GROUPS.flatMap((g) => g.keys.flatMap((k) => [k, ...(NESTED[k] ?? [])]));
  const filtering = view !== "all" || query.trim() !== "";
  const q = query.trim().toLowerCase();
  const shownKeys = allKeys.filter((k) => {
    // The key itself is searchable as well as the words: an operator working from `docs/deploy-ai.md` or from
    // the settings blob knows this feature as `budgets.narrate`, not as "Write up how a budget is tracking".
    if (q && !`${byKey[k].title} ${SUMMARY[k]} ${k}`.toLowerCase().includes(q)) return false;
    if (view === "on") return features[k] === true;
    if (view === "todo") return features[k] === true && !!needsChoice(k);
    return true;
  });

  /**
   * Flip a switch, and open the settings it just made available - nothing else.
   *
   * DESCRIPTIONS STAY CLOSED, here as everywhere. A paragraph that appears because somebody clicked a
   * checkbox is a paragraph in the way of the next click, and it pushes the settings - the thing there is
   * actually to do now - down the page. The description is one press of the `i` away on the row, in the same
   * place it always is, whether the feature is on or off.
   *
   * The scroll is `block: "nearest"`, so a row already on screen does not move and one near the fold rises by
   * the least amount that works. The panel appears in the same render, hence the frame's wait.
   */
  function toggle(key: AiFeatureKey, on: boolean) {
    setFeatures((cur) => ({ ...cur, [key]: on }));
    if (!on) return;
    // ADDED, never assigned: switching a nested feature on must leave its parent's panel open, because that
    // panel is where the row lives.
    setOpenPanels((cur) => (cur.includes(key) ? cur : [...cur, key]));
    requestAnimationFrame(() => document.getElementById(`ai-row-${key}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  const fieldList = (
    fields: { key: string; label: string; caution?: string }[],
    chosen: string[],
    set: (fn: (cur: string[]) => string[]) => void,
  ) => (
    <div className="space-y-2">
      {fields.map((f) => (
        <label key={f.key} className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-2.5">
          <Checkbox
            checked={chosen.includes(f.key)}
            onCheckedChange={(v) => set((cur) => (v === true ? [...cur, f.key] : cur.filter((k) => k !== f.key)))}
            aria-label={f.label}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm">{f.label}</span>
            {/* Shown for the fields where the model is doing more than copying, so the person choosing can
                tell those apart without having read the prompt. */}
            {f.caution && <span className="block text-sm text-warning">{f.caution}</span>}
          </span>
        </label>
      ))}
    </div>
  );

  /** The `i` that folds one note, wherever it sits. */
  const noteButton = (id: string, label: string) => {
    const open = notes.includes(id);
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("-my-1 h-6 w-6 shrink-0 text-muted-foreground", open && "bg-muted text-foreground")}
        onClick={() => setNotes((cur) => (open ? cur.filter((n) => n !== id) : [...cur, id]))}
        aria-expanded={open}
        aria-label={open ? `Hide what "${label}" means` : `What "${label}" means`}
        title={open ? "Hide the explanation" : "What this means"}
      >
        <Info className="h-3.5 w-3.5" />
      </Button>
    );
  };

  /** A heading, whatever it heads, with its explanation folded behind the `i` beside it. */
  const heading = (title: string, note: ReactNode, opts: { section?: boolean; aside?: ReactNode } = {}) => (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {opts.section
          ? <h3 className="text-sm font-semibold">{title}</h3>
          : <p className="text-sm font-medium">{title}</p>}
        {noteButton(title, title)}
        {opts.aside && <span className="ml-auto text-xs tabular-nums text-muted-foreground">{opts.aside}</span>}
      </div>
      {notes.includes(title) && <p className="mt-1 text-sm text-muted-foreground">{note}</p>}
    </div>
  );

  /** A labelled block of settings that belong to one feature. */
  const sub = (title: string, blurb: string, body: ReactNode) => (
    <div className="space-y-2">
      {heading(title, blurb)}
      {body}
    </div>
  );

  /**
   * The settings that belong to one feature, shown UNDER it and only while it is on.
   *
   * These used to be a stack of panels below the whole switch list, in a fixed order that had nothing to do
   * with which switch they belonged to - so with three features on, the page was four unrelated blocks and
   * the only way to tell what "Which fields may be read" was about was to know already.
   */
  function extrasFor(key: AiFeatureKey): ReactNode {
    if (key === "ats.extraction") {
      return (
        <>
          {sub(
            "Which fields a CV may be read into",
            "Only the fields ticked here are asked for, and anything else the model returns is discarded. A recruiter still accepts or discards each value before it is saved to the candidate.",
            fieldList(RESUME_FIELDS, resumeFields, setResumeFields),
          )}
          {resumeFields.length === 0 && (
            <p className="text-sm text-warning">
              Nothing is ticked, so extraction will refuse rather than read the whole CV. Tick at least one
              field, or switch the feature off.
            </p>
          )}
        </>
      );
    }
    if (key === "expenses.receiptExtraction") {
      return (
        <>
          {sub(
            "Which fields a receipt may be read into",
            "Only the fields ticked here are asked for, and anything else the model returns is discarded. The person filing still accepts or discards each value before it is saved to the claim.",
            fieldList(RECEIPT_FIELDS, receiptFields, setReceiptFields),
          )}
          {receiptFields.length === 0 && (
            <p className="text-sm text-warning">
              Nothing is ticked, so extraction will refuse rather than read the whole receipt. Tick at least
              one field, or switch the feature off.
            </p>
          )}
        </>
      );
    }
    if (key === "cards.triage") {
      return sub(
        "How alike two tasks must look to be called a duplicate",
        "The trade-off is symmetric and worth choosing deliberately: too loose and the panel points at tasks that have nothing to do with yours, which teaches people to ignore it; too strict and the task somebody genuinely filed twice goes unmentioned. Nothing is merged either way - a person decides.",
        <div className="space-y-2">
          {DUPLICATE_SENSITIVITIES.map((s) => (
            <label key={s.key} className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-2.5">
              <input
                type="radio"
                name="cardDuplicateSensitivity"
                className="mt-1"
                checked={duplicateSensitivity === s.key}
                onChange={() => setDuplicateSensitivity(s.key)}
                aria-label={s.label}
              />
              <span className="min-w-0">
                <span className="block text-sm">{s.label}</span>
                <span className="block text-sm text-muted-foreground">{s.blurb}</span>
              </span>
            </label>
          ))}
        </div>,
      );
    }
    if (key === "moderation") {
      return (
        <>
          {sub(
            "Which posts are checked",
            "Each wall separately, because they are not the same risk. A name beside a post does most of the work a queue would otherwise do, which is why the suggestion box - the one place somebody can post without one - can be checked on its own. A wall set to don't check still has a moderation queue and can still be moderated by hand; what stops is a model reading it, and therefore posts on it being held.",
            <div className="space-y-2">
              {MODERATION_WALLS.map((w) => (
                <div key={w.key} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card p-2.5">
                  <span className="min-w-0">
                    <span className="block text-sm">{w.label}</span>
                    <span className="block text-sm text-muted-foreground">{w.blurb}</span>
                  </span>
                  <Select
                    value={moderationScope[w.key] ?? DEFAULT_WALL_POSITION}
                    onValueChange={(v) => setModerationScope((cur) => ({ ...cur, [w.key]: v }))}
                  >
                    <SelectTrigger className="w-44 shrink-0" aria-label={`What is checked on ${w.label}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {positionsFor(w).map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>,
          )}
          {MODERATION_WALLS.every((w) => moderationScope[w.key] === "off") && (
            // The state that reads as the feature being broken: the switch says posts are checked and
            // nothing is. Said here rather than left to be discovered by a post that never gets read.
            <p className="text-sm text-warning">
              Nothing is checked, so this feature is on and doing nothing. Choose a wall above, or switch
              &ldquo;Check public posts before they go up&rdquo; off - which is the honest way to say it.
            </p>
          )}
          {sub(
            "When the model cannot answer",
            "The check can fail to run at all: the day's AI allowance is spent, the model is unavailable, or it replies with something that is not a verdict. This is what happens to a post caught in that window. It does not change what happens to a post the model reads and objects to - that one is held for a person either way, which is the feature working rather than failing.",
            <div className="space-y-2">
              {MODERATION_FALLBACKS.map((f) => (
                <label key={f.key} className="flex cursor-pointer items-start gap-3 rounded-md border bg-card p-2.5">
                  <input
                    type="radio"
                    name="moderationFallback"
                    className="mt-1"
                    checked={moderationFallback === f.key}
                    onChange={() => setModerationFallback(f.key)}
                    aria-label={f.label}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm">{f.label}</span>
                    <span className="block text-sm text-muted-foreground">{f.blurb}</span>
                  </span>
                </label>
              ))}
            </div>,
          )}
          {moderationFallback === "publish" && (
            // Said once more, plainly, beside the position that has the consequence. This is the consent
            // record for "some posts will reach this organisation's walls without any check having run".
            <p className="text-sm text-warning">
              With this chosen, a post can reach a public wall unread. Everything that goes up that way is on
              the Flagged posts queue marked &ldquo;Not checked&rdquo; - that queue is the only record of
              which posts they were, so somebody needs to be reading it.
            </p>
          )}
        </>
      );
    }
    return null;
  }

  /**
   * Does this feature bring settings of its own?
   *
   * Asked by CALLING the function above rather than by a second list beside it. Building a JSX tree and
   * dropping it is a few object allocations, and the alternative is a hand-kept set of four keys that has to
   * be remembered when a fifth feature grows a setting - which is the drift this file has already been bitten
   * by twice (`budgets.narrate` had a service and no card; `cardDuplicateSensitivity` had a default and no
   * control). The answer cannot disagree with the thing it is about.
   */
  const hasSettings = (key: AiFeatureKey) => extrasFor(key) !== null;

  /**
   * A choice this feature needs before it will do anything, or null.
   *
   * Shown on the ROW, not only inside the panel, so a page with several features on still says where the
   * unfinished business is without opening each one. Each of these is a state the server treats as "refuse
   * rather than guess": extraction with no fields asks for nothing, and a gate with every wall off reads
   * every post as out of scope.
   */
  function needsChoice(key: AiFeatureKey): string | null {
    if (key === "ats.extraction" && resumeFields.length === 0) return "Pick fields";
    if (key === "expenses.receiptExtraction" && receiptFields.length === 0) return "Pick fields";
    if (key === "moderation" && MODERATION_WALLS.every((w) => moderationScope[w.key] === "off")) return "Pick a wall";
    return null;
  }

  /**
   * A word on the row for a choice that is MISSING, which is the one state whose detail is hidden.
   *
   * The other two conditions worth flagging - a similarity feature with no index behind it, a conduct check
   * whose gate is off - now say so in a sentence on the row itself, so they need no chip: a badge and the
   * sentence explaining it, side by side, is the same thing said twice.
   */
  const rowFlag = (key: AiFeatureKey): string | null => (features[key] === true ? needsChoice(key) : null);

  /**
   * ONE LINE PER FEATURE, and two things it can open.
   *
   * The collapsed row is the switchboard: a checkbox, the name, what it does in a few words, and a flag when
   * a choice is outstanding. Sixteen of those fit on about a screen and a half, so "what is on here" is
   * answered by looking rather than by scrolling.
   *
   * TWO DISCLOSURES, because they are two different questions and mixing them made the useful one expensive.
   * The `i` opens the DESCRIPTION - the full account of what happens when this is on and what happens when it
   * is off, which is the record of what the organisation agreed to. The chevron opens the SETTINGS this
   * feature brings with it. A feature with no settings has no chevron, and its row opens the description
   * instead, because that is all it has.
   *
   * Warnings are in neither: they sit on the row, always visible. Something that needs attention is not an
   * answer to a question somebody thought to ask.
   */
  function featureRow(key: AiFeatureKey): ReactNode {
    const f = byKey[key];
    const on = features[key] === true;
    const extras = on ? extrasFor(key) : null;
    // While filtering, a nested feature is a row of its own in the results - so it must not ALSO be drawn
    // inside its parent, or the same feature would be on the page twice, sharing one `id`.
    const children = on && !filtering ? (NESTED[key] ?? []) : [];
    const hasPanel = !!extras || children.length > 0;
    const open = hasPanel && openPanels.includes(key);
    const described = info.includes(key);
    const flag = rowFlag(key);
    const idle = key === "moderation" && !on && features["moderation.conduct"] === true;
    const unindexed = on && indexOff && NEEDS_INDEX.includes(key);
    return (
      <div key={key} id={`ai-row-${key}`} className="rounded-md border bg-card">
        <div className="flex items-start gap-3 p-2.5">
          <Checkbox
            checked={on}
            onCheckedChange={(v) => toggle(key, v === true)}
            aria-label={f.title}
            className="mt-1 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {/* The ROW opens whatever this feature has to open; the CHECKBOX switches it on. Two targets,
                  because people reach for the switch to switch and for the name to find out more, and a row
                  that did both from one click would turn reading into changing. */}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => (hasPanel ? togglePanel(key) : toggleInfo(key))}
                aria-expanded={hasPanel ? open : described}
              >
                <span className="shrink-0 text-sm font-medium">{f.title}</span>
                <span className="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground sm:block">{SUMMARY[key]}</span>
                {flag && (
                  <span className="shrink-0 rounded-full border border-warning px-2 py-0.5 text-xs text-warning">{flag}</span>
                )}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn("-my-1 h-7 w-7 shrink-0 text-muted-foreground", described && "bg-muted text-foreground")}
                onClick={() => toggleInfo(key)}
                aria-expanded={described}
                aria-label={described ? `Hide what ${f.title} means` : `What ${f.title} means`}
                title={described ? "Hide the description" : "What this means"}
              >
                <Info className="h-4 w-4" />
              </Button>
              {hasPanel && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="-my-1 h-7 w-7 shrink-0 text-muted-foreground"
                  onClick={() => togglePanel(key)}
                  aria-expanded={open}
                  aria-label={open ? `Hide ${f.title} settings` : `${f.title} settings`}
                  title={open ? "Hide settings" : "Settings"}
                >
                  <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
                </Button>
              )}
            </div>

            {/* On a phone the summary has no room beside the title, so it takes the line below. */}
            <p className="text-sm text-muted-foreground sm:hidden">{SUMMARY[key]}</p>

            {/* The dependency nothing used to state. Turned on by itself, these are not broken - they simply
                never have anything to say, because nothing fills the index while semantic search is off. */}
            {unindexed && (
              <p className="mt-1 text-sm text-warning">
                This reads the semantic index, and nothing fills it while &ldquo;Semantic search&rdquo; is
                off - so it will quietly find nothing. Turn that on, or leave this one off.
              </p>
            )}
            {/* A stored sub-feature whose parent is off is doing nothing, and its row is not on the page to
                say so - because it is nested inside the parent that is off. */}
            {idle && (
              <p className="mt-1 text-sm text-warning">
                The conduct check is switched on and does nothing while this is off.
              </p>
            )}
          </div>
        </div>

        {described && (
          <div className="space-y-2 border-t bg-muted/20 p-3">
            <p className="text-sm"><span className="font-medium">When on. </span>{f.on}</p>
            <p className="text-sm text-muted-foreground"><span className="font-medium">When off. </span>{f.off}</p>
          </div>
        )}

        {open && (
          <div className="space-y-4 border-t bg-muted/20 p-3">
            {children.map((c) => featureRow(c))}
            {extras}
          </div>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        {/* No count here: the chip row below carries it, and carries it as something you can act on. The
            page's standing promise about where this runs is behind the `i`, like every other paragraph. */}
        <CardTitle className="text-base">
          <span className="flex items-center gap-2">
            <AccessAction collection="settings" objectPath="settings/ai" label="AI features">
              <span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> AI features</span>
            </AccessAction>
            {noteButton("AI features", "this page")}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {notes.includes("AI features") && (
          <p className="text-sm text-muted-foreground">
            These features run on Cloudflare Workers AI, inside the same account that already holds this
            application's database and documents. Nothing is sent to an outside model provider, and the text
            involved is never salary, statutory, medical or assessment data - those are excluded in code, not
            by configuration. Every feature here is off until you turn it on, and each works without AI when
            it is off.
          </p>
        )}

        {/* FIND ONE, or see only what is on. Somebody arriving to change a single feature knows its name and
            should not have to read four groups to get to it; somebody auditing wants the short list. The
            `todo` chip is the one that earns its place - a feature switched on and not finished does nothing,
            and until now the only way to learn that was to open it. */}
        <FilterChips
          value={view}
          onChange={(v) => setView(v)}
          clearTo="all"
          options={[
            { value: "all", label: "All", count: FEATURES.length },
            { value: "on", label: "On", count: onCount },
            // Disabled at zero rather than hidden: "nothing needs a choice" is worth being able to READ, and
            // a chip that appears and disappears is one people stop trusting.
            { value: "todo", label: "Needs a choice", count: todoCount, disabled: todoCount === 0 },
          ]}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a feature…"
            aria-label="Find a feature"
            className="h-8 w-full sm:w-56"
          />
        </FilterChips>

        {filtering ? (
          // FLAT WHILE FILTERING, because a filter cuts across the groups and empty headings are noise. The
          // groups are how the page is READ; the filter is how one row is FOUND.
          <div className="space-y-2">
            {shownKeys.length === 0
              ? <p className="text-sm text-muted-foreground">Nothing matches. Clear the filter to see all {FEATURES.length}.</p>
              : shownKeys.map((k) => featureRow(k))}
          </div>
        ) : (
          GROUPS.map((g) => {
            // Nested features count toward their group: `moderation.conduct` has no row of its own until the
            // gate is on, and a group that said "0 of 1" while two things were running would be wrong.
            const all = g.keys.flatMap((k) => [k, ...(NESTED[k] ?? [])]);
            const n = all.filter((k) => features[k] === true).length;
            return (
              <section key={g.title} className="space-y-2">
                {heading(g.title, g.blurb, { section: true, aside: `${n} of ${all.length} on` })}
                <div className="space-y-2">{g.keys.map((k) => featureRow(k))}</div>
              </section>
            );
          })
        )}

        <section className="space-y-3 border-t pt-5">
          {heading(
            "The shared allowance",
            <>
              Cloudflare includes a free allowance of 10,000 neurons a day, shared by the whole account
              (including any staging deployment). These ceilings sit below it. They can only be lowered:
              setting a higher number does not buy more allowance, so the app ignores it. When the budget is
              spent, every feature falls back to its non-AI behaviour until the allowance resets at midnight
              UTC. Unattended work - the search backfill, the moderation sweep, the nightly jobs - is capped at
              a share of the day, so it cannot spend what somebody at a keyboard needs.
            </>,
            { section: true },
          )}
          <div className="editor-row">
            <span className="editor-row-main text-sm">Neurons per day, org-wide</span>
            <Input type="number" className="w-28" value={dailyNeurons} onChange={(e) => setDailyNeurons(Number(e.target.value))} />
          </div>
          <div className="editor-row">
            <span className="editor-row-main text-sm">Generated drafts per person, per hour</span>
            <Input type="number" className="w-28" value={perUserHourly} onChange={(e) => setPerUserHourly(Number(e.target.value))} />
          </div>
          {features["moderation"] === true && features["attention.summary"] === true && (
            // The two interactive features that can crowd each other, said where the allowance is set rather
            // than left for the afternoon posting stops. Both spend the share reserved for people, and the
            // dashboard one runs on the app's busiest page - so it is the gate that loses.
            <p className="text-sm text-warning">
              &ldquo;Check public posts&rdquo; and the &ldquo;Needs you&rdquo; summary both spend the share of
              the allowance kept for people at a keyboard, and the dashboard is the busiest page in the app.
              On the free allowance, run one or the other: if the day runs out, posting is what stops.
            </p>
          )}
        </section>

        {/* STICKY, because this page is long enough that the switch somebody just changed and the button
            that saves it are never on screen together. The negative margins pull it out to the card's own
            edges so the opaque background covers the full width of what scrolls under it; `-mb-4 sm:-mb-6`
            cancels `CardContent`'s bottom padding, which is where this bar now sits. */}
        <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end border-t bg-card px-4 py-3 sm:-mx-6 sm:-mb-6 sm:px-6">
          <Button onClick={save} disabled={saving || !ready}>{saving ? "Saving..." : "Save"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}
