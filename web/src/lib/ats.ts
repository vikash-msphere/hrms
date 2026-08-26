// Hiring vocabulary shared by more than one Recruiting page.
//
// A recommendation is written on the Interviews page and read on the pipeline drawer, so its labels live here
// rather than in either page: importing one page from another to borrow a constant drags the whole route's
// bundle along with it.

/** The four verdicts a scorecard can carry, in the order a panel thinks about them. */
export const REC_LABEL: Record<string, string> = { strong_yes: "Strong yes", yes: "Yes", no: "No", strong_no: "Strong no" };
export const REC_VARIANT: Record<string, "success" | "destructive"> = { strong_yes: "success", yes: "success", no: "destructive", strong_no: "destructive" };
/** True for the verdicts that need a reason written next to them. */
export const NEGATIVE_REC = ["no", "strong_no"];

/** The offer workflow, labelled. Read on the Offers page AND on a pipeline card, so it lives here. */
export type OfferStatusVariant = "secondary" | "success" | "destructive" | "outline";
export const OFFER_STATUS_META: Record<string, { label: string; variant: OfferStatusVariant }> = {
  draft: { label: "Draft", variant: "outline" },
  approved: { label: "Approved", variant: "secondary" },
  extended: { label: "Extended", variant: "secondary" },
  accepted: { label: "Accepted", variant: "success" },
  declined: { label: "Declined", variant: "destructive" },
  rescinded: { label: "Rescinded", variant: "destructive" },
};

// ── Finding a slot everybody can make ───────────────────────────────────────────────────────────────────────
//
// Scheduling used to ask the reader to already know the answer: type a time, then read a clash warning and try
// again. The app holds every commitment that matters (other interviews, approved leave, events with an
// attendee list), so it can offer the first few hours the whole panel is actually free instead.
//
// Pure and clock-injected so it can be tested: the caller passes `fromMs` and the busy windows it collected.

export type BusyWindow = {
  /** Employee id (not a path) whose time this takes. */
  who: string;
  start: number;
  end: number;
  /** What it is, for the "why not this hour" hint. */
  label?: string;
};

export type SlotQuery = {
  /** Employee ids that must ALL be free. An empty panel has no constraint and yields plain working hours. */
  panel: string[];
  busy: BusyWindow[];
  durationMin: number;
  /** Search from here - normally now. */
  fromMs: number;
  /** Calendar days to scan forward (weekends skipped, so ten days is about two working weeks). */
  days?: number;
  /** Working window, in minutes from local midnight. */
  dayStartMin?: number;
  dayEndMin?: number;
  /** Candidate start times land on this grid. */
  stepMin?: number;
  limit?: number;
};

const MIN = 60_000;

/** The first `limit` windows of `durationMin` inside working hours where nobody on the panel is busy. */
export function findFreeSlots(q: SlotQuery): { start: number; end: number }[] {
  const { panel, busy, durationMin, fromMs } = q;
  const days = q.days ?? 10;
  const dayStartMin = q.dayStartMin ?? 9 * 60;
  const dayEndMin = q.dayEndMin ?? 18 * 60;
  const stepMin = q.stepMin ?? 30;
  const limit = q.limit ?? 6;
  if (!(durationMin > 0) || durationMin > dayEndMin - dayStartMin) return [];

  const wanted = new Set(panel);
  // Only the panel's own commitments matter; everything else is noise for this question.
  const mine = wanted.size ? busy.filter((b) => wanted.has(b.who) && b.end > b.start) : [];
  const out: { start: number; end: number }[] = [];
  const day0 = new Date(fromMs);
  day0.setHours(0, 0, 0, 0);

  for (let d = 0; d < days && out.length < limit; d++) {
    const day = new Date(day0.getTime());
    day.setDate(day.getDate() + d);
    if (day.getDay() === 0 || day.getDay() === 6) continue; // weekends are not a slot anybody wants
    for (let m = dayStartMin; m + durationMin <= dayEndMin && out.length < limit; m += stepMin) {
      const start = new Date(day.getTime());
      start.setHours(0, m, 0, 0);
      const startMs = start.getTime();
      if (startMs < fromMs) continue; // no slot in the past, and none in the hour already half gone
      const endMs = startMs + durationMin * MIN;
      if (mine.some((b) => b.start < endMs && b.end > startMs)) continue;
      out.push({ start: startMs, end: endMs });
    }
  }
  return out;
}

// ── Reading a person out of pasted text ─────────────────────────────────────────────────────────────────────
//
// Pool entry is five fields typed off an email signature or a profile blurb somebody sent over chat. The text
// already holds the answer, so paste it and let the form fill itself; every field stays editable, because a
// guess presented as a fact is worse than no guess.
export type ParsedContact = { name?: string; email?: string; phone?: string };

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// Phone: at least 8 digits, optional +, spaces / dashes / brackets between them. Deliberately conservative -
// it must not swallow a salary figure or a date out of the same block of text.
const PHONE_RE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d[\d\s-]{7,}\d/;
const NOISE = /^(hi|hello|hey|thanks|regards|best|cheers|sent from|--+|resume|cv)\b/i;

export function parseContact(text: string): ParsedContact {
  const out: ParsedContact = {};
  const email = text.match(EMAIL_RE)?.[0];
  if (email) out.email = email;
  // Take the phone from a line that is NOT the email line, so a "+91-..." inside a URL is not mistaken for one.
  for (const line of text.split(/\r?\n/)) {
    if (email && line.includes(email)) continue;
    const digits = line.replace(/[^\d]/g, "");
    if (digits.length < 8 || digits.length > 15) continue;
    const m = line.match(PHONE_RE);
    if (m) { out.phone = m[0].trim(); break; }
  }
  // The name: the first line that reads like one - two to four words, letters, and not a greeting or a sign-off.
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, "");
    if (!line || NOISE.test(line)) continue;
    if (email && line.includes(email)) continue;
    if (/\d/.test(line) || line.includes("@") || line.includes("http")) continue;
    const words = line.split(/\s+/);
    if (words.length < 1 || words.length > 4) continue;
    if (!/^[\p{L}][\p{L}'.-]*(\s+[\p{L}'.-]+)*$/u.test(line)) continue;
    out.name = line;
    break;
  }
  // An email with no name still names them: "asha.rao@x.com" -> "Asha Rao" beats an empty field.
  if (!out.name && out.email) {
    const local = out.email.split("@")[0] ?? "";
    const words = local.split(/[._-]+/).filter((w) => w && !/^\d+$/.test(w));
    if (words.length) out.name = words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
  }
  return out;
}
