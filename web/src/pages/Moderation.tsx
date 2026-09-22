import { useCallback, useEffect, useState } from "react";
import { EyeOff, ShieldCheck, ShieldAlert, Undo2 } from "lucide-react";
import { get, invoke } from "@/api";
import { navigate } from "@/router";
import { idOf } from "@/lib/utils";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
import { useToast } from "@/components/ui/use-toast";
import { AccessAction } from "@/components/access/AccessAction";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { FilterChips } from "@/components/common/FilterChips";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// Posts a safety model objected to, for somebody to decide about.
//
// NOTHING ON THIS PAGE HAPPENED AUTOMATICALLY EXCEPT THE FLAG. Every row is a post that is still on the wall,
// still visible to everyone who could see it before, waiting on a person. That is the design: a false
// positive that quietly ate somebody's kudos post would be a worse failure than a queue item that sits for an
// afternoon, so the model's only power is to put things here.
//
// GATED ON THE CAPABILITY, NOT ON THE AI SETTING, and the distinction matters. Switching the moderation
// feature off stops new posts being scanned; it does not resolve the flags already raised. A page that
// vanished with the setting would strand them - decided by nobody, on posts still on the wall - so the queue
// is reachable whenever somebody holds `moderation.read` and simply stops filling up.

type QueueItem = {
  host: string;
  collection: string;
  hazards: string[];
  hazard_labels: string[];
  excerpt: string;
  title: string;
  edited_since_flag: boolean;
  author: string | null;
  flagged_time: string;
  /** The gate withheld this one: it was written but never seen, and nobody was notified about it. The whole
   *  page reads differently for these - the question is "may this go up", not "should this come down". */
  held: boolean;
  visible: boolean;
  /** History only: what a person decided about this one. Null while it is still waiting. */
  decision: "hidden" | "released" | null;
  decided_time: string | null;
  decided_by: string | null;
};

/** The queue, or what has already been answered. A decided row carries no verdict buttons: the flag is
 *  answered, and what it offers instead is putting the post back. */
type View = "pending" | "decided";

/** How big each half is, whichever half is on screen. The two view chips show these, so a moderator looking
 *  at an empty queue can see there is a history worth opening without opening it. Counted server-side off
 *  the flags, because the list itself is capped at 100. */
type Counts = { pending: number; decided: number };

/** Where a post goes when it is put back: to its author's drafts, or onto the wall. */
type PutBack = "draft" | "publish";

const WALL_LABEL: Record<string, string> = {
  announcements: "Noticeboard",
  "announcement-replies": "Reply",
  suggestions: "Suggestion box",
};

