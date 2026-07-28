// Pure flow-analytics over a board's cards + movement log (no I/O). Powers the cumulative flow diagram (count
// per column over time), lead time (delivery - commitment), cycle time (delivery - start of work) and
// throughput (cards delivered per period). All durations are in days.

export type MovementLite = { cardId: string; toColumn: string; at: number }; // at = epoch ms
export type CardLite = { committedAt: number | null; startedAt: number | null; deliveredAt: number | null };

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}
function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const avg = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  return { p50: round1(percentile(s, 50)), p85: round1(percentile(s, 85)), avg: round1(avg), count: s.length };
}

// UTC yyyy-mm-dd for a day offset back from `today`.
function dayStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export type BoardMetrics = {
  columns: { key: string; label: string }[];
  cfd: { date: string; counts: Record<string, number> }[];
  lead_time: { p50: number; p85: number; avg: number; count: number };
  cycle_time: { p50: number; p85: number; avg: number; count: number };
  throughput: { delivered: number; per_week: number };
};

export function computeBoardMetrics(
  columns: { key: string; label: string }[],
  cards: CardLite[],
  movements: MovementLite[],
  opts: { days?: number; now?: number } = {},
): BoardMetrics {
  const days = opts.days ?? 30;
  const now = opts.now ?? Date.now();

  // Per-card movement history sorted by time, for point-in-time column reconstruction.
  const byCard = new Map<string, MovementLite[]>();
  for (const m of movements) {
    const arr = byCard.get(m.cardId) ?? [];
    arr.push(m);
    byCard.set(m.cardId, arr);
  }
  for (const arr of byCard.values()) arr.sort((a, b) => a.at - b.at);

  // CFD: for each day boundary, the column each card sat in as of end-of-day (its last move at or before then).
  const todayStart = Math.floor(now / DAY) * DAY;
  const cfd: { date: string; counts: Record<string, number> }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const cutoff = todayStart - i * DAY + DAY - 1; // end of that day
    const counts: Record<string, number> = {};
    for (const c of columns) counts[c.key] = 0;
    for (const arr of byCard.values()) {
      let col: string | null = null;
      for (const m of arr) {
        if (m.at <= cutoff) col = m.toColumn;
        else break;
      }
      if (col && col in counts) counts[col] = (counts[col] ?? 0) + 1;
    }
    cfd.push({ date: dayStr(cutoff), counts });
  }

  const lead: number[] = [];
  const cycle: number[] = [];
  let deliveredInRange = 0;
  const rangeStart = todayStart - (days - 1) * DAY;
  for (const c of cards) {
    if (c.deliveredAt && c.committedAt) lead.push((c.deliveredAt - c.committedAt) / DAY);
    if (c.deliveredAt) {
      const start = c.startedAt ?? c.committedAt;
      if (start) cycle.push((c.deliveredAt - start) / DAY);
      if (c.deliveredAt >= rangeStart) deliveredInRange++;
    }
  }
  const weeks = Math.max(1, days / 7);
  return {
    columns,
    cfd,
    lead_time: stats(lead),
    cycle_time: stats(cycle),
    throughput: { delivered: deliveredInRange, per_week: round1(deliveredInRange / weeks) },
  };
}
