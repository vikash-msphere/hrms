import { useState } from "react";
import { FileSearch, CheckSquare, Award, Users, MessageSquare } from "lucide-react";
import { invokeRead } from "@/api";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { navigate } from "@/router";

// What this person actually did during the cycle, from the records that already hold it.
//
// NO MODEL, NO SCORE, NO SUMMARY. Four lists and their links: cards they delivered in the window, kudos
// colleagues wrote them, goals somebody else owned that credited them a share, and the shared notes of their
// own 1:1s. Whoever is writing the review reads them and decides what they mean, which is the whole of the
// job a model must not be given here.
//
// ASKED FOR, NOT FETCHED ON OPEN, for the same reason the card triage panel is: a review is opened to read a
// rating far more often than to write one, and four queries on every open would be paid mostly by people who
// are not writing anything.
//
// GATED ON THE CALLER'S OWN VERB. `reviews:evidence` answers with records from four other collections, so it
// is a capability in its own right - and each section is separately decided server-side by the list verdict
// its collection would give this caller, so a section they may not list arrives empty rather than refused.
export function ReviewEvidenceCard({ reviewId, can, subject, onUse }: {
  reviewId: string;
  /** The verbs this caller holds on THIS review (`access.can`, server-computed). */
  can?: string[];
  /** Whose record this is, for the button's wording. Absent means the reader's own. */
  subject?: string;
  /**
   * Put the delivered work into the draft instruction box, as editable text.
   *
   * WHAT IS HANDED OVER AND WHAT IS NOT. Tasks delivered and goals contributed to: the person's own record
   * of what they did, on collections that are not on the denylist. Kudos and 1:1 notes are NOT, although
   * they are on screen a few lines above - a kudos is a colleague's sentence about this person, which is
   * peer feedback however warmly it is written, and a 1:1 note is a conversation. The basis for the line is
   * written out in CONSENTED_PATHS (src/domain/aiPolicy.ts).
   */
  onUse?: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [pack, setPack] = useState<Evidence | null>(null);

  if (!can?.includes("evidence")) return null;

  async function run() {
    setBusy(true);
    try {
      const res = await invokeRead<{ evidence: Evidence }>(`reviews/${reviewId}`, "evidence");
      setPack(res.evidence);
    } catch {
      // Silent: this is a reading aid beside a form somebody opened to do something else.
      setPack(null);
    } finally {
      setAsked(true);
      setBusy(false);
    }
  }

  if (!asked) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={run} disabled={busy}>
        <FileSearch className="h-4 w-4" /> {busy ? "Gathering…" : subject ? `What ${subject} did this cycle` : "What I did this cycle"}
      </Button>
    );
  }

  const empty = !pack || (pack.cards.length + pack.kudos.length + pack.contributions.length + pack.check_ins.length === 0);
  if (empty) {
    return <p className="text-xs text-muted-foreground">Nothing recorded against this cycle in tasks, kudos, shared goals or 1:1 notes.</p>;
  }

  const period = pack.window.start || pack.window.end
    ? `${pack.window.start ? formatDate(pack.window.start) : "the start"} to ${pack.window.end ? formatDate(pack.window.end) : "now"}`
    : "this review's period";

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-medium"><FileSearch className="h-4 w-4" /> From the record</p>
        {/* The window is stated because the pack is only honest with it: the same four lists over a different
            period are a different set of facts. */}
        <p className="text-xs text-muted-foreground">{period}. Nothing here is an assessment - it is what the app recorded.</p>
      </div>

      <Group icon={<CheckSquare className="h-3.5 w-3.5" />} title="Delivered" count={pack.cards.length}>
        {pack.cards.map((c) => (
          <li key={c.path}>
            <button type="button" className="text-left underline underline-offset-2" onClick={() => navigate(c.path)}>{c.key ? `${c.key} ` : ""}{c.title}</button>
            <span className="ml-1.5 text-xs text-muted-foreground">
              {c.board} · {formatDate(c.delivered)}{c.goal ? ` · ${c.goal.title}` : ""}
            </span>
          </li>
        ))}
      </Group>

      <Group icon={<Award className="h-3.5 w-3.5" />} title="Kudos received" count={pack.kudos.length}>
        {pack.kudos.map((k) => (
          <li key={k.path}>
            {/* Quoted, not counted. A number of kudos reads as a score; the sentence somebody wrote in March
                is the thing worth carrying into a review. */}
            <span>&ldquo;{k.body}&rdquo;</span>
            <span className="ml-1.5 text-xs text-muted-foreground">{k.from ? `${k.from} · ` : ""}{formatDate(k.at)}</span>
          </li>
        ))}
      </Group>

      <Group icon={<Users className="h-3.5 w-3.5" />} title="Contributed to" count={pack.contributions.length}>
        {pack.contributions.map((g) => (
          <li key={g.path}>
            <button type="button" className="text-left underline underline-offset-2" onClick={() => navigate(g.path)}>{g.title}</button>
            <span className="ml-1.5 text-xs text-muted-foreground">{g.share}% credited · {g.progress}%{g.note ? ` · ${g.note}` : ""}</span>
          </li>
        ))}
      </Group>

      <Group icon={<MessageSquare className="h-3.5 w-3.5" />} title="From 1:1 notes" count={pack.check_ins.length}>
        {pack.check_ins.map((ci) => (
          <li key={ci.path}>
            <button type="button" className="underline underline-offset-2" onClick={() => navigate(ci.path)}>{formatDate(ci.date)}</button>
            <span className="ml-1.5 text-xs text-muted-foreground">{ci.notes.length > 140 ? `${ci.notes.slice(0, 140)}…` : ci.notes}</span>
          </li>
        ))}
      </Group>

      {pack.truncated && <p className="text-xs text-muted-foreground">Showing the most recent of each. There is more on the pages themselves.</p>}

      {/* Straight into the writing box, as text to edit. The alternative is retyping what is already on
          screen, which is the work this panel exists to remove. */}
      {onUse && (pack.cards.length > 0 || pack.contributions.length > 0) && (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => onUse(seedTextOf(pack))}>
            Add the delivered work to my draft
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">Tasks and shared goals only. Kudos and 1:1 notes stay here: those are other people's words.</p>
        </div>
      )}
    </div>
  );
}

/** One section, absent when it has nothing - an empty heading reads as a thing that failed to load. */
function Group({ icon, title, count, children }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="space-y-1">
      <p className="flex items-center gap-1.5 text-sm font-medium">{icon} {title} <span className="font-normal text-muted-foreground">({count})</span></p>
      <ul className="space-y-0.5 text-sm">{children}</ul>
    </div>
  );
}

/** The delivered work as plain lines, for the draft instruction box. The author reads it, cuts what did not
 *  matter and adds what the record does not know, before anything is sent. */
function seedTextOf(pack: Evidence): string {
  const lines = [
    ...pack.cards.map((c) => `- ${c.title}${c.goal ? ` (towards ${c.goal.title})` : ""} - delivered ${c.delivered}`),
    ...pack.contributions.map((g) => `- ${g.title} - contributed ${g.share}% of it`),
  ];
  return `What I delivered this cycle:\n${lines.join("\n")}\n`;
}

type Evidence = {
  window: { start?: string; end?: string };
  cards: { path: string; key?: string; title: string; delivered: string; board: string; size?: number; goal?: { path: string; title: string } }[];
  kudos: { path: string; body: string; at: string; from?: string; category?: string; level?: string }[];
  contributions: { path: string; title: string; share: number; note?: string; progress: number; status: string }[];
  check_ins: { path: string; date: string; notes: string }[];
  truncated: boolean;
};
