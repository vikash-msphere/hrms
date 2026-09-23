import * as React from "react";
import type { FrappeChartType, FrappeData, FrappeOptions, Chart as FrappeChart } from "frappe-charts";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { chartColors, heatmapColors, heatmapDays, heatmapPoints } from "@/lib/chartTheme";
import { Skeleton } from "@/components/ui/skeleton";

/** Text as markup that reads back as the same text - for strings handed to a library that uses innerHTML. */
const escapeText = (s: string): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

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
// numbers as a table in the accessibility tree, and the figure carries a caption naming what it shows. That
// table is also where a chart is operated from without a pointer: a chart that filters the list below it
// renders each of its rows' headers as a button, and the table lifts out of `sr-only` while it holds focus,
// so a sighted keyboard user can see where they are. The library's own keyboard navigation is NOT used - see
// the CLICKING block below for why it could not be. Charts do not animate at all - see ANIMATION.

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
  /** Bar/point/slice clicks, by index into `labels` - for a chart that filters the rows behind it. Fires for
   *  every type but the heatmap, which has no labels to index and uses `onSelectDay`. */
  onSelect?: (index: number) => void;
  /** Heatmap: the day that was clicked, "YYYY-MM-DD". */
  onSelectDay?: (ymd: string) => void;
  /** The `labels` index the page is currently narrowed by: that mark keeps its colour and the rest are
   *  dimmed, so the picture says what it is filtered by. Null when nothing is picked. */
  selected?: number | null;
  /** Shown instead of the chart when there is nothing to draw. */
  emptyText?: string;
  className?: string;
};

// CLICKING A CHART. frappe has no click API. What it has is `data-select`, and that event is a by-product of
// its KEYBOARD NAVIGATION (`isNavigable`) rather than a way to be told what was pressed. Every part of that
// is wrong for a chart that filters the list under it:
//
// * Only `AxisChart` fires it (`setCurrentDataPoint`). Pie, donut, percentage and heatmap never do, so a
//   click handler on those types was silently dead - and those are most of the app's charts.
// * It refuses to fire twice for the same point (`if(index === s.currentIndex) return;`), so a filter could
//   never be toggled back OFF from the picture. Its index also starts at the last point, so the first click
//   on the last bar was dead too.
// * The `document` keydown listener that drives it is added per chart and removed by nothing - `destroy()`
//   takes off the resize listeners and leaves this one. Every rebuild (a theme flip, a resize, a shape
//   change) left another behind, bound to a dead instance whose `parent` is the host div the LIVE chart now
//   occupies, and a detached container measures as on-screen - so arrow keys anywhere on the page had stale
//   charts firing `data-select` at the live one with their own stale index.
// * Its unit binding also reads `data-point-index` off the tooltip, which never carries one: clicking the
//   tooltip set the current index to `NaN`.
//
// So navigation is off and the click is ours: one listener on the host, resolving the press out of the SVG.
// It is resolved per type because the library marks its units differently, and one of those ways is a trap:
//
// * Bars and dots carry `data-point-index`, which IS the index into the data as given. A press that lands
//   between them - the gap above a short bar, the space beside a line - falls back to the nearest x
//   position, the same mapping the library's own tooltip uses, so a column is a target and not just its bar.
//
// * Pie, donut and percentage slices carry nothing, so a slice is found by its place in the component's own
//   store. That place is NOT the caller's label index: `AggregationChart.calc` drops every negative total
//   and, past `maxSlices`, sorts what is left descending and pools the tail into one `Rest` slice. The store
//   position is therefore read back through the library's `state.labels` and matched to the caller's labels
//   by name. A slice that resolves to nothing - `Rest` - is not a filter, and does nothing.
//
// * Heatmap squares carry `data-date` ("YYYY-MM-DD"), which is a day rather than an index into anything.
//   Hence its own callback.

/** Where each aggregation type keeps its slices. Axis charts are not here - their units carry an index. */
const SLICE_STORE: Record<string, string> = {
  pie: "pieSlices",
  donut: "donutSlices",
  percentage: "percentageBars",
};

type ChartInternals = {
  state?: { labels?: string[]; xAxis?: { positions?: number[] } };
  components?: Map<string, { store?: Element[] }>;
  measures?: { margins?: { left?: number }; paddings?: { left?: number } };
  container?: HTMLElement;
};

