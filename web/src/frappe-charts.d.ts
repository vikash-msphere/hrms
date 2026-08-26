// Type surface for frappe-charts (the package ships none). Deliberately narrow: only the options this app
// actually passes are declared, so a typo in a chart config is a compile error rather than a silently ignored
// key. Widen it when a chart needs an option that is genuinely missing - not to make a mistake typecheck.
declare module "frappe-charts" {
  export type FrappeChartType = "line" | "bar" | "axis-mixed" | "pie" | "donut" | "percentage" | "heatmap";

  export type FrappeDataset = {
    name?: string;
    values: number[];
    /** On an `axis-mixed` chart, what this particular series is drawn as. */
    chartType?: "line" | "bar";
  };

  export type FrappeData = {
    labels?: string[];
    datasets?: FrappeDataset[];
    /** A horizontal reference line (a target, an average, a full day). */
    yMarkers?: { label: string; value: number; options?: { labelPos?: "left" | "right" } }[];
    yRegions?: { label: string; start: number; end: number; options?: { labelPos?: "left" | "right" } }[];
    /** Heatmap only: seconds-since-epoch (as a string key) -> that day's value. */
    dataPoints?: Record<string, number>;
    start?: Date;
    end?: Date;
  };

  export type FrappeOptions = {
    title?: string;
    data: FrappeData;
    type?: FrappeChartType;
    height?: number;
    colors?: string[];
    animate?: 0 | 1;
    truncateLegends?: boolean;
    maxLegendPoints?: number;
    maxSlices?: number;
    isNavigable?: boolean;
    valuesOverPoints?: 0 | 1;
    countLabel?: string;
    discreteDomains?: 0 | 1;
    axisOptions?: {
      xAxisMode?: "span" | "tick";
      yAxisMode?: "span" | "tick";
      xIsSeries?: 0 | 1;
      shortenYAxisNumbers?: 0 | 1;
    };
    barOptions?: { stacked?: 0 | 1; spaceRatio?: number; height?: number; depth?: number };
    lineOptions?: { dotSize?: number; hideLine?: 0 | 1; hideDots?: 0 | 1; heatline?: 0 | 1; regionFill?: 0 | 1; areaFill?: 0 | 1; spline?: 0 | 1 };
    tooltipOptions?: {
      formatTooltipX?: (value: string) => string;
      formatTooltipY?: (value: number) => string;
    };
  };

  export class Chart {
    constructor(parent: Element | string, options: FrappeOptions);
    parent: HTMLElement;
    update(data: FrappeData): void;
    export(): void;
    /** Drops frappe's own ResizeObserver on the parent plus its window resize/orientationchange listeners.
     *  Skipping it leaves a destroyed chart redrawing into a container that is no longer in the document,
     *  which throws inside frappe (`nodeName` / `parentNode` of undefined) on every later resize. */
    destroy(): void;
  }
}
