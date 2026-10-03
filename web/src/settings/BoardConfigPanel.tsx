import { useState } from "react";
import { Plus, X, ChevronUp, ChevronDown, Trash2 } from "lucide-react";
import { invoke, patch, remove } from "@/api";
import { useResource } from "@/hooks/useResource";
import { idOf } from "@/lib/utils";
import type { Board, BoardColumn, BoardMode, SwimlaneMode, WipScope, Label as BoardLabel } from "@/types";
import { LABEL_COLORS, DEFAULT_LABEL_COLOR, nextLabelColor } from "@/lib/labelColors";
import { Field } from "@/components/common/Field";
import { ColorPicker } from "@/components/common/ColorPicker";
import { PanelSkeleton } from "@/components/common/Skeletons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { useDeletedToast } from "@/hooks/useSoftDelete";
import { useUnsaved } from "@/components/common/UnsavedChanges";
import { BoardSharingTab } from "./BoardSharingTab";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "col";

// Per-board configuration (columns / WIP / swimlanes / labels), rendered inline in the settings Sheet from the
// board's gear - the object-scoped counterpart to the org settings panels. `objectPath` is the board's
// resource path from the deep-link.
//
// READ BY ID, not by scanning the shared boards cache. That cache is one server page, so an org past a
// hundred boards got a flat "This board is no longer available." for a board that was open behind the sheet -
// and the panel is reachable by deep link (`/boards?setting=board-config`) with the Boards page never having
// mounted, where the cache holds nothing at all. One id, one indexed read, always the right board.
export function BoardConfigPanel({ objectPath, onClose }: { objectPath: string; onClose?: () => void }) {
  const { row: board, state, reload } = useResource<Board>("boards", idOf(objectPath));
  if (!board) {
    return state === "loading" ? (
      <PanelSkeleton />
    ) : (
      <p className="py-10 text-center text-sm text-muted-foreground">This board is no longer available.</p>
    );
  }
  // Key by path so edits survive the post-save refetch (same path, fresh object) but reset if the board changes.
  return <BoardConfigForm key={board.path} board={board} onClose={onClose} onSaved={reload} />;
}

