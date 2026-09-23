import { KPI_ICONS, CATEGORY_ICONS } from "../web/src/lib/kpiIcons";
import { KPI_DEFS, KPI_CATEGORIES } from "../web/src/lib/dashboardConfig";
import { test, expect } from "./fixtures";

// One shared map, so the dashboard's KPI cards and the Settings visibility editor draw the same glyph for a
// given key with no duplication (lib/kpiIcons.ts's own opening comment). That sharing is exactly why a
// missing entry can't be caught by opening either page and looking: `KPI_ICONS[d.key]` is read with `!` in
// Dashboard.tsx and behind `Icon && <Icon .../>` in Settings.tsx, so a KPI added without its icon renders
// silently blank in BOTH places rather than throwing anywhere a browser test would trip over it. `KPI_ICONS`
// is typed `Record<string, LucideIcon>` - an open map, not a closed union - so TypeScript itself enforces
// nothing here; `CATEGORY_ICONS` is typed `Record<KpiCategory, LucideIcon>` against the closed category
// union and so is already complete by construction, which this leaves alone rather than re-proving.
test("every KPI definition has an icon wired up for it", () => {
  const missing = KPI_DEFS.filter((d) => !KPI_ICONS[d.key]).map((d) => d.key);
  expect(missing, `these KPI keys have no entry in KPI_ICONS: ${missing.join(", ")}`).toEqual([]);
});

test("every KPI category the icon map claims to cover is one the dashboard actually has", () => {
  const categoryKeys = new Set<string>(KPI_CATEGORIES.map((c) => c.key));
  for (const key of Object.keys(CATEGORY_ICONS)) {
    expect(categoryKeys.has(key), `CATEGORY_ICONS has an entry for an unknown category "${key}"`).toBe(true);
  }
});
