import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart, Bold, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Type,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  attrsAt, continueList, insertLink as linkEdit, markActive, prefixActive, RICH_ALIGNMENTS, RICH_FACES, RICH_SIZES,
  setAttrs as attrEdit, toggleMark, togglePrefix as prefixEdit, type Edit, type Prefix, type RichAttrs, type RichSize, type Sel,
} from "@/lib/richTextEdit";
import { NAME_FONTS, orgNameFontStack } from "@/lib/fonts";
import { type BodyValign, VALIGN_LABELS } from "@/components/common/CardSticker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// The formatting bar over the composer's message box. It edits the markdown-lite SOURCE in the textarea rather
// than any editor state of its own: every button is a text transform (lib/richTextEdit.ts), so the box stays a
// plain textarea - paste, undo, spellcheck, IME and screen readers all keep working - and what is stored is
// exactly what is shown. This file is the wiring: read the selection, run the transform, put the caret back.
//
// The bar behaves the way a formatting bar is expected to:
//
//   * Inline marks (bold, italic, strike) act on the SELECTION and nothing else, and each toggles: pressed on
//     marked words it takes the mark off, pressed on plain ones it puts it on, and the two emphases are
//     independent of each other. With no selection they drop an empty pair of markers at the caret so the next
//     thing typed comes out formatted, and pressing again with the caret still there takes the pair away.
//   * Line controls (lists, quote, heading) act on every LINE the selection touches - three selected lines give
//     three bullets - or on the line holding the caret.
//   * Block controls (alignment, size, typeface) act on every block the selection touches, or on the block
//     holding the caret: those are paragraph settings, and they ride on an attribute line governing a whole block.
//   * Enter inside a list item or a quote opens the next one; on an empty item it ends the list.
//   * Every control shows whether it is already on, read back off the text at the caret.
//
// With nothing selected, then, every control is about what comes NEXT: the mark the next keystroke lands inside,
// the line the caret is about to fill. Two cases make that literal rather than nearly true - a caret parked on a
// blank line is its own line to prefix rather than the tail of the paragraph above it, and a box that has never
// been focused is treated as a caret at the end of its text (see selection), so pressing Bold before writing
// anything sets up the words instead of doing nothing.
//
// The bar never steals focus: every control cancels its own mousedown, so the textarea keeps focus AND selection
// while a button is pressed. The last selection is also remembered, because opening a dropdown moves focus into
// the menu and would otherwise lose it before the command runs.

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
// Three sizes, so they are three buttons like the two alignment sets rather than a menu to open and read. What
// each one shows is a letter at the size it sets - the control IS the sample, which no pictogram of a letter
// manages. Set in the bar's own face, not the one being edited: this picks a size, and a Playfair "A" on the
// button would read as picking a typeface too.
const SIZE_GLYPH: Record<RichSize, string> = { sm: "text-[9px]", base: "text-[11px]", lg: "text-[14px]" };
// Labels come from the shared font table, so the post control and the wordmark picker name a face the same way.
const FACE_LABEL = (key: string) => NAME_FONTS.find((f) => f.value === key)?.label ?? key;
const ALIGN_ICONS = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify };
// The vertical counterpart of ALIGN_ICONS: same shape, so the two align rows read as one pair of controls.
const VALIGN_ICONS: Record<BodyValign, typeof AlignLeft> = {
  top: AlignVerticalJustifyStart,
  middle: AlignVerticalJustifyCenter,
  bottom: AlignVerticalJustifyEnd,
};

