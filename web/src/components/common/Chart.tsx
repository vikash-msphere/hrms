import * as React from "react";
import type { FrappeChartType, FrappeData, FrappeOptions, Chart as FrappeChart } from "frappe-charts";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { chartColors, heatmapColors } from "@/lib/chartTheme";
import { Skeleton } from "@/components/ui/skeleton";

// The app's one chart primitive: line, bar, mixed axis, pie, donut, percentage bar and calendar heatmap, all
// drawn by frappe-charts (MIT, no runtime dependencies, plain SVG).
//
// WHY A LIBRARY AT ALL. Every chart the app had was hand-drawn SVG, and each one re-derived the same things -
// a scale, an axis, tick labels, a hover readout, a legend, a dark-mode palette - slightly differently. Two of
// them disagreed about what a gridline should look like. A chart is a solved problem; the parts worth this
// app's attention are which numbers go on it and what the reader is meant to take away.
//
// WHAT STAYS HAND-DRAWN. Micro-visuals: the daily-hours strip, a progress ring, the attendance month grid.
// They are 50px tall, have no axis, and are laid out to the pixel against the text beside them; a general
// charting engine would make them bigger and worse. The rule is the axis: something with an axis and a
// tooltip is a Chart, something that is a shape beside a number is not.
//
// THE LIBRARY IS LAZY-LOADED, like the spreadsheet exporter: ~25KB gzipped that most pages never draw, so it
// is fetched by the first chart that actually renders rather than by everybody's first paint.
//
// THEME. frappe bakes its colours in at construction, so a theme flip REBUILDS the chart (cheap - these are
// tens of SVG nodes). Its stylesheet hardcodes one light-mode ink and a black tooltip; both are re-pointed at
// our tokens in index.css, which is also where the tooltip is given the app's own tooltip surface. Those
// overrides carry a doubled class deliberately - the library injects its sheet from JS, so it always lands
// after ours and wins any tie. See the CHARTS block there before touching a chart colour.
//
// ACCESSIBILITY. An SVG of coloured paths is nothing to a screen reader, so every chart also emits its own
// numbers as a table in the accessibility tree, and the figure carries a caption naming what it shows. Charts
// with an axis are keyboard-navigable (frappe's `isNavigable` moves a highlight along the series with the
// arrow keys). Animation is skipped entirely when the reader has asked for reduced motion.

export type ChartSeries = {
  /** Series name - shown in the legend and the tooltip. Required whenever there is more than one. */
  name?: string;
  values: number[];
  /** `axis-mixed` only: draw this one as a line over the bars (a target over actuals, a rate over volumes). */
  chartType?: "line" | "bar";
};

/**
 * A chart in the app's standard frame: a bordered card, a title, one line saying what the reader is looking
 * at, and optional controls in the corner. Almost every chart on a page wants exactly this, and writing the
 * frame by hand is how six pages end up with six spacings.
 */