export default function Moderation() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<QueueItem[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, decided: 0 });
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [wall, setWall] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<View>("pending");

  const load = useCallback(() => {
    setState("loading");
    get<{ results: QueueItem[]; has_more?: boolean; counts?: Counts }>(`moderation${view === "decided" ? "?state=decided" : ""}`)
      .then((r) => {
        setRows(r.results);
        setCounts(r.counts ?? { pending: 0, decided: 0 });
        setHasMore(r.has_more === true);
        setState("ready");
        setError(null);
      })
      .catch((e: unknown) => { setState("error"); setError(e instanceof Error ? e.message : String(e)); });
    // `view` is a dependency: switching to the history has to re-read, and an empty array here is what
    // would leave the page showing the queue's rows under the history's heading.
  }, [view]);

  useEffect(load, [load]);

  // ONE CALL FOR THE THREE WAYS BACK, because they are one verb - `:unhide` with a `mode` - and what
  // actually differs is what the person is agreeing to. So the dialog, the toast and the bookkeeping are
  // read off the row rather than baked into three handlers that would drift apart.
  //
  //  - A HELD post (still waiting, nobody has decided): it goes to its author as a draft and its flag closes.
  //    Only an announcement has a draft to go back to, which is why the button is absent on the other two.
  //  - A HIDDEN announcement, `draft`: back in its author's hands, flag closed - a draft is on no wall, so
  //    there is nothing left for a moderator to decide. "Waiting on a decision again" sent them looking for
  //    the row somewhere it cannot be.
  //  - A HIDDEN announcement, `publish`: on the wall as of now, and the flag records the takedown as
  //    overruled. The row STAYS in the history, re-badged, because the decision is still a decision.
  //  - A HIDDEN reply or suggestion: no draft state, so there is one place for it to go. It is back on the
  //    wall and its flag reopens, so it really is on the queue again.
  const putBack = async (row: QueueItem, mode: PutBack) => {
    const handBack = row.decision === null; // a held post: nobody decided anything, it goes back to be rewritten
    const toDraft = mode === "draft" && row.collection === "announcements";
    if (!(await confirmDecision(confirm, handBack ? "handBack" : mode === "publish" ? "unhidePublish" : "unhide", `"${row.title}"`))) return;
    setBusy(row.host);
    try {
      await invoke("moderation", "unhide", undefined, { host: row.host, mode });
      toast({
        title: handBack ? "Sent back to its author" : toDraft ? "Returned to its author as a draft" : "Put back on the wall",
        description: handBack || toDraft
          ? "It is off the queue: publishing it is what asks the question again."
          : mode === "publish"
            ? "Its audience can see it again."
            : "It is waiting on a decision again.",
        variant: "success",
      });
      // A published post keeps its place in the history under a new badge; everything else leaves the list
      // being looked at, because its flag is no longer in the half that produced it.
      setRows((rs) => (mode === "publish" && !handBack
        ? rs.map((r) => (r.host === row.host ? { ...r, decision: "released", visible: true } : r))
        : rs.filter((r) => r.host !== row.host)));
      setCounts((c) => ({
        // Only the hand-back takes something off the queue; a reply or suggestion put back from the history
        // goes ON to it, because its flag reopens for somebody to decide now that it is visible again.
        pending: c.pending + (handBack ? -1 : !toDraft && mode === "draft" ? 1 : 0),
        // The history loses a row for every flag that is retired rather than decided. `publish` retires
        // nothing - it records the reversal - and the hand-back was never in the history to begin with.
        decided: c.decided - (handBack || mode === "publish" ? 0 : 1),
      }));
    } catch (e) {
      toast({ title: "Couldn't put it back", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const decide = async (row: QueueItem, action: "hide" | "dismiss") => {
    // WHICH DECISION ASKS FOR CONFIRMATION FLIPS WITH `held`, because the consequential half does.
    //
    //  - Post on the wall: `hide` takes it down in public, `dismiss` changes nothing. Hiding asks.
    //  - Post being held: `dismiss` RELEASES it - puts it on the wall and tells the audience, which is the
    //    irreversible one here - while `hide` just leaves it where it already is. Releasing asks.
    //
    // A dialog in front of the harmless one is what trains people to click through the one that matters.
    const consequential = row.held ? "dismiss" : "hide";
    if (action === consequential) {
      const what = row.held ? "release" : "hide";
      if (!(await confirmDecision(confirm, what, `"${row.title}"`))) return;
    }
    setBusy(row.host);
    try {
      await invoke("moderation", "decide", undefined, { host: row.host, action });
      toast({
        title: row.held
          ? (action === "dismiss" ? "Post released" : "Post kept hidden")
          : (action === "hide" ? "Post hidden" : "Flag dismissed"),
        variant: "success",
      });
      setRows((rs) => rs.filter((r) => r.host !== row.host));
      // Every decision moves one flag from the queue to the history, whichever way it went.
      setCounts((c) => ({ pending: c.pending - 1, decided: c.decided + 1 }));
    } catch (e) {
      toast({ title: "Couldn't apply that", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const shown = wall ? rows.filter((r) => r.collection === wall) : rows;

  return (
    <div>
      <PageHeader
        eyebrow="Connect"
        accessCollection="moderation"
        title="Flagged posts"
        // The page can now hold two kinds of row and the difference matters more than anything else on it,
        // so the description says so rather than asserting the old one-liner ("nothing here is hidden"),
        // which is now false for every held post.
        description="Posts a safety check objected to. A HELD post was stopped before anyone saw it and is waiting on you to release it; anything else is still on the wall until you decide."
      />

      {/* OUTSIDE `DataState`, so the way back is there even when the list is empty or failed. The history
          is where somebody goes after deciding something - including to find a post they hid and now want
          back - and burying that switch inside the empty state would hide it exactly then.

          COUNTED, and the count on the half you are NOT looking at is the point of it: an empty queue said
          nothing about whether there was a history to open, so the only way to find out was to go and look.
          Server-side numbers, because the list stops at 100 while the chip is about the whole of it. */}
      <FilterChips
        className="mb-4"
        options={[
          { value: "pending", label: "Waiting on you", count: counts.pending },
          { value: "decided", label: "Already decided", count: counts.decided },
        ]}
        value={view}
        onChange={(v) => { setView(v as View); setWall(""); }}
      />

      <DataState state={state} error={error} onRetry={load}>
        {rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title={view === "decided" ? "Nothing decided yet" : "Nothing flagged"}
            description={view === "decided"
              ? "Posts you hide or release show up here, with who decided and when."
              : "No post on the noticeboard or the suggestion box is waiting on a decision."}
          />
        ) : (
          <>
            <FilterChips
              className="mb-4"
              options={[
                { value: "", label: "All", count: rows.length },
                ...Object.entries(WALL_LABEL).map(([key, label]) => ({
                  value: key,
                  label,
                  count: rows.filter((r) => r.collection === key).length,
                })),
              ]}
              value={wall}
              onChange={setWall}
            />

            <ul className="space-y-3">
              {shown.map((row) => (
                <li key={row.host} className="rounded-xl border bg-card p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <ShieldAlert className="h-4 w-4 text-warning" />
                    <span className="font-medium">{row.title}</span>
                    <Badge variant="secondary">{WALL_LABEL[row.collection] ?? row.collection}</Badge>
                    {/* The most important thing on the row, so it sits before the reasons: whether anybody
                        has seen this post. Everything else on the card reads differently depending on it. */}
                    {row.held && !row.decision && <Badge variant="outline" className="border-warning text-warning">Held - nobody has seen it</Badge>}
                    {row.decision === "hidden" && <Badge variant="outline">Hidden</Badge>}
                    {row.decision === "released" && <Badge variant="outline" className="border-success text-success">Released</Badge>}
                    {row.hazard_labels.map((h) => <Badge key={h} variant="outline">{h}</Badge>)}
                  </div>

                  <blockquote className="mb-2 whitespace-pre-wrap border-l-2 pl-3 text-sm text-muted-foreground">
                    {row.excerpt}
                  </blockquote>

                  <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {/* Anonymous posts arrive with no author and there is nothing to click through to. The
                        wall's promise is to the reader as much as the submitter, so a moderation queue is not
                        the place it gets quietly broken. */}
                    {row.author ? (
                      <button type="button" className="underline hover:text-foreground" onClick={() => navigate(`employees/${idOf(row.author!)}`)}>
                        View author
                      </button>
                    ) : (
                      <span>Posted anonymously</span>
                    )}
                    <span>Flagged {new Date(row.flagged_time).toLocaleString()}</span>
                    {row.decided_time && <span>Decided {new Date(row.decided_time).toLocaleString()}</span>}
                    {/* Only meaningful for a post that is UP: a held post is the same text nobody has read,
                        so "edited since" would be a warning about a discrepancy that cannot matter yet. */}
                    {row.edited_since_flag && !row.held && <span className="text-warning">Edited since it was flagged - the quote above is what the model read</span>}
                  </div>

                  {/* A decided row is a RECORD, so it carries no buttons: changing your mind is done on the
                      post itself (restore it where it lives), not by re-deciding a flag that is answered.
                      What it does say is where the post is now, because "hidden" on its own leaves a
                      moderator with nowhere to go. */}
                  {row.decision ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="text-xs text-muted-foreground">
                        {row.decision === "released"
                          ? "On the wall."
                          : "Off the wall, and off the board entirely - this is where it lives now."}
                      </p>
                      {/* ITS OWN GRANT, so the buttons are absent for a moderator who may decide but may not
                          reverse a decision - `AccessAction` reads the verb out of the caller's own rights
                          rather than this page deciding who is senior enough. Hide, never disable. */}
                      {row.decision === "hidden" && (
                        <AccessAction verb="unhide" collection="moderation" label="Put a hidden post back">
                          <div className="flex flex-wrap gap-2">
                            {/* TWO WAYS BACK FOR AN ANNOUNCEMENT, because the cautious one is not always the
                                right one: a draft costs its author a second publish, and an author on leave
                                or one who has left never performs it - so the post a moderator meant to
                                restore simply stays gone. A reply and a suggestion have no draft state, so
                                there is one button and it says where the post actually lands. */}
                            {row.collection === "announcements" && (
                              <Button size="sm" variant="outline" disabled={busy === row.host} onClick={() => void putBack(row, "draft")}>
                                <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                                Put it back as a draft
                              </Button>
                            )}
                            <Button size="sm" variant="outline" disabled={busy === row.host} onClick={() => void putBack(row, "publish")}>
                              <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                              Put it back on the wall
                            </Button>
                          </div>
                        </AccessAction>
                      )}
                    </div>
                  ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* One target for both buttons: deciding is a single verb, and offering separate grants
                        for "may dismiss" and "may hide" would invite a moderator who can only clear the
                        queue. */}
                    <AccessAction verb="decide" collection="moderation" label="Decide on a flagged post">
                      {/* THE SAME TWO VERBS, NAMED FOR WHAT THEY DO TO THIS POST. `dismiss` on a post that is
                          up leaves it up; on a held post it publishes it. Labelling both "Leave it up" would
                          be wrong on exactly the rows where being wrong puts something on the wall. The
                          primary button is the one that makes the post visible, because that is the decision
                          a held post is waiting on. */}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant={row.held ? "default" : "outline"}
                          disabled={busy === row.host}
                          onClick={() => void decide(row, "dismiss")}
                        >
                          {row.held ? "Release it" : "Leave it up"}
                        </Button>
                        <Button
                          size="sm"
                          variant={row.held ? "outline" : "destructive"}
                          disabled={busy === row.host}
                          onClick={() => void decide(row, "hide")}
                        >
                          <EyeOff className="mr-1.5 h-3.5 w-3.5" />
                          {row.held ? "Keep it hidden" : "Hide it"}
                        </Button>
                      </div>
                    </AccessAction>
                    {/* THE THIRD ANSWER TO A HELD POST, and the queue had no button for it: release it, keep
                        it buried, or hand it back. This is the one where the moderator will not be the person
                        who judges the text - the author gets it back as a draft and can rewrite it or drop
                        it. It is `unhide`'s grant, not `decide`'s, because nothing is being decided.
                        Announcements only: a reply and a suggestion have no draft to go back to. */}
                    {row.held && row.collection === "announcements" && (
                      <AccessAction verb="unhide" collection="moderation" label="Put a hidden post back">
                        <Button size="sm" variant="ghost" disabled={busy === row.host} onClick={() => void putBack(row, "draft")}>
                          <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                          Put it back as a draft
                        </Button>
                      </AccessAction>
                    )}
                  </div>
                  )}
                </li>
              ))}
            </ul>

            {shown.length === 0 && (
              <p className="mt-4 text-sm text-muted-foreground">Nothing flagged on that wall.</p>
            )}

            {/* Said out loud, because a page that quietly stops at 100 is one somebody clears and believes
                they have finished. Deciding a few makes room for the rest on the next read. */}
            {hasMore && (
              <p className="mt-4 text-sm text-muted-foreground">
                Showing the {rows.length} most recent. More are waiting - decide some of these and reload.
              </p>
            )}
          </>
        )}
      </DataState>
    </div>
  );
}
