import { useMemo } from "react";
import { Megaphone, Lightbulb, BarChart3, PartyPopper, MessageSquare, Reply } from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { AccessAction } from "@/components/access/AccessAction";
import { useSubjectCanRead } from "@/lib/perm";
import { navigate } from "@/router";
import { formatDate, idOf } from "@/lib/utils";
import type { Announcement, Department, Employee, Suggestion } from "@/types";
import { DataState } from "@/components/common/DataState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// What this person has put on the board and in the suggestion box, newest first.
//
// One list rather than two cards: from the reader's side "what has she posted" is a single question, and a
// board post and a suggestion are the same kind of thing to it - something this person wrote, in public, that
// other people responded to. The two reads stay separate (two collections, two grants), and either one being
// empty or unreadable just contributes nothing.
//
// BOTH READS ARE SERVER-FILTERED (`?author=` / `?submitter=`), not a client-side pass over a page of the
// collection: the board is a feed and the box is a feed, so whatever this person wrote is mostly NOT in the
// first hundred rows of either. Filtering here would have shown an arbitrary recent slice and called it their
// posts.
//
// The suggestion half is narrower than it looks, deliberately - see the anonymity guard in
// services/suggestions.ts. On somebody else's profile the server returns their SIGNED suggestions only; an
// anonymous one is not theirs to be attributed with, whoever is asking. On your own it returns everything,
// and the anonymous ones are badged so you can see which of them nobody else can trace to you.

type Row = {
  key: string;
  at: string;
  title: string;
  teaser?: string;
  route: string;
  icon: JSX.Element;
  kind: string;
  badges: { label: string; variant?: "secondary" | "outline" | "warning" | "success" }[];
  engagement?: string;
};

const ANNOUNCEMENT_ICON: Record<string, JSX.Element> = {
  poll: <BarChart3 className="h-4 w-4" />,
  kudos: <PartyPopper className="h-4 w-4" />,
};
const ANNOUNCEMENT_KIND: Record<string, string> = { post: "Post", poll: "Poll", kudos: "Kudos", announcement: "Announcement" };
const SUGGESTION_STATUS: Record<string, "secondary" | "outline" | "warning" | "success"> = {
  implemented: "success",
  planned: "secondary",
  under_review: "warning",
  declined: "outline",
};

