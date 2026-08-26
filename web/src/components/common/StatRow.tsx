import * as React from "react";
import { cn } from "@/lib/utils";
import { statRow, type StatRowCaps, type StatRowGap } from "@/lib/statRows";

// A row of metric tiles that never leaves an orphan row: the count is split into rows as evenly as the
// per-width cap allows and every row is stretched to the full width (the arithmetic, and why, are in
// `web/src/lib/statRows.ts`). Use it for any tile row whose LENGTH IS DATA - a KPI wall the viewer curates, a
// My-day row whose tiles only exist when there is something to say, a metric strip that grows a segment for
// "No invoice attached". A fixed count that already divides its columns can stay an ordinary grid.
//
// Children are counted, not declared: `{cond && <Tile/>}` children drop out of the count when they are false,
// so a caller writes the tiles exactly as before. Each surviving child is handed its row size as CSS custom
// properties through `style`, which is why a tile component used here has to forward `style` to its root.
//
// Not for card GALLERIES (the directory's people, the illustration picker). There the cell size is the point -
// a stretched last row would draw two enormous employee cards - and a short last row reads as "the list
// ended", which is true.
export const StatRow = React.forwardRef<
  HTMLDivElement,
  {
    /** Items per row at each rung of STAT_ROW_LADDER: one of the *_CAPS presets, or a list of your own. */
    caps: StatRowCaps;
    gap?: StatRowGap;
    className?: string;
    children?: React.ReactNode;
  } & Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "className">
>(function StatRow({ caps, gap, className, style, children, ...rest }, ref) {
  const items = React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement<{ style?: React.CSSProperties }>[];
  if (items.length === 0) return null;
  const rows = statRow(items.length, caps, gap);
  return (
    // The caller's own style (the dashboard orders its sections with one) keeps precedence over nothing -
    // the gap variables and it are disjoint - but it is spread first so a caller can override even those.
    <div ref={ref} className={cn("stat-row", className)} style={{ ...rows.style, ...style }} {...rest}>
      {items.map((child, i) =>
        React.cloneElement(child, { style: { ...(child.props.style ?? {}), ...rows.cell(i) } }),
      )}
    </div>
  );
});
