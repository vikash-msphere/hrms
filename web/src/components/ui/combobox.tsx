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
  disabled,
  autoFocus,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
  disabled?: boolean;
  // Focus the trigger on mount, so a dialog whose first decision is a person can be opened straight into. It
  // focuses the trigger, not the list - opening the popover for the author would be a decision they didn't ask
  // for yet.
  autoFocus?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);

  React.useEffect(() => setActive(0), [query]);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          autoFocus={autoFocus}
          className={cn(
            // min-w-0 / truncate: see ui/input.tsx. The selected label can be an employee's full name or
            // a whole cost centre, and without a zeroed minimum the trigger claims that width from
            // whatever row it sits in - which on a phone is the row that then runs off screen.
            "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 coarse:min-h-10",
            !selected && "text-muted-foreground",
            className,
          )}
        >
          <span className="min-w-0 truncate text-left">{selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
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
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {/* Bounded by the room Radix measured, so on a phone the list ends above the screen edge instead of
            being clipped by it (a 20-name list otherwise runs off the bottom with no way to reach the tail). */}
        <div ref={listRef} className="max-h-[min(15rem,var(--radix-popover-content-available-height,15rem))] overflow-y-auto overscroll-contain p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
          ) : (
            filtered.map((o, idx) => (
              <button
                key={o.value}
                type="button"
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
