import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The row of pill filters that sits above a list, in one place.
//
// WHAT THIS REPLACED. Nine pages drew this control and every one of them wrote the markup out by hand:
// Goals, Team goals, Reviews, Payslips, Holidays, Suggestions, Announcements, Workflows and the post
// composer. The class strings had drifted apart, which is a thing a person SEES walking from one page to the
// next: on Payslips an unselected chip carried `bg-background` and lit up `hover:bg-muted hover:text-
// foreground`, while on Holidays and Suggestions it was transparent and lit up `hover:bg-accent`. Same
// control, three appearances, none of them chosen.
//
// Three behaviours are settled here rather than per page, because they were settled on some pages and not
// others:
//
//  - `aria-pressed`. Which chip is on was said in the fill colour and nowhere else, so a screen reader was
//    told there were six buttons and nothing about which one was active.
//  - Pressing the chip that is already on clears it, when the caller says what "cleared" means. A filter
//    that can be turned on and not off is a filter people get stuck in - most of these pages REMEMBER the
//    chip across visits, so somebody could arrive on an empty list with no obvious way back.
//  - The count rides in the chip at a lower contrast, never as a separate element that can wrap away from
//    the label it counts. The gap before it is a SPACE, not a margin: a margin separates label from count on
//    screen and fuses them in the accessible name, so the chip announced itself as "Unread16".

/**
 * The chip's own appearance, for the few controls that have to BE a chip without being a button.
 *
 * The post composer's audience row is three chips where the third is a department `Select` - picking a
 * department chooses the department and the mode in one move, so it has to open a menu rather than toggle.
 * It still has to look like the two chips beside it, and it did that by copying their classes, which is how
 * the copy that drifts gets made. Exported so the appearance has one definition even where the element
 * underneath is not a `FilterChip`.
 */
export const filterChipClass = (active: boolean) =>
  cn(
    "rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40",
    active ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );

export function FilterChip({ active, onClick, count, disabled, title, className, children }: {
  active: boolean;
  onClick: () => void;
  /** The number this filter would show. Omitted where counting it would cost a read the page has not done. */
  count?: number;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(filterChipClass(active), className)}
    >
      {children}
      {count !== undefined && <>{" "}<span className="tabular-nums opacity-70">{count}</span></>}
    </button>
  );
}

export type FilterChipOption<T extends string> = {
  value: T;
  label: ReactNode;
  count?: number;
  disabled?: boolean;
  title?: string;
};

/**
 * The whole row, driven by a list.
 *
 * `clearTo` is what pressing the active chip falls back to - usually the "all" option. Leave it out where
 * there is no neutral state to fall back to (a year picker, a required scope), and the active chip then
 * simply ignores the press rather than emptying the list with nothing to say why.
 */
export function FilterChips<T extends string>({ value, onChange, options, clearTo, className, children }: {
  value: T;
  onChange: (next: T) => void;
  options: FilterChipOption<T>[];
  clearTo?: T;
  className?: string;
  /** Anything that belongs on the same row - a search box, a view toggle, a cycle picker. */
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {options.map((o) => (
        <FilterChip
          key={o.value}
          active={value === o.value}
          count={o.count}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(value === o.value && clearTo !== undefined ? clearTo : o.value)}
        >
          {o.label}
        </FilterChip>
      ))}
      {children}
    </div>
  );
}
