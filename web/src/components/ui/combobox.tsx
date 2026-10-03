import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type ComboboxOption = { value: string; label: string };

// A searchable single-select, styled to match SelectTrigger so it's a drop-in for long option lists (people,
// departments) where the native Select's scroll-and-hunt gets unwieldy. Type to filter, ↑/↓ to move, Enter to
// pick, Esc to close. Built on Popover (no extra dep) and portaled, so it works inside dialogs without the
// dialog's Enter-to-submit stealing the keystroke.
export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  className,
  contentClassName,
  disabled,
  autoFocus,
  id,
  onOpenChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  /** Width/styling for the POPUP. Defaults to the trigger's width; override it for a compact trigger. */
  contentClassName?: string;
  disabled?: boolean;
  // Told when the popup opens and closes, so a caller whose options are EXPENSIVE can fetch them on first
  // open instead of on mount. Without it the only lazy trigger available is the caller's own state changing,
  // which for a control that IS the state change (pick a value, and that is the choice) happens too late -
  // the list is empty exactly when it is first read.
  onOpenChange?: (open: boolean) => void;
  // Lands on the TRIGGER (a button, which is labelable), so a <Field> can point its <label for> at this
  // control the same way it does at an <input>. Field sets it automatically - see components/common/Field.tsx.
  id?: string;
  // Focus the trigger on mount, so a dialog whose first decision is a person can be opened straight into. It
  // focuses the trigger, not the list - opening the popover for the author would be a decision they didn't ask
  // for yet.
  autoFocus?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  // The combobox pattern's wiring. `active` is real state - arrow keys move it, `bg-accent` highlights it and
  // Enter commits it - so a sighted reader watches the highlight travel while a screen-reader user got nothing
  // at all: focus never leaves the search box, and without `aria-activedescendant` there is nothing to
  // announce. This control exists to REPLACE ui/select (Radix, fully ARIA-correct) on exactly the lists too
  // long to scan, so the lists that most need announcing were the ones that had none.
  const listId = React.useId();
  const optionId = (idx: number) => `${listId}-opt-${idx}`;
  const selected = options.find((o) => o.value === value);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  React.useEffect(() => setActive(0), [query]);
  // The highlight has to stay inside the list it points at. `active` was reset on a typed query and on nothing
  // else, so a list that shrinks for any OTHER reason (the caller's options narrowing as its own data loads,
  // an excluded name being picked elsewhere) left it past the end: `aria-activedescendant` dropped off, the
  // reader was told nothing, and Enter picked `undefined` and silently did nothing.
  React.useEffect(() => {
    setActive((a) => (a < filtered.length ? a : Math.max(0, filtered.length - 1)));
  }, [filtered.length]);
  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (o?: ComboboxOption) => {
    if (!o) return;
    onValueChange(o.value);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        onOpenChange?.(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          // No role/aria-* of its own. The combobox in this control is the SEARCH INPUT inside the popup (APG's
          // editable-combobox pattern); the trigger is only the disclosure that opens it. Naming the trigger a
          // second `combobox` over the same listbox is invalid ARIA - and it also strips the element of its
          // button role, which is the only thing a label, a test or a screen reader had to call it by. Radix's
          // PopoverTrigger already supplies aria-haspopup="dialog", aria-expanded and aria-controls.
          disabled={disabled}
          autoFocus={autoFocus}
          className={cn(
            // min-w-0 / truncate: see ui/input.tsx. The selected label can be an employee's full name or
            // a whole cost centre, and without a zeroed minimum the trigger claims that width from
            // whatever row it sits in - which on a phone is the row that then runs off screen.
            "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 coarse:min-h-10",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <span className="min-w-0 truncate text-left">{selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      {/* Matching the trigger's width is right for a full-width form field and wrong for a compact trigger:
          a chip sized to "Sales" would open a list two words wide. `contentClassName` overrides it (cn runs
          twMerge, so a caller's `w-*` replaces this one) without changing the default every other caller
          depends on. */}
      <PopoverContent align="start" className={cn("w-[var(--radix-popover-trigger-width)] p-0", contentClassName)}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={searchPlaceholder}
            // The highlight, spoken. Without this the reader is told nothing as ↑/↓ move `active`, and Enter
            // picks an option they were never told about.
            aria-activedescendant={filtered[active] ? optionId(active) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(filtered[active]);
              }
            }}
            placeholder={searchPlaceholder}
            // Filtering a list of names and codes, not writing prose: the phone must not capitalise or
            // autocorrect what is typed here. Enter picks the highlighted row, so the key says Go.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            className="h-9 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
        </div>
        {/* Bounded by the room Radix measured, so on a phone the list ends above the screen edge instead of
            being clipped by it (a 20-name list otherwise runs off the bottom with no way to reach the tail). */}
        <div ref={listRef} id={listId} role="listbox" className="max-h-[min(15rem,var(--radix-popover-content-available-height,15rem))] overflow-y-auto overscroll-contain p-1">
          {filtered.length === 0 ? (
            // Announced: filtering to nothing is a state change with no other signal - the list simply empties.
            <p role="status" aria-live="polite" className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
          ) : (
            filtered.map((o, idx) => (
              <button
                key={o.value}
                type="button"
                id={optionId(idx)}
                role="option"
                aria-selected={o.value === value}
                data-idx={idx}
                onMouseMove={() => setActive(idx)}
                onClick={() => choose(o)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors coarse:min-h-11",
                  idx === active && "bg-accent text-accent-foreground",
                )}
              >
                <Check className={cn("h-4 w-4 shrink-0", o.value === value ? "opacity-100" : "opacity-0")} />
                <span className="line-clamp-1">{o.label}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Set explicitly: <Field> identifies the controls it may bind its label to by displayName, and a minified
// production build mangles Function.name. See components/common/Field.tsx.
Combobox.displayName = "Combobox";
