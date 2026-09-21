import { useCallback, useEffect, useState } from "react";
import { EyeOff, ShieldCheck, ShieldAlert } from "lucide-react";
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
};

const WALL_LABEL: Record<string, string> = {
  announcements: "Noticeboard",
  "announcement-replies": "Reply",
  suggestions: "Suggestion box",
};

export default function Moderation() {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<QueueItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [wall, setWall] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setState("loading");
    get<{ results: QueueItem[]; has_more?: boolean }>("moderation")
      .then((r) => { setRows(r.results); setHasMore(r.has_more === true); setState("ready"); setError(null); })
      .catch((e: unknown) => { setState("error"); setError(e instanceof Error ? e.message : String(e)); });
  }, []);

  useEffect(load, [load]);

  const decide = async (row: QueueItem, action: "hide" | "dismiss") => {
    // Only hiding asks. Dismissing leaves the post exactly where it is and can be undone by the next scan, so
    // a dialog in front of it would train people to click through the one that matters.
    if (action === "hide" && !(await confirmDecision(confirm, "hide", `"${row.title}"`))) return;
    setBusy(row.host);
    try {
      await invoke("moderation", "decide", undefined, { host: row.host, action });
      toast({ title: action === "hide" ? "Post hidden" : "Flag dismissed", variant: "success" });
      setRows((rs) => rs.filter((r) => r.host !== row.host));
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
        description="Public posts a safety model objected to. Nothing here has been hidden - each one is still on the wall until you decide."
      />

      <DataState state={state} error={error} onRetry={load}>
        {rows.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="Nothing flagged"
            description="No post on the noticeboard or the suggestion box is waiting on a decision."
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
                    {row.edited_since_flag && <span className="text-warning">Edited since it was flagged - the quote above is what the model read</span>}
                  </div>

                  {/* One target for both buttons: deciding is a single verb, and offering separate grants for
                      "may dismiss" and "may hide" would invite a moderator who can only clear the queue. */}
                  <AccessAction verb="decide" collection="moderation" label="Decide on a flagged post">
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" disabled={busy === row.host} onClick={() => void decide(row, "dismiss")}>
                        Leave it up
                      </Button>
                      <Button size="sm" variant="destructive" disabled={busy === row.host} onClick={() => void decide(row, "hide")}>
                        <EyeOff className="mr-1.5 h-3.5 w-3.5" />
                        Hide it
                      </Button>
                    </div>
                  </AccessAction>
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
