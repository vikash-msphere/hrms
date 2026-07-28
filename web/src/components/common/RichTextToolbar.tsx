import { useEffect, useRef, useState, type RefObject } from "react";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatAttrLine, parseAttrLine, RICH_ALIGNMENTS, RICH_FACES, RICH_SIZES, type RichAttrs, type RichSize } from "@/lib/richText";
import { NAME_FONTS, orgNameFontStack } from "@/lib/fonts";
import { type BodyValign, VALIGN_LABELS } from "@/components/common/CardSticker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// The formatting bar over the composer's message box. It edits the markdown-lite SOURCE in the textarea rather
// than any editor state of its own: every button is a text transform, so the box stays a plain textarea (paste,
// undo, spellcheck, IME and screen readers all keep working) and what is stored is exactly what is shown.
//
// It behaves the way a formatting bar is expected to:
//
//   * Inline marks (bold, italic, strike, link) act on the SELECTION and nothing else. With no selection they
//     drop an empty pair of markers at the caret so the next thing typed comes out formatted - they never reach
//     out and re-format text the author did not select, and never invent placeholder words.
//   * Block controls (alignment, size, typeface, lists, quote, heading) act on every block the selection touches,
//     or on the block holding the caret - the rule a word processor uses for paragraph formatting.
//   * Nothing happens at all until the box has been focused, or a click on "centre" before typing would silently
//     format whichever block happened to be last.
//
// The bar never steals focus: every control cancels its own mousedown, so the textarea keeps focus AND selection
// while a button is pressed. The last selection is also remembered, because opening a dropdown moves focus into
// the menu and would otherwise lose it before the command runs.
//
// "The block the caret is in" is the run of lines around it bounded by blank lines, which is exactly how the
// parser groups them - the two agree by construction.

type Props = {
  textareaRef: RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (next: string) => void;
  // Vertical position of the words in the finished card. Not part of the source - it is a field on the post - so
  // it is passed in and handed back rather than written into the text like everything else here.
  valign?: BodyValign;
  onValignChange?: (valign: BodyValign) => void;
  className?: string;
};

const SIZE_LABELS: Record<RichSize, string> = { sm: "Small", base: "Normal", lg: "Large" };
// Labels come from the shared font table, so the post control and the wordmark picker name a face the same way.
const FACE_LABEL = (key: string) => NAME_FONTS.find((f) => f.value === key)?.label ?? key;
const ALIGN_ICONS = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify };

export function RichTextToolbar({ textareaRef, value, onChange, valign, onValignChange, className }: Props) {
  const pending = useRef<[number, number] | null>(null); // caret to restore once React has re-rendered
  const lastSel = useRef<[number, number] | null>(null); // survives focus moving into a dropdown
  const [, bump] = useState(0); // the bar reflects the caret's block, and caret moves are not React events

  // Track the caret, and keep the shortcuts on the box itself.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const remember = () => {
      lastSel.current = [el.selectionStart, el.selectionEnd];
      bump((n) => n + 1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "b" && key !== "i" && key !== "k") return;
      e.preventDefault();
      e.stopPropagation();
      remember();
      if (key === "b") wrap("**");
      else if (key === "i") wrap("*");
      else insertLink();
    };
    for (const ev of ["select", "keyup", "click", "focus"] as const) el.addEventListener(ev, remember);
    el.addEventListener("keydown", onKey);
    return () => {
      for (const ev of ["select", "keyup", "click", "focus"] as const) el.removeEventListener(ev, remember);
      el.removeEventListener("keydown", onKey);
    };
  });

  /** The selection to act on, or null when the box has never been focused - commands then do nothing. */
  function selection(): [number, number] | null {
    const el = textareaRef.current;
    if (el && document.activeElement === el) return [el.selectionStart, el.selectionEnd];
    return lastSel.current;
  }

  function apply(next: string, caret: [number, number]) {
    pending.current = caret;
    lastSel.current = caret;
    onChange(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      const at = pending.current;
      pending.current = null;
      if (!el || !at) return;
      el.focus();
      el.setSelectionRange(at[0], at[1]);
    });
  }

  /**
   * Apply a whole-document rewrite (a block command), leaving the caret where the author left it, shifted by
   * however much text the command added or removed. Jumping to the end of the post after clicking "centre" would
   * be its own small betrayal.
   */
  function keepCaret(next: string, from: [number, number]) {
    const delta = next.length - value.length;
    const at = (n: number) => Math.max(0, Math.min(next.length, n + delta));
    apply(next, [at(from[0]), at(from[1])]);
  }

  // ---- Inline marks ------------------------------------------------------------------------------------------

  /**
   * Wrap the selection in `marker`, or unwrap it when it is already wrapped (so each button toggles). With an
   * empty selection this inserts the pair and sits between them: the next keystroke comes out formatted, and not
   * one character of existing text is touched.
   */
  function wrap(marker: string) {
    const sel = selection();
    if (!sel) return;
    const [start, end] = sel;
    const inner = value.slice(start, end);
    const before = value.slice(0, start);
    const after = value.slice(end);
    // Markers inside the selection.
    if (inner.startsWith(marker) && inner.endsWith(marker) && inner.length > marker.length * 2) {
      const bare = inner.slice(marker.length, -marker.length);
      apply(before + bare + after, [start, start + bare.length]);
      return;
    }
    // Markers hugging it.
    if (inner && before.endsWith(marker) && after.startsWith(marker)) {
      const next = before.slice(0, -marker.length) + inner + after.slice(marker.length);
      apply(next, [start - marker.length, start - marker.length + inner.length]);
      return;
    }
    const next = `${before}${marker}${inner}${marker}${after}`;
    apply(next, [start + marker.length, start + marker.length + inner.length]);
  }

  function insertLink() {
    const sel = selection();
    if (!sel) return;
    const [start, end] = sel;
    const text = value.slice(start, end);
    const next = `${value.slice(0, start)}[${text}](https://)${value.slice(end)}`;
    // With text selected the URL is what still needs typing, so the caret lands there. With nothing selected the
    // label is typed first, so it lands between the brackets.
    const urlAt = start + text.length + 3 + 8;
    apply(next, text ? [urlAt, urlAt] : [start + 1, start + 1]);
  }

  // ---- Blocks ------------------------------------------------------------------------------------------------

  /** Index of the line containing character offset `caret`. */
  function lineAt(lines: string[], caret: number): number {
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      pos += lines[i]!.length;
      if (caret <= pos) return i;
      pos += 1; // the newline
    }
    return Math.max(0, lines.length - 1);
  }

  /** Grow a line index out to its whole block (bounded by blank lines), skipping any attribute line on top. */
  function blockAround(lines: string[], line: number): [number, number] {
    let first = line;
    let last = line;
    while (first > 0 && lines[first - 1]!.trim() !== "") first--;
    while (last < lines.length - 1 && lines[last + 1]!.trim() !== "") last++;
    if (parseAttrLine(lines[first] ?? "")) first = Math.min(first + 1, last);
    return [first, last];
  }

  /** Every block the selection touches, first to last. A collapsed caret yields the one block it sits in. */
  function selectedBlocks(lines: string[], sel: [number, number]): [number, number][] {
    const from = lineAt(lines, sel[0]);
    const to = lineAt(lines, sel[1]);
    const out: [number, number][] = [];
    let i = from;
    while (i <= to) {
      if (lines[i]!.trim() === "") { i++; continue; }
      const block = blockAround(lines, i);
      out.push(block);
      i = block[1] + 1;
    }
    return out.length ? out : [blockAround(lines, from)];
  }

  /** Toggle a line prefix (`- `, `1. `, `> `, `## `) across every selected block. */
  function togglePrefix(kind: "ul" | "ol" | "quote" | "h") {
    const sel = selection();
    if (!sel) return;
    const lines = value.split("\n");
    const blocks = selectedBlocks(lines, sel);
    const marked = (t: string) =>
      kind === "ul" ? /^[-*]\s+/.test(t) : kind === "ol" ? /^\d+[.)]\s+/.test(t) : kind === "quote" ? /^>\s?/.test(t) : /^#{1,3}\s+/.test(t);
    // Marked everywhere already -> the button removes it; otherwise it applies to all of them.
    const already = blocks.every(([f, l]) => lines.slice(f, l + 1).every((line) => marked(line.trim())));
    const strip = (s: string) => s.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+|>\s?|#{1,3}\s+)/, "");
    for (const [first, last] of blocks) {
      for (let i = first; i <= last; i++) {
        const bare = strip(lines[i]!);
        lines[i] = already ? bare : kind === "ul" ? `- ${bare}` : kind === "ol" ? `${i - first + 1}. ${bare}` : kind === "quote" ? `> ${bare}` : `## ${bare}`;
      }
    }
    keepCaret(lines.join("\n"), sel);
  }

  /** The attributes governing the block the caret is in - what the bar reports as active. */
  function currentAttrs(): RichAttrs {
    const sel = selection();
    if (!sel) return {};
    const lines = value.split("\n");
    const [first] = blockAround(lines, lineAt(lines, sel[0]));
    return (first > 0 ? parseAttrLine(lines[first - 1]!) : null) ?? {};
  }

  /** Set or clear attribute tokens on every selected block. */
  function setAttrs(patch: Partial<RichAttrs>) {
    const sel = selection();
    if (!sel) return;
    const lines = value.split("\n");
    // Back to front, so splicing an attribute line in never shifts the blocks still to be handled.
    for (const [first] of selectedBlocks(lines, sel).reverse()) {
      const existing = first > 0 ? parseAttrLine(lines[first - 1]!) : null;
      const merged: RichAttrs = { ...(existing ?? {}), ...patch };
      // A token back at its default drops out entirely, so a plain block keeps a clean source.
      for (const k of ["align", "size", "face"] as const) if (!merged[k]) delete merged[k];
      if (!merged.muted) delete merged.muted;
      const line = formatAttrLine(merged);
      if (existing) {
        if (line) lines[first - 1] = line;
        else lines.splice(first - 1, 1);
      } else if (line) {
        lines.splice(first, 0, line);
      }
    }
    keepCaret(lines.join("\n"), sel);
  }

  // ---- Render ------------------------------------------------------------------------------------------------

  const active = currentAttrs();
  const btn = "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
  // Cancelling mousedown is what keeps the textarea's selection alive while a control is pressed.
  const hold = (e: React.MouseEvent) => e.preventDefault();

  const iconButton = (label: string, Icon: typeof Bold, onClick: () => void, on = false) => (
    <Tooltip key={label}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} aria-pressed={on} onMouseDown={hold} onClick={onClick} className={cn(btn, on && "bg-accent text-foreground")}>
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <div className={cn("flex flex-wrap items-center gap-0.5 rounded-t-md border border-b-0 bg-muted/40 px-1 py-1", className)}>
      {iconButton("Bold  ⌘B", Bold, () => wrap("**"))}
      {iconButton("Italic  ⌘I", Italic, () => wrap("*"))}
      {iconButton("Strikethrough", Strikethrough, () => wrap("~~"))}
      {iconButton("Link  ⌘K", Link2, insertLink)}
      <span className="mx-1 h-4 w-px bg-border" />
      {iconButton("Heading", Type, () => togglePrefix("h"))}
      {iconButton("Bulleted list", List, () => togglePrefix("ul"))}
      {iconButton("Numbered list", ListOrdered, () => togglePrefix("ol"))}
      {iconButton("Quote", Quote, () => togglePrefix("quote"))}
      <span className="mx-1 h-4 w-px bg-border" />
      {RICH_ALIGNMENTS.map((a) =>
        iconButton(`Align ${a}`, ALIGN_ICONS[a], () => setAttrs({ align: active.align === a ? undefined : a }), active.align === a || (!active.align && a === "left")),
      )}
      <span className="mx-1 h-4 w-px bg-border" />
      <AttrMenu
        label="Text size"
        current={SIZE_LABELS[active.size ?? "base"]}
        value={active.size ?? "base"}
        options={RICH_SIZES.map((s) => ({ key: s, label: SIZE_LABELS[s] }))}
        onPick={(k) => setAttrs({ size: k === "base" ? undefined : (k as RichSize) })}
        onHold={hold}
      />
      <AttrMenu
        label="Typeface"
        current={FACE_LABEL(active.face ?? "default")}
        value={active.face ?? "default"}
        // Each choice is set in its own face, so the menu shows what it means rather than naming it.
        options={[{ key: "default", label: FACE_LABEL("default") }, ...RICH_FACES.map((f) => ({ key: f, label: FACE_LABEL(f), style: { fontFamily: orgNameFontStack(f) } }))]}
        onPick={(k) => setAttrs({ face: k === "default" ? undefined : k })}
        onHold={hold}
      />
      {/* Where the words ride in the CARD, not in this box - the one control here that is not a text transform.
          It sits with the others because that is where an author looks for it, and because from their side it is
          the same kind of decision: which way the writing is set. */}
      {valign && onValignChange && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <AttrMenu
            label="Text position in the card"
            current={VALIGN_LABELS.find((v) => v.value === valign)?.label ?? "Text at top"}
            value={valign}
            options={VALIGN_LABELS.map((v) => ({ key: v.value, label: v.label }))}
            onPick={(k) => onValignChange(k as BodyValign)}
            onHold={hold}
          />
        </>
      )}
    </div>
  );
}

function AttrMenu({
  label,
  current,
  options,
  value,
  onPick,
  onHold,
}: {
  label: string;
  current: string;
  options: { key: string; label: string; style?: React.CSSProperties }[];
  value: string;
  onPick: (key: string) => void;
  onHold: (e: React.MouseEvent) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onMouseDown={onHold}
          className="flex h-7 items-center rounded px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {current}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={o.key} onSelect={() => onPick(o.key)} style={o.style} className={cn(o.key === value && "font-semibold")}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