export function EmployeePosts({ employeeId, isSelf }: { employeeId: string; isSelf: boolean }) {
  const employee = `employees/${employeeId}`;
  // `useCollection` gates each read on `<collection>.read` and answers empty+ready without a request when the
  // caller has no grant, so an org that hides the box from most people gets the board half and no denials.
  //
  // That gate is scope-BLIND, though - the capability string is stripped - so it cannot tell a caller who may
  // read this person's posts from one who may read only their own. The server's per-subject answer can, and it
  // is what decides whether each read FIRES: without it a colleague's profile spent a request to be told,
  // correctly, nothing. Same answer the Posts tab itself is gated on (pages/EmployeeProfile.tsx).
  const canPosts = useSubjectCanRead("announcements");
  const canIdeas = useSubjectCanRead("suggestions");
  const posts = useCollection<Announcement>("announcements", { enabled: canPosts, params: { author: employee } });
  const ideas = useCollection<Suggestion>("suggestions", { enabled: canIdeas, params: { submitter: employee } });
  // Posts they replied to. A separate read rather than a flag on the one above: they are different questions
  // ("what did she write" / "where did she join in"), and the server answers each with its own filter.
  const joined = useCollection<Announcement>("announcements", { enabled: canPosts, params: { replied_by: employee } });
  // Both profile pages already load these two with `all`, so the shared resource store answers from cache -
  // this is a lookup, not a third and fourth request.
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { rows: depts } = useCollection<Department>("departments", { all: true });

  const nameOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [employees]);
  const deptOf = useMemo(() => {
    const m = new Map(depts.map((d) => [idOf(d.path), d.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) : undefined);
  }, [depts]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const authored = new Set(posts.rows.map((a) => a.path));
    for (const a of posts.rows) {
      const kind = a.kind ?? "announcement";
      out.push({
        key: a.path,
        // What the board itself sorts by: a scheduled post belongs at the time it went live, not the time it
        // was drafted. A draft has neither, so it falls back to when it was written.
        at: a.publish_time ?? a.create_time,
        title: a.title?.trim() || ANNOUNCEMENT_KIND[kind] || "Untitled",
        teaser: a.body_text?.trim() || undefined,
        route: `announcements/${idOf(a.path)}/view`,
        icon: ANNOUNCEMENT_ICON[kind] ?? <Megaphone className="h-4 w-4" />,
        // Kudos is the one kind that is ABOUT somebody else, and a kudos card whose whole point is who was
        // recognised read as a bare "Kudos" here. The recipient is a ref on the row (a person or a whole
        // team), never part of the title, so it has to be resolved and said.
        kind: kind === "kudos" ? kudosLine(nameOf(a.recipient) ?? deptOf(a.recipient_department)) : ANNOUNCEMENT_KIND[kind] ?? "Post",
        // A draft is only ever in this list for someone who may see it (the server decides that, not this
        // card) - and when it is, saying so is the point: it is the difference between written and posted.
        badges: a.published === false ? [{ label: "Draft", variant: "warning" }] : [],
        engagement: reactionCount(a) > 0 ? `${reactionCount(a)} ${reactionCount(a) === 1 ? "reaction" : "reactions"}` : undefined,
      });
    }
    for (const s of ideas.rows) {
      const votes = (s.upvotes ?? 0) - (s.downvotes ?? 0);
      out.push({
        key: s.path,
        at: s.create_time,
        title: s.title?.trim() || "Untitled suggestion",
        route: `suggestions/${idOf(s.path)}/view`,
        icon: <Lightbulb className="h-4 w-4" />,
        kind: "Suggestion",
        badges: [
          ...(s.status ? [{ label: humanStatus(s.status), variant: SUGGESTION_STATUS[s.status] ?? ("outline" as const) }] : []),
          // Only ever reachable on your own profile (the server will not attribute an anonymous suggestion to
          // anybody else), and worth saying there: it is the row whose author nobody else can see.
          ...(s.anonymous ? [{ label: "Anonymous", variant: "outline" as const }] : []),
        ],
        engagement: votes !== 0 ? `${votes > 0 ? "+" : ""}${votes} net ${Math.abs(votes) === 1 ? "vote" : "votes"}` : undefined,
      });
    }
    for (const a of joined.rows) {
      // Their own post that they also replied to is already above, as the thing they wrote. Listing it twice
      // (and under the same key) says less than listing it once.
      if (authored.has(a.path)) continue;
      const theirs = (a.replies ?? []).filter((r) => r.author && idOf(r.author) === employeeId);
      if (theirs.length === 0) continue; // the thread is there but their reply is not visible to this reader
      const last = theirs[theirs.length - 1]!;
      out.push({
        key: `reply:${a.path}`,
        // When they joined in, not when the post went up - this row is about their reply.
        at: last.create_time ?? a.create_time,
        title: a.title?.trim() || "Untitled",
        teaser: last.body?.trim() || undefined,
        route: `announcements/${idOf(a.path)}/view`,
        icon: <Reply className="h-4 w-4" />,
        kind: theirs.length > 1 ? `${theirs.length} replies` : "Reply",
        badges: [],
      });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [posts.rows, ideas.rows, joined.rows, employeeId, nameOf, deptOf]);

  // Loading until BOTH have answered, and an error only when both failed - one readable collection is a
  // perfectly good Posts tab, and a grant the caller does not hold is not an error to put in front of them.
  //
  // Only the reads that were actually ENABLED count. A read held back by the scope gate above never fires, so
  // its snapshot sits at "loading" forever - folding it in here would leave the card skeleton-ing for a caller
  // whose answer is simply "nothing you may see", which is a settled empty.
  const reads = [...(canPosts ? [posts, joined] : []), ...(canIdeas ? [ideas] : [])];
  const state = reads.length === 0
    ? "ready"
    : reads.some((r) => r.state === "loading") ? "loading" : reads.every((r) => r.state === "error") ? "error" : "ready";

  return (
    // `sentry-mask` on the whole card: `suggestions` is MEMORY_ONLY (lib/resourceStore.ts), so its rows may
    // not be written to disk - and session replay ships them one hop further, to a third party with
    // retention. The board half is masked with it rather than separately: the two are interleaved in one
    // list, and a mask that has to follow alternating rows is one refactor from covering the wrong ones.
    <Card className="sentry-mask">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        {/* TWO KEYS, because this one card is two collections. The tab above carries `announcements` (the half
            that is public by grant), and the box is a separate grant with a separate answer - an admin who
            opened the tab's key to give somebody sight of a person's suggestions would have granted the board
            instead, and wondered why nothing changed. The second key has no child: in access mode it is the
            icon alone, and in normal use both render nothing. */}
        <CardTitle className="text-base">
          <span className="flex items-center gap-2">
            <AccessAction collection="announcements" label="Board posts">
              <span className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-primary" /> Posts</span>
            </AccessAction>
            <AccessAction collection="suggestions" label="Suggestion box" />
          </span>
        </CardTitle>
        {rows.length > 0 && <span className="text-xs text-muted-foreground">{rows.length} {rows.length === 1 ? "item" : "items"}</span>}
      </CardHeader>
      <CardContent>
        <DataState state={state} error={posts.error ?? ideas.error} rows={3} onRetry={() => { posts.reload(); ideas.reload(); joined.reload(); }}>
          {rows.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {isSelf ? "You haven't posted anything yet." : "Nothing posted yet."}
            </p>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.key}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 py-3 text-left hover:bg-muted/40"
                    onClick={() => navigate(r.route)}
                  >
                    <span className="mt-0.5 shrink-0 text-muted-foreground">{r.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">{r.title}</span>
                        {r.badges.map((b) => (
                          <Badge key={b.label} variant={b.variant ?? "outline"}>{b.label}</Badge>
                        ))}
                      </span>
                      {r.teaser && <span className="mt-0.5 line-clamp-2 block text-sm text-muted-foreground">{r.teaser}</span>}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {r.kind} · {formatDate(r.at)}{r.engagement ? ` · ${r.engagement}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      </CardContent>
    </Card>
  );
}

/** "Kudos to Asha Rao", or a bare "Kudos" when the recipient is gone or not readable by this viewer. */
function kudosLine(recipient?: string): string {
  return recipient ? `Kudos to ${recipient}` : "Kudos";
}

/** Every emoji on a post, added up - the one number that says "people responded to this". */
function reactionCount(a: Announcement): number {
  return (a.reactions ?? []).reduce((n, r) => n + (r.count ?? 0), 0);
}

function humanStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ");
}