function BoardConfigForm({ board, onClose, onSaved }: { board: Board; onClose?: () => void; onSaved?: () => void }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const deleted = useDeletedToast();
  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description ?? "");
  const [prefix, setPrefix] = useState(board.task_prefix ?? "");
  const [boardMode, setBoardMode] = useState<BoardMode>(board.mode);
  const [cols, setCols] = useState<BoardColumn[]>(() => board.columns.map((c) => ({ ...c })));
  const [mode, setMode] = useState<SwimlaneMode>(board.swimlane_mode);
  const [labelCat, setLabelCat] = useState<BoardLabel[]>(() => board.labels.map((l) => ({ ...l })));
  const [lanes, setLanes] = useState(() => board.swimlanes.map((s) => ({ ...s })));
  const [hideEmpty, setHideEmpty] = useState(!!board.hide_empty_lanes);
  const [reassignLane, setReassignLane] = useState(!!board.reassign_lane_on_move);
  const [noLaneLabel, setNoLaneLabel] = useState(board.no_lane_label ?? "");
  const [busy, setBusy] = useState(false);

  const setCol = (i: number, patch: Partial<BoardColumn>) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  // A key that is FREE, not one derived from how many columns there happen to be - the same rule ATS stages
  // took (pages/Settings.tsx `addStage`). `col_${cols.length + 1}` repeats the moment the list has ever
  // shrunk: add three columns (col_6, col_7, col_8), delete col_7, add another - the length is 7 again, so the
  // new column is col_8 too, and a card's `column_key` is stored AS this key. The uniquing in `save()` below
  // then renames whichever of the two comes SECOND in the array, so putting the new column first hands
  // `col_8` to the empty one and every card stored against it moves there.
  const addCol = () => setCols((cs) => {
    const taken = new Set(cs.map((c) => c.key));
    let n = cs.length + 1;
    while (taken.has(`col_${n}`)) n++;
    return [...cs, { key: `col_${n}`, label: "New column", wipLimit: null, policy: "", commitment: false, delivery: false, allowCreate: false }];
  });
  const removeCol = (i: number) => setCols((cs) => cs.filter((_, j) => j !== i));
  const moveCol = (i: number, d: -1 | 1) => setCols((cs) => {
    const j = i + d;
    if (j < 0 || j >= cs.length) return cs;
    const n = [...cs]; [n[i], n[j]] = [n[j]!, n[i]!]; return n;
  });
  // Commitment/delivery are single-select across columns.
  const setFlag = (i: number, flag: "commitment" | "delivery", on: boolean) =>
    setCols((cs) => cs.map((c, j) => ({ ...c, [flag]: j === i ? on : on ? false : c[flag] })));

  const canDelete = (board.access?.can ?? []).includes("delete");
  // Who may see and work the board is for whoever manages it - the `share` verb.
  const canShare = (board.access?.can ?? []).includes("share");

  async function del() {
    const ok = await confirm({
      title: `Delete ${board.name}?`,
      description: "The board and its tasks are removed from view (soft delete). Undo on the message that follows brings it back, and an admin can restore it later.",
      confirmLabel: "Delete board",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await remove(`boards/${idOf(board.path)}`, board.etag);
      deleted({ path: `boards/${idOf(board.path)}`, noun: "board", can: board.access?.can, reload: () => onSaved?.() });
      onClose?.();
    } catch (e) {
      toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" });
      setBusy(false);
    }
  }

  // Local drafts come straight from the board prop (no async load), so the baseline is ready immediately.
  const { markSaved } = useUnsaved(
    { name, description, prefix, boardMode, cols, mode, labelCat, lanes, hideEmpty, reassignLane, noLaneLabel },
    true,
    save,
  );
  // The server refuses a board no task could ever be created on; saying so here names the control to change.
  const noEntry = !cols.some((c) => c.allowCreate);
  async function save() {
    if (!name.trim()) return;
    if (noEntry) {
      toast({ title: "Couldn't save", description: "Tick \"New tasks can be created here\" on at least one column.", variant: "destructive" });
      return;
    }
    setBusy(true);
    // Ensure keys are unique slugs (labels drive keys for freshly added columns).
    //
    // THE COLUMN THAT ALREADY HAS THE CARDS KEEPS THE KEY. A card's `column_key` is stored as this string, so
    // renaming a key is what relocates its cards - and a plain first-come walk renames whichever duplicate
    // comes SECOND in the array, which is array ORDER, not history. Reorder a colliding pair and the repair
    // hands the incumbent key to the new, empty column and renames the one holding the cards: every card
    // "moves" to the new column and the original is left empty, with a valid, unique list arriving at the
    // server so nothing there can catch it. So a key already on the saved board is claimed by its own column
    // first, and only the others are nudged.
    const onBoard = new Set(board.columns.map((c) => c.key));
    const incumbent = new Map<string, number>(); // existing key -> index of the column that already holds it
    cols.forEach((c, i) => {
      const k = slug(c.key || c.label);
      if (onBoard.has(k) && !incumbent.has(k)) incumbent.set(k, i);
    });
    const seen = new Set<string>();
    const columns = cols.map((c, i) => {
      let k = slug(c.key || c.label);
      while (seen.has(k) || (incumbent.has(k) && incumbent.get(k) !== i)) k = `${k}_`;
      seen.add(k);
      return { ...c, key: k, wipLimit: c.wipLimit === null || Number.isNaN(c.wipLimit) ? null : Number(c.wipLimit) };
    });
    // THE SAME PASS FOR LANES AND LABELS, which had the slug and not the uniquing.
    //
    // `normalizeSwimlanes` / `normalizeLabels` refuse a duplicate key exactly as `normalizeColumns` does, so a
    // save that produced one failed at the server with a message naming a key the user never typed and no
    // control anywhere in this panel to change it. Two ways to produce one: the `lane_${length + 1}` mint below
    // repeats once the list has shrunk, and two lanes given the same label slug to the same thing.
    const unique = <T extends { key: string; label: string }>(items: T[]): T[] => {
      const used = new Set<string>();
      return items.map((it) => {
        let k = slug(it.key || it.label);
        while (used.has(k)) k = `${k}_`;
        used.add(k);
        return { ...it, key: k };
      });
    };
    // Name/description are a plain PATCH (do it first, while the etag is fresh); the structural config goes
    // through the :configure verb (which doesn't gate on the etag).
    const cleanPrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const detailsChanged = name.trim() !== board.name || description.trim() !== (board.description ?? "") || boardMode !== board.mode || cleanPrefix !== board.task_prefix;
    try {
      if (detailsChanged) {
        await patch(`boards/${idOf(board.path)}`, { name: name.trim(), description: description.trim() || null, task_prefix: cleanPrefix, mode: boardMode }, board.etag);
      }
      await invoke(`boards/${idOf(board.path)}`, "configure", undefined, {
        columns,
        swimlane_mode: mode,
        swimlanes: mode === "custom" ? unique(lanes) : board.swimlanes,
        labels: unique(labelCat),
        hide_empty_lanes: hideEmpty,
        reassign_lane_on_move: reassignLane,
        no_lane_label: mode === "custom" ? noLaneLabel.trim() : board.no_lane_label ?? "",
      });
      markSaved();
      // Re-read the board this panel holds: the PATCH above moved its etag, and a second save from the same
      // open panel would otherwise carry the one it mounted with and take a 409.
      onSaved?.();
      toast({ title: "Board configured", variant: "success" });
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Tabs defaultValue="details">
        {/* No `grid grid-cols-4` here: four equal minmax(0,1fr) tracks are narrower than "Swimlanes"
            wants once this panel is in a phone-width Sheet, and the label - which is `whitespace-nowrap` -
            then spills out of its own track. The plain TabsList already scrolls its strip and pulls the
            active tab into view, which is the behaviour a grid override throws away. */}
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="columns">Columns</TabsTrigger>
          <TabsTrigger value="swimlanes">Swimlanes</TabsTrigger>
          <TabsTrigger value="labels">Labels</TabsTrigger>
          {canShare && <TabsTrigger value="sharing">Sharing</TabsTrigger>}
        </TabsList>

        {canShare && (
          <TabsContent value="sharing" className="mt-3">
            <BoardSharingTab board={board} onSaved={onSaved} />
          </TabsContent>
        )}

        <TabsContent value="details" className="mt-3 space-y-2">
          <Field label="Method" hint="Kanban = continuous flow. Scrum = time-boxed sprints (adds a backlog, sprint board, burndown & velocity).">
            <Select value={boardMode} onValueChange={(v) => setBoardMode(v as BoardMode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="kanban">Kanban (continuous flow)</SelectItem>
                <SelectItem value="scrum">Scrum (sprints)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Board name" /></Field>
          <Field label="Task key prefix" hint="Used for task keys like MS-12. New tasks only; existing keys don't change.">
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="MS" className="w-40 uppercase" maxLength={6} />
          </Field>
          <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} /></Field>
        </TabsContent>

        <TabsContent value="columns" className="mt-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <p className={noEntry ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {noEntry
                ? "No column takes new tasks yet. Tick \"New tasks can be created here\" on at least one."
                : "New tasks are created only in the columns ticked to take them, and reach the others by being moved."}
            </p>
            <Button size="sm" variant="outline" className="shrink-0" onClick={addCol}><Plus className="h-3.5 w-3.5" /> Add column</Button>
          </div>
          {cols.map((c, i) => (
            <div key={i} className="rounded-md border p-2.5">
              <div className="editor-row">
                <Input value={c.label} onChange={(e) => setCol(i, { label: e.target.value })} className="editor-row-main h-8" placeholder="Column name" />
                <Input type="number" value={c.wipLimit ?? ""} onChange={(e) => setCol(i, { wipLimit: e.target.value === "" ? null : Number(e.target.value) })} className="h-8 w-20" placeholder="WIP" />
                <Button size="icon" variant="ghost" aria-label="Move this column left" className="h-7 w-7" onClick={() => moveCol(i, -1)} disabled={i === 0}><ChevronUp className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Move this column right" className="h-7 w-7" onClick={() => moveCol(i, 1)} disabled={i === cols.length - 1}><ChevronDown className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" aria-label="Remove this column" className="h-7 w-7 text-destructive" onClick={() => removeCol(i)} disabled={cols.length === 1}><X className="h-4 w-4" /></Button>
              </div>
              <Input value={c.policy} onChange={(e) => setCol(i, { policy: e.target.value })} className="mt-2 h-8" placeholder="Column policy (definition of done / entry criteria)" />
              {c.wipLimit != null && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>WIP limit applies</span>
                  <Select value={c.limitScope ?? "column"} onValueChange={(v) => setCol(i, { limitScope: v as WipScope })}>
                    <SelectTrigger className="h-7 w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="column">board-wide</SelectItem>
                      <SelectItem value="assignee">per assignee</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <label className="flex items-center gap-1.5"><Checkbox checked={c.allowCreate} onCheckedChange={(v) => setCol(i, { allowCreate: !!v })} /> New tasks can be created here</label>
                <label className="flex items-center gap-1.5"><Checkbox checked={c.commitment} onCheckedChange={(v) => setFlag(i, "commitment", !!v)} /> Commitment point</label>
                <label className="flex items-center gap-1.5"><Checkbox checked={c.delivery} onCheckedChange={(v) => setFlag(i, "delivery", !!v)} /> Delivery point</label>
              </div>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="swimlanes" className="mt-3 space-y-2">
          <Select value={mode} onValueChange={(v) => setMode(v as SwimlaneMode)}>
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="assignee">By assignee</SelectItem>
              <SelectItem value="goal">By goal</SelectItem>
              <SelectItem value="priority">By priority</SelectItem>
              <SelectItem value="department">By department</SelectItem>
              <SelectItem value="custom">Custom lanes</SelectItem>
            </SelectContent>
          </Select>
          {mode === "custom" && (
            <div className="space-y-1.5">
              {lanes.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input value={l.label} onChange={(e) => setLanes((ls) => ls.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="h-8" placeholder="Lane name" />
                  <Button size="icon" variant="ghost" aria-label="Remove this swimlane" className="h-7 w-7 text-destructive" onClick={() => setLanes((ls) => ls.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setLanes((ls) => [...ls, { key: `lane_${ls.length + 1}`, label: "New lane" }])}><Plus className="h-3.5 w-3.5" /> Add lane</Button>
              <Field label="Catch-all lane label" hint="Label for cards not placed in any lane."><Input value={noLaneLabel} onChange={(e) => setNoLaneLabel(e.target.value)} className="h-8 w-56" placeholder="Ungrouped" /></Field>
            </div>
          )}
          {mode !== "none" && (
            <div className="space-y-1.5 pt-1">
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={hideEmpty} onCheckedChange={(v) => setHideEmpty(v === true)} /> Hide empty lanes</label>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={reassignLane} onCheckedChange={(v) => setReassignLane(v === true)} /> Allow swimlane change when moving between columns</label>
            </div>
          )}
        </TabsContent>

        <TabsContent value="labels" className="mt-3 space-y-2">
          <div className="flex items-center justify-end">
            <Button size="sm" variant="outline" onClick={() => setLabelCat((ls) => [...ls, { key: `label_${ls.length + 1}`, label: "New label", color: nextLabelColor(ls.map((x) => x.color)) }])}><Plus className="h-3.5 w-3.5" /> Add label</Button>
          </div>
          {labelCat.map((l, i) => (
            <div key={i} className="editor-row">
              <Input value={l.label} onChange={(e) => setLabelCat((ls) => ls.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="editor-row-main h-8" placeholder="Label name" />
              <ColorPicker value={l.color ?? DEFAULT_LABEL_COLOR} presets={LABEL_COLORS} label={`Color for ${l.label || "this label"}`} onChange={(color) => setLabelCat((ls) => ls.map((x, j) => (j === i ? { ...x, color } : x)))} />
              <Button size="icon" variant="ghost" aria-label="Remove this label" className="h-7 w-7 text-destructive" onClick={() => setLabelCat((ls) => ls.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
            </div>
          ))}
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-between gap-2 border-t pt-3">
        {canDelete
          ? <Button variant="ghost" className="text-destructive" onClick={del} loading={busy}><Trash2 className="h-4 w-4" /> Delete board</Button>
          : <span />}
        <Button onClick={save} loading={busy} disabled={!name.trim()}>Save</Button>
      </div>
    </div>
  );
}
