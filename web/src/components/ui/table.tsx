import * as React from "react";
import { cn } from "@/lib/utils";

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement> & { containerClassName?: string }
>(({ className, containerClassName, ...props }, ref) => (
  // `overflow-auto` (both axes) makes this the single scroll container, so a `sticky` TableHeader can pin to
  // the top while horizontal scroll still works. With no max-height the box just grows to fit (no vertical
  // scroll, header stays put as before); callers that want a pinned header pass `containerClassName` a
  // max-height to bound it.
  // `scroll-shadow-x` because this box is the one place a table's sideways scroll can be advertised. On
  // a phone there is no scrollbar to see and no hover to summon one, so a table wider than the screen
  // is indistinguishable from a table with columns missing. The ground is `card` since a Table is
  // almost always inside one; a caller on another surface passes its own `--scroll-ground`.
  <div
    className={cn(
      "scroll-shadow-x relative w-full overflow-auto [--scroll-ground:hsl(var(--card))]",
      containerClassName
    )}
  >
    <table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  )
);
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn("group border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted", className)}
      {...props}
    />
  )
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-11 px-4 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn("px-4 py-3 align-middle [&:has([role=checkbox])]:pr-0", className)} {...props} />
  )
);
TableCell.displayName = "TableCell";

// Totals strip under a table. Sticky to the bottom of the scroll container so a column's total stays on
// screen while a long list scrolls - the number is only useful next to the rows it sums.
const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot
      ref={ref}
      className={cn("sticky bottom-0 z-10 border-t bg-muted/95 font-medium backdrop-blur-sm [&_tr]:border-0", className)}
      {...props}
    />
  )
);
TableFooter.displayName = "TableFooter";

export { Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell };
