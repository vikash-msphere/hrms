import { useEffect, useMemo, useState } from "react";
import { Lightbulb, Plus, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ArrowLeft, Trash2, MessageSquare, EyeOff, Link2, Maximize2, Loader2 } from "lucide-react";
import { create, get, invoke, remove } from "@/api";
import { navigate, pagePath, recordUrl, setRouteRecord } from "@/router";
import { useCollection, type LoadState } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { formatDate, idOf, humanize, cn } from "@/lib/utils";
import type { Suggestion, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { useInfiniteScroll } from "@/hooks/useInfiniteScroll";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/common/confirm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { WriteDialog } from "@/components/common/WriteDialog";
import { useToast } from "@/components/ui/use-toast";

// How many suggestions the box reads at a time. The list grows by another page each time the reader reaches its
// foot (see useInfiniteScroll), so this is the cost of opening the page, not a cap on what can be read. Turn it
// up for fewer round trips, down for a cheaper cold open; the server caps a page at 100 either way.
const BOARD_PAGE_SIZE = 20;

const CATEGORIES = ["Workplace", "Process", "Culture", "Tools & IT", "Benefits", "Other"];
const STATUSES = ["new", "under_review", "planned", "implemented", "declined"];
const statusVariant: Record<string, "secondary" | "warning" | "success" | "muted" | "destructive"> = {
  new: "secondary", under_review: "warning", planned: "secondary", implemented: "success", declined: "muted",
};
const EMPTY = { title: "", body: "", category: "", anonymous: false };
// What each status means for the submitter, said in the respond dialog before it is sent.
const STATUS_EFFECT: Record<string, string> = {
  new: "Back to unreviewed - no outcome is claimed.",
  under_review: "Says somebody is looking at it, without promising an outcome.",
  planned: "Reads as a commitment: this is going to happen.",
  implemented: "Reads as done. Worth checking it actually shipped.",
  declined: "A no. The reason below is the whole answer the submitter gets, so write one.",
};

export default function Suggestions({ me, openId, solo }: { me: Me; openId?: string; solo?: boolean }) {
  void me;
  // `solo` is one suggestion on a page of its own (`#/suggestions/<id>/view`): the board list is not read
  // there at all - the single row is fetched by id below - so a popped-out suggestion costs one read.
  const { rows, setRows, state, error, reload, hasMore, loadMore } = useCollection<Suggestion>("suggestions", { enabled: !solo, max: BOARD_PAGE_SIZE });
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();
  const canSubmit = usePermission("suggestions.write");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState<"new" | "top">("new");
  const [respondFor, setRespondFor] = useState<Suggestion | null>(null);

  // ----- One suggestion, on a page of its own -----
  // A source swap, nothing else: the card and its handlers (votes, respond, remove) read and write through
  // `src`/`setSrc`, so pointing those at a one-row list renders the whole thing with no board behind it. It is
  // fetched by id rather than picked out of the board, since the board list is only its first page.
  const [soloRows, setSoloRows] = useState<Suggestion[]>([]);
  const [soloState, setSoloState] = useState<LoadState>("loading");
  const [soloError, setSoloError] = useState<string | undefined>(undefined);
  const [soloTick, setSoloTick] = useState(0);
  const soloId = solo ? openId ?? null : null;
  useEffect(() => {
    if (!soloId) return;
    let active = true;
    setSoloState("loading");
    setSoloError(undefined);
    get<Suggestion>(`suggestions/${soloId}`).then(
      (row) => { if (!active) return; setSoloRows([row]); setSoloState("ready"); },
      (e) => { if (!active) return; setSoloError((e as Error).message); setSoloState("error"); },
    );
    return () => { active = false; };
  }, [soloId, soloTick]);
  const src = solo ? soloRows : rows;
  const setSrc = solo ? setSoloRows : setRows;
  const viewState = solo ? soloState : state;
  const viewError = solo ? soloError : error;
  const viewReload = solo ? () => setSoloTick((t) => t + 1) : reload;

  // Opening the reply writes the suggestion's id into the hash, so the dialog is linkable and a pasted link
  // reopens it (useDeepOpen was already reading that route - nothing wrote it). A solo page's hash already IS
  // that suggestion, and clearing it would navigate off the page, so there the dialog leaves the route alone.
  const openRespond = (s: Suggestion) => { setRespondFor(s); if (!solo) setRouteRecord(idOf(s.path)); };
  const closeRespond = () => { setRespondFor(null); if (!solo) setRouteRecord(null); };
  // Solo mode is already showing the suggestion - there is no dialog to auto-open on arrival.
  useDeepOpen(solo ? undefined : openId, rows, setRespondFor);

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const empName = (p?: string) => { const e = emp(p); return e ? `${e.first_name} ${e.last_name}` : ""; };

  const shown = useMemo(() => {
    // The solo page shows the suggestion it was asked for - the board's status chip must not hide it.
    if (solo) return src;
    const list = src.filter((s) => !statusFilter || s.status === statusFilter);
    const score = (s: Suggestion) => s.upvotes - s.downvotes;
    return [...list].sort((a, b) => (sort === "top" ? score(b) - score(a) || +new Date(b.create_time ?? "") - +new Date(a.create_time ?? "") : +new Date(b.create_time ?? "") - +new Date(a.create_time ?? "")));
  }, [solo, src, statusFilter, sort]);

  // The box is an infinite list: reaching the foot of what is loaded pulls the next page. Under "Newest" that
  // matches the server's own page order, so a page lands strictly below what is on screen. Under "Top" the
  // ranking is a pass over the loaded rows, so an arriving page can slot in above the fold - the same window
  // the score ranking has always been computed from, now with more of the box in it.
  const { sentinelRef, loading: loadingMore } = useInfiniteScroll({ hasMore, loadMore, enabled: !solo });

  // What the respond dialog walks: everything still waiting for an answer, newest first, so a triage session is
  // one dialog and two keys instead of twelve trips through the board.
  const triageQueue = useMemo(
    () => rows.filter((s) => !s.merged_into && (s.status === "new" || s.status === "under_review") && (s.access?.can ?? []).includes("respond")),
    [rows],
  );

  // Duplicate guard: the closest existing suggestion by shared words in the title. Deliberately loose - the
  // point is to surface "somebody already asked for this", not to be a search engine.
  const similar = useMemo(() => {
    const words = form.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    if (!words.length) return null;
    let best: { s: Suggestion; score: number } | null = null;
    for (const s of rows) {
      const t = s.title.toLowerCase();
      const score = words.filter((w) => t.includes(w)).length;
      if (score >= Math.min(2, words.length) && (!best || score > best.score)) best = { s, score };
    }
    return best?.s ?? null;
  }, [rows, form.title]);

  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of rows) m.set(s.status, (m.get(s.status) ?? 0) + 1);
    return m;
  }, [rows]);

  // Throws to fail: WriteDialog pins the reason in the form rather than flashing a toast behind it.
  async function submit() {
    await create("suggestions", { title: form.title.trim(), body: form.body.trim(), category: form.category || null, anonymous: form.anonymous });
    toast({ title: "Suggestion submitted", variant: "success" });
    setForm(EMPTY);
    reload();
  }
  // The local mirror of the server's toggle: same direction clears the vote, the other direction switches it.
  const applyVote = (s: Suggestion, dir: 1 | -1): Suggestion => {
    const next = s.my_vote === dir ? 0 : dir;
    let { upvotes, downvotes } = s;
    if (s.my_vote === 1) upvotes--;
    if (s.my_vote === -1) downvotes--;
    if (next === 1) upvotes++;
    if (next === -1) downvotes++;
    return { ...s, my_vote: next as -1 | 0 | 1, upvotes, downvotes };
  };
  const [voting, setVoting] = useState<string | null>(null);
  async function vote(s: Suggestion, dir: 1 | -1) {
    if (voting) return; // one vote in flight at a time - rapid clicks would race the toggle
    setVoting(s.path);
    // Optimistic: the tally moves under the click; the server's reserialized row then reconciles it (or the
    // original row comes back on failure). No collection refetch either way (see resourceStore's verb map).
    setSrc((prev) => prev.map((r) => (r.path === s.path ? applyVote(r, dir) : r)));
    try {
      const updated = await invoke<Suggestion>(`suggestions/${idOf(s.path)}`, dir === 1 ? "upvote" : "downvote");
      setSrc((prev) => prev.map((r) => (r.path === s.path ? { ...r, ...updated } : r)));
    } catch (e) {
      setSrc((prev) => prev.map((r) => (r.path === s.path ? s : r)));
      toast({ title: "Couldn't vote", description: (e as Error).message, variant: "destructive" });
    } finally {
      setVoting(null);
    }
  }
  async function del(s: Suggestion) {
    if (!(await confirm({ title: "Remove this suggestion?", description: `"${s.title}" and its votes will be permanently removed.`, confirmLabel: "Remove", destructive: true }))) return;
    // Removing the suggestion a solo page IS leaves nothing to render, so that page goes back to the board.
    try { await remove(s.path, s.etag); toast({ title: "Suggestion removed", variant: "success" }); if (solo) navigate("suggestions"); else reload(); }
    catch (e) { toast({ title: "Couldn't remove", description: (e as Error).message, variant: "destructive" }); }
  }

  useIntent("new-suggestion", () => setOpen(true));

  const addBtn = canSubmit && <AccessAction collection="suggestions" create><Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New suggestion</Button></AccessAction>;

  return (
    <div>
      {/* A suggestion on its own page keeps none of the board's chrome - no status chips, no sort, no
          composer. What it owes the reader is the way back to the board it came from. */}
      {solo ? (
        <div className="mb-3">
          <Button variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={() => navigate("suggestions")}>
            <ArrowLeft className="h-4 w-4" /> Back to the suggestion box
          </Button>
        </div>
      ) : (
        <PageHeader title="Suggestion Box" description="Share ideas to improve how we work." actions={addBtn} />
      )}

      {!solo && (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {["", ...STATUSES].map((st) => {
            const count = st ? statusCounts.get(st) ?? 0 : rows.length;
            return (
              <button
                key={st || "all"}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  statusFilter === st ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {st ? humanize(st) : "All"} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto inline-flex rounded-md border bg-background p-0.5">
          {(["new", "top"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSort(s)} className={`rounded px-3 py-1 text-sm transition-colors ${sort === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{s === "top" ? "Most upvoted" : "Newest"}</button>
          ))}
        </div>
      </div>
      )}

      <DataState state={viewState} error={viewError} onRetry={viewReload}>
        <>
        {shown.length === 0 ? (
          solo ? (
            <EmptyState icon={Lightbulb} title="This suggestion isn't here any more" description="It may have been removed." action={<Button variant="outline" onClick={() => navigate("suggestions")}><ArrowLeft className="h-4 w-4" /> Back to the suggestion box</Button>} />
          ) : rows.length > 0 ? (
            <EmptyState icon={Lightbulb} title={`No ${humanize(statusFilter).toLowerCase()} suggestions`} description="Try another status filter." action={<Button variant="outline" onClick={() => setStatusFilter("")}>Show all</Button>} />
          ) : (
            <EmptyState illustration="feedback" icon={Lightbulb} title="No suggestions yet" description="Have an idea to improve things? Be the first to share it." action={addBtn} />
          )
        ) : (
          <div className="space-y-3">
            {shown.map((s) => {
              const can = s.access?.can ?? [];
              const e = emp(s.submitter);
              return (
                <AccessItem key={s.path} collection="suggestions" objectPath={s.path} can={s.access?.can} why={s.access?.why} label="Suggestion">
                <Card className="flex gap-3 p-4">
                  {s.own ? (
                    // No vote arrows on your own suggestion - the server rejects self-votes.
                    <div className="flex h-fit flex-col items-center gap-0.5 rounded-md border px-2.5 py-1.5" title="You can't vote on your own suggestion">
                      <span className="text-sm font-semibold tabular-nums">{s.upvotes - s.downvotes}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Yours</span>
                    </div>
                  ) : (
                    <div className="flex h-fit flex-col items-center rounded-md border px-2.5 py-1.5">
                      <button type="button" disabled={voting === s.path} onClick={() => vote(s, 1)} className={`rounded transition-colors disabled:opacity-50 ${s.my_vote === 1 ? "text-primary" : "text-muted-foreground hover:text-foreground"}`} title="Upvote">
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <span className="text-sm font-semibold tabular-nums">{s.upvotes - s.downvotes}</span>
                      <button type="button" disabled={voting === s.path} onClick={() => vote(s, -1)} className={`rounded transition-colors disabled:opacity-50 ${s.my_vote === -1 ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`} title="Downvote">
                        <ChevronDown className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("font-medium", s.merged_into && "text-muted-foreground")}>{s.title}</span>
                      {/* A merged row says so instead of looking like a suggestion that quietly lost: its votes
                          live on the one it was folded into. */}
                      {s.merged_into
                        ? <Badge variant="muted">Merged</Badge>
                        : <Badge variant={statusVariant[s.status]}>{humanize(s.status)}</Badge>}
                      {s.category && <Badge variant="outline">{s.category}</Badge>}
                    </div>
                    {s.merged_into && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Folded into{" "}
                        <button
                          type="button"
                          className="font-medium text-primary hover:underline"
                          // On the board the target is a row already loaded, so the reply opens over it. A solo
                          // page has no board to open it on - it goes to that suggestion's own page instead.
                          onClick={() => {
                            if (solo) { navigate(`suggestions/${idOf(s.merged_into!)}/view`); return; }
                            const t = rows.find((x) => idOf(x.path) === idOf(s.merged_into!));
                            if (t) openRespond(t);
                          }}
                        >
                          {rows.find((x) => idOf(x.path) === idOf(s.merged_into!))?.title ?? "another suggestion"}
                        </button>
                        , which carries the votes.
                      </p>
                    )}
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{s.body}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {s.anonymous ? <span className="inline-flex items-center gap-1"><EyeOff className="h-3.5 w-3.5" /> Anonymous{s.own ? " (you)" : ""}</span>
                        : <span className="inline-flex items-center gap-1"><PhotoAvatar employeeId={s.submitter ? idOf(s.submitter) : ""} name={empName(s.submitter)} photo={e?.photo} className="h-5 w-5" /> {empName(s.submitter)}</span>}
                      <span>· {formatDate(s.create_time ?? "")}</span>
                    </div>
                    {s.response && (
                      <div className="mt-2 rounded-md border bg-muted/40 p-2 text-sm">
                        <p className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><MessageSquare className="h-3.5 w-3.5" /> Response from HR</p>
                        {s.response}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      {can.includes("respond") && <AccessAction verb="respond" can={can} label="Respond to suggestion"><Button size="sm" variant="outline" onClick={() => openRespond(s)}><MessageSquare className="h-3.5 w-3.5" /> Respond</Button></AccessAction>}
                      {can.includes("delete") && <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => del(s)}><Trash2 className="h-3.5 w-3.5" /> Remove</Button>}
                      {/* Pop this one out onto a page of its own: the suggestion, its votes and the response,
                          with no board behind it. Same tab - the back button returns to the board. Not
                          offered on that page - it IS that page. */}
                      {!solo && (
                        <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" title="Open this suggestion in its own page" aria-label="Open in its own page" onClick={() => navigate(pagePath("suggestions", idOf(s.path)))}>
                          <Maximize2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </Card>
                </AccessItem>
              );
            })}
          </div>
        )}
        {/* Foot of the list: more suggestions live past the cursor, and crossing this marker fetches them. The
            button behind it is the manual way through, and the whole affordance if the observer never fires.
            Rendered outside the empty branch too, so a status filter that matches nothing on the page loaded so
            far can still page its way to rows that do match. */}
        {!solo && hasMore && (
          <div ref={sentinelRef} className="pt-3 text-center">
            {loadingMore ? (
              <p className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading more suggestions…
              </p>
            ) : (
              <Button variant="outline" size="sm" onClick={() => loadMore()}>Load more suggestions</Button>
            )}
          </div>
        )}
        </>
      </DataState>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="New suggestion"
        description="Goes on the board for everyone who can see it, and they can vote on it. HR replies in the open."
        collection="suggestions"
        guardLabel="suggestion"
        form={form}
        draftKey="suggestion:new"
        applyDraft={(d) => setForm(d)}
        onStartOver={() => setForm(EMPTY)}
        submitLabel="Submit"
        canSubmit={!!form.title.trim() && !!form.body.trim()}
        whyNot={!form.title.trim() ? "Give the idea a one-line title." : "Say what you're suggesting."}
        onSubmit={submit}
        submitAccess={(b) => <AccessAction collection="suggestions" create label="New suggestion">{b}</AccessAction>}
      >
          <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="A short summary of your idea" autoFocus /></Field>
          {/* Somebody has asked for this already. Pointing at it beats a second thread nobody can vote on
              together - and it's a nudge, never a block. */}
          {similar && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              A similar suggestion is already on the board: “{similar.title}” ({humanize(similar.status).toLowerCase()},
              {" "}{similar.upvotes - similar.downvotes} net {Math.abs(similar.upvotes - similar.downvotes) === 1 ? "vote" : "votes"}).{" "}
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => { setOpen(false); setStatusFilter(""); }}>
                Find it on the board
              </button>
            </p>
          )}
          <Field label="Category" hint="Optional.">
            <Select value={form.category || "none"} onValueChange={(v) => setForm({ ...form, category: v === "none" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="Pick a category…" /></SelectTrigger>
              <SelectContent><SelectItem value="none">None</SelectItem>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Details"><Textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Describe your suggestion…" /></Field>
          <div className="rounded-lg border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={form.anonymous} onCheckedChange={(v) => setForm({ ...form, anonymous: v === true })} />
              <span className="inline-flex items-center gap-1"><EyeOff className="h-4 w-4" /> Submit anonymously</span>
            </label>
            {/* Anonymity is the one decision here that can't be taken back, so it says what it costs. */}
            <p className="mt-1 text-xs text-muted-foreground">
              {form.anonymous
                ? "Nobody sees your name on it, including HR - so they can't come back to you for detail. You can still see it's yours."
                : "Your name is on it, and HR can follow up with you directly."}
            </p>
          </div>
      </WriteDialog>

      {respondFor && (
        <RespondDialog
          suggestion={respondFor}
          queue={triageQueue}
          onStep={openRespond}
          mergeTargets={rows.filter((x) => x.path !== respondFor.path && !x.merged_into)}
          onClose={closeRespond}
          onDone={() => { closeRespond(); toast({ title: "Response saved", variant: "success" }); reload(); }}
        />
      )}
    </div>
  );
}

// HR's reply: the status the board will show, and the words the submitter reads. Both land in one invoke, and
// the status line says what each one claims before it is sent.
function RespondDialog({ suggestion: s, queue, onStep, mergeTargets, onClose, onDone }: {
  suggestion: Suggestion;
  /** Everything awaiting a response, in board order - what ‹ › and j/k walk. */
  queue: Suggestion[];
  onStep: (s: Suggestion) => void;
  /** Open suggestions this one could be folded into (never itself, never an already-merged one). */
  mergeTargets: Suggestion[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState({ status: s.status, response: s.response ?? "", merge: "" });
  const { toast } = useToast();
  const merging = !!form.merge;
  async function save() {
    // Merging IS the response: the target absorbs the votes and this row closes pointing at it, so sending a
    // status alongside would be two answers to one question.
    if (merging) {
      await invoke(`suggestions/${idOf(s.path)}`, "merge", undefined, { into: form.merge });
      onDone();
      return;
    }
    await invoke(`suggestions/${idOf(s.path)}`, "respond", undefined, { status: form.status, response: form.response.trim() || null });
    onDone();
  }
  const declining = form.status === "declined";
  const net = s.upvotes - s.downvotes;
  const dirty = form.status !== s.status || form.response !== (s.response ?? "") || merging;

  // Triage is a queue, not twelve dialogs: HR opens the oldest unanswered suggestion and walks the rest.
  const qIndex = queue.findIndex((x) => x.path === s.path);
  const canStep = (d: number) => qIndex >= 0 && !!queue[qIndex + d] && !dirty;
  const step = (d: number) => { const next = queue[qIndex + d]; if (next) onStep(next); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (e.key === "j" && canStep(1)) { e.preventDefault(); step(1); }
      if (e.key === "k" && canStep(-1)) { e.preventDefault(); step(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Re-bound each render: it closes over the queue position and the dirty flag.
  });
  const target = mergeTargets.find((t) => t.path === form.merge);
  return (
    <WriteDialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2 pr-8">
          <span>Respond to suggestion</span>
          {queue.length > 1 && qIndex >= 0 && (
            <span className="ml-auto flex items-center gap-0.5 text-xs font-normal text-muted-foreground">
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(-1)} onClick={() => step(-1)} aria-label="Previous suggestion" title={dirty ? "Save or discard your reply first" : "Previous (k)"}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="tabular-nums">{qIndex + 1}/{queue.length}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canStep(1)} onClick={() => step(1)} aria-label="Next suggestion" title={dirty ? "Save or discard your reply first" : "Next (j)"}><ChevronRight className="h-4 w-4" /></Button>
            </span>
          )}
        </span>
      }
      description={merging
        ? "Merging closes this one and moves its votes to the suggestion you pick, so support for the idea adds up in one place."
        : s.anonymous
          ? "Submitted anonymously, so the reply is the only answer they get - there is nobody to follow up with."
          : "The submitter is notified, and everyone who can see the suggestion sees the reply."}
      collection="suggestions"
      objectPath={s.path}
      guardLabel="response"
      form={form}
      submitLabel={merging ? "Merge" : "Save response"}
      canSubmit={merging || !declining || !!form.response.trim()}
      whyNot="Declining without a reason leaves the submitter nothing to read. Write one line."
      onSubmit={save}
      submitAccess={(b) => (merging
        ? <AccessAction verb="merge" objectPath={s.path} can={s.access?.can} label="Merge suggestion">{b}</AccessAction>
        : <AccessAction verb="respond" objectPath={s.path} can={s.access?.can} label="Respond to suggestion">{b}</AccessAction>)}
      footerStart={
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          title="Copy a link to this suggestion"
          onClick={() => navigator.clipboard.writeText(recordUrl("suggestions", idOf(s.path))).then(
            () => toast({ title: "Link copied", description: "Anyone who can see the board can open it." }),
            () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
          )}
        >
          <Link2 className="h-3.5 w-3.5" /> Copy link
        </button>
      }
    >
      <div className="rounded-lg border bg-muted/40 p-3">
        <p className="text-sm font-medium">{s.title}</p>
        <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{s.body}</p>
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {net} net {Math.abs(net) === 1 ? "vote" : "votes"} · {s.upvotes} up · {s.downvotes} down
        </p>
      </div>
      {/* The same idea asked twice reads as two unpopular ideas. Folding one into the other moves its votes, so
          the fifteen people who wanted it show up as fifteen on one row. */}
      {mergeTargets.length > 0 && !s.merged_into && (
        <Field label="Duplicate of" hint={merging ? undefined : "Leave empty unless this is the same idea as another one."}>
          <Combobox
            value={form.merge}
            onValueChange={(v) => setForm({ ...form, merge: v === form.merge ? "" : v })}
            placeholder="Not a duplicate"
            searchPlaceholder="Search suggestions…"
            options={mergeTargets.map((t) => ({ value: t.path, label: `${t.title} (${t.upvotes - t.downvotes > 0 ? "+" : ""}${t.upvotes - t.downvotes})` }))}
          />
          {target && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {s.upvotes + s.downvotes === 0
                ? `This one has no votes to move. It closes pointing at “${target.title}”.`
                : `Its ${s.upvotes + s.downvotes} vote${s.upvotes + s.downvotes === 1 ? "" : "s"} move to “${target.title}”, except from anyone who already voted there. The submitter is told where their idea went.`}
            </p>
          )}
        </Field>
      )}
      {s.merged_into && (
        <p className="text-xs text-muted-foreground">Already merged into another suggestion, so its votes have moved on.</p>
      )}
      {!merging && (
        <>
          <Field label="Status" hint={STATUS_EFFECT[form.status]}>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v as Suggestion["status"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{STATUSES.map((x) => <SelectItem key={x} value={x}>{humanize(x)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Public response" field="response" hint="Shown to everyone who can see the suggestion.">
            <Textarea rows={3} value={form.response} onChange={(e) => setForm({ ...form, response: e.target.value })} placeholder={declining ? "Why not, in a sentence." : "Optional reply…"} autoFocus />
          </Field>
        </>
      )}
      <ActivitySection resource={s.path} className="border-t pt-3" />
    </WriteDialog>
  );
}