export function RichTextToolbar({ textareaRef, value, onChange, valign, onValignChange, className }: Props) {
  const pending = useRef<Sel | null>(null); // caret to restore once React has re-rendered
  const lastSel = useRef<Sel | null>(null); // survives focus moving into a dropdown
  const [, bump] = useState(0); // the bar reflects the caret's marks and line, and caret moves are not React events

  /**
   * The selection to act on. With nothing selected that is the caret, and every command then applies to what is
   * about to be TYPED there rather than to something already written.
   *
   * A box that has never been focused has no caret to speak of, so it is taken to be at the end of the text -
   * where the next thing typed would go. Pressing Bold before writing a word is a statement about the word, and
   * the bar answering with nothing at all is the one reading that cannot be what was meant. `apply` focuses the
   * box afterwards, so the author is left typing inside what they just asked for.
   */
  function selection(): Sel {
    const el = textareaRef.current;
    if (el && document.activeElement === el) return [el.selectionStart, el.selectionEnd];
    return lastSel.current ?? [value.length, value.length];
  }

  function apply(edit: Edit) {
    pending.current = edit.selection;
    lastSel.current = edit.selection;
    onChange(edit.value);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      const at = pending.current;
      pending.current = null;
      if (!el || !at) return;
      el.focus();
      el.setSelectionRange(at[0], at[1]);
    });
  }

  const mark = (marker: string) => apply(toggleMark(value, selection(), marker));
  const prefix = (kind: Prefix) => apply(prefixEdit(value, selection(), kind));
  const attrs = (patch: Partial<RichAttrs>) => apply(attrEdit(value, selection(), patch));
  const link = () => apply(linkEdit(value, selection()));

  // Track the caret, and keep the keyboard commands on the box itself.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const remember = () => {
      lastSel.current = [el.selectionStart, el.selectionEnd];
      bump((n) => n + 1);
    };
    const onKey = (e: KeyboardEvent) => {
      // Enter continues a list or a quote. Shift+Enter is the plain newline inside one and Cmd/Ctrl+Enter posts
      // (the dialog owns that), so neither is touched here - nor is Enter over a selection, which replaces it.
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (el.selectionStart !== el.selectionEnd) return;
        const edit = continueList(value, el.selectionStart);
        if (!edit) return;
        e.preventDefault();
        apply(edit);
        return;
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "b" && key !== "i" && key !== "k") return;
      e.preventDefault();
      e.stopPropagation();
      remember();
      if (key === "b") mark("**");
      else if (key === "i") mark("*");
      else link();
    };
    for (const ev of ["select", "keyup", "click", "focus"] as const) el.addEventListener(ev, remember);
    el.addEventListener("keydown", onKey);
    return () => {
      for (const ev of ["select", "keyup", "click", "focus"] as const) el.removeEventListener(ev, remember);
      el.removeEventListener("keydown", onKey);
    };
  });

  // ---- Render ------------------------------------------------------------------------------------------------

  // What the caret is already inside, so every control shows its own state rather than only the alignment ones.
  const sel = selection();
  const active = attrsAt(value, sel);
  const btn = "flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
  // Cancelling mousedown is what keeps the textarea's selection alive while a control is pressed.
  const hold = (e: React.MouseEvent) => e.preventDefault();

  // One pressed-state control, whatever it shows - an icon for most of them, a letter for the sizes.
  const toggleButton = (label: string, content: ReactNode, onClick: () => void, on = false) => (
    <Tooltip key={label}>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} aria-pressed={on} onMouseDown={hold} onClick={onClick} className={cn(btn, on && "bg-accent text-foreground")}>
          {content}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
  const iconButton = (label: string, Icon: typeof Bold, onClick: () => void, on = false) =>
    toggleButton(label, <Icon className="h-3.5 w-3.5" />, onClick, on);

  return (
    <div className={cn("flex flex-wrap items-center gap-0.5 rounded-t-md border border-b-0 bg-muted/40 px-1 py-1", className)}>
      {iconButton("Bold  ⌘B", Bold, () => mark("**"), markActive(value, sel, "**"))}
      {iconButton("Italic  ⌘I", Italic, () => mark("*"), markActive(value, sel, "*"))}
      {iconButton("Strikethrough", Strikethrough, () => mark("~~"), markActive(value, sel, "~~"))}
      {iconButton("Link  ⌘K", Link2, link)}
      <span className="mx-1 h-4 w-px bg-border" />
      {iconButton("Heading", Type, () => prefix("h"), prefixActive(value, sel, "h"))}
      {iconButton("Bulleted list", List, () => prefix("ul"), prefixActive(value, sel, "ul"))}
      {iconButton("Numbered list", ListOrdered, () => prefix("ol"), prefixActive(value, sel, "ol"))}
      {iconButton("Quote", Quote, () => prefix("quote"), prefixActive(value, sel, "quote"))}
      <span className="mx-1 h-4 w-px bg-border" />
      {RICH_ALIGNMENTS.map((a) =>
        iconButton(`Align ${a}`, ALIGN_ICONS[a], () => attrs({ align: active.align === a ? undefined : a }), active.align === a || (!active.align && a === "left")),
      )}
      {/* Where the words ride in the CARD, not in this box - the one control here that is not a text transform.
          It sits in the alignment group all the same, because from the author's side it is the same decision on
          the other axis: which way the writing is set. Three pressed-state icons rather than a menu, to read as
          the vertical twin of the row it joins - and a set of three needs no label to say which one is on.
          Divided from the horizontal set, because seven alignment icons in a row is a wall to read. */}
      {valign && onValignChange && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          {VALIGN_LABELS.map((v) => iconButton(v.label, VALIGN_ICONS[v.value], () => onValignChange(v.value), valign === v.value))}
        </>
      )}
      <span className="mx-1 h-4 w-px bg-border" />
      {/* Normal is the default, so choosing it clears the attribute rather than storing one. One of the three is
          always on, which is why these don't toggle off the way an alignment does. */}
      {RICH_SIZES.map((s) =>
        toggleButton(
          `${SIZE_LABELS[s]} text`,
          <span className={cn("font-semibold leading-none", SIZE_GLYPH[s])}>A</span>,
          () => attrs({ size: s === "base" ? undefined : s }),
          (active.size ?? "base") === s,
        ),
      )}
      <span className="mx-1 h-4 w-px bg-border" />
      <AttrMenu
        label="Typeface"
        current={FACE_LABEL(active.face ?? "default")}
        value={active.face ?? "default"}
        // Each choice is set in its own face, so the menu shows what it means rather than naming it.
        options={[{ key: "default", label: FACE_LABEL("default") }, ...RICH_FACES.map((f) => ({ key: f, label: FACE_LABEL(f), style: { fontFamily: orgNameFontStack(f) } }))]}
        onPick={(k) => attrs({ face: k === "default" ? undefined : k })}
        onHold={hold}
      />
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
