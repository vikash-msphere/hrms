import { useState } from "react";
import { Plus, X, ChevronUp, ChevronDown, Trash2 } from "lucide-react";
import { invoke, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import type { Board, BoardColumn, BoardMode, SwimlaneMode, WipScope, Label as BoardLabel } from "@/types";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { useUnsaved } from "@/components/common/UnsavedChanges";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "col";

// Per-board configuration (columns / WIP / swimlanes / labels), rendered inline in the settings Sheet from the
// board's gear - the object-scoped counterpart to the org settings panels. Reads the board from the shared
// boards cache (no extra fetch: the Boards page already loaded it) and saves through the same cache, so the
// board view refreshes automatically. `objectPath` is the board's resource path from the deep-link.
export function BoardConfigPanel({ objectPath, onClose }: { objectPath: string; onClose?: () => void }) {
  const { rows, state } = useCollection<Board>("boards");
  const board = rows.find((b) => b.path === objectPath);
  if (!board) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {state === "loading" ? "Loading…" : "This board is no longer available."}
      </p>
    );
  }
  // Key by path so edits survive the post-save refetch (same path, fresh object) but reset if the board changes.
  return <BoardConfigForm key={board.path} board={board} onClose={onClose} />;
}

function BoardConfigForm({ board, onClose }: { board: Board; onClose?: () => void }) {
  const { toast } = useToast();
  const confirm = useConfirm();
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
  const addCol = () => setCols((cs) => [...cs, { key: `col_${cs.length + 1}`, label: "New column", wipLimit: null, policy: "", commitment: false, delivery: false }]);
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

  async function del() {
    const ok = await confirm({
      title: `Delete ${board.name}?`,
      description: "The board and its tasks are removed from view (soft delete). This can be restored by an admin.",
      confirmLabel: "Delete board",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await remove(`boards/${idOf(board.path)}`, board.etag);
      toast({ title: "Board deleted" });
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
  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    // Ensure keys are unique slugs (labels drive keys for freshly added columns).
    const seen = new Set<string>();
    const columns = cols.map((c) => {
      let k = slug(c.key || c.label);
      while (seen.has(k)) k = `${k}_`;
      seen.add(k);
      return { ...c, key: k, wipLimit: c.wipLimit === null || Number.isNaN(c.wipLimit) ? null : Number(c.wipLimit) };
    });
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
        swimlanes: mode === "custom" ? lanes.map((l) => ({ ...l, key: slug(l.key || l.label) })) : board.swimlanes,
        labels: labelCat.map((l) => ({ ...l, key: slug(l.key || l.label) })),
        hide_empty_lanes: hideEmpty,
        reassign_lane_on_move: reassignLane,
        no_lane_label: mode === "custom" ? (noLaneLabel.trim() || null) : board.no_lane_label ?? null,
      });
      markSaved();
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
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="columns">Columns</TabsTrigger>
          <TabsTrigger value="swimlanes">Swimlanes</TabsTrigger>
          <TabsTrigger value="labels">Labels</TabsTrigger>
        </TabsList>

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
          <div className="flex items-center justify-end">
            <Button size="sm" variant="outline" onClick={addCol}><Plus className="h-3.5 w-3.5" /> Add column</Button>
          </div>
          {cols.map((c, i) => (
            <div key={i} className="rounded-md border p-2.5">
              <div className="flex items-center gap-2">
                <Input value={c.label} onChange={(e) => setCol(i, { label: e.target.value })} className="h-8 flex-1" placeholder="Column name" />
                <Input type="number" value={c.wipLimit ?? ""} onChange={(e) => setCol(i, { wipLimit: e.target.value === "" ? null : Number(e.target.value) })} className="h-8 w-24" placeholder="WIP" />
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => moveCol(i, -1)} disabled={i === 0}><ChevronUp className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => moveCol(i, 1)} disabled={i === cols.length - 1}><ChevronDown className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => removeCol(i)} disabled={cols.length === 1}><X className="h-4 w-4" /></Button>
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
              <div className="mt-2 flex items-center gap-4 text-sm">
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
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setLanes((ls) => ls.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
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
            <Button size="sm" variant="outline" onClick={() => setLabelCat((ls) => [...ls, { key: `label_${ls.length + 1}`, label: "New label", color: "#64748b" }])}><Plus className="h-3.5 w-3.5" /> Add label</Button>
          </div>
          {labelCat.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={l.label} onChange={(e) => setLabelCat((ls) => ls.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="h-8" placeholder="Label name" />
              <Input type="color" value={l.color ?? "#64748b"} onChange={(e) => setLabelCat((ls) => ls.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} className="h-8 w-14 p-1" />
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setLabelCat((ls) => ls.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
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