/** The slices a pie/donut/percentage chart actually drew, if it drew any. */
function sliceStore(chart: FrappeChart | null, type: FrappeChartType): Element[] | null {
  const key = SLICE_STORE[type];
  if (!key) return null;
  const store = (chart as unknown as ChartInternals | null)?.components?.get(key)?.store;
  return Array.isArray(store) ? store : null;
}

/** The caller's label index for a drawn slice, through the library's own label list - see CLICKING. */
function labelIndexOfSlice(chart: FrappeChart | null, labels: string[], at: number): number | null {
  const drawn = (chart as unknown as ChartInternals | null)?.state?.labels?.[at];
  if (drawn == null) return null;
  const i = labels.indexOf(drawn);
  return i < 0 ? null : i;
}

/** Which label index a press landed on, or null when it landed on nothing that means one. */
function hitIndex(host: HTMLElement, chart: FrappeChart | null, type: FrappeChartType, labels: string[], e: MouseEvent): number | null {
  const target = e.target as Element | null;
  if (!target) return null;

  const slices = sliceStore(chart, type);
  if (slices) {
    const at = slices.indexOf(target);
    return at < 0 ? null : labelIndexOfSlice(chart, labels, at);
  }

  const unit = target.closest?.("[data-point-index]");
  if (unit) {
    const i = Number(unit.getAttribute("data-point-index"));
    return Number.isInteger(i) && i >= 0 && i < labels.length ? i : null;
  }

  // Nothing under the pointer, so the nearest column takes it. The library measures from its own container
  // and past the left margin and padding; anything else is off by the width of the y axis.
  const inst = chart as unknown as ChartInternals | null;
  const positions = inst?.state?.xAxis?.positions;
  const box = inst?.container?.getBoundingClientRect();
  if (!positions?.length || !box) return null;
  const relX = e.clientX - box.left - ((inst?.measures?.margins?.left ?? 0) + (inst?.measures?.paddings?.left ?? 0));
  let best = 0;
  for (let i = 1; i < positions.length; i++) {
    if (Math.abs((positions[i] ?? 0) - relX) < Math.abs((positions[best] ?? 0) - relX)) best = i;
  }
  return best < labels.length ? best : null;
}

/**
 * Dim everything that is not the picked mark, so the picture says what the list below it is filtered by.
 *
 * Only DATA marks are touched - bars, dots, slices - never the axis, the legend or the gridlines: a filter
 * greys out the numbers it excluded, not the frame they are read against. A line chart drawn with its dots
 * hidden therefore has nothing here to dim, which is why every page that makes one clickable also says what
 * it is showing in words above the list.
 */
function paintSelection(host: HTMLElement, chart: FrappeChart | null, type: FrappeChartType, labels: string[], selected: number | null): void {
  const slices = sliceStore(chart, type);
  const units = slices ?? [...host.querySelectorAll("[data-point-index]")];
  units.forEach((unit, at) => {
    const i = slices ? labelIndexOfSlice(chart, labels, at) : Number(unit.getAttribute("data-point-index"));
    (unit as SVGElement).style.opacity = selected != null && i !== selected ? "0.3" : "";
  });
}

/**
 * Re-paint the selection after every draw the library makes for ITSELF.
 *
 * Not every draw comes from a call of ours. `setup()` ends with a deferred `update(this.data)` that lands
 * hundreds of milliseconds later, and it re-makes every unit - which throws away the opacity that says which
 * mark is picked. Wrapping `render` (which both paths end in) is the only place that catches all of them. The
 * teardown below replaces this wrapper with a no-op, so a draw that lands after unmount paints nothing.
 */
function repaintOnRender(chart: FrappeChart | null, paint: () => void): void {
  const inst = chart as unknown as Record<string, unknown> | null;
  const original = inst?.["render"];
  if (!inst || typeof original !== "function") return;
  inst["render"] = function (this: unknown, ...args: unknown[]) {
    const out = (original as (...a: unknown[]) => unknown).apply(this, args);
    paint();
    return out;
  };
}