export function ChartCard({ title, description, actions, className, children }: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border bg-card p-4", className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

export type ChartProps = {
  type: FrappeChartType;
  /** X labels (all types but heatmap). */
  labels?: string[];
  datasets?: ChartSeries[];
  /** Heatmap: "YYYY-MM-DD" -> that day's value, and the window it is drawn over. */
  points?: Record<string, number>;
  start?: Date;
  end?: Date;
  /** What this chart shows, for the accessibility tree - a sentence, not a title-case label. */
  ariaLabel: string;
  height?: number;
  /** Override the categorical palette (a chart whose colours MEAN something - a status, a leave type). */
  colors?: string[];
  /** How a value reads in the tooltip and the data table ("8h", "62%", "₹1,200"). */
  format?: (value: number) => string;
  /** Horizontal reference lines: a target, a team average, a full working day. */
  markers?: { label: string; value: number }[];
  stacked?: boolean;
  /** Line charts: fill under the line (an area chart), and/or smooth it. */
  areaFill?: boolean;
  spline?: boolean;
  hideDots?: boolean;
  /** Pie/donut: how many slices before the rest are pooled by the library. */
  maxSlices?: number;
  /** Heatmap: what one unit is, in the tooltip ("hours", "punches"). */
  countLabel?: string;
  /** Row/slice clicks, by index into `labels` - for a chart that drills through to the rows behind it. */
  onSelect?: (index: number) => void;
  /** Shown instead of the chart when there is nothing to draw. */
  emptyText?: string;
  className?: string;
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

const isEmpty = (p: ChartProps) =>
  p.type === "heatmap"
    ? Object.keys(p.points ?? {}).length === 0
    : (p.labels?.length ?? 0) === 0 || (p.datasets ?? []).every((d) => d.values.every((v) => !v));

export function Chart(props: ChartProps) {
  const { type, labels, datasets, points, start, end, ariaLabel, height = 240, colors, format, markers, stacked, areaFill, spline, hideDots, maxSlices, countLabel, onSelect, emptyText, className } = props;
  const { resolved } = useTheme();
  const host = React.useRef<HTMLDivElement>(null);
  const chart = React.useRef<FrappeChart | null>(null);
  const [lib, setLib] = React.useState<typeof import("frappe-charts") | null>(null);
  const [failed, setFailed] = React.useState(false);
  // Bumped when the data changes shape (see the update effect); a build dep, so the chart is rebuilt rather
  // than updated in place.
  const [rebuild, setRebuild] = React.useState(0);
  const shapeRef = React.useRef("");
  const builtData = React.useRef<FrappeData | null>(null);
  const builtWidth = React.useRef(0);
  const empty = isEmpty(props);

  // Fetch the engine the first time a chart is actually on screen. A failure is not fatal: the data table
  // below is the same information, so the page keeps working with the picture missing.
  React.useEffect(() => {
    if (empty) return;
    let live = true;
    import("frappe-charts")
      .then((m) => { if (live) setLib(m); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [empty]);

  // The data, in the library's shape. Re-derived whenever the numbers change, which is also what drives the
  // update below - so a filter change redraws the same chart instead of building a new one.
  const data: FrappeData = React.useMemo(
    () =>
      type === "heatmap"
        ? { dataPoints: points ?? {}, start, end }
        : {
            labels: labels ?? [],
            datasets: (datasets ?? []).map((d) => ({ name: d.name, values: d.values, ...(d.chartType ? { chartType: d.chartType } : {}) })),
            ...(markers?.length ? { yMarkers: markers.map((m) => ({ label: m.label, value: m.value, options: { labelPos: "left" as const } })) } : {}),
          },
    [type, labels, datasets, points, start, end, markers],
  );

  // Build (and rebuild on a theme flip, a type change or a resize of the box).
  React.useEffect(() => {
    if (!lib || !host.current || empty) return;
    const el = host.current;
    el.innerHTML = ""; // frappe appends; without this a rebuild would stack charts on top of each other
    const palette = colors ?? (type === "heatmap" ? heatmapColors(resolved) : chartColors(resolved, Math.max(datasets?.length ?? 1, labels?.length ?? 1)));
    const options: FrappeOptions = {
      data,
      type,
      height,
      colors: palette,
      animate: prefersReducedMotion() ? 0 : 1,
      truncateLegends: true,
      isNavigable: type === "line" || type === "bar" || type === "axis-mixed",
      ...(maxSlices ? { maxSlices } : {}),
      ...(countLabel ? { countLabel } : {}),
      ...(type === "heatmap" ? { discreteDomains: 1 as const } : {}),
      axisOptions: { xAxisMode: "tick", yAxisMode: "span", shortenYAxisNumbers: 1 },
      barOptions: { stacked: stacked ? 1 : 0, spaceRatio: 0.4 },
      lineOptions: {
        regionFill: areaFill ? 1 : 0,
        spline: spline ? 1 : 0,
        hideDots: hideDots ? 1 : 0,
        dotSize: 3,
      },
      tooltipOptions: format ? { formatTooltipY: (v: number) => format(v) } : undefined,
    };
    chart.current = new lib.Chart(el, options);
    // The numbers this chart was BUILT with. The update effect below compares against it and does nothing when
    // they are the same object, which is the case on the render that built the chart: frappe is still inside
    // its init animation there, its data units and navigable overlays are not drawn yet, and an `update()`
    // landing in that window throws inside the library (`nodeName` of the missing unit, then `parentNode` of a
    // detached overlay) and leaves the picture half drawn.
    builtData.current = data;

    // frappe redraws itself on a resize, and that redraw is broken for a navigable chart (which is every
    // line/bar/axis-mixed chart here): `draw(true)` re-makes the data units and then asks its overlay code for
    // `units[state.currentIndex]`, an index carried over from the previous draw, so on a resize it reads past
    // the end and throws `Cannot read properties of undefined (reading 'nodeName')` from inside the library.
    // The stack is entirely frappe's - our only way in is to take the redraw off it.
    //
    // So its observer and window listeners come off here, and the box is watched below instead: a real width
    // change rebuilds the chart, which is what `draw(true)` was trying to do and gets right.
    const inst = chart.current as unknown as { resizeObserver?: { disconnect(): void }; boundDrawFn?: () => void };
    inst.resizeObserver?.disconnect();
    if (inst.boundDrawFn) {
      window.removeEventListener("resize", inst.boundDrawFn);
      window.removeEventListener("orientationchange", inst.boundDrawFn);
    }
    builtWidth.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      // Integer width only: a fractional reflow is not a redraw, and a rebuild that changes the width it just
      // measured would loop.
      if (Math.abs(el.clientWidth - builtWidth.current) < 1) return;
      builtWidth.current = el.clientWidth;
      setRebuild((n) => n + 1);
    });
    ro.observe(el);

    // Frappe announces a click on an axis point as a DOM event on its own container; a page that wants to
    // drill through subscribes through `onSelect` rather than reaching into the SVG.
    const onEvent = (e: Event) => onSelect?.((e as CustomEvent<{ index: number }>).detail?.index ?? 0);
    if (onSelect) el.addEventListener("data-select", onEvent);
    return () => {
      ro.disconnect();
      if (onSelect) el.removeEventListener("data-select", onEvent);
      // frappe watches this container with its own ResizeObserver and two window listeners, so emptying the
      // node is not a teardown: the old chart keeps being asked to redraw, into a container that is no longer
      // in the document, and throws inside the library on the next resize (`nodeName` of undefined). Every
      // theme flip and route change left one more of those behind.
      chart.current?.destroy();
      chart.current = null;
      el.innerHTML = "";
    };
    // `data` is deliberately absent: new numbers UPDATE the chart (below) rather than rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, empty, type, resolved, height, colors, stacked, areaFill, spline, hideDots, maxSlices, countLabel, rebuild]);

  // New numbers into the chart that is already there, so a filter change animates rather than flashing.
  //
  // Only while the SHAPE holds, though. frappe's `update` re-binds values onto the axis it already drew: give
  // it a different number of points or series and it walks past the end of its own arrays, throwing inside the
  // library (`nodeName` / `parentNode` of undefined) and leaving the old picture on screen. That is not a rare
  // case - it is what a page does normally, since a list arrives in two passes (cache, then the server), and
  // the second pass is the one that adds the twelfth department. A count change therefore rebuilds.
  React.useEffect(() => {
    const shape =
      type === "heatmap"
        ? `h${Object.keys(points ?? {}).length}`
        : `${(labels ?? []).length}x${(datasets ?? []).length}`;
    const had = shapeRef.current;
    shapeRef.current = shape;
    if (had && had !== shape) {
      setRebuild((n) => n + 1);
      return;
    }
    // Already drawn with exactly these numbers (this is the render that built it) - see `builtData`.
    if (builtData.current === data) return;
    chart.current?.update(data);
  }, [data, type, points, labels, datasets]);

  const fmt = format ?? ((v: number) => String(v));

  if (empty) {
    return (
      <div className={cn("flex items-center justify-center rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground", className)} style={{ minHeight: height / 2 }}>
        {emptyText ?? "Nothing to chart yet."}
      </div>
    );
  }

  return (
    <figure className={cn("m-0", className)}>
      {/* The picture is decoration over the table below it: the table IS the chart's content for anything
          that cannot see the SVG, so the figure itself is hidden from the accessibility tree rather than
          announced as an unlabelled graphic. */}
      <div ref={host} aria-hidden="true" style={{ minHeight: height }}>
        {!lib && !failed && <Skeleton className="w-full rounded-lg" style={{ height }} />}
      </div>
      <figcaption className="sr-only">{ariaLabel}</figcaption>
      {/* The `sr-only` goes on a WRAPPER, not on the table. `sr-only` hides a box by shrinking it to 1px and
          clipping it, and a table is the one element that refuses the first half: it cannot be laid out
          narrower than its own min-content, so the class left a ~450px invisible box in the page. Nothing
          painted there, and it still made the document wider than the screen on every page with a chart -
          which on a browser without `overflow-x: clip` is a page that pans sideways over nothing at all.
          A plain block DOES take the 1px, and its own `overflow: hidden` then contains the wide table
          inside it, so the row of numbers stays exactly as available to a screen reader as it was. */}
      <div className="sr-only">
      <table>
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">{type === "heatmap" ? "Day" : "Point"}</th>
            {type === "heatmap"
              ? <th scope="col">{countLabel ?? "Value"}</th>
              : (datasets ?? []).map((d, i) => <th key={i} scope="col">{d.name ?? `Series ${i + 1}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {type === "heatmap"
            ? Object.entries(points ?? {}).map(([ts, v]) => (
                <tr key={ts}>
                  <th scope="row">{new Date(Number(ts) * 1000).toISOString().slice(0, 10)}</th>
                  <td>{fmt(v)}</td>
                </tr>
              ))
            : (labels ?? []).map((label, i) => (
                <tr key={`${label}-${i}`}>
                  <th scope="row">{label}</th>
                  {(datasets ?? []).map((d, j) => <td key={j}>{fmt(d.values[i] ?? 0)}</td>)}
                </tr>
              ))}
        </tbody>
      </table>
      </div>
      {failed && <p className="mt-2 text-xs text-muted-foreground">The chart couldn't be drawn here — the numbers are in the table beside it.</p>}
    </figure>
  );
}
