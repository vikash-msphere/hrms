import * as React from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, Pencil, ShieldCheck, Lock, Search, Users } from "lucide-react";
import { invoke } from "@/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetBody, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { CopyEmail } from "@/components/common/CopyEmail";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { useMedia } from "@/hooks/useMedia";
import { cn } from "@/lib/utils";

// "Who can see my record?" - the effective-access report, aimed at the person the record is about.
//
// Every other access surface in the app answers the ADMIN's question. This one answers the employee's, which
// is the question people actually have about an HR system: who reads my bank details. The engine has always
// known; nothing let you ask it about yourself. Lazily loaded behind an explicit press - it grades the whole
// roster against every area of your data, so it is not something to run on every profile open.
//
// PICK AN AREA ON THE LEFT, READ ITS PEOPLE ON THE RIGHT. This was a column of accordion cards, and the shape
// was wrong twice over: every row ran the full width to hold a label and a badge, so half the tab was empty
// at all times, and opening one pushed everything below it down the page - comparing two areas meant opening
// both and scrolling between them. A master list against a fixed detail pane fixes both. The list is dense
// enough to take in at a glance (label, an exposure meter, a count - the hint moved to the detail, where
// there is room for it), the pane holds the names, and moving between areas swaps the right-hand side while
// the left stays put.
//
// Below `lg` there is no second column to put anything in, so the detail becomes a sheet. Same component
// either way - the pane is one function, mounted in the grid cell or in the sheet body.
//
// ONE AXIS, AND IT IS THE DATA. Every row here is an area of yours, and the names against it are who reaches
// THAT. There was briefly a second lens that pivoted the same verdicts the other way - one row per colleague,
// expanded to every area of yours they reach - and it was wrong: rolled up per person it stops being a fact
// about your data and becomes a profile of that colleague's reach, which every employee could then page
// through to map who is powerful. The headline counts are fine (they say how exposed YOU are, and name
// nobody); a per-person breakdown is not, and must not come back.
//
// NOTHING ABOUT THE READER BUT THEIR NAME, which is the server's doing as much as this file's. There is no
// role in the payload (services/myViewers.ts), and the only reason it sends is the one that describes the
// CALLER'S OWN record - "shared with them specifically". A reason drawn from how far the reader's access runs
// (their department, their branch of the org, the whole company) is left off entirely: on a page every
// employee can open, those sentences add up to a survey of who is powerful.

const WIDE = "(min-width: 1024px)";

type Viewer = { name: string | null; email: string; write: boolean; why?: string; photo?: string };
type Area = { key: string; group: string; label: string; hint: string; records?: number; viewers: Viewer[] };
type Group = { key: string; label: string; hint: string };
type Report = { groups: Group[]; areas: Area[]; roster: number; complete: boolean };

/** How many DISTINCT people the predicate holds for - a headline number, never a list. */
const countPeople = (areas: Area[], keep: (v: Viewer) => boolean) =>
  new Set(areas.flatMap((a) => a.viewers.filter(keep).map((v) => v.email))).size;