// ANIMATION IS OFF, for every reader, not only the ones who asked for reduced motion.
//
// frappe does not animate a chart in place. `render(components, animate)` hands its elements to
// `runSMILAnimation`, which REMOVES the live `<svg>` from the container, appends a `<animate>`-carrying CLONE
// of it in its place, and swaps the original back 250ms later (frappe-charts.esm.js, `runSMILAnimation`). For
// a quarter of a second after every animated draw the node on the page is therefore a throwaway: anything
// holding a reference to the chart's SVG - a measurement, a hover, a screenshot - is holding a node that has
// just been detached, and the picture re-mounts under the reader rather than moving.
//
// Pie and donut make that visible at once: `initTimeout = 0` on those two classes, so the animated re-draw
// lands in the same frame as the mount and the SVG the reader first sees is gone milliseconds later.
//
// The same animation is where the rest of this file's scar tissue comes from: `runSMILAnimation`'s swap-back
// timer, the `CHART_POST_ANIMATE_TIMEOUT` that re-makes components, and the deferred init update all fire
// from timers no caller can await - see `repaintOnRender`, the shadowed methods in the teardown below, and
// the try/catch around `update`. A draw-in that costs the picture its identity is not worth any of that, so
// the numbers simply appear.

/** A row header in the accessible table, when the chart it belongs to is a filter: the keyboard's way in.
 *  `picked` is only passed where the press is a TOGGLE - a heatmap day opens something and stays unpressed,
 *  and `aria-pressed="false"` on a button that never latches is a lie about what it does. */
function RowPick({ label, picked, onPick }: { label: string; picked?: boolean; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} {...(picked === undefined ? {} : { "aria-pressed": picked })} className="underline underline-offset-2">
      {label}
    </button>
  );
}

const isEmpty = (p: ChartProps) =>
  p.type === "heatmap"
    ? Object.keys(heatmapDays(p.points ?? {})).length === 0
    : (p.labels?.length ?? 0) === 0 || (p.datasets ?? []).every((d) => d.values.every((v) => !v));

