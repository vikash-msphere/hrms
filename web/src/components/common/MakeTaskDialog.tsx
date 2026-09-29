import { useEffect, useState } from "react";
import { create } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import type { Board, Card } from "@/types";

// Promote a line of text into a board task.
//
// The same move is wanted from three places - a 1:1 action item, a checklist item on a task, a checklist item
// on a support ticket - and they all want it for the same reason: what looked like a tick-box turned out to be
// work, and work belongs on a board where it can be assigned, prioritised and seen. One-way on purpose: the
// new task carries a line saying where it came from, and the item it came from stays where it is, because
// deleting somebody's checklist item to "move" it loses the context they were reading it in.
//
// Boards load only while this dialog is open (the usual lazy read), and `defaultBoard` skips the picker
// entirely when the caller already knows the board - promoting a checklist item on a task means the board
// that task is on, and asking would be a question with one answer.
export function MakeTaskDialog({ text, source, defaultBoard, onClose, onCreated }: {
  text: string;
  /** One line on where this came from, e.g. "From MS-14: ship the importer." Becomes the task's description. */
  source?: string;
  /** Wire path of the board to file it on. When set, the picker is pre-filled with it. */
  defaultBoard?: string;
  onClose: () => void;
  /** Passed the created task, so the caller can name it ("MS-42 created"). */
  onCreated?: (card: Card) => void;
}) {
  // Only boards the caller may file a task on: a board they can only view is refused by the server, so it is not
  // offered (`my_access`, services/boards.ts).
  const { rows: allBoards, state } = useCollection<Board>("boards");
  const boards = allBoards.filter((b) => b.my_access === "edit" || b.my_access === "manage");
  const [form, setForm] = useState({ board: defaultBoard ?? "", title: text });
  useEffect(() => {
    // Only when the caller had no opinion: a pre-filled board must not be replaced by whatever loads first.
    if (!defaultBoard) setForm((f) => (f.board || !boards[0] ? f : { ...f, board: boards[0]!.path }));
  }, [boards, defaultBoard]);

  return (
    <WriteDialog
      open
      onClose={onClose}
      title="Make a board task"
      description="Files it on a board, with a line pointing back here. What it came from stays where it is."
      collection="cards"
      guardLabel="task"
      form={form}
      submitLabel="Create task"
      canSubmit={!!form.board && !!form.title.trim()}
      whyNot={!form.title.trim() ? "Give the task a title." : "Pick the board it belongs on."}
      submitAccess={(b) => <AccessAction collection="cards" create label="Create a task">{b}</AccessAction>}
      onSubmit={async () => {
        const card = await create<Card>("cards", { board: form.board, title: form.title.trim(), ...(source ? { description: source } : {}) });
        onCreated?.(card);
      }}
    >
      <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></Field>
      <Field label="Board">
        <Combobox
          value={form.board}
          onValueChange={(v) => setForm({ ...form, board: v })}
          placeholder={state === "loading" ? "Loading boards…" : "Pick a board"}
          searchPlaceholder="Search boards…"
          options={boards.map((b) => ({ value: b.path, label: b.name }))}
        />
      </Field>
      {/* The description the task will carry, shown rather than described: it is the only trace of where the
          work came from, and it is written by the caller, not by whoever is looking at this form. */}
      {source && (
        <p className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          The task's description will read: {source}
        </p>
      )}
      {boards.length === 0 && state === "ready" && <p className="text-xs text-muted-foreground">No boards you can add to yet.</p>}
    </WriteDialog>
  );
}
