import { useEffect, useMemo, useState } from "react";
import { api } from "@/api";
import { navigate } from "@/router";
import { AccessAction } from "@/components/access/AccessAction";
import { RowsSkeleton } from "@/components/common/Skeletons";
import { FilterChips } from "@/components/common/FilterChips";
import type { SearchInsight } from "@/types";

// How ⌘K is being used, from the daily counters (services/searchInsights.ts): what people search for and do not
// find (a missing synonym, or a record type nobody can see), where in the list they find what they open (whether
// ranking works), and whether Ask answers. Counts only - nothing here says who searched.
//
// Read when the panel opens and not before, over the chosen window only (`?since=`), a page at a time.

type Window = "7" | "30";
const MAX_PAGES = 20; // a month of counters is a few thousand rows at most; this bounds a runaway

const dayAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function loadSince(since: string): Promise<SearchInsight[]> {
  const out: SearchInsight[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ since, max_page_size: "100", ...(token ? { page_token: token } : {}) });
    const r = await api<{ results?: SearchInsight[]; next_page_token?: string }>(`/search-insights?${q}`);
    out.push(...(r.results ?? []));
    token = r.next_page_token;
    if (!token) break;
  }
  return out;
}

const OPEN_ORDER = ["1", "2-3", "4-10", "11+"];
const SOURCE_LABEL: Record<string, string> = { keyword: "Matched the words", related: "Related (by meaning)", local: "Pages, settings, actions, people" };

export function SearchInsightsPanel() {
  const [win, setWin] = useState<Window>("7");
  const [rows, setRows] = useState<SearchInsight[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    loadSince(dayAgo(Number(win)))
      .then((r) => { if (live) setRows(r); })
      .catch((e: Error) => { if (live) setError(e.message || "Could not load search insights"); });
    return () => { live = false; };
  }, [win]);

  const summary = useMemo(() => {
    const zero = new Map<string, number>();
    const opens = new Map<string, number>(); // "<source>:<bucket>"
    const ask = { answered: 0, empty: 0 };
    for (const r of rows ?? []) {
      if (r.kind === "zero") zero.set(r.label, (zero.get(r.label) ?? 0) + r.count);
      else if (r.kind === "open") opens.set(r.label, (opens.get(r.label) ?? 0) + r.count);
      else if (r.label === "answered" || r.label === "empty") ask[r.label] += r.count;
    }
    const topZero = [...zero.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    const sources = ["keyword", "related", "local"].map((s) => {
      const counts = OPEN_ORDER.map((b) => opens.get(`${s}:${b}`) ?? 0);
      return { source: s, counts, total: counts.reduce((a, b) => a + b, 0) };
    });
    return { topZero, sources, ask, opened: sources.reduce((a, s) => a + s.total, 0) };
  }, [rows]);

  return (
    <div className="space-y-6">
      <FilterChips<Window>
        value={win}
        onChange={setWin}
        options={[{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }]}
      />
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !rows ? (
        <RowsSkeleton rows={6} />
      ) : (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Searches that found nothing</h3>
            <p className="text-xs text-muted-foreground">
              The words people typed and got no result for. A repeated one is usually a word the app does not use for
              the thing (a synonym worth adding) or a record type that person cannot see. Queries carrying a number
              or an email are never kept.
            </p>
            {summary.topZero.length === 0 ? (
              <p className="text-sm text-muted-foreground">None in this window.</p>
            ) : (
              <ul className="divide-y rounded-lg border text-sm">
                {summary.topZero.map(([label, n]) => (
                  <li key={label} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {/* Closes the loop: a word people keep typing is usually a synonym the records do not use.
                        Hidden, not disabled, for anyone who cannot save the synonyms setting. */}
                    <AccessAction collection="settings" objectPath="settings/search-synonyms" label="Add as synonym">
                      <button
                        type="button"
                        className="shrink-0 text-xs text-primary hover:underline"
                        onClick={() => navigate(`settings/search-synonyms?add=${encodeURIComponent(label)}`)}
                      >
                        Add as synonym
                      </button>
                    </AccessAction>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Where opened results sat</h3>
            <p className="text-xs text-muted-foreground">
              {summary.opened} result{summary.opened === 1 ? "" : "s"} opened. Most should be first or near it; a lot of
              opens far down the list means the ranking is putting the wrong things on top.
            </p>
            <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
              <table className="table-stack w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-3 py-1.5 text-left font-medium">Found by</th>
                    {OPEN_ORDER.map((b) => <th key={b} className="px-3 py-1.5 text-right font-medium">#{b}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {summary.sources.map((s) => (
                    <tr key={s.source} className="border-b last:border-0">
                      <td className="px-3 py-1.5" data-label="Found by">{SOURCE_LABEL[s.source]}</td>
                      {s.counts.map((n, i) => <td key={OPEN_ORDER[i]} className="px-3 py-1.5 text-right tabular-nums" data-label={`#${OPEN_ORDER[i]}`}>{n}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Ask</h3>
            <p className="text-sm">
              {summary.ask.answered + summary.ask.empty === 0
                ? "Not used in this window."
                : `${summary.ask.answered} answered, ${summary.ask.empty} with nothing that fit.`}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
