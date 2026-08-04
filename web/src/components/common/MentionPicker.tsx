import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { cn, idOf, initials } from "@/lib/utils";
import type { Employee } from "@/types";

// Typing `@` in a board body or a reply offers the directory, and picking someone writes the mention token
// the renderer draws as a chip and the server reads to notify them (see src/domain/mentions.ts).
//
// A hook rather than a wrapper component, because the boxes it serves already own their own markup: the
// composer's textarea has the formatting bar bound to the same ref and an emoji button inside it, and the
// reply box is a one-line field in the middle of a card. Both keep their own <Textarea>; this contributes
// the two things a mention needs - a `menu` to render inside the box's relative container, and an
// `onKeyDown` to put on the box itself.
//
// The run being completed is read off the caret rather than tracked as state: whatever the box does (paste,
// undo, a formatting command, a click into the middle of a word), the answer is always derived from the text
// and the caret as they are now, so it cannot drift out of step with either.

const MAX_SUGGESTIONS = 6;
const MAX_QUERY = 40; // past this, whatever is after the `@` is prose, not a name being typed

type Run = { start: number; query: string }; // `start` is the index OF the `@`

/** The `@query` run the caret is inside, or null. */
function runAt(text: string, caret: number): Run | null {
  const at = text.lastIndexOf("@", caret - 1);
  if (at < 0) return null;
  const query = text.slice(at + 1, caret);
  // A name has no line break or `@` in it, and a mention starts a word: `user@host` is an address, not a
  // mention of "host". Spaces ARE allowed so "@priya na" can still find "Priya Nair", but only in the middle
  // of a short run - which is what keeps a whole sentence after a stray `@` from being treated as a query.
  if (query.length > MAX_QUERY || /[\n@]/.test(query)) return null;
  const before = at > 0 ? text[at - 1]! : " ";
  if (!/[\s(]/.test(before)) return null;
  return { start: at, query };
}

export function useMentions({
  value,
  onChange,
  textareaRef,
  employees,
}: {
  value: string;
  onChange: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  employees: Employee[];
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [active, setActive] = useState(0);
  // Where to put the caret after an insert - applied once React has rendered the new text (same dance as the
  // formatting bar's `apply`).
  const pendingCaret = useRef<number | null>(null);

  const name = (e: Employee) => `${e.first_name} ${e.last_name}`.trim();

  const matches = useMemo(() => {
    if (!run) return [];
    const q = run.query.trim().toLowerCase();
    const scored = employees
      .map((e) => {
        const full = name(e).toLowerCase();
        // A prefix match is what someone typing a name means; a match further in is a fallback, and an email
        // match catches the people you know by address rather than by spelling.
        const rank = !q ? 2 : full.startsWith(q) ? 0 : full.includes(q) ? 1 : (e.work_email ?? "").toLowerCase().includes(q) ? 2 : -1;
        return { e, rank };
      })
      .filter((m) => m.rank >= 0);
    scored.sort((a, b) => a.rank - b.rank || name(a.e).localeCompare(name(b.e)));
    return scored.slice(0, MAX_SUGGESTIONS).map((m) => m.e);
  }, [run, employees]);

  // A run with nothing behind it is not an offer worth making, so the menu closes rather than sitting empty.
  const open = !!run && matches.length > 0;

  useEffect(() => {
    setActive(0);
  }, [run?.query]);

  useEffect(() => {
    if (pendingCaret.current === null) return;
    const el = textareaRef.current;
    const at = pendingCaret.current;
    pendingCaret.current = null;
    if (!el) return;
    el.focus();
    el.setSelectionRange(at, at);
  }, [value, textareaRef]);

  // Re-read the run whenever the text or the caret could have moved. Called from the box's own handlers, so
  // it sees the state AFTER the browser has applied the keystroke.
  function sync() {
    const el = textareaRef.current;
    if (!el || el.selectionStart !== el.selectionEnd) return setRun(null);
    setRun(runAt(el.value, el.selectionStart));
  }

  function pick(e: Employee) {
    if (!run) return;
    const el = textareaRef.current;
    const caret = el ? el.selectionStart : run.start + 1 + run.query.length;
    // The token carries the name the author picked and the employee's wire id - the two things the chip and
    // the notification need - and a trailing space so typing simply continues after it.
    const token = `[@${name(e)}](employees/${idOf(e.path)}) `;
    const next = value.slice(0, run.start) + token + value.slice(caret);
    pendingCaret.current = run.start + token.length;
    setRun(null);
    onChange(next);
  }

  function onKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return false;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive((i) => (i + (ev.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
      return true;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
      ev.preventDefault();
      pick(matches[active] ?? matches[0]!);
      return true;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      setRun(null);
      return true;
    }
    return false;
  }

  const menu = open ? (
    // Anchored under the box (its container is `relative`) rather than at the caret: a textarea gives no
    // reliable caret coordinates, and a list that appears in the same place every time is easier to aim at
    // than one that jumps around the field.
    <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border bg-popover shadow-md">
      {matches.map((e, i) => (
        <button
          key={e.path}
          type="button"
          // mousedown, not click: the box would blur first and take the run with it.
          onMouseDown={(ev) => {
            ev.preventDefault();
            pick(e);
          }}
          onMouseEnter={() => setActive(i)}
          className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm", i === active ? "bg-accent" : "hover:bg-accent/60")}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">{initials(`${e.first_name} ${e.last_name}`)}</span>
          <span className="min-w-0 truncate">{e.first_name} {e.last_name}</span>
          {e.job_title && <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{e.job_title}</span>}
        </button>
      ))}
    </div>
  ) : null;

  return { menu, onKeyDown, sync };
}