export function Chart(props: ChartProps) {
  const { labels, datasets, points, start, end, ariaLabel, height = 240, colors, format, markers, stacked, areaFill, spline, hideDots, maxSlices, countLabel, onSelect, onSelectDay, selected = null, emptyText, className } = props;
  // ONE POINT IS NOT A LINE. frappe cannot draw a line series through a single x: it emits
  // `d="Mundefined,undefined"` for the path and `cx="undefined"` for the dots, which the browser rejects
  // outright - so the series is absent from the picture and the console fills with SVG parse errors. It is
  // not a rare shape either: any chart of "the biggest N" is a one-bar chart on the day the org has one of
  // them (a single budget cap, one project, one open requisition).
  //
  // A line through one point has nothing to say anyway - there is no slope to read - so a one-point chart is
  // drawn as columns instead, which is the same numbers in the shape that survives. The accessible table
  // below is unaffected either way.
  // The days the heatmap draws, and those same days in the timestamp shape frappe reads. Encoding here and
  // never decoding is what keeps the table's day labels honest: a timestamp read back with local date parts
  // names a different day either side of midnight, and there is no need to read one back at all.
  const days = React.useMemo(() => heatmapDays(points ?? {}), [points]);
  const dayPoints = React.useMemo(() => heatmapPoints(days), [days]);
  const onePoint = props.type !== "heatmap" && (labels?.length ?? 0) === 1;
  const type = onePoint && props.type === "line" ? "bar" : props.type;
  const drawDatasets = React.useMemo(
    () => (onePoint ? (datasets ?? []).map((d) => (d.chartType === "line" ? { ...d, chartType: "bar" as const } : d)) : datasets),
    [onePoint, datasets],
  );
  const { resolved } = useTheme();
  const host = React.useRef<HTMLDivElement>(null);
  const chart = React.useRef<FrappeChart | null>(null);
  // What the click listener and the selection paint read. Both of them run OUTSIDE a render - one from a DOM
  // event, one from a library timer - and both must see what is on screen now, not what was there when the
  // chart was built. Going through a ref is also what keeps all four out of the build effect's deps: a
  // callback that only appears on a later render (a page that decides late that a chart is clickable) would
  // otherwise never be attached, and a chart would rebuild itself every time the page picked a new slice.
  const live = React.useRef({ onSelect, onSelectDay, selected, labels: labels ?? [], type });
  live.current = { onSelect, onSelectDay, selected, labels: labels ?? [], type };
  const clickable = !!(type === "heatmap" ? onSelectDay : onSelect);
  const paint = React.useCallback(() => {
    if (host.current && chart.current) paintSelection(host.current, chart.current, live.current.type, live.current.labels, live.current.selected);
  }, []);
  const [lib, setLib] = React.useState<typeof import("frappe-charts") | null>(null);
  const [failed, setFailed] = React.useState(false);
  // Bumped when the data changes shape (see the update effect); a build dep, so the chart is rebuilt rather
  // than updated in place.
  const [rebuild, setRebuild] = React.useState(0);
  // How many points and series the chart on screen was DRAWN with - frappe's arrays are that long, and an
  // update carrying a different count walks off the end of them.
  const shapeRef = React.useRef("");
  const builtData = React.useRef<FrappeData | null>(null);
  const builtWidth = React.useRef(0);
  const empty = isEmpty(props);
  const shape =
    props.type === "heatmap"
      ? `h${Object.keys(days).length}`
      : `${(props.labels ?? []).length}x${(props.datasets ?? []).length}`;

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
  //
  // EVERY STRING IS ESCAPED on the way in. frappe writes labels, series names and marker labels with
  // innerHTML (its tooltip and axis builders), and several charts are fed user text - a custom grid labels
  // its bars with whatever the rows say. Escaped, the markup shows as the text it is; the browser decodes the
  // entities back on render, so what is drawn reads exactly as the label - which is also why the selection
  // paint below can keep matching on the raw labels.
  const data: FrappeData = React.useMemo(
    () =>
      type === "heatmap"
        ? { dataPoints: dayPoints, start, end }
        : {
            labels: (labels ?? []).map(escapeText),
            datasets: (drawDatasets ?? []).map((d) => ({ name: d.name == null ? d.name : escapeText(d.name), values: d.values, ...(d.chartType ? { chartType: d.chartType } : {}) })),
            ...(markers?.length ? { yMarkers: markers.map((m) => ({ label: escapeText(m.label), value: m.value, options: { labelPos: "left" as const } })) } : {}),
          },
    [type, labels, drawDatasets, dayPoints, start, end, markers],
  );

  // Build (and rebuild on a theme flip, a type change or a resize of the box).
  React.useEffect(() => {
    if (!lib || !host.current || empty) return;
    const el = host.current;
    // Nothing is drawn into a box with no width, and the observer below builds it the moment there is one.
    // A hidden box is an ordinary state here - a chart on the tab that is not the open one, a panel that has
    // not been shown yet - and frappe draws into it regardless: it lays out a chart of zero width, makes no
    // data units, and its own post-animation timer then reads `units[currentIndex]` off the end of that empty
    // array and throws (`nodeName`, then `parentNode` of the overlay it tried to move). Waiting for a real
    // width is also simply correct: the picture is measured against the space it will actually occupy.
    if (el.clientWidth <= 0) {
      const wait = new ResizeObserver(() => {
        if (el.clientWidth > 0) setRebuild((n) => n + 1);
      });
      wait.observe(el);
      return () => wait.disconnect();
    }
    el.innerHTML = ""; // frappe appends; without this a rebuild would stack charts on top of each other
    const palette = colors ?? (type === "heatmap" ? heatmapColors(resolved) : chartColors(resolved, Math.max(datasets?.length ?? 1, labels?.length ?? 1)));
    const options: FrappeOptions = {
      data,
      type,
      height,
      colors: palette,
      animate: 0, // never - see the ANIMATION block above `isEmpty`
      truncateLegends: true,
      // Never. Its highlight overlay is the source of most of this file's crash guards, its keydown listener
      // outlives the chart that added it, and the click event it exists to fire is unusable as a click - see
      // the CLICKING block above. Pressing a chart is handled here instead.
      isNavigable: false,
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
    // The first draw happens inside the constructor, so it is painted by hand; every later one - including
    // the deferred init update the library sets a timer for - goes through the wrapper.
    repaintOnRender(chart.current, paint);
    paint();
    // The numbers this chart was BUILT with. The update effect below compares against it and does nothing when
    // they are the same object, which is the case on the render that built the chart: frappe is still inside
    // its init animation there and its data units are not drawn yet, and an `update()` landing in that window
    // throws inside the library (`nodeName` of the missing unit) and leaves the picture half drawn.
    builtData.current = data;
    shapeRef.current = shape;

    // frappe redraws itself on a resize, and its own redraw is the wrong one: `draw(true)` re-enters the
    // whole setup path on a container it has already drawn into, which is how a resize ended up throwing
    // from inside the library. The stack is entirely frappe's - our only way in is to take the redraw off it.
    //
    // So its observer and window listeners come off here, and the box is watched below instead: a real width
    // change rebuilds the chart, which is what `draw(true)` was trying to do and gets right. It is also what
    // keeps the selection painted, since a rebuild goes back through `paint` above.
    const inst = chart.current as unknown as { resizeObserver?: { disconnect(): void }; boundDrawFn?: () => void };
    inst.resizeObserver?.disconnect();
    if (inst.boundDrawFn) {
      window.removeEventListener("resize", inst.boundDrawFn);
      window.removeEventListener("orientationchange", inst.boundDrawFn);
    }
    builtWidth.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      // A box that has just lost its width was hidden, not resized - the reader moved to another tab. There
      // is nothing to redraw for, and rebuilding at zero width is the state the guard above exists to avoid.
      if (el.clientWidth <= 0) return;
      // Integer width only: a fractional reflow is not a redraw, and a rebuild that changes the width it just
      // measured would loop.
      if (Math.abs(el.clientWidth - builtWidth.current) < 1) return;
      builtWidth.current = el.clientWidth;
      setRebuild((n) => n + 1);
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      // frappe watches this container with its own ResizeObserver and two window listeners, so emptying the
      // node is not a teardown: the old chart keeps being asked to redraw, into a container that is no longer
      // in the document, and throws inside the library on the next resize (`nodeName` of undefined). Every
      // theme flip and route change left one more of those behind.
      //
      // `destroy()` takes those three off (frappe-charts.esm.js), but it cancels none of the timers the
      // library sets for itself, and every draw sets some: `setup()` ends with
      // `setTimeout(() => this.update(this.data), initTimeout)` (the animated draw-in, ~700ms out), and each
      // `render()` queues `components.forEach(c => c.make()); this.updateNav()` for when the animation ends.
      // A reader who switches tab, flips the theme or leaves the page inside that window has those timers
      // fire over nodes this cleanup already removed, and they throw from inside the library - `nodeName` of
      // a data unit that is gone - where no try/catch of ours can reach them. So the methods those timers
      // call are shadowed with no-ops first: the timers still fire, and find nothing to do. Shadowing
      // `render` also drops the repaint wrapper, so a late draw cannot paint into a host we have emptied.
      const pending = chart.current as unknown as { update?: () => void; render?: () => void; updateNav?: () => void } | null;
      if (pending) {
        pending.update = () => {};
        pending.render = () => {};
        pending.updateNav = () => {};
      }
      chart.current?.destroy();
      chart.current = null;
      el.innerHTML = "";
    };
    // `data` is deliberately absent: new numbers UPDATE the chart (below) rather than rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, empty, type, resolved, height, colors, stacked, areaFill, spline, hideDots, maxSlices, countLabel, rebuild, paint]);

  // One click listener for the life of the host, resolving what was pressed out of the SVG - see CLICKING.
  // It outlives every rebuild (the host div is ours; only its contents are frappe's) and reads the current
  // callbacks off `live`, so a page that starts or stops being clickable needs no new listener and no
  // rebuild. `empty` is a dep only because the host is not rendered at all when there is nothing to draw.
  React.useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const { onSelect: select, onSelectDay: selectDay, labels: ls, type: drawn } = live.current;
      if (drawn === "heatmap") {
        const ymd = selectDay ? (e.target as Element | null)?.closest?.("[data-date]")?.getAttribute("data-date") : null;
        if (ymd) selectDay!(ymd);
        return;
      }
      if (!select) return;
      const i = hitIndex(el, chart.current, drawn, ls, e);
      if (i != null) select(i);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [empty]);

  // New numbers into the chart that is already there, so a filter change animates rather than flashing.
  //
  // Only while the SHAPE holds, though. frappe's `update` re-binds values onto the axis it already drew: give
  // it a different number of points or series and it walks past the end of its own arrays, throwing inside the
  // library (`nodeName` / `parentNode` of undefined) and leaving the old picture on screen. That is not a rare
  // case - it is what a page does normally, since a list arrives in two passes (cache, then the server), and
  // the second pass is the one that adds the twelfth department. A count change therefore rebuilds.
  //
  // Compared against what the CHART ON SCREEN was built with, not against the previous props. A rebuild is a
  // state change, so it lands a render later: between the count changing and the new chart existing there can
  // be another render carrying the new numbers, and measuring that one against its predecessor says the shape
  // held - while the chart still standing there has the old number of points. That is the update that walks
  // off the end of frappe's arrays, and it is the one this spent a lane's worth of runs throwing from.
  React.useEffect(() => {
    // Already drawn with exactly these numbers (this is the render that built it) - see `builtData`.
    if (builtData.current === data) return;
    if (shapeRef.current !== shape) {
      setRebuild((n) => n + 1);
      return;
    }
    try {
      chart.current?.update(data);
    } catch {
      // The shape held and the numbers are good, so an exception here came from INSIDE frappe: an update that
      // landed in a window it did not expect (an init animation still running, an overlay already detached by
      // a tab switch), where it walks its own half-built nodes and throws on `nodeName` / `parentNode`. The
      // picture is then half drawn and the page has logged a stack nobody can act on. Rebuilding draws the
      // same numbers from scratch, which is what the reader wanted from the update.
      setRebuild((n) => n + 1);
    }
  }, [data, shape]);

  // The picked mark, after every draw this component asked for. Declared AFTER the update effect so it runs
  // over the units that update just made, and keyed on `data` as well as `selected` because an update
  // re-makes every unit and with it the opacity that says which one is picked.
  React.useEffect(() => { paint(); }, [selected, data, rebuild, paint]);

  const fmt = format ?? ((v: number) => String(v));

  if (empty) {
    return (
      <div className={cn("flex items-center justify-center rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground", className)} style={{ minHeight: height / 2 }}>
        {emptyText ?? "Nothing to chart yet."}
      </div>
    );
  }

  return (
    <figure className={cn("relative m-0", className)}>
      {/* The picture is decoration over the table below it: the table IS the chart's content for anything
          that cannot see the SVG, so the figure itself is hidden from the accessibility tree rather than
          announced as an unlabelled graphic. */}
      <div ref={host} aria-hidden="true" className={cn(clickable && "chart-drillable cursor-pointer")} style={{ minHeight: height }}>
        {!lib && !failed && <Skeleton className="w-full rounded-lg" style={{ height }} />}
      </div>
      <figcaption className="sr-only">{ariaLabel}</figcaption>
      {/* The `sr-only` goes on a WRAPPER, not on the table. `sr-only` hides a box by shrinking it to 1px and
          clipping it, and a table is the one element that refuses the first half: it cannot be laid out
          narrower than its own min-content, so the class left a ~450px invisible box in the page. Nothing
          painted there, and it still made the document wider than the screen on every page with a chart -
          which on a browser without `overflow-x: clip` is a page that pans sideways over nothing at all.
          A plain block DOES take the 1px, and its own `overflow: hidden` then contains the wide table
          inside it, so the row of numbers stays exactly as available to a screen reader as it was.

          A CLICKABLE chart's rows are buttons, which means a keyboard can reach inside this box - and a
          focus ring nobody can see is worse than none. So while it holds focus the wrapper comes out of
          `sr-only` as a panel: absolutely positioned over the picture rather than in the flow, capped at the
          figure's width, and scrolling its own overflow. That is what keeps the ~450px table from doing to
          the page on focus exactly what `sr-only` was hiding it from doing all along. */}
      <div className={cn("sr-only", clickable && "focus-within:not-sr-only focus-within:absolute focus-within:inset-x-0 focus-within:top-0 focus-within:z-10 focus-within:max-h-full focus-within:overflow-auto focus-within:rounded-lg focus-within:border focus-within:bg-popover focus-within:p-2 focus-within:text-xs focus-within:shadow-md")}>
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
            ? Object.entries(days).map(([ymd, v]) => (
                <tr key={ymd}>
                  <th scope="row">{onSelectDay ? <RowPick label={ymd} onPick={() => onSelectDay(ymd)} /> : ymd}</th>
                  <td>{fmt(v)}</td>
                </tr>
              ))
            : (labels ?? []).map((label, i) => (
                <tr key={`${label}-${i}`}>
                  <th scope="row">{onSelect ? <RowPick label={label} picked={selected === i} onPick={() => onSelect(i)} /> : label}</th>
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