export function MyViewers({ selfPath }: { selfPath: string }) {
  const [data, setData] = React.useState<Report | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [picked, setPicked] = React.useState<string | null>(null);
  // Which SECTIONS are unfolded. Rows no longer fold at all - a row's detail has somewhere else to be - so
  // this is the whole of the page's fold state, and "collapse all" is one assignment over it.
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(new Set());
  const wide = useMedia(WIDE);
  const rows = React.useRef<Record<string, HTMLButtonElement | null>>({});

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const report = await invoke<Report>(selfPath, "viewers");
      setData(report);
      setOpenGroups(new Set(report.groups.map((g) => g.key)));
      setPicked(null);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const toggleGroup = (key: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const needle = q.trim().toLowerCase();
  const allAreas = data?.areas ?? [];
  const shownAreas = needle ? allAreas.filter((a) => `${a.label} ${a.hint}`.toLowerCase().includes(needle)) : allAreas;
  const privateAreas = allAreas.filter((a) => a.viewers.length === 0).length;
  const groups = data?.groups ?? [];
  const allOpen = groups.length > 0 && groups.every((g) => openGroups.has(g.key));

  // The rows arrow keys move through: what is on screen, in the order it is on screen, skipping folded
  // sections - so keyboard travel matches what the eye is doing rather than the underlying catalogue.
  const walkable = groups.filter((g) => openGroups.has(g.key)).flatMap((g) => shownAreas.filter((a) => a.group === g.key));

  // WIDE ALWAYS HAS A DETAIL, narrow only has one once something is picked. Derived rather than stored: with a
  // default held in state, every filter change would have to remember to move it, and closing the sheet on a
  // phone would leave the desktop layout blank on the next resize.
  const active = picked ? allAreas.find((a) => a.key === picked) : undefined;
  const detail = active ?? (wide ? walkable[0] : undefined);

  function onListKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (walkable.length === 0) return;
    e.preventDefault();
    const at = walkable.findIndex((a) => a.key === detail?.key);
    const next = walkable[Math.min(walkable.length - 1, Math.max(0, (at < 0 ? 0 : at) + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!next) return;
    setPicked(next.key);
    rows.current[next.key]?.focus();
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4 text-primary" /> Who can see your data</p>
            <p className="text-xs text-muted-foreground">
              Every colleague who can currently read something of yours, area by area. Worked out by the same
              engine that decides every request - not a guess.
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0" disabled={busy} onClick={() => load()}>
            <Eye className="h-4 w-4" /> {busy ? "Checking…" : data ? "Refresh" : "Check"}
          </Button>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {busy && !data && (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
          </div>
        )}

        {data && (
          <>
            {/* The three numbers worth reading before any list: how exposed you are, what stayed private, and
                how much of that is people who can change things rather than only look. Counts, deliberately -
                naming who is behind each one is what the detail pane does, in the context that explains it. */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Summary icon={Users} value={countPeople(allAreas, () => true)} label="people can see something of yours" />
              <Summary icon={Lock} value={privateAreas} label="areas only you can see" />
              <Summary icon={Pencil} value={countPeople(allAreas, (v) => v.write)} label="of them can also make changes" />
            </div>

            {!data.complete && (
              // Under-reporting who can see somebody's bank details would be worse than not answering, so the
              // sample says so out loud rather than reading as a complete list.
              <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                Your organisation is larger than one page, so this covers the first {data.roster} people rather
                than everyone.
              </p>
            )}

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[9rem] flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an area" className="h-8 pl-8 text-xs" />
                  </div>
                  {groups.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setOpenGroups(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground coarse:h-9 coarse:px-2.5"
                    >
                      {allOpen ? <ChevronsDownUp className="h-3 w-3" /> : <ChevronsUpDown className="h-3 w-3" />}
                      {allOpen ? "Collapse all" : "Expand all"}
                    </button>
                  )}
                </div>

                {/* A plain group, not a `listbox`: the section headers between the rows are interactive
                    elements a listbox may not contain, and the rows are buttons that stay reachable by Tab.
                    Up/Down move between them as a convenience on top of that, not instead of it. */}
                <div role="group" aria-label="Areas of your data" onKeyDown={onListKey} className="space-y-3">
                  {groups.map((g) => {
                    const inGroup = shownAreas.filter((a) => a.group === g.key);
                    if (inGroup.length === 0) return null;
                    const groupOpen = openGroups.has(g.key);
                    const seen = inGroup.filter((a) => a.viewers.length > 0).length;
                    return (
                      <div key={g.key}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(g.key)}
                          aria-expanded={groupOpen}
                          className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/30 coarse:min-h-[44px]"
                        >
                          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", groupOpen && "rotate-90")} />
                          <span className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</span>
                          {/* Folded, a section still says how much of it somebody else can see - a heading you
                              must open just to read is worse than one that never folded. */}
                          <span className="shrink-0 text-[11px] text-muted-foreground/80">
                            {seen === 0 ? "private" : `${seen}/${inGroup.length}`}
                          </span>
                        </button>
                        {groupOpen && (
                          <div className="mt-1 space-y-0.5">
                            {inGroup.map((a) => (
                              <AreaRow
                                key={a.key}
                                ref={(el) => { rows.current[a.key] = el; }}
                                area={a}
                                selected={detail?.key === a.key}
                                onSelect={() => setPicked(a.key)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {shownAreas.length === 0 && (
                    <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">No area matches that.</p>
                  )}
                </div>
              </div>

              {/* The pane sticks while the list scrolls: on a long list the names you just asked for should
                  not be the thing that scrolls away. Hidden below `lg`, where the sheet takes over. */}
              <div className="hidden lg:block">
                <div className="sticky top-4 rounded-xl border bg-card/40 p-4">
                  {detail ? <AreaDetail area={detail} /> : <p className="text-xs text-muted-foreground">Pick an area to see who can read it.</p>}
                </div>
              </div>
            </div>

            <Sheet open={!wide && !!active} onOpenChange={(o) => !o && setPicked(null)}>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>{active?.label}</SheetTitle>
                  <SheetDescription>{active?.hint}</SheetDescription>
                </SheetHeader>
                <SheetBody>{active && <AreaDetail area={active} heading={false} />}</SheetBody>
              </SheetContent>
            </Sheet>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One area in the master list: label, then how many can only look and how many can change it.
 *
 * TWO COUNTS, AND THEY DO NOT OVERLAP. The eye is people who can read this and nothing more; the pencil is
 * people who can change it. Spelling the eye as "everyone who can read, editors included" would be the same
 * two numbers silently sharing members - a row reading `5 / 2` that means five, not seven. Disjoint, they
 * add up, and they are the SAME two buckets the detail pane sorts each person into (every name there carries
 * one icon or the other), so the row is a tally of the list it opens rather than a second opinion about it.
 *
 * The counts sit in a fixed-width block and the pencil slot keeps its space when it is empty, so the numbers
 * line up in columns down the whole list - which is most of the reason for putting numbers in a list at all.
 * An area nobody else reaches shows a lock instead of a pair of zeroes: private is a state, not a quantity.
 */
const AreaRow = React.forwardRef<HTMLButtonElement, { area: Area; selected: boolean; onSelect: () => void }>(
  function AreaRow({ area, selected, onSelect }, ref) {
    const { viewOnly, editors } = split(area);
    return (
      <button
        ref={ref}
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          // `coarse:` grows the TARGET, not the design: the row stays 36px dense under a cursor and clears
          // the 44px floor under a finger (docs/06-responsive-ui.md rule 1).
          "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors coarse:min-h-[44px]",
          selected ? "border-primary/50 bg-accent/50" : "border-transparent hover:border-border hover:bg-accent/30",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-sm">{area.label}</span>
        <span className="flex w-[4.25rem] shrink-0 items-center justify-end gap-2.5 text-[11px] tabular-nums text-muted-foreground">
          {viewOnly + editors === 0 ? (
            <span title="only you">
              <Lock className="h-3 w-3" aria-hidden />
              <span className="sr-only">only you</span>
            </span>
          ) : (
            <>
              <Tally icon={Eye} n={viewOnly} label="can only look" />
              <Tally icon={Pencil} n={editors} label="can change it" accent />
            </>
          )}
        </span>
      </button>
    );
  },
);

/** People who can only look, and people who can change it - one bucket each, never both. */
const split = (area: Area) => {
  const editors = area.viewers.filter((v) => v.write).length;
  return { viewOnly: area.viewers.length - editors, editors };
};

/**
 * One icon-and-number in a row's tally.
 *
 * An empty bucket keeps its box and loses its ink (`invisible`), rather than not rendering: a disappearing
 * slot shifts the neighbouring number into its place, and a column of numbers that do not line up is no
 * easier to read than no column at all.
 */
function Tally({ icon: Icon, n, label, accent }: { icon: typeof Eye; n: number; label: string; accent?: boolean }) {
  return (
    // The tooltip and the screen-reader name go on the SPAN, not the icon: an `aria-label` on an <svg> is not
    // reliably announced, and a <title> child of one is a tooltip a mouse can find but nothing else.
    <span className={cn("inline-flex items-center gap-1", n === 0 && "invisible")} aria-hidden={n === 0} title={`${n} ${label}`}>
      <Icon className={cn("h-3 w-3", accent && "text-primary")} aria-hidden />
      {n}
      <span className="sr-only"> {label}</span>
    </span>
  );
}

/** The detail pane: what the area is, how much of it there is, and exactly who reaches it. */
function AreaDetail({ area, heading = true }: { area: Area; heading?: boolean }) {
  const readers = area.viewers.length;
  const { viewOnly, editors } = split(area);
  return (
    <div className="space-y-3">
      {heading && (
        <div>
          <p className="text-sm font-semibold">{area.label}</p>
          <p className="text-xs text-muted-foreground">{area.hint}</p>
        </div>
      )}
      {/* The same two disjoint buckets the rows tally, said in words - and in the same order, so the pair you
          clicked is the pair you land on. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {readers === 0 && <Badge variant="outline" className="text-[11px]">Only you</Badge>}
        {viewOnly > 0 && (
          <Badge variant="secondary" className="gap-1 text-[11px]"><Eye className="h-3 w-3" /> {viewOnly} can only look</Badge>
        )}
        {editors > 0 && (
          <Badge variant="outline" className="gap-1 text-[11px]"><Pencil className="h-3 w-3 text-primary" /> {editors} can change it</Badge>
        )}
        {/* The record count keeps an empty area honest: with nothing filed yet the names below are who WOULD
            see one, not who has seen anything. */}
        {area.records !== undefined && (
          <span className="text-[11px] text-muted-foreground">
            {area.records === 0 ? "nothing filed yet" : `${area.records} ${area.records === 1 ? "record" : "records"}`}
          </span>
        )}
      </div>
      {readers === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" /> Nobody but you can read this.
        </div>
      ) : (
        <ul className="max-h-[22rem] space-y-1 overflow-y-auto pr-1">
          {area.viewers.map((v) => (
            <li key={v.email} className="flex items-center gap-2 rounded-lg px-1 py-1">
              <PhotoAvatar employeeId="" name={v.name || v.email} photo={v.photo} className="h-7 w-7 text-xs" />
              <span className="min-w-0 flex-1">
                {v.name && <span className="block truncate text-xs font-medium">{v.name}</span>}
                <CopyEmail email={v.email} className="text-[11px] text-muted-foreground" />
                {v.why && <span className="block text-[11px] text-muted-foreground">{v.why}</span>}
              </span>
              {/* The icon carries its own label rather than a standing legend under the list: one line of
                  explanation per area, repeated down the page, was more copy than the lists it explained. */}
              {v.write ? (
                <span className="shrink-0" title="can change this">
                  <Pencil className="h-3 w-3 text-primary" aria-hidden />
                  <span className="sr-only">can change this</span>
                </span>
              ) : (
                <span className="shrink-0" title="can only look">
                  <Eye className="h-3 w-3 text-muted-foreground" aria-hidden />
                  <span className="sr-only">can only look</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One headline number, with the sentence it belongs to underneath rather than a bare noun. */
function Summary({ icon: Icon, value, label }: { icon: typeof Users; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-none">{value}</p>
        <p className="mt-1 text-[11px] leading-tight text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}
